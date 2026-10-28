//! Records each change to a queue in its session's log, its row moving in the same write as its
//! `agent.queueItem.*` event, and raises the queue's change once the write commits. A send is one
//! write: its row, its `user.message.sent` for a message (a review has no words), its
//! `agent.queueItem.created` and, when it starts a run, the `agent.run.queued` and row of that run,
//! and, for an edit or a retry, the superseding of the message it replaces, so an acknowledged send
//! never exists without its transcript row and a refused one leaves nothing.

use std::collections::HashSet;
use std::sync::Arc;

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{
    AgentQueueItemAdmittedPayload, AgentQueueItemAdmittedState, AgentQueueItemCanceledPayload,
    AgentQueueItemCanceledState, AgentQueueItemCreatedPayload, AgentQueueItemNotDeliveredPayload,
    AgentQueueItemNotDeliveredState, AgentQueueItemSupersededPayload,
    AgentQueueItemSupersededState, QueueItemId, QueueItemQueuedState, UserMessageSentPayload,
};
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DEVICE_ID_MAX_LEN;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::queue_store::send_now::clear_sent_now_statement;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemExit, QueueItemOutcome, QueueItemReader, QueueItemRecord,
    admit_undelivered_statement, current_interrupted_lead_run_statement,
    insert_queue_item_statement, leave_queued_statement, no_live_lead_run_statement,
    placement_statements, retarget_statement, run_live_statement, session_takes_messages_statement,
    supersede_undelivered_statement,
};
use sidekicks_session::run::projection::insert_queued_run_statement;
use sidekicks_session::run::state_change::refused_statement_index;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::changes::{QueueChangeSignals, QueueKey};

/// Index of a send's session guard (the session takes messages), after its insert at 0.
pub(crate) const SEND_SESSION_GUARD_STATEMENT_INDEX: usize = 1;

/// Index of a send's route guard: no lead run is live for a send that starts one, the run is still
/// live for a send into it, the run still reads interrupted and current for a send that continues
/// it, and the item an edit replaces is still waiting.
pub(crate) const SEND_GUARD_STATEMENT_INDEX: usize = 2;

/// Index of a retry's guard, spliced in right after the route's: the message it sends again still
/// reads not delivered.
pub(crate) const RETRY_GUARD_STATEMENT_INDEX: usize = 3;

// The insert is a send's first statement; a key already spent in the session fails there.
const INSERT_STATEMENT_INDEX: usize = 0;

// Every device id is non-blank, NUL-free text of at most this many code points, the rules of an
// event's actor, so it always reads as one.
const _: () = assert!(DEVICE_ID_MAX_LEN <= EVENT_FIELD_MAX_LEN);

/// Where one person's send goes: a run it starts, the live run it goes into, the interrupted run it
/// continues, or the place of the waiting item it edits, which goes into that item's run.
pub(crate) enum SendRoute {
    /// A run the send starts, queued in the same write.
    NewRun {
        /// The run's creation record.
        queued: AgentRunQueuedPayload,
    },
    /// The live run the send goes into.
    LiveRun,
    /// The interrupted lead run the send continues.
    InterruptedRun,
    /// The waiting item the send edits, which reads superseded in the same write.
    Edit {
        /// The item it replaces.
        replaces: QueueItemRecord,
    },
}

/// One send as it is recorded: the new row, where it goes and, for a retry, the not-delivered
/// message it sends again, which then reads superseded. A message's row names the device that sent
/// it, the message's actor.
pub(crate) struct RecordedSend {
    /// The row to insert.
    pub(crate) item: NewQueueItem,
    /// Where it goes.
    pub(crate) route: SendRoute,
    /// The not-delivered message a retry sends again.
    pub(crate) retries: Option<QueueItemRecord>,
}

/// Which guard refused a send; nothing of it was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum SendRefusal {
    /// The send's key was already spent in the session.
    #[error("the send's key was already spent in the session")]
    KeySpent,
    /// The session no longer takes messages: it was closed or is being purged.
    #[error("the session no longer takes messages")]
    SessionClosed,
    /// The run or the item the send was routed by no longer reads as it did.
    #[error("the run or the item the send was routed by changed")]
    RouteChanged,
    /// The message a retry sends again no longer reads not delivered.
    #[error("the message a retry sends again no longer reads not delivered")]
    RetryChanged,
}

