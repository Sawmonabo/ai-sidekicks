//! One run state change, written whole: the check against the table, the event, the row's swap
//! and, for a terminal, the guard that the run version holds no terminal record yet, all in one
//! write so they commit together or not at all. An undo's rollback of the conversation is written
//! the same way across every run the cut reaches, in one write: each run's version advanced with no
//! state swapped, refused while the run holds a turn with no end.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::{EventCategory, SourcePosition};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{AgentRunRolledBackEvent, RunFailureCategory};
use sidekicks_contracts::run::events::{
    AgentRunCompletedNewState, AgentRunCompletedPayload, AgentRunFailedNewState,
    AgentRunFailedPayload, AgentRunInterruptedNewState, AgentRunInterruptedPayload,
    AgentRunPausedNewState, AgentRunPausedPayload, AgentRunPausingNewState, AgentRunPausingPayload,
    AgentRunRunningNewState, AgentRunRunningPayload, AgentRunStartingNewState,
    AgentRunStartingPayload, AgentRunStoppedNewState, AgentRunStoppedPayload,
    AgentRunWaitingForApprovalNewState, AgentRunWaitingForApprovalPayload,
    AgentRunWaitingForInputNewState, AgentRunWaitingForInputPayload, RunStateChangeState,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::state_entry::{RunStateEntry, RunStateReport};
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};

use crate::run::engine::turns::guards::open_turns_sql;
use crate::run::engine::undo::RunCut;
use crate::run::projection::{
    RunStateSwap, rolled_back_run_version_statement, swap_run_state_statement,
};
use crate::run::provider_choice::ChoiceDialog;
use crate::run::read::{RunRead, read_run_through, safe_run_version};
use crate::run::refusals::RunRefusal;
use crate::run::transitions::{RUN_TERMINAL_EVENT_TYPES_SQL, is_transition_allowed};

/// The position of a terminal write's guard that its run version holds no terminal record yet:
/// the first statement of the write.
pub(crate) const TERMINAL_GUARD_INDEX: usize = 0;

// How many times a change is read and written before a run that keeps moving under it is refused.
const MAX_WRITE_ATTEMPTS: usize = 3;

// Finds a turn of the run that started and holds no end, inside the write, so no rollback lands
// between a turn's start and its end.
static SELECT_OPEN_TURN_SQL: LazyLock<String> =
    LazyLock::new(|| open_turns_sql("@run_id", "LIMIT 1"));

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

/// One state change asked of a run: the state it enters with what that state's event carries,
/// and the failure category and recovery condition any change may carry. With `expected_state`,
/// the change is refused unless the run is in that state when it is read.
#[derive(Clone, Debug, PartialEq)]
pub struct RunStateChange {
    /// The run.
    pub run_id: RunId,
    /// The state the run must be in when it is read, where the caller decided from one.
    pub expected_state: Option<RunState>,
    /// Why the run failed.
    pub failure_category: Option<RunFailureCategory>,
    /// Why the run needs recovery.
    pub recovery_condition: Option<RecoveryCondition>,
    /// The state it enters and that state's own members.
    pub entry: RunStateEntry,
}

