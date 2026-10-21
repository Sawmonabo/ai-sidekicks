//! The blocks a provider's own reviewer makes at Reviewed, and `Allow once` on them.
//!
//! - A block is recorded once, on the blocked call's own row: the newest `agent.toolCall.invoked`
//!   of the block's run with the call's id. The provider's own record of it is kept whole in
//!   `reviewer_denials`, in the same write, and is what the override hands back.
//! - A block can arrive before that row (a provider may review a call before its item starts),
//!   so its intake arms a wait first, then reads: a row committed after the arm wakes the wait,
//!   one committed before it is read. A block whose run ends with no row is refused, nothing
//!   recorded. Two blocks of one call are two waits and two records. A block that names no call
//!   (a review of a network request) is recorded as it arrives, as a row of its own.
//! - The first press hands the record back to the provider that made the block, through the
//!   driver of the run's provider, and is recorded only once the driver took it; every later press
//!   answers the first press's instant and sends nothing. A press whose request got no answer is
//!   held: until the process it went to has ended, a second press answers the same refusal and
//!   sends nothing. A block raises no card and settles no ask.

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::approval::events::{
    ApprovalDenialOverriddenPayload, ApprovalReviewerDeniedPayload,
};
use sidekicks_contracts::approval::{
    ApprovalDenialOverrideRequest, ApprovalDenialOverrideResponse, ReviewerDenialId,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::approvals::refusals::{reviewer_denial_not_found, reviewer_denial_not_overridable};
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::stored_column::{closed_word, text_column};
use crate::events::log_service::EventAppendError;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage, UnsequencedEventEnvelope,
};
use crate::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::keyed_lock::KeyedLock;
use crate::keyed_wait::KeyedWaits;
#[cfg(test)]
use crate::pause_point::PausePoint;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::error_causes::RequestUnanswered;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::run_control::OverrideDenialParams;
use crate::provider::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::session::changes::refuse_unchangeable_session;
use crate::session::not_found::session_not_found;
use crate::session::run::agent::{RUN_AGENT_STATEMENT_CAPACITY, RunAgentReadError, RunAgentReader};
use crate::session::run::read::{RunProvider, RunStateReader, read_run_provider};
use crate::session::run::transitions::is_run_terminal_event_type;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// The statements [`ReviewerDenials`] prepares on a read connection: the blocked call's row, the
/// session's state, the block, its override, the run and its provider, and the run's agent.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start sizes the read connections' statement caches with it"
    )
)]
pub(crate) const REVIEWER_DENIALS_STATEMENT_CAPACITY: usize = 6 + RUN_AGENT_STATEMENT_CAPACITY;

// The blocked call's own row: the newest opening of the call in the block's run, outside every
// range its session skipped. A provider may reuse a call's key in a later run or after a cut.
static SELECT_BLOCKED_CALL_ROW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id FROM session_events AS event
  WHERE session_id = @session_id AND type = '{}' AND run_id = @run_id
    AND json_extract(payload, '$.toolCallId') = @tool_call_id
    AND {}
  ORDER BY sequence DESC
  LIMIT 1",
        SessionEventType::AgentToolCallInvoked.as_str(),
        outside_skipped_ranges_sql("event")
    )
});

const INSERT_DENIAL_SQL: &str = "INSERT INTO reviewer_denials
    (denial_id, session_id, provider_denial)
  VALUES (@denial_id, @session_id, @provider_denial)";

const SELECT_SESSION_STATE_SQL: &str = "SELECT state FROM sessions WHERE id = @session_id";

// The block under the session: the run and the overridable flag its event carries, and the
// provider's own record of it.
static SELECT_DENIAL_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(event.payload, '$.runId'),
       json_extract(event.payload, '$.overridable'),
       denial.provider_denial
  FROM reviewer_denials AS denial
  JOIN session_events AS event
    ON event.session_id = denial.session_id AND event.type = '{}'
   AND json_extract(event.payload, '$.denialId') = denial.denial_id
  WHERE denial.denial_id = @denial_id AND denial.session_id = @session_id",
        SessionEventType::ApprovalReviewerDenied.as_str()
    )
});

static SELECT_OVERRIDE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT occurred_at FROM session_events
  WHERE session_id = @session_id AND type = '{}'
    AND json_extract(payload, '$.denialId') = @denial_id
  ORDER BY sequence
  LIMIT 1",
        SessionEventType::ApprovalDenialOverridden.as_str()
    )
});

