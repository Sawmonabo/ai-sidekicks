//! Writes a person's send to a session's lead: a new message, which goes into the lead run that is
//! live, continues the current one resting interrupted, or starts the next one; an edit of a
//! waiting message, which takes its place; and a retry of one not delivered, which goes again as a
//! new message with the same words and files while the failed one reads superseded. Each is one
//! write, taken under the queue's session lock its caller holds. A send into a paused or pausing
//! run answers the run to resume, which the caller resumes once it has let the lock go.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{AgentQueueItemChangeRefusedReason, QueueItemId};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_session::changes::refuse_unchangeable_session;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemReader, QueueItemRecord, RecordedQueueItemState,
};
use sidekicks_session::run::agent::read_lead_agent_through;
use sidekicks_session::run::read::{RunRead, read_run_through};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::schema::session_directory::read_session_state_through;

use crate::admission::QueueAdmission;
use crate::delivery::{QueueDelivery, QueueWithdrawal};
use crate::error::QueueError;
use crate::recorder::{
    QueueRecordError, QueueRecorder, RecordSendError, RecordedSend, SendRefusal, SendRoute,
    lead_run_queued,
};
use crate::refusals::{
    UnreturnedReason, change_refused, left_queue_refusal, queue_item_not_found, unreturned_refusal,
};
use crate::run_lifecycle::QueueRunLifecycle;

/// Reads and writes of a send before a lead run that keeps moving under it is refused.
const SEND_ATTEMPTS: usize = 3;

/// One message as a send writes it: its new id, what it carries and the key it was sent under.
pub(crate) struct QueueSendMessage {
    /// The new item.
    pub(crate) item_id: QueueItemId,
    /// What it carries.
    pub(crate) body: QueueItemBody,
    /// The send's own key.
    pub(crate) client_idempotency_key: ClientUuid,
}

/// A send as written: its row, and the paused or pausing run it went into, which the caller
/// resumes once it has let the session's lock go.
pub(crate) struct WrittenSend {
    /// The row as read back.
    pub(crate) item: QueueItemRecord,
    /// The run to resume, at the version read after the write.
    pub(crate) resumes: Option<(RunId, RunRead)>,
}

/// What a send reads, writes and calls.
pub(crate) struct QueueSendsDeps {
    /// The read pool every queue and run read goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Writes each send.
    pub(crate) recorder: Arc<QueueRecorder>,
    /// Hands a live run what was sent to it, and takes an edited message back.
    pub(crate) delivery: QueueDelivery,
    /// Starts the run a send queues.
    pub(crate) admission: Arc<QueueAdmission>,
    /// Continues the interrupted run a send goes to.
    pub(crate) lifecycle: Arc<QueueRunLifecycle>,
}

/// Writes a person's sends, edits and retries; the caller holds the queue's session lock.
pub(crate) struct QueueSends {
    deps: QueueSendsDeps,
    /// Holds a send after it read the session's lead runs, before each write.
    #[cfg(test)]
    pub(crate) route_write_pause: sidekicks_std::pause_point::PausePoint,
}

impl QueueSends {
    /// Sends over `deps`.
    pub(crate) fn new(deps: QueueSendsDeps) -> Self {
        Self {
            deps,
            #[cfg(test)]
            route_write_pause: sidekicks_std::pause_point::PausePoint::default(),
        }
    }

    /// A new message from `device_id`: into the lead run that is live, the current one resting
    /// interrupted, or as the opening of the next one. `retries` names a not-delivered message it
    /// sends again, which reads superseded in the same write. Called under `hold`; refuses a
    /// session closed or being purged, a retry whose message left meanwhile, a key spent meanwhile
    /// answers the item it saved, and a lead run that changed under every attempt refuses
    /// `agent.queueItem.runChanged`.
    pub(crate) async fn send(
        &self,
        hold: &KeyHold<'_, SessionId>,
        message: QueueSendMessage,
        device_id: DeviceId,
        retries: Option<QueueItemRecord>,
    ) -> Result<WrittenSend, QueueError> {
        let session_id = *hold.key();
        let mut attempt = 1;
        loop {
            let (live_run_id, interrupted_run_id) = self.read_lead_runs(session_id).await?;
            let (run_id, route) = match (live_run_id, interrupted_run_id) {
                (Some(run_id), _) => (run_id, SendRoute::LiveRun),
                (None, Some(run_id)) => (run_id, SendRoute::InterruptedRun),
                (None, None) => {
                    let run_id =
                        RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
                    let agent_id =
                        read_lead_agent_through::<QueueError>(&self.deps.pool, session_id).await?;
                    let queued = lead_run_queued(session_id, run_id, agent_id);
                    (run_id, SendRoute::NewRun { queued })
                }
            };
            let send = RecordedSend {
                item: new_item(session_id, &message, run_id, &device_id, None),
                device_id: device_id.clone(),
                route,
                retries: retries.clone(),
            };
            #[cfg(test)]
            self.route_write_pause.pass().await;
            let recorded = match self.record(send).await {
                Ok(recorded) => recorded,
                Err(SendFailure::RouteChanged) if attempt < SEND_ATTEMPTS => {
                    attempt += 1;
                    continue;
                }
                Err(SendFailure::RouteChanged) => return Err(run_changed(session_id).into()),
                Err(SendFailure::RetryChanged) => {
                    let retried = retries.expect("only a retry has a retry guard");
                    // The agent took the failed message after all, or another retry replaced it.
                    return Err(match self.read_item(retried.id).await? {
                        Some(left) => left_queue_refusal(&left),
                        None => queue_item_not_found(retried.id),
                    }
                    .into());
                }
                Err(SendFailure::Error(error)) => return Err(*error),
            };
            let resumes = if live_run_id.is_some() {
                self.deps
                    .delivery
                    .accept_send(hold, &recorded, run_id)
                    .await?;
                read_run_through::<QueueError>(&self.deps.pool, run_id)
                    .await?
                    .filter(|run| matches!(run.state, RunState::Paused | RunState::Pausing))
                    .map(|run| (run_id, run))
            } else {
                if interrupted_run_id.is_some() {
                    self.deps
                        .lifecycle
                        .continue_interrupted_run(hold, run_id, true)
                        .await?;
                } else {
                    self.deps.admission.start(session_id, run_id);
                }
                None
            };
            return Ok(WrittenSend {
                item: recorded,
                resumes,
            });
        }
    }

