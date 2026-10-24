//! One run state change, written whole: the check against the table, the event, the row's swap
//! and, for a terminal, the guard that the run version holds no terminal record yet, all in one
//! write so they commit together or not at all.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{ProcessExit, RunFailureCategory, StopTrigger};
use sidekicks_contracts::run::events::{
    AgentRunCompletedNewState, AgentRunCompletedPayload, AgentRunFailedNewState,
    AgentRunFailedPayload, AgentRunInterruptedNewState, AgentRunInterruptedPayload,
    AgentRunPausedNewState, AgentRunPausedPayload, AgentRunPausingNewState, AgentRunPausingPayload,
    AgentRunRunningNewState, AgentRunRunningPayload, AgentRunStartingNewState,
    AgentRunStartingPayload, AgentRunStoppedNewState, AgentRunStoppedPayload,
    AgentRunWaitingForApprovalNewState, AgentRunWaitingForApprovalPayload,
    AgentRunWaitingForInputNewState, AgentRunWaitingForInputPayload, RunStateChangeState,
};
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::events::log_service::EventAppendError;
use crate::events::session::append_lock::SessionAppendHold;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use crate::session::run::live_count::LiveRunCount;
use crate::session::run::projection::{RunStateSwap, swap_run_state_statement};
use crate::session::run::read::{RunRead, read_run_through, safe_run_version};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::transitions::{RUN_TERMINAL_EVENT_TYPES_SQL, is_transition_allowed};

/// The position of a terminal write's guard that its run version holds no terminal record yet:
/// the first statement of the write.
pub(crate) const TERMINAL_GUARD_INDEX: usize = 0;

/// The position of a terminal write's swap, after its guard.
pub(crate) const TERMINAL_SWAP_INDEX: usize = 1;

/// The position of any other change's swap: the first statement of its write.
pub(crate) const SWAP_INDEX: usize = 0;

// How many times a change is read and written before a run that keeps moving under it is refused.
const MAX_WRITE_ATTEMPTS: usize = 3;

// Reads the log inside the write by the event's own run columns, which the append set from the
// typed event, so no read outside the write decides a terminal.
static SELECT_TERMINAL_RECORD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type IN ({})
    AND run_id = @run_id
    AND run_version = @run_version
  LIMIT 1",
        EventCategory::RunLifecycle.as_str(),
        *RUN_TERMINAL_EVENT_TYPES_SQL
    )
});

// The members every state change's payload repeats beside its own.
#[derive(Clone, Copy)]
struct Transition {
    session_id: SessionId,
    run_id: RunId,
    run_version: SafeInt<0>,
    previous_state: RunState,
    failure_category: Option<RunFailureCategory>,
    recovery_condition: Option<RecoveryCondition>,
}

// One state's payload: `transition`'s members, the state's own `new_state`, then its own members,
// each a binding of the same name.
macro_rules! state_change_payload {
    ($transition:ident, $payload:ident, $new_state:ident { $($member:ident),* }) => {
        $payload {
            session_id: $transition.session_id,
            run_id: $transition.run_id,
            run_version: $transition.run_version,
            previous_state: $transition.previous_state,
            new_state: $new_state::Value,
            failure_category: $transition.failure_category,
            recovery_condition: $transition.recovery_condition,
            $($member,)*
        }
    };
}

/// The state a change enters, with what that state's event carries beyond the transition itself.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RunStateEntry {
    /// Into `starting`.
    Starting,
    /// Into `running`, stamped with the effective posture where it is final.
    Running {
        /// The effective posture, with the workspace root resolved.
        execution_posture: Option<ExecutionPosture>,
    },
    /// Into `waitingForApproval`.
    WaitingForApproval,
    /// Into `waitingForInput`.
    WaitingForInput,
    /// Into `pausing`.
    Pausing,
    /// Into `paused`.
    Paused,
    /// Into `completed`.
    Completed {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
    },
    /// Into `interrupted`.
    Interrupted {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
        /// Why the daemon itself interrupted the run; `None` for a person's interrupt.
        trigger: Option<InterruptReason>,
    },
    /// Into `stopped`.
    Stopped {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
        /// Why the daemon itself stopped the run.
        trigger: Option<StopTrigger>,
    },
    /// Into `failed`.
    Failed {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
        /// The run's typed failure cause.
        failure_cause: Option<RunFailureCause>,
        /// The provider's own words on why it failed the run.
        provider_failure_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
        /// How the provider process ended under the turn, where it ended on its own.
        process_exit: Option<ProcessExit>,
    },
}