/// The blocked call a waiting block is keyed by.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
#[expect(
    clippy::struct_field_names,
    reason = "the call is named by the session's, the run's and its own id"
)]
struct BlockedCall {
    session_id: SessionId,
    run_id: RunId,
    tool_call_id: String,
}

/// How a block's wait for its row ended.
#[derive(Clone, Debug)]
enum RowWait {
    /// The row committed, with its event id.
    Committed(String),
    /// The block's run ended with no row for it.
    RunEnded,
    /// The daemon stopped.
    Stopped,
}

/// What a block's intake read: the row and the run's agent, the run's end, or a live run with no
/// row yet.
enum BlockedCallRead {
    Row { event_id: String, agent_id: AgentId },
    RunEnded,
    Waiting { agent_id: AgentId },
}

/// A press held after its first send: the request is in flight, the provider got the override with
/// no answer back, or it took it and its record failed.
enum HeldPress {
    /// The binding whose process the request in flight went to; a release that lands before the
    /// answer drops it, so an unanswered request to an ended process holds nothing.
    Pending { binding_id: RuntimeBindingId },
    /// The refusal the press answered and the binding whose process the request went to.
    Unanswered {
        refusal: DomainError,
        binding_id: RuntimeBindingId,
    },
    /// The instant the provider took the override, which a later press records.
    Answered { overridden_at: WireInstant },
}

/// The block a press names, as stored.
struct StoredDenial {
    run_id: RunId,
    is_overridable: bool,
    provider_denial: String,
    run_provider: Option<RunProvider>,
}

/// What a press read: the session's state, the block and its earlier override.
struct PressRead {
    session_state: Option<SessionState>,
    denial: Option<StoredDenial>,
    overridden_at: Option<WireInstant>,
}