    /// Replaces the lead's message `replaces_queue_item_id`: one still waiting is edited in its
    /// place, and one not delivered is sent again with its own words and files. Called under
    /// `hold`; refuses an item the lead's queue of the session does not hold, one that has left the
    /// queue otherwise, and a retry whose words differ from the failed message's.
    pub(crate) async fn replace(
        &self,
        hold: &KeyHold<'_, SessionId>,
        replaces_queue_item_id: QueueItemId,
        message: QueueSendMessage,
        device_id: DeviceId,
    ) -> Result<WrittenSend, QueueError> {
        let session_id = *hold.key();
        let replaces = self
            .read_item(replaces_queue_item_id)
            .await?
            .filter(|item| item.session_id == session_id && item.child_handle.is_none())
            .ok_or_else(|| queue_item_not_found(replaces_queue_item_id))?;
        match replaces.state {
            RecordedQueueItemState::NotDelivered { .. } => {
                if message.body.content != replaces.body.content {
                    return Err(change_refused(
                        AgentQueueItemChangeRefusedReason::NotDelivered,
                        &format!(
                            "Queue item {} reads not delivered; only its own words can be sent \
                             again",
                            replaces.id
                        ),
                    )
                    .into());
                }
                // Its question was marked answered by the first send's row, so the new row marks
                // it no second time.
                let body = QueueItemBody {
                    answers_question_id: None,
                    ..replaces.body.clone()
                };
                let message = QueueSendMessage { body, ..message };
                self.send(hold, message, device_id, Some(replaces)).await
            }
            RecordedQueueItemState::Queued => {
                // An edit goes into its message's run; a waiting message the daemon wrote for no
                // run has none.
                let run_id = replaces
                    .target_run_id
                    .ok_or_else(|| queue_item_not_found(replaces_queue_item_id))?;
                let edited = self.edit(hold, &replaces, run_id, message, device_id).await;
                // What was taken back goes again, edited or not.
                self.deps.lifecycle.hand_or_continue(hold, run_id).await?;
                Ok(WrittenSend {
                    item: edited?,
                    resumes: None,
                })
            }
            RecordedQueueItemState::Admitted
            | RecordedQueueItemState::Superseded
            | RecordedQueueItemState::Canceled => Err(left_queue_refusal(&replaces).into()),
        }
    }

    // An edit: the message takes the waiting one's place, which reads `superseded`. A provider that
    // holds handed messages gives back the old one and every one after it first, and they go again
    // in order after.
    async fn edit(
        &self,
        hold: &KeyHold<'_, SessionId>,
        replaces: &QueueItemRecord,
        run_id: RunId,
        message: QueueSendMessage,
        device_id: DeviceId,
    ) -> Result<QueueItemRecord, QueueError> {
        let mut taken_back = vec![replaces.clone()];
        taken_back.extend(
            self.read_waiting(run_id)
                .await?
                .into_iter()
                .filter(|item| item.id != replaces.id && item.position > replaces.position),
        );
        let withdrawal = self
            .deps
            .delivery
            .take_back(hold, &taken_back)
            .await?
            .get(&replaces.id)
            .copied()
            .unwrap_or(QueueWithdrawal::Unreturned(UnreturnedReason::Taken));
        if let QueueWithdrawal::Unreturned(reason) = withdrawal {
            return Err(unreturned_refusal(replaces.id, reason).into());
        }
        let send = RecordedSend {
            item: new_item(*hold.key(), &message, run_id, &device_id, Some(replaces.id)),
            device_id,
            route: SendRoute::Edit {
                replaces: replaces.clone(),
            },
            retries: None,
        };
        match self.record(send).await {
            Ok(recorded) => Ok(recorded),
            Err(SendFailure::RouteChanged | SendFailure::RetryChanged) => Err(change_refused(
                AgentQueueItemChangeRefusedReason::AlreadyTaken,
                &format!("Queue item {} has left the queue", replaces.id),
            )
            .into()),
            Err(SendFailure::Error(error)) => Err(*error),
        }
    }

