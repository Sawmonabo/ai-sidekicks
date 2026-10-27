//! The interventions on a run with no outcome yet, and the settle the run's end, or a turn of it
//! that ends without being interrupted, gives them in that same write. At the run's end a left
//! interrupt is applied when the run ended `interrupted` and expires at any other end, and a left
//! retry expires; a turn that ends any other way than interrupted shows an interrupt left
//! `accepted` did not take, so it expires. A person's interrupt the settle reaches lets go the run
//! queue's hold with their choice for the waiting messages when it applied, and with the messages
//! left waiting when it expired.

use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::run::events::InterventionDeviceActor;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, InterventionState, InterventionType,
    PersonInterruptRecord,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

use crate::interventions::interrupt_queue::InterruptChoice;
use crate::interventions::service::InterventionTarget;
use crate::interventions::service::reached_state::{ReachedState, draft};
use crate::interventions::store::{
    InterventionTransition, UnresolvedInterventionState, move_intervention_statement, stored_actor,
    unresolved_state_of,
};
use crate::run::read::{SessionRun, session_run_of_row};
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_store::database::session_scope::SessionScopedSql;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventDraftError};

// The run's interventions with no outcome yet, with its session, oldest first.
static SELECT_UNRESOLVED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT interventions.id, interventions.type, interventions.state,
       interventions.device_id, interventions.payload, runs.session_id
  FROM interventions JOIN runs ON runs.run_id = interventions.target_run_id
  WHERE interventions.target_run_id = @run_id
    AND interventions.state IN ('{}', '{}')
  ORDER BY interventions.created_at, interventions.id",
        <&'static str>::from(InterventionState::Requested),
        <&'static str>::from(InterventionState::Accepted)
    )
});

// Every ended run that still holds an intervention with no outcome.
static SELECT_ENDED_RUNS_WITH_UNRESOLVED_SQL: LazyLock<SessionScopedSql> = LazyLock::new(|| {
    SessionScopedSql::new("runs.session_id", |session_condition| {
        format!(
            "SELECT DISTINCT runs.run_id, runs.session_id
  FROM interventions JOIN runs ON runs.run_id = interventions.target_run_id
  WHERE interventions.state IN ('{}', '{}')
    AND runs.state IN ({})
    {session_condition}",
            <&'static str>::from(InterventionState::Requested),
            <&'static str>::from(InterventionState::Accepted),
            *RUN_TERMINAL_STATES_SQL
        )
    })
});

/// An intervention on a run with no outcome yet, as its row records it.
#[derive(Clone, Debug)]
pub(crate) struct UnresolvedIntervention {
    /// What the intervention's events name.
    target: InterventionTarget,
    /// Where it stands.
    state: UnresolvedInterventionState,
    /// A person's choice for the waiting messages, on a person's interrupt alone.
    choice: Option<InterruptChoice>,
}

/// When the settle runs: at the run's end, in the state it ended in, or at the end of one of its
/// turns that the provider reported as anything but interrupted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnresolvedSettleMoment {
    /// The run ended in this state.
    RunEnded(RunState),
    /// A turn of the live run ended, and not interrupted.
    TurnEndedUninterrupted,
}

/// What settles the unresolved interventions in the write of a run's end or a turn's end: each
/// row's move, guarded on the state it was read in, its event, and the choice each person's
/// interrupt it settles lets go the run queue's hold with once the write lands.
#[derive(Default)]
pub(crate) struct UnresolvedSettle {
    /// The rows' moves.
    pub(crate) statements: Vec<WriteStatement>,
    /// Their events, in the rows' order.
    pub(crate) events: Vec<SessionEventDraft>,
    /// Each settled person's interrupt, with the choice it lets go the queue's hold with.
    pub(crate) released_choices: Vec<(InterventionId, InterruptChoice)>,
}