/// Why a send failed: a guard refused it, its write failed, or its row could not be read back
/// after the commit.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RecordSendError {
    /// A guard of the write refused it.
    #[error(transparent)]
    Refused(SendRefusal),
    /// The write failed otherwise, or its item could not be read back.
    #[error("the send was not recorded or not read back")]
    Record(#[from] QueueRecordError),
}

/// Why a queue change was not recorded or its item not read back.
#[derive(Debug, thiserror::Error)]
pub enum QueueRecordError {
    /// An event of the write breaks a check of its type.
    #[error("a queue change's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The append that carries the change was refused or not kept.
    #[error("a queue change's append was not kept")]
    Append(#[from] SessionEventAppendError),
    /// The write of a change no event records was refused or not kept.
    #[error("a queue change's write was not kept")]
    Write(#[from] WriteError),
    /// SQLite refused the read back, or a stored value does not read as its type.
    #[error("a queue item could not be read back")]
    Read(#[from] rusqlite::Error),
    /// The read back reached no connection.
    #[error("a queue item's read did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The item was written and cannot be read back.
    #[error("queue item {item_id} was written but cannot be read back")]
    Unreadable {
        /// The item.
        item_id: QueueItemId,
    },
}

impl QueueRecordError {
    /// Whether a guard of the write refused it: an item had left `queued`, or the run no longer
    /// reads as the write expected. Nothing was written.
    pub(crate) fn is_refused(&self) -> bool {
        match self {
            Self::Append(error) => refused_statement_index(error).is_some(),
            Self::Write(error) => error.refused_statement_index().is_some(),
            Self::Draft(_) | Self::Read(_) | Self::Pool(_) | Self::Unreadable { .. } => false,
        }
    }
}

/// What the recorder writes, reads and signals through.
pub(crate) struct QueueRecorderDeps {
    /// The event log every queue event is appended to.
    pub(crate) event_log: Arc<EventLogService>,
    /// The writer a change no event records goes through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The read pool a send's item is read back through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The queues' change signals, raised once a change commits.
    pub(crate) signals: Arc<QueueChangeSignals>,
}

/// Writes every queue change with its event, or with none where none records it, and raises each
/// queue it changed once the write commits.
pub(crate) struct QueueRecorder {
    appender: SessionEventAppender,
    writer: Arc<DatabaseWriter>,
    pool: Arc<DatabaseReadPool>,
    signals: Arc<QueueChangeSignals>,
}

/// Whether a retarget points the items at a live run or at the session's current lead run
/// resting interrupted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RetargetRun {
    /// A run that has not ended.
    Live(RunId),
    /// The session's current lead run, resting interrupted for a continue.
    Interrupted(RunId),
}

impl QueueRecorder {
    /// A recorder over `deps`.
    pub(crate) fn new(deps: QueueRecorderDeps) -> Self {
        let QueueRecorderDeps {
            event_log,
            writer,
            pool,
            signals,
        } = deps;
        Self {
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            writer,
            pool,
            signals,
        }
    }

    /// Records `send` in one write and returns its row as read back. Fails with
    /// [`RecordSendError::Refused`] naming the guard that refused it, writing nothing, and
    /// otherwise as [`QueueRecordError`] says; only a failed read back follows the commit.
    pub(crate) async fn record_send(
        &self,
        send: RecordedSend,
    ) -> Result<QueueItemRecord, RecordSendError> {
        let RecordedSend {
            item,
            route,
            retries,
        } = send;
        let mut statements = vec![
            insert_queue_item_statement(&item),
            session_takes_messages_statement(&item.session_id),
        ];
        let mut preceding_events = Vec::new();
        let edit_replaces = match route {
            SendRoute::NewRun { queued } => {
                statements.push(no_live_lead_run_statement(&item.session_id));
                statements.push(insert_queued_run_statement(&queued));
                preceding_events.push(
                    SessionEventDraft::of_session(
                        item.session_id,
                        &SessionEvent::AgentRunQueued(queued),
                    )
                    .map_err(QueueRecordError::Draft)?,
                );
                None
            }
            SendRoute::LiveRun => {
                statements.push(run_live_statement(&item.target_run_id));
                None
            }
            SendRoute::InterruptedRun => {
                statements.push(current_interrupted_lead_run_statement(&item.target_run_id));
                None
            }
            // An edit waits for the run its old item waited for; once that run ends, the run's
            // next start takes it with the rest.
            SendRoute::Edit { replaces } => {
                statements.push(leave_queued_statement(
                    &replaces.id,
                    &QueueItemExit::Superseded,
                    &item.now,
                ));
                Some(replaces)
            }
        };
        let is_retry = retries.is_some();
        if let Some(retried) = &retries {
            statements.insert(
                RETRY_GUARD_STATEMENT_INDEX,
                supersede_undelivered_statement(&retried.id, &item.now),
            );
        }
        let created = SessionEvent::AgentQueueItemCreated(AgentQueueItemCreatedPayload {
            session_id: item.session_id,
            queue_item_id: item.id,
            state: QueueItemQueuedState::Value,
        });
        let (draft, correlation_id) = match &item.body {
            QueueItemBody::Message(body) => {
                preceding_events.push(
                    SessionEventDraft::of_session(item.session_id, &created)
                        .map_err(QueueRecordError::Draft)?,
                );
                if let Some(replaced) = edit_replaces.or(retries) {
                    let superseded =
                        SessionEvent::AgentQueueItemSuperseded(AgentQueueItemSupersededPayload {
                            session_id: item.session_id,
                            queue_item_id: replaced.id,
                            state: AgentQueueItemSupersededState::Value,
                            replaced_by_queue_item_id: item.id,
                        });
                    preceding_events.push(
                        SessionEventDraft::of_session(item.session_id, &superseded)
                            .map_err(QueueRecordError::Draft)?,
                    );
                }
                let device_id = item
                    .device_id
                    .clone()
                    .expect("a person's message names the device that sent it");
                let message = UserMessageSentPayload {
                    session_id: item.session_id,
                    queue_item_id: Some(item.id),
                    run_id: Some(item.target_run_id),
                    actor: FreeFormText::new(device_id.as_str().to_owned()).expect(
                        "a device id is non-blank, NUL-free text within an event field's cap",
                    ),
                    device_id: Some(device_id),
                    message: body.content.clone(),
                    origin: None,
                    answers_question_id: body.answers_question_id,
                };
                let draft = SessionEventDraft::new(message, SessionEvent::UserMessageSent)
                    .map_err(QueueRecordError::Draft)?;
                // The provider echoes the message under its queue item's id, which folds into this
                // row.
                let correlation_id = FreeFormText::new(item.id.to_string())
                    .expect("a queue item id is a UUID, within an event field's cap");
                (draft, Some(correlation_id))
            }
            // A review has no words, so its created event carries the write.
            QueueItemBody::Review { .. } => (
                SessionEventDraft::of_session(item.session_id, &created)
                    .map_err(QueueRecordError::Draft)?,
                None,
            ),
        };
        let linkage = SessionEventLinkage {
            correlation_id,
            transactional_prelude: statements,
            preceding_events,
            ..SessionEventLinkage::default()
        };
        if let Err(error) = self.appender.append(draft, linkage).await {
            let refusal = refused_statement_index(&error)
                .and_then(|statement_index| send_refusal_at(statement_index, is_retry));
            return Err(match refusal {
                Some(refusal) => RecordSendError::Refused(refusal),
                None => QueueRecordError::Append(error).into(),
            });
        }
        // A send goes to the lead's queue, which holds the item it replaces too.
        self.signals.raise_change(
            &QueueKey {
                session_id: item.session_id,
                child_handle: None,
            },
            false,
        );
        let item_id = item.id;
        let recorded = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueRecordError>(QueueItemReader::new(reader).get(&item_id)?)
            })
            .await?;
        Ok(recorded.ok_or(QueueRecordError::Unreadable { item_id })?)
    }