    // Writes a send: a session that stopped taking messages is refused as its state says, a key
    // spent meanwhile answers what it saved, and a store that cannot keep it refuses as
    // unavailable.
    async fn record(&self, send: RecordedSend) -> Result<QueueItemRecord, SendFailure> {
        let session_id = send.item.session_id;
        let key = send.item.client_idempotency_key.clone();
        match self.deps.recorder.record_send(send).await {
            Ok(recorded) => Ok(recorded),
            Err(RecordSendError::Refused(SendRefusal::RouteChanged)) => {
                Err(SendFailure::RouteChanged)
            }
            Err(RecordSendError::Refused(SendRefusal::RetryChanged)) => {
                Err(SendFailure::RetryChanged)
            }
            Err(RecordSendError::Refused(SendRefusal::SessionClosed)) => Err(SendFailure::Error(
                Box::new(self.refuse_closed_session(session_id).await),
            )),
            Err(RecordSendError::Refused(SendRefusal::KeySpent)) => {
                let saved = self
                    .deps
                    .pool
                    .read(ReadLength::Short, move |reader| {
                        Ok::<_, QueueError>(
                            QueueItemReader::new(reader)
                                .get_by_idempotency_key(&session_id, &key)?,
                        )
                    })
                    .await
                    .map_err(|error| SendFailure::Error(Box::new(error)))?;
                // A row is never deleted while its session is kept, so the key's row reads back.
                saved.ok_or_else(|| {
                    SendFailure::Error(Box::new(persistence_unavailable(None).into()))
                })
            }
            Err(RecordSendError::Record(error)) => Err(SendFailure::Error(Box::new(
                persistence_unavailable(Some(error)).into(),
            ))),
        }
    }

    // The refusal of a session that no longer takes messages, by the state it reads now.
    async fn refuse_closed_session(&self, session_id: SessionId) -> QueueError {
        let state = read_session_state_through::<QueueError>(&self.deps.pool, session_id).await;
        match state {
            Ok(Some(state)) => match refuse_unchangeable_session(&session_id, state) {
                Err(refusal) => refusal.into(),
                // It took messages again by the read: the send raced its state, as a moved lead
                // run does.
                Ok(()) => run_changed(session_id).into(),
            },
            Ok(None) => session_not_found(&session_id).into(),
            Err(error) => error,
        }
    }

    // The session's live lead run, else its current lead run when that one rests interrupted.
    async fn read_lead_runs(
        &self,
        session_id: SessionId,
    ) -> Result<(Option<RunId>, Option<RunId>), QueueError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let items = QueueItemReader::new(reader);
                if let Some(live_run_id) = items.read_live_lead_run(&session_id)? {
                    return Ok::<_, QueueError>((Some(live_run_id), None));
                }
                let interrupted = items
                    .read_current_lead_run(&session_id)?
                    .filter(|current| current.state == RunState::Interrupted)
                    .map(|current| current.run_id);
                Ok((None, interrupted))
            })
            .await
    }

    async fn read_item(&self, item_id: QueueItemId) -> Result<Option<QueueItemRecord>, QueueError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).get(&item_id)?)
            })
            .await
    }

    async fn read_waiting(&self, run_id: RunId) -> Result<Vec<QueueItemRecord>, QueueError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).list_waiting_for_run(&run_id)?)
            })
            .await
    }
}

// Why a send's write did not land: a guard the caller answers itself, or a refusal or a fault.
enum SendFailure {
    RouteChanged,
    RetryChanged,
    Error(Box<QueueError>),
}

fn new_item(
    session_id: SessionId,
    message: &QueueSendMessage,
    run_id: RunId,
    device_id: &DeviceId,
    replaces_queue_item_id: Option<QueueItemId>,
) -> NewQueueItem {
    NewQueueItem {
        id: message.item_id,
        session_id,
        body: message.body.clone(),
        target_run_id: run_id,
        device_id: Some(device_id.clone()),
        client_idempotency_key: message.client_idempotency_key.clone(),
        replaces_queue_item_id,
        now: WireInstant::now(),
    }
}

// The refusal of a send whose session's lead run kept changing under every attempt.
fn run_changed(session_id: SessionId) -> DomainError {
    DomainError::new(
        "The session's lead run kept changing while the message was queued; nothing was queued",
        RefusalCode::AgentQueueItemRunChanged,
    )
    .with_detail(json!({ "sessionId": session_id }))
}

// The refusal of a send the store could not keep, with its cause where one is known.
fn persistence_unavailable(cause: Option<QueueRecordError>) -> DomainError {
    let refusal = DomainError::new(
        "The queue could not store the message; nothing was queued",
        RefusalCode::AgentQueueItemPersistenceUnavailable,
    );
    refusal.with_optional_source(cause.map(Into::into))
}