/// Every intervention on `run_id` with no outcome yet, read on `reader`, oldest first. Fails when
/// the read fails or a stored column does not read as its type, an interrupt's record among them.
pub(crate) fn read_unresolved_interventions(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Vec<UnresolvedIntervention>> {
    reader
        .prepare_cached(&SELECT_UNRESOLVED_SQL)?
        .query_map(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            let intervention_type: InterventionType = text_column(row, 1, closed_word)?;
            let choice = match intervention_type {
                InterventionType::Interrupt => text_column(row, 4, |text| {
                    serde_json::from_str::<InterruptInterventionRecord>(&text)
                })
                .map(|record| choice_of(&record))?,
                InterventionType::FasterModelRetry => None,
            };
            Ok(UnresolvedIntervention {
                target: InterventionTarget {
                    session_id: text_column(row, 5, |text| SessionId::new(&text))?,
                    intervention_id: text_column(row, 0, |text| InterventionId::new(&text))?,
                    target_run_id: *run_id,
                    intervention_type,
                    actor: stored_actor(optional_text_column(
                        row,
                        3,
                        closed_word::<InterventionDeviceActor>,
                    )?),
                },
                state: text_column(row, 2, unresolved_state_of)?,
                choice,
            })
        })?
        .collect()
}

/// Every ended run of `session_id`, or of every session when it is `None`, that still holds an
/// intervention with no outcome, read on `reader`: what a daemon that went down between a run's
/// end and its settle left. Fails when the read fails or a stored id is not one.
pub(crate) fn read_ended_runs_with_unresolved(
    reader: &Connection,
    session_id: Option<&SessionId>,
) -> rusqlite::Result<Vec<SessionRun>> {
    SELECT_ENDED_RUNS_WITH_UNRESOLVED_SQL.query(reader, session_id, session_run_of_row)
}

/// The settle `moment` gives `unresolved`, less each row `settled_by_writer` names, which the
/// write's own statements move. Fails when an event breaks a check of its type.
pub(crate) fn settle_unresolved(
    unresolved: &[UnresolvedIntervention],
    moment: UnresolvedSettleMoment,
    settled_by_writer: &[InterventionId],
) -> Result<UnresolvedSettle, SessionEventDraftError> {
    let mut settle = UnresolvedSettle::default();
    for row in unresolved {
        if settled_by_writer.contains(&row.target.intervention_id) {
            continue;
        }
        let from = row.state;
        // A turn's end tells nothing of an interrupt not yet sent.
        if moment == UnresolvedSettleMoment::TurnEndedUninterrupted
            && from == UnresolvedInterventionState::Requested
        {
            continue;
        }
        let is_applied = match (moment, row.target.intervention_type) {
            (UnresolvedSettleMoment::RunEnded(end), InterventionType::Interrupt) => {
                end == RunState::Interrupted
            }
            (UnresolvedSettleMoment::RunEnded(_), InterventionType::FasterModelRetry)
            | (UnresolvedSettleMoment::TurnEndedUninterrupted, InterventionType::Interrupt) => {
                false
            }
            // A turn's end tells nothing of a retry.
            (
                UnresolvedSettleMoment::TurnEndedUninterrupted,
                InterventionType::FasterModelRetry,
            ) => continue,
        };
        let (transition, state) = if is_applied {
            (
                InterventionTransition::Apply { from },
                ReachedState::Applied,
            )
        } else {
            (
                InterventionTransition::Expire { from },
                ReachedState::Expired,
            )
        };
        settle.statements.push(move_intervention_statement(
            &row.target.intervention_id,
            &transition,
        ));
        settle.events.push(draft(&row.target, &state)?);
        if let Some(choice) = row.choice {
            let released = if is_applied {
                choice
            } else {
                InterruptChoice {
                    pending: InterruptPendingChoice::KeepWaiting,
                    deliver_first: None,
                }
            };
            settle
                .released_choices
                .push((row.target.intervention_id, released));
        }
    }
    Ok(settle)
}

// A person's choice for the waiting messages as their interrupt's record stores it; `None` for
// the daemon's own at a limit, which holds no queue.
fn choice_of(record: &InterruptInterventionRecord) -> Option<InterruptChoice> {
    match record {
        InterruptInterventionRecord::Person(PersonInterruptRecord::NextTurn {
            deliver_first,
            ..
        }) => Some(InterruptChoice {
            pending: InterruptPendingChoice::NextTurn,
            deliver_first: *deliver_first,
        }),
        InterruptInterventionRecord::Person(PersonInterruptRecord::ReturnToDraft { .. }) => {
            Some(InterruptChoice {
                pending: InterruptPendingChoice::ReturnToDraft,
                deliver_first: None,
            })
        }
        InterruptInterventionRecord::Limit(_) => None,
    }
}
