//! The run queue: a person's sends to a session's lead, and the edit, removal and reorder of the
//! messages still waiting. A send is written whole before anything acts on it. Every decision on a
//! session's waiting messages is taken under the queue's one lock per session, so a send, a change
//! and a run's end never interleave; a skill pick is resolved before the lock, so a read waiting
//! at the memory gate never holds the session's writes. A change to a message a provider was
//! handed takes it back first, and one the provider does not give back reads not delivered and
//! leaves the change. A send into a paused or pausing run resumes it once the lock is let go.

mod interrupt;
#[cfg(test)]
mod tests;

use std::sync::{Arc, LazyLock, Weak};

use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::AgentRunResumeRequest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCancelRequest, AgentQueueItemCancelResponse, AgentQueueItemCanceledState,
    AgentQueueItemChangeRefusedReason, AgentQueueItemCreateRequest, AgentQueueItemCreateResponse,
    AgentQueueItemListRequest, AgentQueueItemListResponse, AgentQueueItemReorderRequest,
    QueueItemId, QueueItemState,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::task::TaskTracker;

use crate::admission::{QUEUE_DELIVERY_TIMEOUT, QueueAdmission, QueueAdmissionDeps, RunOpenings};
use crate::changes::QueueChangeSignals;
use crate::delivery::{
    InterruptedRunContinuation, OpeningMessages, QueueDelivery, QueueDeliveryDeps, QueueWithdrawal,
};
use crate::error::QueueError;
use crate::memory_gate::MemoryGate;
use crate::provider_session::ProviderSessions;
use crate::recorder::{QueueRecorder, QueueRecorderDeps};
use crate::refusals::{
    UnreturnedReason, change_refused, left_queue_refusal, queue_item_not_found, unreturned_refusal,
};
use crate::run_lifecycle::{QueueRunLifecycle, QueueRunLifecycleDeps, RunLifecycleListener};
use crate::send::{QueueSendMessage, QueueSends, QueueSendsDeps};
use crate::session_lock::{QueueSessionLock, UnreleasedInterrupts};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::ports::ProcessGoneListener;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::process_identity::ProviderProcessIds;
use sidekicks_session::changes::refuse_unchangeable_session;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_session::interventions::store::read_sessions_with_unreleased_interrupts;
use sidekicks_session::queue_store::summary::summary_of;
use sidekicks_session::queue_store::{
    QueueItemBody, QueueItemOutcome, QueueItemReader, QueueItemRecord, RecordedQueueItemState,
};
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::pause::RunPauseControl;
use sidekicks_session::run::read::{read_run_through, safe_run_version};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::schema::session_directory::read_session_state_through;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

// The detail of a queued run ended because every message it was queued for was removed.
static EMPTIED_RUN_DETAIL: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new(
            "Every message the run was queued for was removed before it started".to_owned(),
        )
        .expect("the detail is non-blank and within the cap")
    });

