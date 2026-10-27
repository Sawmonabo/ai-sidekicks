//! The `runs` row each run event writes in its own write, so the row always equals a rebuild from
//! the log and every later write can guard against it; the rebuild folds the log through the same
//! statements. A range the session skipped past as damaged still moves each live run's version past
//! every version the range stored, so no later change reuses one.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionType;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::run_facts::{RUN_STATE_EVENT_TYPES, RunStateEventType};

use crate::run::transitions::RUN_TERMINAL_STATES_SQL;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::skipped_ranges::DAMAGED_EVENTS_SKIPPED_TYPE;

/// One run state change as its stored event carries it: the state it leaves, the state it enters,
/// and the run version after the change advanced it by one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunStateSwap {
    /// The session the run belongs to.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The run version the change reaches.
    pub(crate) run_version: i64,
    /// The state the change leaves.
    pub(crate) previous_state: RunState,
    /// The state the change enters.
    pub(crate) new_state: RunStateChangeState,
}

const INSERT_QUEUED_RUN_SQL: &str = "INSERT INTO runs
    (run_id, session_id, parent_run_id, reached_by, is_apart, state, run_version)
  VALUES (@run_id, @session_id, @parent_run_id, @reached_by, @is_apart, @state, @run_version)";

// Matches only a row still in the state the change leaves, one version behind it.
const SWAP_RUN_STATE_SQL: &str = "UPDATE runs
    SET state = @new_state,
        run_version = @run_version
  WHERE run_id = @run_id
    AND session_id = @session_id
    AND state = @previous_state
    AND run_version = @run_version - 1";

// An ended run keeps its version: nothing moves a run past its end event.
static ADVANCE_RUN_VERSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE runs
    SET run_version = run_version
      + CASE WHEN state IN ({}) THEN 0 ELSE 1 END
  WHERE run_id = @run_id
    AND session_id = @session_id",
        *RUN_TERMINAL_STATES_SQL
    )
});

// Each live run of the session moves to the highest run version any row of the skipped range
// stored for it, if that is past its own. The run and its version are read from the row's own
// columns, which the append set from the typed event, so a damaged payload is never parsed.
static ADVANCE_PAST_SKIPPED_VERSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE runs
    SET run_version = MAX(run_version, COALESCE((
      SELECT MAX(run_version) FROM session_events
       WHERE session_id = @session_id
         AND run_id = runs.run_id
         AND sequence BETWEEN @from_sequence AND @to_sequence), run_version))
  WHERE session_id = @session_id
    AND state NOT IN ({})",
        *RUN_TERMINAL_STATES_SQL
    )
});

const DELETE_SESSION_RUNS_SQL: &str = "DELETE FROM runs WHERE session_id = ?";

// Every type the runs fold reads: a run's creation, a skipped range, an intervention's verdict and
// each state change.
static RUNS_EVENT_TYPES: LazyLock<Vec<SessionEventType>> = LazyLock::new(|| {
    [
        SessionEventType::AgentRunQueued,
        DAMAGED_EVENTS_SKIPPED_TYPE,
        SessionEventType::AgentInterventionApplied,
        SessionEventType::AgentInterventionDegraded,
    ]
    .into_iter()
    .chain(
        RUN_STATE_EVENT_TYPES
            .iter()
            .filter(|event_type| **event_type != RunStateEventType::Queued)
            .map(|event_type| event_type.session_event_type()),
    )
    .collect()
});

/// The statement that creates a run's row from its `agent.run.queued` payload.
pub(crate) fn insert_queued_run_statement(payload: &AgentRunQueuedPayload) -> WriteStatement {
    let (session_id, run_id, run_version, parent_run_id, reached_by, is_apart) = match payload {
        AgentRunQueuedPayload::SessionAgent(queued) => (
            &queued.session_id,
            &queued.run_id,
            queued.run_version,
            queued.parent_run_id.as_ref(),
            queued.reached_by,
            queued.is_apart.is_some(),
        ),
        AgentRunQueuedPayload::ResolvedAgent(queued) => (
            &queued.session_id,
            &queued.run_id,
            queued.run_version,
            queued.parent_run_id.as_ref(),
            queued.reached_by,
            queued.is_apart.is_some(),
        ),
    };
    WriteStatement {
        sql: Cow::Borrowed(INSERT_QUEUED_RUN_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@session_id", session_id.text().as_str()),
            (
                Cow::Borrowed("@parent_run_id"),
                Value::from(parent_run_id.map(|parent| parent.text().as_str().to_owned())),
            ),
            (
                Cow::Borrowed("@reached_by"),
                Value::from(
                    reached_by.map(|provenance| <&'static str>::from(provenance).to_owned()),
                ),
            ),
            (
                Cow::Borrowed("@is_apart"),
                Value::Integer(i64::from(is_apart)),
            ),
            text_binding("@state", RunState::Queued.into()),
            (
                Cow::Borrowed("@run_version"),
                Value::Integer(i64::from(run_version)),
            ),
        ]),
        expected_row_count: None,
    }
}