/// Why a block was not recorded.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReviewerDenialError {
    /// The run ended with no row of the blocked call to carry the block.
    #[error(
        "the blocked tool call {tool_call_id} of session {session_id} ended its run {run_id} with \
         no row to carry its block"
    )]
    NoRow {
        /// The session.
        session_id: SessionId,
        /// The run.
        run_id: RunId,
        /// The blocked call.
        tool_call_id: String,
    },
    /// The daemon stopped before the blocked call's row was written.
    #[error("the daemon stopped before the blocked call's row was written")]
    Stopped,
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the blocked call's row could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The run's agent could not be read.
    #[error(transparent)]
    Agent(#[from] RunAgentReadError),
    /// The block's event breaks a check of its type.
    #[error("the block's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the block.
    #[error("the block was not recorded")]
    Append(#[from] SessionEventAppendError),
}

/// Why `Allow once` was refused or failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DenialOverrideError {
    /// `session.notFound`, `approval.denial.notFound`, `approval.denial.notOverridable`,
    /// `session.alreadyClosed`, `session.changeRefused`, `provider.notFound`, or the held refusal
    /// of a press that got no answer.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The driver refused or failed the override.
    #[error(transparent)]
    Driver(DriverError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the block could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The stored record of the block is not JSON.
    #[error("the stored record of the block is not JSON")]
    StoredDenial(#[source] serde_json::Error),
    /// The block's run has no binding on itself or a parent whose process it runs in.
    #[error("the blocked run {run_id} names no provider")]
    NoBinding {
        /// The run.
        run_id: RunId,
    },
    /// The override's event breaks a check of its type.
    #[error("the override could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the override.
    #[error("the override was not recorded")]
    Append(#[from] SessionEventAppendError),
}

impl From<DenialOverrideError> for HandlerError {
    /// A refusal answers by its code, the session's refusal of the record among them, and a
    /// driver's error as a driver error answers; the rest are faults in the daemon.
    fn from(error: DenialOverrideError) -> Self {
        match error {
            DenialOverrideError::Refused(refusal)
            | DenialOverrideError::Append(SessionEventAppendError::Append(
                EventAppendError::SessionWriteRefused(refusal),
            )) => Self::Refused(refusal),
            DenialOverrideError::Driver(driver) => driver.into(),
            fault @ (DenialOverrideError::Read(_)
            | DenialOverrideError::Pool(_)
            | DenialOverrideError::StoredDenial(_)
            | DenialOverrideError::NoBinding { .. }
            | DenialOverrideError::Draft(_)
            | DenialOverrideError::Append(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Records each block a provider's reviewer makes and allows one once on a person's press: the
/// port the drivers hand their blocks to, and what the `approval.denial.override` handler calls.
pub(crate) struct ReviewerDenials {
    /// Where the log, the sessions and the runs are read.
    reads: Arc<DatabaseReadPool>,
    /// Where the blocks and the overrides are recorded.
    events: Arc<SessionEventAppender>,
    /// The drivers an override reaches.
    providers: Arc<ProviderRegistry>,
    /// The blocks waiting for their call's row.
    row_waits: KeyedWaits<BlockedCall, RowWait>,
    /// Set once the daemon stops, so a block taken after it is refused.
    is_stopped: AtomicBool,
    /// Orders the presses on one block, so two at once hand it to the provider once.
    presses: KeyedLock<ReviewerDenialId>,
    /// The presses held after their first send, changed under the map's lock: a press writes its
    /// pending mark before the driver call and keeps it only if no release dropped it meanwhile.
    held_presses: Mutex<HashMap<ReviewerDenialId, HeldPress>>,
    // Where a test holds a block's read on the pool's thread once it found no row.
    #[cfg(test)]
    row_query_pause: Arc<PausePoint>,
    // Where a test holds a block once its read found no row, before it waits for one.
    #[cfg(test)]
    row_read_pause: PausePoint,
}

impl ReviewerDenials {
    /// The blocks read through `reads`, recorded through `events`, and allowed once through the
    /// drivers `providers` registered; nothing wakes a waiting block until
    /// [`ReviewerDenials::start`].
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the approvals composer builds it and registers it as the drivers' port"
        )
    )]
    pub(crate) fn new(
        reads: Arc<DatabaseReadPool>,
        events: Arc<SessionEventAppender>,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            reads,
            events,
            providers,
            row_waits: KeyedWaits::default(),
            is_stopped: AtomicBool::new(false),
            presses: KeyedLock::new(),
            held_presses: Mutex::new(HashMap::new()),
            #[cfg(test)]
            row_query_pause: Arc::default(),
            #[cfg(test)]
            row_read_pause: PausePoint::default(),
        }
    }

    /// Follows `followers`, so a block waiting for its call's row is woken when the row commits
    /// and refused when its run ends without one, until [`ReviewerDenials::stop`] takes the
    /// returned attachment.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the approvals composer starts it with the daemon")
    )]
    pub(crate) fn start(
        self: &Arc<Self>,
        followers: &Arc<SessionEventFollowers>,
    ) -> FollowerAttachment {
        let row_waits = self.row_waits.clone();
        // Runs on the writer's pump, so it only wakes waiters.
        followers.follow_all(move |event| {
            wake_blocks_on(&row_waits, &event.envelope);
            Ok(())
        })
    }

    /// Stops following the log and refuses every block still waiting, since nothing will now
    /// record it; a block taken after the stop is refused too.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the approvals composer stops it with the daemon")
    )]
    pub(crate) fn stop(&self, attachment: FollowerAttachment) {
        self.is_stopped.store(true, Ordering::SeqCst);
        drop(attachment);
        self.row_waits.settle_where(|_| true, RowWait::Stopped);
    }

    /// The process behind `binding_id` has ended, so nothing can still take an override sent to
    /// it: a press held on one, or still waiting on its answer, sends again. A driver that has
    /// released a binding never answers a later request to it as unanswered: such a request fails
    /// as refused, so no press is held on a binding that will not be released again.
    pub(crate) fn release_held_presses(&self, binding_id: &RuntimeBindingId) {
        lock_held(&self.held_presses).retain(|_, held| match held {
            HeldPress::Pending {
                binding_id: sent_to,
            }
            | HeldPress::Unanswered {
                binding_id: sent_to,
                ..
            } => sent_to != binding_id,
            HeldPress::Answered { .. } => true,
        });
    }

    /// Records `denial` on the blocked call's own row, waiting for that row when the block came
    /// first; a block that names no call is recorded at once, as a row of its own. Fails with
    /// [`ReviewerDenialError::NoRow`] when the run ends with no row for it, with
    /// [`ReviewerDenialError::Stopped`] once the daemon stops, and as the reads and the append do.
    async fn take(&self, denial: ProviderReviewerDenial) -> Result<(), ReviewerDenialError> {
        let (session_id, run_id) = (denial.session_id, denial.run_id);
        let Some(tool_call_id) = denial.tool_call_id.clone() else {
            if self.is_stopped.load(Ordering::SeqCst) {
                return Err(ReviewerDenialError::Stopped);
            }
            // A block that names no call is a row of its own, recorded as it arrives.
            let agent_id = self
                .reads
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, ReviewerDenialError>(
                        RunAgentReader::new(reader).read_agent(&session_id, &run_id)?,
                    )
                })
                .await?;
            return self.record(denial, None, agent_id).await;
        };
        let blocked_call = BlockedCall {
            session_id,
            run_id,
            tool_call_id: tool_call_id.clone(),
        };
        // Armed before the read, so a row committed while it runs still wakes this block.
        let wait = self.row_waits.arm(blocked_call.clone());
        if self.is_stopped.load(Ordering::SeqCst) {
            return Err(ReviewerDenialError::Stopped);
        }
        #[cfg(test)]
        let row_query_pause = Arc::clone(&self.row_query_pause);
        let read = self
            .reads
            .read(ReadLength::Short, move |reader| {
                let read = read_blocked_call(reader, &blocked_call);
                #[cfg(test)]
                if matches!(read, Ok(BlockedCallRead::Waiting { .. })) {
                    row_query_pause.pass_blocking();
                }
                read
            })
            .await?;
        let (event_id, agent_id) = match read {
            BlockedCallRead::Row { event_id, agent_id } => {
                drop(wait);
                (event_id, agent_id)
            }
            BlockedCallRead::RunEnded => return Err(no_row(session_id, run_id, tool_call_id)),
            BlockedCallRead::Waiting { agent_id } => {
                #[cfg(test)]
                self.row_read_pause.pass().await;
                match wait.settled().await {
                    RowWait::Committed(event_id) => (event_id, agent_id),
                    RowWait::RunEnded => return Err(no_row(session_id, run_id, tool_call_id)),
                    RowWait::Stopped => return Err(ReviewerDenialError::Stopped),
                }
            }
        };
        self.record(denial, Some(event_id), agent_id).await
    }

    // One write: the block's event, on its call's row where it names one, and the provider's record
    // kept whole beside it.
    async fn record(
        &self,
        denial: ProviderReviewerDenial,
        event_id: Option<String>,
        agent_id: AgentId,
    ) -> Result<(), ReviewerDenialError> {
        let denial_id =
            ReviewerDenialId::try_from(mint_uuid_v7()).expect("a minted UUID is a denial id");
        let keep_record = WriteStatement {
            sql: INSERT_DENIAL_SQL.into(),
            bindings: StatementBindings::Named(vec![
                text_binding("@denial_id", denial_id.text().as_str()),
                text_binding("@session_id", denial.session_id.text().as_str()),
                text_binding("@provider_denial", denial.provider_denial.get()),
            ]),
            expected_row_count: Some(1),
        };
        let payload = ApprovalReviewerDeniedPayload {
            session_id: denial.session_id,
            run_id: denial.run_id,
            agent_id,
            denial_id,
            event_id: event_id
                .map(|event_id| NonEmptyText::new(event_id).expect("an event id is a minted UUID")),
            reason: denial.reason.and_then(NonEmptyText::new),
            overridable: denial.is_overridable,
        };
        self.events
            .append(
                SessionEventDraft::new(payload, SessionEvent::ApprovalReviewerDenied)?,
                SessionEventLinkage {
                    transactional_prelude: vec![keep_record],
                    ..SessionEventLinkage::default()
                },
            )
            .await?;
        Ok(())
    }

    /// Allows the block once: hands the provider's own record of it to the driver of its run's
    /// provider and records the override at the instant the driver took it, which every later
    /// press answers with and sends nothing. Refuses `session.notFound`,
    /// `approval.denial.notFound`, `approval.denial.notOverridable`, `session.alreadyClosed`,
    /// `session.changeRefused` and `provider.notFound`, in that order, with nothing sent, then the
    /// driver's refusal; a press whose request got no answer answers that refusal, and so does
    /// every later press until the process it went to has ended. A caller awaits a press to its
    /// end and never drops it mid-send; the method layer cancels through its token, not by
    /// dropping the future.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the approval.denial.override handler calls it")
    )]
    pub(crate) async fn override_denial(
        &self,
        request: &ApprovalDenialOverrideRequest,
    ) -> Result<ApprovalDenialOverrideResponse, DenialOverrideError> {
        let session_id = request.session_id;
        let denial_id = request.denial_id;
        let _press_hold = self.presses.acquire(denial_id).await;
        let PressRead {
            session_state,
            denial,
            overridden_at,
        } = self
            .reads
            .read(ReadLength::Short, move |reader| {
                read_press(reader, session_id, denial_id)
            })
            .await?;
        let Some(session_state) = session_state else {
            return Err(session_not_found(&session_id).into());
        };
        let Some(denial) = denial else {
            return Err(reviewer_denial_not_found(session_id, denial_id).into());
        };
        if let Some(overridden_at) = overridden_at {
            return Ok(ApprovalDenialOverrideResponse {
                denial_id,
                overridden_at,
            });
        }
        if !denial.is_overridable {
            return Err(reviewer_denial_not_overridable(session_id, denial_id).into());
        }
        refuse_unchangeable_session(&session_id, session_state)?;
        // Read out first, so the map's lock is never held across the record's await.
        let held = match lock_held(&self.held_presses).get(&denial_id) {
            Some(HeldPress::Unanswered { refusal, .. }) => Some(Err(copy_of_refusal(refusal))),
            Some(HeldPress::Answered { overridden_at }) => Some(Ok(overridden_at.clone())),
            // A press settles its own pending mark before it ends, and no caller drops a press
            // mid-send, so a pending mark is never met here by another press.
            None | Some(HeldPress::Pending { .. }) => None,
        };
        match held {
            Some(Err(refusal)) => return Err(refusal.into()),
            Some(Ok(overridden_at)) => {
                return self
                    .record_override(session_id, denial_id, overridden_at)
                    .await;
            }
            None => {}
        }
        let Some(run_provider) = denial.run_provider else {
            return Err(DenialOverrideError::NoBinding {
                run_id: denial.run_id,
            });
        };
        let driver = self.providers.lookup(&run_provider.provider)?;
        let provider_denial = RawValue::from_string(denial.provider_denial)
            .map_err(DenialOverrideError::StoredDenial)?;
        // Written before the send, so a release that lands before the answer drops it.
        lock_held(&self.held_presses).insert(
            denial_id,
            HeldPress::Pending {
                binding_id: run_provider.binding_id,
            },
        );
        let sent = driver
            .override_denial(OverrideDenialParams {
                session_id,
                run_id: denial.run_id,
                provider_denial,
            })
            .await;
        match sent {
            Ok(()) => {
                self.record_override(session_id, denial_id, WireInstant::now())
                    .await
            }
            Err(DriverError::Unanswered(RequestUnanswered { refusal })) => {
                // The provider may have taken it, so nothing is sent again while its process
                // lives; a process that already ended dropped the pending mark.
                let mut held_presses = lock_held(&self.held_presses);
                if let Some(held) = held_presses.get_mut(&denial_id)
                    && let HeldPress::Pending { binding_id } = held
                {
                    *held = HeldPress::Unanswered {
                        refusal: copy_of_refusal(&refusal),
                        binding_id: binding_id.clone(),
                    };
                }
                Err(refusal.into())
            }
            Err(failed) => {
                lock_held(&self.held_presses).remove(&denial_id);
                Err(DenialOverrideError::Driver(failed))
            }
        }
    }

    // Records the override the provider took at `overridden_at`; a failed record holds that
    // instant, so the next press records it without telling the provider again.
    async fn record_override(
        &self,
        session_id: SessionId,
        denial_id: ReviewerDenialId,
        overridden_at: WireInstant,
    ) -> Result<ApprovalDenialOverrideResponse, DenialOverrideError> {
        let draft = SessionEventDraft::new(
            ApprovalDenialOverriddenPayload {
                session_id,
                denial_id,
            },
            SessionEvent::ApprovalDenialOverridden,
        )?;
        let recorded = self
            .events
            .append(
                draft,
                SessionEventLinkage {
                    occurred_at: Some(overridden_at.clone()),
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        let mut held_presses = lock_held(&self.held_presses);
        match recorded {
            Ok(_receipt) => {
                held_presses.remove(&denial_id);
                Ok(ApprovalDenialOverrideResponse {
                    denial_id,
                    overridden_at,
                })
            }
            Err(failure) => {
                held_presses.insert(denial_id, HeldPress::Answered { overridden_at });
                Err(failure.into())
            }
        }
    }
}

impl ReviewerDenialPort for ReviewerDenials {
    fn take_denial(
        &self,
        denial: ProviderReviewerDenial,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(self.take(denial).await?) })
    }

    fn release_held_presses(&self, binding_id: &RuntimeBindingId) {
        ReviewerDenials::release_held_presses(self, binding_id);
    }
}