/// What the run queue reads, writes and calls.
pub struct RunQueueDeps {
    /// The read pool every queue and run read goes through.
    pub pool: Arc<DatabaseReadPool>,
    /// The event log every queue event is appended to.
    pub event_log: Arc<EventLogService>,
    /// The writer a change no event records goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The queues' change signals.
    pub signals: Arc<QueueChangeSignals>,
    /// Starts, continues and ends runs.
    pub engine: Arc<RunEngine>,
    /// The drivers and their descriptors.
    pub providers: Arc<ProviderRegistry>,
    /// Opens each session's provider session.
    pub provider_sessions: Arc<ProviderSessions>,
    /// The gate every start waits its turn at.
    pub memory_gate: Arc<MemoryGate>,
    /// The identity of each session's provider process.
    pub processes: Arc<dyn ProviderProcessIds>,
    /// Resumes a paused run a send went into, and settles what resumes kept.
    pub pauses: Arc<RunPauseControl>,
    /// The committed events the run lifecycle follows.
    pub followers: Arc<SessionEventFollowers>,
    /// Where each damaged session's log stops being readable.
    pub read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// The daemon's one run queue: the handlers' sends and changes, the interventions' interrupts, and
/// the run lifecycle that follows every committed run state change.
pub struct RunQueue {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    providers: Arc<ProviderRegistry>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    pauses: Arc<RunPauseControl>,
    engine: Arc<RunEngine>,
    recorder: Arc<QueueRecorder>,
    delivery: QueueDelivery,
    admission: Arc<QueueAdmission>,
    lifecycle: Arc<QueueRunLifecycle>,
    sends: QueueSends,
    session_lock: Arc<QueueSessionLock>,
    // The queue itself, for the releases it settles on tasks of their own.
    this: Weak<RunQueue>,
    // The releases settling once the session's hold is free.
    releases: TaskTracker,
    _following: FollowerAttachment,
}

impl RunQueue {
    /// The queue over `deps`, following every session's committed events from now on.
    pub fn new(deps: RunQueueDeps) -> Arc<Self> {
        let RunQueueDeps {
            pool,
            event_log,
            writer,
            signals,
            engine,
            providers,
            provider_sessions,
            memory_gate,
            processes,
            pauses,
            followers,
            read_damaged_from_sequence,
        } = deps;
        let recorder = Arc::new(QueueRecorder::new(QueueRecorderDeps {
            event_log,
            writer: Arc::clone(&writer),
            pool: Arc::clone(&pool),
            signals,
        }));
        let session_lock = Arc::new(QueueSessionLock::new());
        let openings = Arc::new(RunOpenings::default());
        let mut parts = None;
        let lifecycle = Arc::new_cyclic(|lifecycle: &Weak<QueueRunLifecycle>| {
            let delivery = QueueDelivery::new(QueueDeliveryDeps {
                pool: Arc::clone(&pool),
                recorder: Arc::clone(&recorder),
                providers: Arc::clone(&providers),
                session_lock: Arc::clone(&session_lock),
                processes: Arc::clone(&processes),
                openings: Arc::clone(&openings) as Arc<dyn OpeningMessages>,
                continuation: Arc::new(lifecycle.clone()) as Arc<dyn InterruptedRunContinuation>,
            });
            let admission = Arc::new(QueueAdmission::new(QueueAdmissionDeps {
                pool: Arc::clone(&pool),
                recorder: Arc::clone(&recorder),
                engine: Arc::clone(&engine),
                provider_sessions: Arc::clone(&provider_sessions),
                providers: Arc::clone(&providers),
                memory_gate: Arc::clone(&memory_gate),
                processes,
                session_lock: Arc::clone(&session_lock),
                read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
                openings,
                delivery: delivery.clone(),
                delivery_timeout: QUEUE_DELIVERY_TIMEOUT,
            }));
            parts = Some((delivery.clone(), Arc::clone(&admission)));
            QueueRunLifecycle::new(QueueRunLifecycleDeps {
                pool: Arc::clone(&pool),
                recorder: Arc::clone(&recorder),
                admission,
                delivery,
                provider_sessions,
                memory_gate,
                pauses: Arc::clone(&pauses),
                session_lock: Arc::clone(&session_lock),
            })
        });
        let (delivery, admission) = parts.expect("the lifecycle's construction built its parts");
        let sends = QueueSends::new(QueueSendsDeps {
            pool: Arc::clone(&pool),
            recorder: Arc::clone(&recorder),
            delivery: delivery.clone(),
            admission: Arc::clone(&admission),
            lifecycle: Arc::clone(&lifecycle),
        });
        let following = {
            let lifecycle = Arc::clone(&lifecycle);
            followers.follow_all(move |event| lifecycle.observe(event))
        };
        Arc::new_cyclic(|this: &Weak<Self>| {
            let unreleased: Weak<dyn UnreleasedInterrupts> = this.clone();
            session_lock.settle_with(unreleased);
            Self {
                pool,
                writer,
                providers,
                read_damaged_from_sequence,
                pauses,
                engine,
                recorder,
                delivery,
                admission,
                lifecycle,
                sends,
                session_lock,
                this: this.clone(),
                releases: TaskTracker::new(),
                _following: following,
            }
        })
    }