/// The statement that moves a run from `previous_state` to `new_state` at `run_version`. It
/// refuses the write unless the row is in `previous_state` at `run_version - 1`, so of two changes
/// decided from the same read only the first commits.
pub(crate) fn swap_run_state_statement(swap: &RunStateSwap) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SWAP_RUN_STATE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", swap.run_id.text().as_str()),
            text_binding("@session_id", swap.session_id.text().as_str()),
            text_binding("@previous_state", swap.previous_state.into()),
            text_binding("@new_state", RunState::from(swap.new_state).into()),
            (
                Cow::Borrowed("@run_version"),
                Value::Integer(swap.run_version),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that advances a live run's version by one from its current value with no state
/// change, as a dispatched intervention's verdict does, and leaves an ended run's as it is. It
/// holds no stale comparand, because no earlier read decides it; it refuses the write only when the
/// run is not under `session_id`.
pub(crate) fn advance_run_version_statement(
    session_id: &SessionId,
    run_id: &RunId,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(ADVANCE_RUN_VERSION_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@session_id", session_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

// The swap a stored state change writes, read from its payload; `None` for any other event.
macro_rules! state_change_swap {
    ($event:expr, $($variant:ident => $state:ident,)+) => {{
        let event: &SessionEvent = $event;
        $(
            if let SessionEvent::$variant(change) = event {
                return Some(RunStateSwap {
                    session_id: change.session_id,
                    run_id: change.run_id,
                    run_version: i64::from(change.run_version),
                    previous_state: change.previous_state,
                    new_state: RunStateChangeState::$state,
                });
            }
        )+
        None
    }};
}

fn state_change_swap_of(event: &SessionEvent) -> Option<RunStateSwap> {
    state_change_swap!(
        event,
        AgentRunStarting => Starting,
        AgentRunRunning => Running,
        AgentRunWaitingForApproval => WaitingForApproval,
        AgentRunWaitingForInput => WaitingForInput,
        AgentRunPausing => Pausing,
        AgentRunPaused => Paused,
        AgentRunCompleted => Completed,
        AgentRunInterrupted => Interrupted,
        AgentRunStopped => Stopped,
        AgentRunFailed => Failed,
    )
}

/// The `runs` rows as a rebuild replaces them: one per run, at its last state and version.
pub(crate) struct RunsProjection;

impl SessionProjection for RunsProjection {
    fn name(&self) -> &'static str {
        "runs"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &RUNS_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed(DELETE_SESSION_RUNS_SQL),
            bindings: StatementBindings::Positional(vec![Value::Text(
                session_id.text().as_str().to_owned(),
            )]),
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(RunsFold {
            terminal_event_ids: HashMap::new(),
        })
    }
}

// Each terminal event already folded, by its run and run version, with its envelope id.
struct RunsFold {
    terminal_event_ids: HashMap<(RunId, i64), String>,
}

impl SessionProjectionFold for RunsFold {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        if let SessionEvent::AgentRunQueued(payload) = event {
            statements.push(insert_queued_run_statement(payload));
            return Ok(());
        }
        if let SessionEvent::SessionDamagedEventsSkipped(skipped) = event {
            statements.push(WriteStatement {
                sql: Cow::Borrowed(ADVANCE_PAST_SKIPPED_VERSIONS_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@session_id", skipped.session_id.text().as_str()),
                    (
                        Cow::Borrowed("@from_sequence"),
                        Value::Integer(i64::from(skipped.from_sequence)),
                    ),
                    (
                        Cow::Borrowed("@to_sequence"),
                        Value::Integer(i64::from(skipped.to_sequence)),
                    ),
                ]),
                expected_row_count: None,
            });
            return Ok(());
        }
        // An interrupt's verdict ends its run in the same write, which the run's own end event
        // moves, or finds the run already ended; neither advances the version.
        let verdict = if let SessionEvent::AgentInterventionApplied(applied) = event {
            Some((
                applied.intervention_type,
                &applied.session_id,
                &applied.target_run_id,
            ))
        } else if let SessionEvent::AgentInterventionDegraded(degraded) = event {
            Some((
                degraded.intervention_type,
                &degraded.session_id,
                &degraded.target_run_id,
            ))
        } else {
            None
        };
        if let Some((intervention_type, session_id, run_id)) = verdict {
            match intervention_type {
                InterventionType::Interrupt => {}
                InterventionType::FasterModelRetry => {
                    statements.push(advance_run_version_statement(session_id, run_id));
                }
            }
            return Ok(());
        }
        let Some(swap) = state_change_swap_of(event) else {
            return Ok(());
        };
        if RunState::from(swap.new_state).is_terminal() {
            match self
                .terminal_event_ids
                .entry((swap.run_id, swap.run_version))
            {
                // The same terminal seen again changes nothing.
                Entry::Occupied(folded) if folded.get() == envelope.id.as_str() => return Ok(()),
                // A different one contradicts the first.
                Entry::Occupied(folded) => {
                    return Err(ProjectionContradiction(format!(
                        "Run {} has two terminal events at run version {}: {} and {}",
                        swap.run_id,
                        swap.run_version,
                        folded.get(),
                        envelope.id.as_str()
                    )));
                }
                Entry::Vacant(vacant) => {
                    vacant.insert(envelope.id.as_str().to_owned());
                }
            }
        }
        statements.push(swap_run_state_statement(&swap));
        Ok(())
    }
}