    /// Moves `item` out of `queued` to `outcome` with its event in one write. Fails as
    /// [`QueueRecordError`] says, refused when the item has already left `queued`; nothing is
    /// written then.
    pub(crate) async fn record_outcome(
        &self,
        item: &QueueItemRecord,
        outcome: QueueItemOutcome,
        now: &WireInstant,
    ) -> Result<(), QueueRecordError> {
        let (draft, statement) = outcome_draft_of(item, &outcome, now)?;
        self.append_with(draft, vec![statement]).await?;
        self.raise_committed(std::slice::from_ref(item), false);
        Ok(())
    }

    /// Admits `item`, which reads not delivered, into `run_id`, the run whose turn took it after
    /// all, with its event in one write. Fails as [`QueueRecordError`] says, refused when the item
    /// no longer reads not delivered; nothing is written then.
    pub(crate) async fn record_late_admission(
        &self,
        item: &QueueItemRecord,
        run_id: RunId,
        now: &WireInstant,
    ) -> Result<(), QueueRecordError> {
        let draft = SessionEventDraft::of_session(item.session_id, &admitted_event(item, run_id))?;
        self.append_with(draft, vec![admit_undelivered_statement(&item.id, now)])
            .await?;
        self.raise_committed(std::slice::from_ref(item), false);
        Ok(())
    }