    /// The queue's delivery, which the drivers' ports tell of each message a provider took,
    /// refused or gave back, and which holds the messages waiting for paused runs.
    #[expect(
        dead_code,
        reason = "the daemon's start registers the drivers' ports with it"
    )]
    pub(crate) fn delivery(&self) -> QueueDelivery {
        self.delivery.clone()
    }

    /// The queue's admission, which opens the binding of a turn the daemon starts.
    #[expect(
        dead_code,
        reason = "the daemon's start registers the drivers' ports with it"
    )]
    pub(crate) fn admission(&self) -> Arc<QueueAdmission> {
        Arc::clone(&self.admission)
    }

    /// The listener a driver tells of a session's provider process that ended, which moves on
    /// what the process kept for runs that ended; it holds the queue's run lifecycle weakly.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start registers the drivers' ports with it"
        )
    )]
    pub(crate) fn process_gone_listener(&self) -> Arc<dyn ProcessGoneListener> {
        Arc::new(RunLifecycleListener(Arc::downgrade(&self.lifecycle)))
    }

    /// Sends one message from `device_id` to the lead of `to`, else of `session_id`, and answers it
    /// as saved; a send again under the same key answers what the first send saved.
    /// `replaces_queue_item_id` edits a waiting message, or sends one not delivered again. Refuses
    /// a session the daemon does not hold, one closed (`session.alreadyClosed`) or being purged
    /// (`session.changeRefused`), an edit of a message the agent has taken or its provider did not
    /// give back, a retry in other words, a skill pick the provider does not list or whose read
    /// waited past the delivery timeout, a send the store cannot keep and one whose lead run kept
    /// moving under it, writing nothing.
    pub async fn create(
        &self,
        request: AgentQueueItemCreateRequest,
        device_id: DeviceId,
    ) -> Result<AgentQueueItemCreateResponse, QueueError> {
        let session_id = request.to.unwrap_or(request.session_id);
        let (provider, provider_account_id, driver) = read_session_driver::<QueueError>(
            &self.pool,
            &self.providers,
            self.read_damaged_from_sequence.as_ref(),
            session_id,
        )
        .await?;
        let key = request.client_idempotency_key.clone();
        if let Some(saved) = self.read_saved(session_id, &key).await? {
            return Ok(created_response_of(saved));
        }
        let state = read_session_state_through::<QueueError>(&self.pool, session_id).await?;
        if let Some(state) = state {
            refuse_unchangeable_session(&session_id, state)?;
        }
        let skills = self
            .admission
            .resolve_skill_picks(
                session_id,
                &provider,
                provider_account_id,
                driver.as_ref(),
                request.skills.clone(),
            )
            .await?;
        let written = {
            let hold = self.session_lock.hold_session(session_id).await;
            if let Some(saved) = self.read_saved(session_id, &key).await? {
                return Ok(created_response_of(saved));
            }
            let message = QueueSendMessage {
                item_id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is an id"),
                body: QueueItemBody {
                    content: request.content,
                    attachments: request.attachments,
                    skills,
                    answers_question_id: request.answers_question_id,
                    output_speed_for_turn: request.output_speed_for_turn,
                    workspace_id: request.workspace_id,
                },
                client_idempotency_key: key,
            };
            match request.replaces_queue_item_id {
                None => self.sends.send(&hold, message, device_id, None).await?,
                Some(replaces) => {
                    self.sends
                        .replace(&hold, replaces, message, device_id)
                        .await?
                }
            }
        };
        if let Some((run_id, run)) = written.resumes {
            self.resume_for_send(run_id, run.version).await;
        }
        Ok(created_response_of(written.item))
    }

    /// A queue, the lead's or a child's, in its order, only the items in `state` when it is
    /// given. Fails as the read fails.
    pub async fn list(
        &self,
        request: AgentQueueItemListRequest,
    ) -> Result<AgentQueueItemListResponse, QueueError> {
        let AgentQueueItemListRequest {
            session_id,
            child_handle,
            state,
        } = request;
        let items = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).list(
                    &session_id,
                    child_handle.as_ref(),
                    state,
                )?)
            })
            .await?;
        Ok(AgentQueueItemListResponse {
            items: items.into_iter().map(summary_of).collect(),
        })
    }

    /// Removes a waiting message, after which nothing reaches the agent. Refuses an item the queue
    /// does not hold, one the agent has taken and one its provider did not give back, which then
    /// reads not delivered. Removing the last message of a run that has not started ends that run
    /// `failed` in the same write.
    pub async fn cancel(
        &self,
        request: AgentQueueItemCancelRequest,
    ) -> Result<AgentQueueItemCancelResponse, QueueError> {
        let item_id = request.queue_item_id;
        let found = self
            .read_item(item_id)
            .await?
            .filter(|found| found.child_handle == request.child_handle)
            .ok_or_else(|| queue_item_not_found(item_id))?;
        let session_id = found.session_id;
        let hold = self.session_lock.hold_session(session_id).await;
        // A purge of the session while the removal waited took its rows.
        let item = self
            .read_item(item_id)
            .await?
            .ok_or_else(|| queue_item_not_found(item_id))?;
        if item.state != RecordedQueueItemState::Queued {
            return Err(left_queue_refusal(&item).into());
        }
        let withdrawal = self
            .delivery
            .take_back(&hold, std::slice::from_ref(&item))
            .await?
            .get(&item.id)
            .copied()
            .unwrap_or(QueueWithdrawal::Unreturned(UnreturnedReason::Taken));
        if let QueueWithdrawal::Unreturned(reason) = withdrawal {
            return Err(unreturned_refusal(item.id, reason).into());
        }
        let run_id = item.target_run_id;
        let is_last_of_queued_run = match run_id {
            Some(run_id) => self.is_queued_run_emptied_by(run_id, &[item.id]).await?,
            None => false,
        };
        match run_id {
            Some(run_id) if is_last_of_queued_run => {
                self.admission
                    .end_queued_run(
                        &hold,
                        run_id,
                        vec![(item, QueueItemOutcome::Canceled)],
                        EMPTIED_RUN_DETAIL.clone(),
                    )
                    .await?;
            }
            _ => {
                let is_lead = item.child_handle.is_none();
                self.recorder
                    .record_outcome(&item, QueueItemOutcome::Canceled, &WireInstant::now())
                    .await?;
                self.delivery.forget(&[item.id]);
                // A message the provider kept no longer holds back the interrupted run's continue.
                if let Some(run_id) = run_id.filter(|_| is_lead) {
                    self.lifecycle
                        .continue_interrupted_run(&hold, run_id, false)
                        .await?;
                }
            }
        }
        Ok(AgentQueueItemCancelResponse {
            queue_item_id: item_id,
            state: AgentQueueItemCanceledState::Value,
        })
    }

    /// Puts a queue's waiting messages in the order `queue_item_ids` names and answers them in it;
    /// a message a `Send now` marked that the order puts after another loses the mark and goes in
    /// its place. Refuses a list that is not exactly the waiting items; a message the agent takes
    /// meanwhile keeps its place.
    pub async fn reorder(
        &self,
        request: AgentQueueItemReorderRequest,
    ) -> Result<AgentQueueItemListResponse, QueueError> {
        let AgentQueueItemReorderRequest {
            session_id,
            child_handle,
            queue_item_ids,
        } = request;
        let hold = self.session_lock.hold_session(session_id).await;
        let waiting = self
            .read_queue(
                session_id,
                child_handle.clone(),
                Some(QueueItemState::Queued),
            )
            .await?;
        let requested = queue_item_ids.as_slice();
        let is_waiting_set = requested.len() == waiting.len()
            && requested
                .iter()
                .all(|id| waiting.iter().any(|item| item.id == *id));
        if !is_waiting_set {
            return Err(change_refused(
                AgentQueueItemChangeRefusedReason::OrderMismatch,
                "The new order does not name exactly the waiting messages",
            )
            .into());
        }
        let withdrawals = self.delivery.take_back(&hold, &waiting).await?;
        let movable: Vec<QueueItemRecord> = waiting
            .into_iter()
            .filter(|item| withdrawals.get(&item.id) == Some(&QueueWithdrawal::Returned))
            .collect();
        let ordered: Vec<QueueItemRecord> = requested
            .iter()
            .filter_map(|id| movable.iter().find(|item| item.id == *id).cloned())
            .collect();
        let recorded = if ordered.is_empty() {
            Ok(())
        } else {
            self.recorder
                .record_order(&ordered, &WireInstant::now())
                .await
        };
        // What was taken back goes again, in the new order or the old.
        self.hand_lead_runs(&hold, &movable).await?;
        recorded?;
        let items = self
            .read_queue(session_id, child_handle, Some(QueueItemState::Queued))
            .await?;
        Ok(AgentQueueItemListResponse {
            items: items.into_iter().map(summary_of).collect(),
        })
    }

    /// Reads every session's waiting messages again from the record, once the daemon has started
    /// and its recovery has settled the runs it found live: an interrupt's release left unsettled
    /// before the restart is settled again, a run the messages wait for that ended before the
    /// restart is ended as at its end, and a queued run is started. Answers each session whose
    /// settle or read failed, with why, every session tried; fails as the read of the sessions
    /// fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start, once its recovery settled the live runs"
        )
    )]
    pub(crate) async fn recover(&self) -> Result<Vec<(SessionId, QueueError)>, QueueError> {
        let (unreleased, waiting) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>((
                    read_sessions_with_unreleased_interrupts(reader)?,
                    QueueItemReader::new(reader).list_sessions_with_unstarted_waiting()?,
                ))
            })
            .await?;
        let mut failures = Vec::new();
        for session_id in unreleased {
            let (_hold, settled) = self.session_lock.hold_settled(session_id).await;
            if let Err(error) = settled {
                failures.push((session_id, error));
            }
        }
        let reconciles: Vec<_> = waiting
            .into_iter()
            .map(|session_id| (session_id, self.lifecycle.reconcile(session_id)))
            .collect();
        for (session_id, reconciled) in reconciles {
            match reconciled.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push((session_id, error)),
                Err(_dropped) => failures.push((session_id, QueueError::DrainEnded)),
            }
        }
        Ok(failures)
    }

    /// Waits until no start, drain, release or hand of the queue runs, so a hand in flight
    /// finishes or fails before it answers. Work keeps being taken meanwhile: each kind of work is
    /// waited for in turn, again until all four are idle at once, since a drain may start a run, a
    /// run's end a release and either a hand.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's stop"))]
    pub(crate) async fn stop(&self) {
        self.lifecycle.close();
        self.admission.close();
        self.releases.close();
        self.delivery.close();
        // A drain may start a run, a run's end a release, and either a hand: each tracker is
        // waited in that order until none holds work.
        loop {
            self.lifecycle.wait().await;
            self.admission.wait().await;
            self.releases.wait().await;
            self.delivery.wait().await;
            if self.lifecycle.is_idle()
                && self.admission.is_idle()
                && self.releases.is_empty()
                && self.delivery.is_idle()
            {
                return;
            }
        }
    }

    // Resumes the paused or pausing run a send went into, off the session's lock, so the message
    // goes with the continue; a run moved on meanwhile takes the message as it runs.
    async fn resume_for_send(&self, run_id: RunId, run_version: i64) {
        let request = AgentRunResumeRequest {
            target_run_id: run_id,
            expected_run_version: safe_run_version(run_version),
        };
        if let Err(error) = self.pauses.resume(&request, &self.delivery).await {
            tracing::error!(
                run_id = %run_id,
                error = &error as &(dyn std::error::Error + 'static),
                "resuming the paused run a message was sent to failed; the message waits"
            );
        }
    }

    // Whether removing `removed` leaves the queued run `run_id` with no message to start with.
    async fn is_queued_run_emptied_by(
        &self,
        run_id: RunId,
        removed: &[QueueItemId],
    ) -> Result<bool, QueueError> {
        let is_queued = read_run_through::<QueueError>(&self.pool, run_id)
            .await?
            .is_some_and(|run| run.state == RunState::Queued);
        if !is_queued {
            return Ok(false);
        }
        let waiting = self.read_waiting(run_id).await?;
        Ok(waiting.iter().all(|item| removed.contains(&item.id)))
    }

    // Hands each lead run among `items` what waits for it, after a change took messages back.
    async fn hand_lead_runs(
        &self,
        hold: &KeyHold<'_, SessionId>,
        items: &[QueueItemRecord],
    ) -> Result<(), QueueError> {
        let mut run_ids: Vec<RunId> = Vec::new();
        for run_id in items
            .iter()
            .filter(|item| item.child_handle.is_none())
            .filter_map(|item| item.target_run_id)
        {
            if !run_ids.contains(&run_id) {
                run_ids.push(run_id);
            }
        }
        for run_id in run_ids {
            self.lifecycle.hand_or_continue(hold, run_id).await?;
        }
        Ok(())
    }

    async fn read_saved(
        &self,
        session_id: SessionId,
        key: &ClientUuid,
    ) -> Result<Option<QueueItemRecord>, QueueError> {
        let key = key.clone();
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(
                    QueueItemReader::new(reader).get_by_idempotency_key(&session_id, &key)?,
                )
            })
            .await
    }

    async fn read_item(&self, item_id: QueueItemId) -> Result<Option<QueueItemRecord>, QueueError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).get(&item_id)?)
            })
            .await
    }

    async fn read_waiting(&self, run_id: RunId) -> Result<Vec<QueueItemRecord>, QueueError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).list_waiting_for_run(&run_id)?)
            })
            .await
    }

    async fn read_queue(
        &self,
        session_id: SessionId,
        child_handle: Option<ChildHandle>,
        state: Option<QueueItemState>,
    ) -> Result<Vec<QueueItemRecord>, QueueError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).list(
                    &session_id,
                    child_handle.as_ref(),
                    state,
                )?)
            })
            .await
    }
}

// The answer to a send: the item as saved, with the reason of one never delivered.
fn created_response_of(item: QueueItemRecord) -> AgentQueueItemCreateResponse {
    let queue_item_id = item.id;
    let created_at = item.created_at;
    match item.state {
        RecordedQueueItemState::Queued => AgentQueueItemCreateResponse::Queued {
            queue_item_id,
            created_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::Admitted => AgentQueueItemCreateResponse::Admitted {
            queue_item_id,
            created_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::Superseded => AgentQueueItemCreateResponse::Superseded {
            queue_item_id,
            created_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::Canceled => AgentQueueItemCreateResponse::Canceled {
            queue_item_id,
            created_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::NotDelivered { reason } => {
            AgentQueueItemCreateResponse::NotDelivered {
                queue_item_id,
                created_at,
                not_delivered_reason: reason,
            }
        }
    }
}