impl RunStateChange {
    /// A change of `run_id` into `entry`, from whatever state it is in, with no failure category
    /// or recovery condition.
    pub fn new(run_id: RunId, entry: RunStateEntry) -> Self {
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

impl From<RunStateReport> for RunStateChange {
    /// The change a driver reported, with no recovery condition.
    fn from(report: RunStateReport) -> Self {
        let RunStateReport {
            run_id,
            expected_state,
            failure_category,
            entry,
        } = report;
        Self {
            run_id,
            expected_state,
            failure_category,
            recovery_condition: None,
            entry,
        }
    }
}

/// An event drafted from the run as one attempt of a change reads it, so the run version it
/// carries is the one that attempt writes from. Fails when the event breaks a check of its type.
pub(crate) type RunEventDraft =
    Arc<dyn Fn(&RunRead) -> Result<SessionEventDraft, SessionEventDraftError> + Send + Sync>;

/// What commits with a run write, a state change or a rollback, in its write: statements run after
/// the run's row moves, so one that reads the run sees the version the write reached, and events
/// appended just before the write's own. A statement refusing refuses the whole write.
#[derive(Clone, Default)]
pub struct RunWriteCompanions {
    /// Statements run after the swap.
    pub statements: Vec<WriteStatement>,
    /// Events appended just before the change's own.
    pub preceding_events: Vec<SessionEventDraft>,
    /// An event drafted again at each attempt from the run it read, appended before every other
    /// preceding event.
    pub(crate) leading_event: Option<RunEventDraft>,
    /// The interventions whose rows `statements` move to an outcome, which a run's end leaves to
    /// them rather than settling as left with none.
    pub settled_interventions: Vec<InterventionId>,
    /// The choices whose settlements `preceding_events` carry, which a run's end leaves to them
    /// rather than settling as left with no answer.
    pub(crate) settled_choices: Vec<ChoiceDialog>,
}

/// Why a run write, a state change or a rollback, was not written; nothing of it is kept. Its large
/// failures are boxed so the engine's error that carries it stays small.
#[derive(Debug, thiserror::Error)]
pub enum RunWriteError {
    /// The run is unknown, has ended, or is in a state the table does not let it leave for the one
    /// asked.
    #[error(transparent)]
    Refused(#[from] RunRefusal),
    /// One of the companion statements refused the write; `companion_index` is its position among
    /// them, and the write error under it names its position in the whole write.
    #[error("companion statement {companion_index} of the run write refused it")]
    CompanionRefused {
        /// The refusing statement's position among the companions.
        companion_index: usize,
        /// The append's refusal.
        #[source]
        source: Box<SessionEventAppendError>,
    },
    /// The change's event or a preceding one breaks a check of its type.
    #[error("the run write's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// A rollback refused because a run it cuts holds a turn with no end, which must end before
    /// the run's conversation is cut.
    #[error("run {run_id} holds a turn with no end, so its conversation is not cut")]
    TurnOpen {
        /// The run whose turn is open.
        run_id: RunId,
        /// The guard's refusal.
        #[source]
        source: Box<SessionEventAppendError>,
    },
    /// The event log did not keep the write for a reason other than a guard.
    #[error("the run write was not appended")]
    Append(#[source] Box<SessionEventAppendError>),
    /// SQLite refused the run's read, or a stored column does not read as its type.
    #[error("the run's row could not be read")]
    Database(#[source] Box<rusqlite::Error>),
    /// The read pool did not run the run's read.
    #[error("the read pool did not run the run's read")]
    Pool(#[source] Box<DatabaseReadError>),
}

impl From<rusqlite::Error> for RunWriteError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(Box::new(error))
    }
}

impl From<DatabaseReadError> for RunWriteError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Pool(Box::new(error))
    }
}

// One write: a state change of a run, or the forward rollback of the conversation to a cut the
// provider confirmed, across every run the cut reaches, oldest first, each advancing its run's
// version and moving it through no state.
#[derive(Clone, Debug, PartialEq)]
enum RunWrite {
    Transition(RunStateChange),
    Rollback { cuts: Vec<RunCut> },
}

impl RunWrite {
    // The run the write leads with, which a companion's leading event is drafted from.
    fn run_id(&self) -> RunId {
        match self {
            Self::Transition(change) => change.run_id,
            Self::Rollback { cuts } => cuts[0].run_id,
        }
    }
}

// The guards on the runs' rows a write leads with, which decide how a refusal reads: a swap into
// `new_state` at `index`, behind the terminal guard where that state ends the run, or for each run
// a rollback cuts, at `2 * i` the guard that it holds no open turn and at `2 * i + 1` the advance
// of the version the attempt read, the state left as it is.
enum RowGuard {
    Swap {
        new_state: RunStateChangeState,
        index: usize,
    },
    Advances {
        read_versions: Vec<(RunId, i64)>,
    },
}

// What one read and write came to: each run as the write left it, in the write's order, or the
// refusal of a guard a run moved under, to retry from fresh reads.
enum AttemptOutcome {
    Written(Vec<RunRead>),
    Moved(RunRefusal),
}

/// Writes run state changes and rollbacks; the run's row and its event move in the same write.
pub(crate) struct RunWriter {
    pool: Arc<DatabaseReadPool>,
    appender: Arc<SessionEventAppender>,
}

impl RunWriter {
    /// A writer reading runs through `pool` and appending through `appender`.
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, appender: Arc<SessionEventAppender>) -> Self {
        Self { pool, appender }
    }

    /// Writes `change` from the run's current row and returns the run as it left it. A run that
    /// moved after it was read is read again and the change retried while the table still allows
    /// it and the run has not ended, up to a few times. Fails with [`RunRefusal::NotFound`] for an
    /// unknown run, [`RunRefusal::AlreadyEnded`] for a terminal of a run that has ended or whose
    /// run version already holds one, [`RunRefusal::InvalidTransition`] for a move the table does
    /// not allow from the state the run is in, and [`RunWriteError::CompanionRefused`] when a
    /// companion statement refuses; each refusal writes nothing. Every write goes under `hold`
    /// where the caller holds the run's session.
    pub(crate) async fn write(
        &self,
        change: RunStateChange,
        companions: RunWriteCompanions,
        hold: Option<&SessionAppendHold>,
    ) -> Result<RunRead, RunWriteError> {
        let mut written = self
            .write_retrying(RunWrite::Transition(change), companions, hold)
            .await?;
        Ok(written.pop().expect("a state change writes its one run"))
    }

    /// Writes the rollback of each of `cuts`, oldest run first, from the runs' current rows in one
    /// write under `hold`, the session's append lock, and returns each run as it left it, in the
    /// same order; a run that moved after it was read is read again and the write retried, up to
    /// a few times. `cuts` holds at least one cut. Fails with [`RunRefusal::NotFound`] for an
    /// unknown run, [`RunRefusal::VersionStale`] for a run that kept moving,
    /// [`RunWriteError::TurnOpen`] for a run holding a turn with no end, and
    /// [`RunWriteError::CompanionRefused`] when a companion statement refuses; each refusal
    /// writes nothing.
    pub(crate) async fn roll_back(
        &self,
        cuts: Vec<RunCut>,
        companions: RunWriteCompanions,
        hold: &SessionAppendHold,
    ) -> Result<Vec<RunRead>, RunWriteError> {
        self.write_retrying(RunWrite::Rollback { cuts }, companions, Some(hold))
            .await
    }

    // Writes `write`, reading again and retrying while a guard finds a run moved, up to a few
    // times.
    async fn write_retrying(
        &self,
        write: RunWrite,
        companions: RunWriteCompanions,
        hold: Option<&SessionAppendHold>,
    ) -> Result<Vec<RunRead>, RunWriteError> {
        for attempt in 1..MAX_WRITE_ATTEMPTS {
            if let AttemptOutcome::Written(runs) = self
                .attempt(write.clone(), companions.clone(), attempt > 1, hold)
                .await?
            {
                return Ok(runs);
            }
        }
        match self.attempt(write, companions, true, hold).await? {
            AttemptOutcome::Written(runs) => Ok(runs),
            AttemptOutcome::Moved(refusal) => Err(refusal.into()),
        }
    }

    // One read and one write; a guard a run moved under comes back to be retried from fresh
    // reads. A change's retry never starts from an ended run: re-opening one is the daemon's own
    // decision, made on a first read, never a change that lost its race to the run's end.
    async fn attempt(
        &self,
        write: RunWrite,
        companions: RunWriteCompanions,
        is_retry: bool,
        hold: Option<&SessionAppendHold>,
    ) -> Result<AttemptOutcome, RunWriteError> {
        let run_id = write.run_id();
        let Some(run) = self.read_run(run_id).await? else {
            return Err(RunRefusal::NotFound { run_id }.into());
        };
        let (guard, mut transactional_prelude, mut events, written) = match write {
            RunWrite::Transition(change) => {
                let new_state = change.entry.state();
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
                let mut prelude = if is_terminal {
                    vec![no_terminal_record_statement(&run_id, swap.run_version)]
                } else {
                    Vec::new()
                };
                prelude.push(swap_run_state_statement(&swap));
                let written = RunRead {
                    version: swap.run_version,
                    session_id: run.session_id,
                    state: new_state.into(),
                };
                let event = change.into_event(&swap);
                // The swap is the last statement before the companions'.
                let guard = RowGuard::Swap {
                    new_state,
                    index: prelude.len() - 1,
                };
                (guard, prelude, vec![event], vec![written])
            }
            RunWrite::Rollback { cuts } => {
                let mut prelude = Vec::with_capacity(cuts.len() * 2);
                let mut events = Vec::with_capacity(cuts.len());
                let mut written = Vec::with_capacity(cuts.len());
                let mut read_versions = Vec::with_capacity(cuts.len());
                for cut in cuts {
                    let read = if cut.run_id == run_id {
                        run.clone()
                    } else {
                        self.read_run(cut.run_id)
                            .await?
                            .ok_or(RunRefusal::NotFound { run_id: cut.run_id })?
                    };
                    let rolled_back = RunRead {
                        version: read.version + 1,
                        ..read.clone()
                    };
                    let rollback = rolled_back_event(cut.run_id, &rolled_back, cut.target_position);
                    prelude.push(no_open_turn_statement(&cut.run_id));
                    prelude.push(rolled_back_run_version_statement(&rollback));
                    events.push(SessionEvent::AgentRunRolledBack(rollback));
                    read_versions.push((cut.run_id, read.version));
                    written.push(rolled_back);
                }
                (
                    RowGuard::Advances { read_versions },
                    prelude,
                    events,
                    written,
                )
            }
        };
        let RunWriteCompanions {
            statements,
            mut preceding_events,
            leading_event,
            settled_interventions: _,
            settled_choices: _,
        } = companions;
        if let Some(draft) = leading_event {
            preceding_events.insert(0, draft(&run)?);
        }
        let companions_in_write =
            transactional_prelude.len()..transactional_prelude.len() + statements.len();
        transactional_prelude.extend(statements);
        // The write's own events follow the companions', the last of them the appended one.
        let event = events
            .pop()
            .expect("every write records at least one event of its own");
        for leading in &events {
            preceding_events.push(SessionEventDraft::of_session(run.session_id, leading)?);
        }
        let draft = SessionEventDraft::of_session(run.session_id, &event)?;
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
            return Ok(AttemptOutcome::Written(written));
        };
        let Some(refused_index) = error.refused_statement_index() else {
            return Err(RunWriteError::Append(Box::new(error)));
        };
        match guard {
            RowGuard::Swap { new_state, index } => {
                if RunState::from(new_state).is_terminal() && refused_index == TERMINAL_GUARD_INDEX
                {
                    return Err(RunRefusal::AlreadyEnded {
                        run_id,
                        from_state: run.state,
                        to_state: new_state,
                        source: Some(Box::new(error)),
                    }
                    .into());
                }
                if refused_index == index {
                    return Ok(AttemptOutcome::Moved(
                        self.moved_run_refusal(run_id, new_state, error).await?,
                    ));
                }
            }
            RowGuard::Advances { read_versions } => {
                if let Some(&(cut_run_id, read_version)) = read_versions.get(refused_index / 2) {
                    if refused_index % 2 == 0 {
                        return Err(RunWriteError::TurnOpen {
                            run_id: cut_run_id,
                            source: Box::new(error),
                        });
                    }
                    return Ok(AttemptOutcome::Moved(
                        self.moved_version_refusal(cut_run_id, read_version, error)
                            .await?,
                    ));
                }
            }
        }
        // A statement past the companions is a projection's own, which refuses the write whole.
        if !companions_in_write.contains(&refused_index) {
            return Err(RunWriteError::Append(Box::new(error)));
        }
        Err(RunWriteError::CompanionRefused {
            companion_index: refused_index - companions_in_write.start,
            source: Box::new(error),
        })
    }