    /// Queues the run `queued` for the session's waiting `items`, pointing each at it, in one
    /// write. Fails as [`QueueRecordError`] says, refused when a lead run is live or one of the
    /// items has left `queued`; nothing is written then.
    pub(crate) async fn record_next_run(
        &self,
        queued: AgentRunQueuedPayload,
        items: &[QueueItemRecord],
        now: &WireInstant,
    ) -> Result<(), QueueRecordError> {
        let (session_id, run_id) = queued_run_of(&queued);
        let mut statements = vec![
            no_live_lead_run_statement(&session_id),
            insert_queued_run_statement(&queued),
        ];
        statements.extend(
            items
                .iter()
                .map(|item| retarget_statement(&item.id, &run_id, now)),
        );
        let draft =
            SessionEventDraft::of_session(session_id, &SessionEvent::AgentRunQueued(queued))?;
        self.append_with(draft, statements).await?;
        // No item event records the retarget.
        self.raise_committed(items, true);
        Ok(())
    }

    /// Points each of the waiting `items` at `run` in one write, which no event records. Fails as
    /// [`QueueRecordError`] says, refused when the run no longer reads so or one of the items has
    /// left `queued`; nothing is written then.
    pub(crate) async fn record_retarget(
        &self,
        run: RetargetRun,
        items: &[QueueItemRecord],
        now: &WireInstant,
    ) -> Result<(), QueueRecordError> {
        let (guard, run_id) = match run {
            RetargetRun::Live(run_id) => (run_live_statement(&run_id), run_id),
            RetargetRun::Interrupted(run_id) => {
                (current_interrupted_lead_run_statement(&run_id), run_id)
            }
        };
        let mut statements = vec![guard];
        statements.extend(
            items
                .iter()
                .map(|item| retarget_statement(&item.id, &run_id, now)),
        );
        self.writer.write(statements).await?;
        // The retarget moves each item's `updated_at`, which its summary carries.
        self.raise_committed(items, true);
        Ok(())
    }

    /// Puts the waiting items `ordered` in that order among the places they hold, in one write,
    /// which no event records; an item a `Send now` marked loses the mark when the order puts it
    /// after another, so it goes in its place. Fails as [`QueueRecordError`] says, refused when one
    /// of them has left `queued`; nothing is written then.
    pub(crate) async fn record_order(
        &self,
        ordered: &[QueueItemRecord],
        now: &WireInstant,
    ) -> Result<(), QueueRecordError> {
        let mut statements = placement_statements(ordered, now);
        statements.extend(
            ordered
                .iter()
                .skip(1)
                .filter(|item| item.sent_now_id.is_some())
                .map(|item| clear_sent_now_statement(&item.id, now)),
        );
        self.writer.write(statements).await?;
        self.raise_committed(ordered, true);
        Ok(())
    }