impl RunStateEntry {
    /// The state the change enters.
    pub(crate) fn state(&self) -> RunStateChangeState {
        match self {
            Self::Starting => RunStateChangeState::Starting,
            Self::Running { .. } => RunStateChangeState::Running,
            Self::WaitingForApproval => RunStateChangeState::WaitingForApproval,
            Self::WaitingForInput => RunStateChangeState::WaitingForInput,
            Self::Pausing => RunStateChangeState::Pausing,
            Self::Paused => RunStateChangeState::Paused,
            Self::Completed { .. } => RunStateChangeState::Completed,
            Self::Interrupted { .. } => RunStateChangeState::Interrupted,
            Self::Stopped { .. } => RunStateChangeState::Stopped,
            Self::Failed { .. } => RunStateChangeState::Failed,
        }
    }
}

/// One state change asked of a run: the state it enters with what that state's event carries,
/// and the failure category and recovery condition any change may carry. With `expected_state`,
/// the change is refused unless the run is in that state when it is read.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RunStateChange {
    /// The run.
    pub(crate) run_id: RunId,
    /// The state the run must be in when it is read, where the caller decided from one.
    pub(crate) expected_state: Option<RunState>,
    /// Why the run failed.
    pub(crate) failure_category: Option<RunFailureCategory>,
    /// Why the run needs recovery.
    pub(crate) recovery_condition: Option<RecoveryCondition>,
    /// The state it enters and that state's own members.
    pub(crate) entry: RunStateEntry,
}

impl RunStateChange {
    /// A change of `run_id` into `entry`, from whatever state it is in, with no failure category
    /// or recovery condition.
    pub(crate) fn new(run_id: RunId, entry: RunStateEntry) -> Self {
        Self {
            run_id,
            expected_state: None,
            failure_category: None,
            recovery_condition: None,
            entry,
        }
    }

    // The change's stored event, from the swap it makes.
    fn into_event(self, swap: &RunStateSwap) -> SessionEvent {
        let Self {
            failure_category,
            recovery_condition,
            entry,
            ..
        } = self;
        let transition = Transition {
            session_id: swap.session_id,
            run_id: swap.run_id,
            run_version: safe_run_version(swap.run_version),
            previous_state: swap.previous_state,
            failure_category,
            recovery_condition,
        };
        match entry {
            RunStateEntry::Starting => SessionEvent::AgentRunStarting(state_change_payload!(
                transition,
                AgentRunStartingPayload,
                AgentRunStartingNewState {}
            )),
            RunStateEntry::Running { execution_posture } => {
                SessionEvent::AgentRunRunning(state_change_payload!(
                    transition,
                    AgentRunRunningPayload,
                    AgentRunRunningNewState { execution_posture }
                ))
            }
            RunStateEntry::WaitingForApproval => {
                SessionEvent::AgentRunWaitingForApproval(state_change_payload!(
                    transition,
                    AgentRunWaitingForApprovalPayload,
                    AgentRunWaitingForApprovalNewState {}
                ))
            }
            RunStateEntry::WaitingForInput => {
                SessionEvent::AgentRunWaitingForInput(state_change_payload!(
                    transition,
                    AgentRunWaitingForInputPayload,
                    AgentRunWaitingForInputNewState {}
                ))
            }
            RunStateEntry::Pausing => SessionEvent::AgentRunPausing(state_change_payload!(
                transition,
                AgentRunPausingPayload,
                AgentRunPausingNewState {}
            )),
            RunStateEntry::Paused => SessionEvent::AgentRunPaused(state_change_payload!(
                transition,
                AgentRunPausedPayload,
                AgentRunPausedNewState {}
            )),
            RunStateEntry::Completed { intended_close } => {
                SessionEvent::AgentRunCompleted(state_change_payload!(
                    transition,
                    AgentRunCompletedPayload,
                    AgentRunCompletedNewState { intended_close }
                ))
            }
            RunStateEntry::Interrupted {
                intended_close,
                trigger,
            } => SessionEvent::AgentRunInterrupted(state_change_payload!(
                transition,
                AgentRunInterruptedPayload,
                AgentRunInterruptedNewState {
                    intended_close,
                    trigger
                }
            )),
            RunStateEntry::Stopped {
                intended_close,
                trigger,
            } => SessionEvent::AgentRunStopped(state_change_payload!(
                transition,
                AgentRunStoppedPayload,
                AgentRunStoppedNewState {
                    intended_close,
                    trigger
                }
            )),
            RunStateEntry::Failed {
                intended_close,
                failure_cause,
                provider_failure_detail,
                process_exit,
            } => SessionEvent::AgentRunFailed(state_change_payload!(
                transition,
                AgentRunFailedPayload,
                AgentRunFailedNewState {
                    intended_close,
                    failure_cause,
                    provider_failure_detail,
                    process_exit
                }
            )),
        }
    }
}