    // A swap refused because the run moved after it was read: a terminal meeting an ended run is
    // refused as already ended, and any other change from the state the run moved to.
    async fn moved_run_refusal(
        &self,
        run_id: RunId,
        new_state: RunStateChangeState,
        refusal: SessionEventAppendError,
    ) -> Result<RunRefusal, RunWriteError> {
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

    // An advance refused because the run's version moved past `read_version` after it was read.
    async fn moved_version_refusal(
        &self,
        run_id: RunId,
        read_version: i64,
        refusal: SessionEventAppendError,
    ) -> Result<RunRefusal, RunWriteError> {
        let Some(now) = self.read_run(run_id).await? else {
            return Ok(RunRefusal::NotFound { run_id });
        };
        Ok(RunRefusal::VersionStale {
            run_id,
            expected_run_version: safe_run_version(read_version).get(),
            run_version: now.version,
            source: Some(Box::new(refusal)),
        })
    }

    async fn read_run(&self, run_id: RunId) -> Result<Option<RunRead>, RunWriteError> {
        read_run_through(&self.pool, run_id).await
    }
}

/// The `agent.run.rolledBack` a rollback of `run_id` landing at `target_position` writes, `written`
/// being the run as the rollback leaves it.
pub(crate) fn rolled_back_event(
    run_id: RunId,
    written: &RunRead,
    target_position: SourcePosition,
) -> AgentRunRolledBackEvent {
    AgentRunRolledBackEvent {
        session_id: written.session_id,
        run_id,
        run_version: safe_run_version(written.version),
        target_position,
    }
}

// Refuses the write while `run_id` holds a turn that started and has no end.
fn no_open_turn_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_OPEN_TURN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(0),
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
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_envelope, test_session_id,
    };
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
    use sidekicks_store::events::session::insert::{SessionEventRow, monotonic_ns_now};

    use super::{TERMINAL_GUARD_INDEX, no_terminal_record_statement};
    use crate::questions::schema::schema_parts;

    // Killed by spelling the guard's category other than the stored word, which lets a second
    // terminal through, or by dropping its run version condition, which refuses every version.
    #[tokio::test]
    async fn the_terminal_guard_refuses_only_at_a_version_holding_a_stored_terminal() {
        let database = TestDatabase::new(schema_parts());
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