    /// Raises the change of each queue `items` belong to, once per queue, after a write another
    /// made committed; `moves_order` as `raise_change` takes it.
    pub(crate) fn raise_committed(&self, items: &[QueueItemRecord], moves_order: bool) {
        let queues: HashSet<QueueKey> = items
            .iter()
            .map(|item| QueueKey {
                session_id: item.session_id,
                child_handle: item.child_handle.clone(),
            })
            .collect();
        for queue in &queues {
            self.signals.raise_change(queue, moves_order);
        }
    }

    // Appends `draft` with `statements` before it in the same write.
    async fn append_with(
        &self,
        draft: SessionEventDraft,
        statements: Vec<WriteStatement>,
    ) -> Result<(), SessionEventAppendError> {
        self.appender
            .append(
                draft,
                SessionEventLinkage {
                    transactional_prelude: statements,
                    ..SessionEventLinkage::default()
                },
            )
            .await?;
        Ok(())
    }
}

/// The event and the row move that take `item` out of `queued` to `outcome`, for a write another
/// makes (the interrupt's end write cancels through it). Fails as the draft fails.
pub(crate) fn outcome_draft_of(
    item: &QueueItemRecord,
    outcome: &QueueItemOutcome,
    now: &WireInstant,
) -> Result<(SessionEventDraft, WriteStatement), SessionEventDraftError> {
    let event = match outcome {
        QueueItemOutcome::Admitted { run_id } => admitted_event(item, *run_id),
        QueueItemOutcome::Canceled => {
            SessionEvent::AgentQueueItemCanceled(AgentQueueItemCanceledPayload {
                session_id: item.session_id,
                queue_item_id: item.id,
                state: AgentQueueItemCanceledState::Value,
            })
        }
        QueueItemOutcome::NotDelivered { reason } => {
            SessionEvent::AgentQueueItemNotDelivered(AgentQueueItemNotDeliveredPayload {
                session_id: item.session_id,
                queue_item_id: item.id,
                state: AgentQueueItemNotDeliveredState::Value,
                not_delivered_reason: reason.clone(),
            })
        }
    };
    Ok((
        SessionEventDraft::of_session(item.session_id, &event)?,
        leave_queued_statement(&item.id, &QueueItemExit::Outcome(outcome.clone()), now),
    ))
}

// The `agent.queueItem.admitted` event of `item` taken by `run_id`.
fn admitted_event(item: &QueueItemRecord, run_id: RunId) -> SessionEvent {
    SessionEvent::AgentQueueItemAdmitted(AgentQueueItemAdmittedPayload {
        session_id: item.session_id,
        queue_item_id: item.id,
        state: AgentQueueItemAdmittedState::Value,
        run_id,
    })
}

/// The `agent.run.queued` record of the session's next lead run `run_id`, run by `agent_id`,
/// which a send or an ended run's leftovers queue.
pub(crate) fn lead_run_queued(
    session_id: SessionId,
    run_id: RunId,
    agent_id: AgentId,
) -> AgentRunQueuedPayload {
    AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
        session_id,
        run_id,
        run_version: SafeInt::ZERO,
        new_state: AgentRunQueuedNewState::Value,
        agent_id,
        resolved_agent: None,
        parent_run_id: None,
        reached_by: None,
        is_apart: None,
        effective_run_config: None,
        admitted_model_family: None,
        admitted_provider_account_id: None,
    })
}

// The session and the run an `agent.run.queued` payload names.
fn queued_run_of(queued: &AgentRunQueuedPayload) -> (SessionId, RunId) {
    match queued {
        AgentRunQueuedPayload::SessionAgent(payload) => (payload.session_id, payload.run_id),
        AgentRunQueuedPayload::ResolvedAgent(payload) => (payload.session_id, payload.run_id),
    }
}

// The guard a send's refused statement is, by its index; `None` past the guards.
fn send_refusal_at(statement_index: usize, is_retry: bool) -> Option<SendRefusal> {
    match statement_index {
        INSERT_STATEMENT_INDEX => Some(SendRefusal::KeySpent),
        SEND_SESSION_GUARD_STATEMENT_INDEX => Some(SendRefusal::SessionClosed),
        SEND_GUARD_STATEMENT_INDEX => Some(SendRefusal::RouteChanged),
        RETRY_GUARD_STATEMENT_INDEX if is_retry => Some(SendRefusal::RetryChanged),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