// Wakes the blocks a committed event settles: a blocked call's row wakes every block of that
// call, and a run's end refuses every block of the run still waiting.
fn wake_blocks_on(
    row_waits: &KeyedWaits<BlockedCall, RowWait>,
    envelope: &UnsequencedEventEnvelope,
) {
    let Some(run) = envelope.run() else {
        return;
    };
    let session_id = envelope.session_id();
    if envelope.event_type() == SessionEventType::AgentToolCallInvoked {
        if let Some(Value::String(tool_call_id)) = envelope.payload().get("toolCallId") {
            row_waits.settle_all(
                &BlockedCall {
                    session_id,
                    run_id: run.run_id,
                    tool_call_id: tool_call_id.clone(),
                },
                RowWait::Committed(envelope.id.as_str().to_owned()),
            );
        }
    } else if is_run_terminal_event_type(envelope.event_type().as_str()) {
        row_waits.settle_where(
            |blocked| blocked.session_id == session_id && blocked.run_id == run.run_id,
            RowWait::RunEnded,
        );
    }
}

// The blocked call's row with the run's agent; else the run's end, with no run row or in a
// terminal state; else a live run still waiting for the row, with its agent.
fn read_blocked_call(
    reader: &Connection,
    blocked_call: &BlockedCall,
) -> Result<BlockedCallRead, ReviewerDenialError> {
    let event_id: Option<String> = reader
        .prepare_cached(&SELECT_BLOCKED_CALL_ROW_SQL)?
        .query_row(
            named_params! {
                "@session_id": blocked_call.session_id.text().as_str(),
                "@run_id": blocked_call.run_id.text().as_str(),
                "@tool_call_id": blocked_call.tool_call_id,
            },
            |row| row.get(0),
        )
        .optional()?;
    let agents = RunAgentReader::new(reader);
    if let Some(event_id) = event_id {
        let agent_id = agents.read_agent(&blocked_call.session_id, &blocked_call.run_id)?;
        return Ok(BlockedCallRead::Row { event_id, agent_id });
    }
    let run = RunStateReader::new(reader).read_run(&blocked_call.run_id)?;
    if run.is_none_or(|run| run.state.is_terminal()) {
        return Ok(BlockedCallRead::RunEnded);
    }
    let agent_id = agents.read_agent(&blocked_call.session_id, &blocked_call.run_id)?;
    Ok(BlockedCallRead::Waiting { agent_id })
}