/// An event drafted from the run as one attempt of a change reads it, so the run version it
/// carries is the one that attempt writes from. Fails when the event breaks a check of its type.
pub(crate) type RunEventDraft =
    Arc<dyn Fn(&RunRead) -> Result<SessionEventDraft, SessionEventDraftError> + Send + Sync>;

/// What commits with a run state change in its write: statements run after the run's swap, so one
/// that reads the run sees the version the change reached, and events appended just before the
/// change's own. A statement refusing refuses the whole write.
#[derive(Clone, Default)]
pub(crate) struct RunStateChangeCompanions {
    /// Statements run after the swap.
    pub(crate) statements: Vec<WriteStatement>,
    /// Events appended just before the change's own.
    pub(crate) preceding_events: Vec<SessionEventDraft>,
    /// An event drafted again at each attempt from the run it read, appended before every other
    /// preceding event.
    pub(crate) leading_event: Option<RunEventDraft>,
    /// The interventions whose rows `statements` move to an outcome, which a run's end leaves to
    /// them rather than settling as left with none.
    pub(crate) settled_interventions: Vec<InterventionId>,
}

/// Why a run state change was not written; nothing of it is kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunStateChangeError {
    /// The run is unknown, has ended, or is in a state the table does not let it leave for the one
    /// asked.
    #[error(transparent)]
    Refused(#[from] RunRefusal),
    /// One of the companion statements refused the write; `companion_index` is its position among
    /// them, and the write error under it names its position in the whole write.
    #[error("companion statement {companion_index} of the run state change refused its write")]
    CompanionRefused {
        /// The refusing statement's position among the companions.
        companion_index: usize,
        /// The append's refusal.
        #[source]
        source: SessionEventAppendError,
    },
    /// The change's event or a preceding one breaks a check of its type.
    #[error("the run state change's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the write for a reason other than a guard.
    #[error("the run state change was not appended")]
    Append(#[source] SessionEventAppendError),
    /// SQLite refused the run's read, or a stored column does not read as its type.
    #[error("the run's row could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool did not run the run's read.
    #[error("the read pool did not run the run's read")]
    Pool(#[from] DatabaseReadError),
}

// What one read and write of a change came to: the run as the change left it, or the refusal of a
// swap the run moved under, to retry from a fresh read.
enum AttemptOutcome {
    Written(RunRead),
    Moved(RunRefusal),
}

/// Writes run state changes; the run's row and its event move in the same write, and the count of
/// live runs moves once it has committed.
pub(crate) struct RunStateChangeWriter {
    pool: Arc<DatabaseReadPool>,
    appender: Arc<SessionEventAppender>,
    live_runs: Arc<LiveRunCount>,
}

impl RunStateChangeWriter {
    /// A writer reading runs through `pool`, appending through `appender` and moving `live_runs`.
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        appender: Arc<SessionEventAppender>,
        live_runs: Arc<LiveRunCount>,
    ) -> Self {
        Self {
            pool,
            appender,
            live_runs,
        }
    }

    /// Writes `change` from the run's current row and returns the run as it left it. A run that
    /// moved after it was read is read again and the change retried while the table still allows
    /// it and the run has not ended, up to a few times. Fails with [`RunRefusal::NotFound`] for an
    /// unknown run, [`RunRefusal::AlreadyEnded`] for a terminal of a run that has ended or whose
    /// run version already holds one, [`RunRefusal::InvalidTransition`] for a move the table does
    /// not allow from the state the run is in, and [`RunStateChangeError::CompanionRefused`] when
    /// a companion statement refuses; each refusal writes nothing. Every write goes under `hold`
    /// where the caller holds the run's session.
    pub(crate) async fn write(
        &self,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
        hold: Option<&SessionAppendHold>,
    ) -> Result<RunRead, RunStateChangeError> {
        for attempt in 1..MAX_WRITE_ATTEMPTS {
            if let AttemptOutcome::Written(run) = self
                .attempt(change.clone(), companions.clone(), attempt > 1, hold)
                .await?
            {
                return Ok(run);
            }
        }
        match self.attempt(change, companions, true, hold).await? {
            AttemptOutcome::Written(run) => Ok(run),
            AttemptOutcome::Moved(refusal) => Err(refusal.into()),
        }
    }

    // One read and one write; a swap the run moved under comes back to be retried from a fresh
    // read. A retry never starts from an ended run: re-opening one is the daemon's own decision,
    // made on a first read, never a change that lost its race to the run's end.
    async fn attempt(
        &self,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
        is_retry: bool,
        hold: Option<&SessionAppendHold>,
    ) -> Result<AttemptOutcome, RunStateChangeError> {
        let run_id = change.run_id;
        let new_state = change.entry.state();
        let Some(run) = self.read_run(run_id).await? else {
            return Err(RunRefusal::NotFound { run_id }.into());
        };
        let is_terminal = RunState::from(new_state).is_terminal();
        if change
            .expected_state
            .is_some_and(|expected| expected != run.state)
            || !is_transition_allowed(run.state, new_state)
            || (is_retry && run.state.is_terminal())
        {
            return Err(if run.state.is_terminal() && is_terminal {
                RunRefusal::AlreadyEnded {
                    run_id,
                    from_state: run.state,
                    to_state: new_state,
                    source: None,
                }
            } else {
                RunRefusal::InvalidTransition {
                    run_id,
                    from_state: run.state,
                    to_state: new_state,
                    source: None,
                }
            }
            .into());
        }

        let swap = RunStateSwap {
            session_id: run.session_id,
            run_id,
            run_version: run.version + 1,
            previous_state: run.state,
            new_state,
        };
        let RunStateChangeCompanions {
            statements,
            mut preceding_events,
            leading_event,
            settled_interventions: _,
        } = companions;
        if let Some(draft) = leading_event {
            preceding_events.insert(0, draft(&run)?);
        }
        let (swap_index, mut transactional_prelude) = if is_terminal {
            (
                TERMINAL_SWAP_INDEX,
                vec![no_terminal_record_statement(&run_id, swap.run_version)],
            )
        } else {
            (SWAP_INDEX, Vec::new())
        };
        transactional_prelude.push(swap_run_state_statement(&swap));
        let companions_in_write =
            transactional_prelude.len()..transactional_prelude.len() + statements.len();
        transactional_prelude.extend(statements);
        let draft = SessionEventDraft::of_session(run.session_id, &change.into_event(&swap))?;
        let linkage = SessionEventLinkage {
            transactional_prelude,
            preceding_events,
            ..SessionEventLinkage::default()
        };
        let appended = match hold {
            Some(hold) => self.appender.append_held(hold, draft, linkage).await,
            None => self.appender.append(draft, linkage).await,
        };
        let Err(error) = appended else {
            self.live_runs.record(swap.previous_state, new_state.into());
            return Ok(AttemptOutcome::Written(RunRead {
                version: swap.run_version,
                session_id: run.session_id,
                state: new_state.into(),
            }));
        };
        let Some(refused_index) = refused_statement_index(&error) else {
            return Err(RunStateChangeError::Append(error));
        };
        if is_terminal && refused_index == TERMINAL_GUARD_INDEX {
            return Err(RunRefusal::AlreadyEnded {
                run_id,
                from_state: run.state,
                to_state: new_state,
                source: Some(Box::new(error)),
            }
            .into());
        }
        if refused_index == swap_index {
            return Ok(AttemptOutcome::Moved(
                self.moved_run_refusal(run_id, new_state, error).await?,
            ));
        }
        // A statement past the companions is a projection's own, which refuses the write whole.
        if !companions_in_write.contains(&refused_index) {
            return Err(RunStateChangeError::Append(error));
        }
        Err(RunStateChangeError::CompanionRefused {
            companion_index: refused_index - companions_in_write.start,
            source: error,
        })
    }

    // A swap refused because the run moved after it was read: a terminal meeting an ended run is
    // refused as already ended, and any other change from the state the run moved to.
    async fn moved_run_refusal(
        &self,
        run_id: RunId,
        new_state: RunStateChangeState,
        refusal: SessionEventAppendError,
    ) -> Result<RunRefusal, RunStateChangeError> {
        let Some(now) = self.read_run(run_id).await? else {
            return Ok(RunRefusal::NotFound { run_id });
        };
        Ok(
            if RunState::from(new_state).is_terminal() && now.state.is_terminal() {
                RunRefusal::AlreadyEnded {
                    run_id,
                    from_state: now.state,
                    to_state: new_state,
                    source: Some(Box::new(refusal)),
                }
            } else {
                RunRefusal::InvalidTransition {
                    run_id,
                    from_state: now.state,
                    to_state: new_state,
                    source: Some(Box::new(refusal)),
                }
            },
        )
    }

    async fn read_run(&self, run_id: RunId) -> Result<Option<RunRead>, RunStateChangeError> {
        read_run_through(&self.pool, run_id).await
    }
}

/// The position of the statement that refused the append's write, when a guard's row count
/// refused it.
pub(crate) fn refused_statement_index(error: &SessionEventAppendError) -> Option<usize> {
    if let SessionEventAppendError::Append(EventAppendError::Write(write_error)) = error {
        write_error.refused_statement_index()
    } else {
        None
    }
}

// Refuses the write once the run version holds a terminal record.
fn no_terminal_record_statement(run_id: &RunId, run_version: i64) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_TERMINAL_RECORD_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (Cow::Borrowed("@run_version"), Value::Integer(run_version)),
        ]),
        expected_row_count: Some(0),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::id::RunId;

    use super::{TERMINAL_GUARD_INDEX, no_terminal_record_statement};
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
    use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    // Killed by spelling the guard's category other than the stored word, which lets a second
    // terminal through, or by dropping its run version condition, which refuses every version.
    #[tokio::test]
    async fn the_terminal_guard_refuses_only_at_a_version_holding_a_stored_terminal() {
        let database = TestDatabase::new();
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let completed: SessionEvent = serde_json::from_value(json!({
            "type": "agent.run.completed",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "runVersion": 3,
                "previousState": "running",
                "newState": "completed",
            },
        }))
        .expect("the test writes an agent.run.completed event");
        let envelope = test_envelope(session_id, &completed);
        let row = SessionEventRow {
            payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
            envelope: Arc::new(envelope),
            monotonic_ns: monotonic_ns_now(),
            content_payload: None,
        };
        writer
            .append_events(vec![row], Vec::new())
            .await
            .expect("the terminal row is appended");

        let at_its_version = writer
            .write(vec![no_terminal_record_statement(&run_id, 3)])
            .await;
        assert!(
            matches!(
                at_its_version,
                Err(WriteError::Refused {
                    statement_index: TERMINAL_GUARD_INDEX,
                    row_count: 1,
                })
            ),
            "a second terminal at the stored one's version is refused: {at_its_version:?}"
        );
        writer
            .write(vec![no_terminal_record_statement(&run_id, 4)])
            .await
            .expect("a version that holds no terminal passes the guard");
    }
}