// The session's state, the block under it with its run's provider, and its earlier override.
fn read_press(
    reader: &Connection,
    session_id: SessionId,
    denial_id: ReviewerDenialId,
) -> Result<PressRead, DenialOverrideError> {
    let session_text = session_id.text();
    let denial_text = denial_id.text();
    let session_state = reader
        .prepare_cached(SELECT_SESSION_STATE_SQL)?
        .query_row(
            named_params! { "@session_id": session_text.as_str() },
            |row| text_column(row, 0, closed_word::<SessionState>),
        )
        .optional()?;
    let key = named_params! {
        "@session_id": session_text.as_str(),
        "@denial_id": denial_text.as_str(),
    };
    let denial = reader
        .prepare_cached(&SELECT_DENIAL_SQL)?
        .query_row(key, |row| {
            Ok((
                text_column(row, 0, |text| RunId::new(&text))?,
                row.get::<_, bool>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .optional()?;
    let denial = match denial {
        Some((run_id, is_overridable, provider_denial)) => Some(StoredDenial {
            run_provider: read_run_provider(reader, &run_id)?,
            run_id,
            is_overridable,
            provider_denial,
        }),
        None => None,
    };
    let overridden_at = reader
        .prepare_cached(&SELECT_OVERRIDE_SQL)?
        .query_row(key, |row| text_column(row, 0, WireInstant::try_from))
        .optional()?;
    Ok(PressRead {
        session_state,
        denial,
        overridden_at,
    })
}

fn no_row(session_id: SessionId, run_id: RunId, tool_call_id: String) -> ReviewerDenialError {
    ReviewerDenialError::NoRow {
        session_id,
        run_id,
        tool_call_id,
    }
}

// The refusal a held press answers again: the same code, words and detail, its cause logged once
// with the first.
fn copy_of_refusal(refusal: &DomainError) -> DomainError {
    DomainError {
        message: refusal.message.clone(),
        code: refusal.code,
        detail: refusal.detail.clone(),
        source: None,
    }
}

// No holder awaits or panics while it changes the map, so a poisoned lock still holds whole marks.
fn lock_held(
    held_presses: &Mutex<HashMap<ReviewerDenialId, HeldPress>>,
) -> MutexGuard<'_, HashMap<ReviewerDenialId, HeldPress>> {
    held_presses.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
