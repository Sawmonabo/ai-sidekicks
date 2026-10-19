//! How a run a restart left live ends when recovery cannot resume it: interrupted when the person
//! had asked to stop it or it was a child held when the daemon went down, interrupted or stopped
//! with its limit when its log still owes one, left alone when it is queued behind a message
//! still waiting to start it, failed otherwise. A run with open turns ends them as the daemon's
//! own report, the turns a limit cut with the limit's cause, the newest in the run's own write.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Type;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::{
    AgentInterventionAppliedPayload, AgentInterventionAppliedState, DaemonInterventionActor,
    InterventionActor, InterventionDeviceActor, TurnEndCause,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, InterventionState, InterventionType, RunLimit,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use crate::events::session::appender::{SessionEventDraft, SessionEventDraftError};
use crate::interventions::store::{
    InterventionResolvedError, InterventionTransition, UnresolvedInterventionState,
    move_intervention_statement,
};
use crate::queue::store::{QueueItemReader, SELECT_WAITING_FOR_RUN_SQL};
use crate::session::run::engine::turns::TURN_END_TYPES_SQL;
use crate::session::run::read::LiveRun;
use crate::session::run::state_change::RunStateChangeCompanions;

// An interrupt that has no outcome yet, the person's or the daemon's own at a limit. An applied one
// ends its run in the outcome's own write, so a live run never holds one.
static SELECT_PENDING_INTERRUPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, state, device_id, payload FROM interventions
  WHERE target_run_id = @run_id
    AND type = '{}'
    AND state IN ('{}', '{}')
  LIMIT 1",
        <&'static str>::from(InterventionType::Interrupt),
        <&'static str>::from(InterventionState::Requested),
        <&'static str>::from(InterventionState::Accepted)
    )
});

// The limit the run still owes: every reached event of it that no end of the run by that limit
// followed, each with the turn it reached, the run's newest turn started before it and not ended
// by then. A token limit is discharged only by `agent.run.stopped` with its trigger, since a
// stopped run is never live again; a step limit by any later `agent.run.interrupted`, after which
// a continue counts the steps afresh. A token limit wins over a step limit, since its end is
// final, so only the winning limit's events are read, oldest first.
static SELECT_OWED_LIMIT_SQL: LazyLock<String> = LazyLock::new(|| {
    let step = SessionEventType::AgentRunStepLimitReached;
    let token = SessionEventType::AgentRunTokenLimitReached;
    let interrupted = SessionEventType::AgentRunInterrupted;
    let stopped = SessionEventType::AgentRunStopped;
    let started = SessionEventType::AgentTurnStarted;
    let token_trigger =
        serde_json::to_value(StopTrigger::TokenLimit).expect("a closed word serializes");
    format!(
        "WITH owed AS (
  SELECT reached.type AS reached_type, reached.sequence AS reached_sequence, (
      SELECT MAX(started.turn_number) FROM session_events AS started
       WHERE started.category = '{started_category}'
         AND started.type = '{started}'
         AND started.run_id = @run_id
         AND started.sequence < reached.sequence
         AND NOT EXISTS (
           SELECT 1 FROM session_events AS turn_end
            WHERE turn_end.category = '{turn_end_category}'
              AND turn_end.type IN ({turn_ends})
              AND turn_end.run_id = started.run_id
              AND turn_end.turn_number = started.turn_number
              AND turn_end.sequence < reached.sequence)) AS reaching_turn
    FROM session_events AS reached
   WHERE reached.run_id = @run_id
     AND ((reached.category = '{token_category}' AND reached.type = '{token}')
       OR (reached.category = '{step_category}' AND reached.type = '{step}'))
     AND NOT EXISTS (
       SELECT 1 FROM session_events AS ended
        WHERE ended.run_id = @run_id
          AND ended.sequence > reached.sequence
          AND ((reached.type = '{token}'
              AND ended.category = '{stopped_category}'
              AND ended.type = '{stopped}'
              AND json_extract(ended.payload, '$.trigger') = '{token_trigger}')
            OR (reached.type = '{step}'
              AND ended.category = '{interrupted_category}'
              AND ended.type = '{interrupted}'))))
SELECT reached_type, reaching_turn FROM owed
 WHERE reached_type = (
   SELECT reached_type FROM owed
    ORDER BY CASE reached_type WHEN '{token}' THEN 0 ELSE 1 END
    LIMIT 1)
 ORDER BY reached_sequence",
        token = token.as_str(),
        token_category = token.category().as_str(),
        step = step.as_str(),
        step_category = step.category().as_str(),
        interrupted = interrupted.as_str(),
        interrupted_category = interrupted.category().as_str(),
        stopped = stopped.as_str(),
        stopped_category = stopped.category().as_str(),
        started = started.as_str(),
        started_category = started.category().as_str(),
        turn_end_category = EventCategory::RunLifecycle.as_str(),
        turn_ends = *TURN_END_TYPES_SQL,
        token_trigger = token_trigger
            .as_str()
            .expect("a closed word serializes as text"),
    )
});

/// An interrupt a restart found with no outcome: its row, the state it leaves, who asked, and its
/// stored record, which says whether the daemon was stopping the run at a limit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingInterrupt {
    /// The intervention.
    pub(crate) intervention_id: InterventionId,
    /// Where it stands.
    pub(crate) state: UnresolvedInterventionState,
    /// Who it is from: the device a person's came from, or the daemon for its own.
    pub(crate) actor: InterventionActor,
    /// Its stored record: a person's, or the daemon's own stop at a limit.
    pub(crate) record: InterruptInterventionRecord,
}

/// A limit a run still owes, read from its log alone: the limit, and the turns its reached events
/// reached, each the run's newest turn started and not yet ended before its event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OwedLimit {
    /// The limit the run reached and was not yet ended by.
    pub(crate) limit: RunLimit,
    /// The turns the limit reached, oldest event first; empty where no turn was open at any.
    pub(crate) reaching_turns: Vec<SafeInt<1>>,
}

/// What a restart reads of a live run to decide how it settles: its pending interrupt, the limit
/// it still owes, and whether a message still waits in the queue for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestartFacts {
    /// The run's interrupt with no outcome yet, if one is.
    pub(crate) pending_interrupt: Option<PendingInterrupt>,
    /// The limit the run reached and no end of it by that limit followed, read whether or not an
    /// interrupt is pending: the daemon was stopping the run at it.
    pub(crate) owed_limit: Option<OwedLimit>,
    /// Whether a queued message targets the run, which starts it when its queue reaches it.
    pub(crate) has_queued_item: bool,
}

/// The end a restart gives a live run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestartSettlement {
    /// `interrupted`, with the daemon's own reason where the interrupt was its own.
    Interrupted {
        /// Why the daemon interrupted the run; `None` for a person's interrupt.
        trigger: Option<InterruptReason>,
    },
    /// `stopped`, by the daemon at a limit.
    Stopped {
        /// Why the daemon stopped the run.
        trigger: StopTrigger,
    },
    /// `failed`, by the restart.
    Failed,
}

/// How a restart ends a run's open turn, in the run's own end write, reported by the daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestartTurnEnd {
    /// `agent.turn.interrupted`, with why.
    Interrupted {
        /// Why the turn ended.
        cause: TurnEndCause,
    },
    /// `agent.turn.failed`, with why.
    Failed {
        /// Why the turn ended.
        cause: TurnEndCause,
    },
}

/// How a restart settles one live run: its end, and the end its open turns take where it has any.
/// A queued run never started a turn, so its end carries none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestartDecision {
    /// The run's end.
    pub(crate) settlement: RestartSettlement,
    /// The end of the run's open turn that takes its cause; `None` where the run started none.
    pub(crate) open_turn_end: Option<RestartTurnEnd>,
    /// The turns the limit reached, as its stops cut them: each still open at the restart takes
    /// `open_turn_end`'s cause, and where none is, the newest open turn, which the limit's
    /// interrupt would cut. Every other open turn ends the same way with `daemonRestart`.
    pub(crate) cut_turns: Vec<SafeInt<1>>,
}

/// Reads what [`decide_restart_settlement`] needs of `run` on `reader`: a queued run's waiting
/// messages, any other run's pending interrupt and the limit it still owes. Fails when SQLite
/// refuses a read or a stored row does not read as its type, an interrupt's record among them.
pub(crate) fn read_restart_facts(
    reader: &Connection,
    run: &LiveRun,
) -> rusqlite::Result<RestartFacts> {
    if run.run.state == RunState::Queued {
        let has_queued_item = !QueueItemReader::new(reader)
            .list_waiting_for_run(&run.run_id)?
            .is_empty();
        return Ok(RestartFacts {
            pending_interrupt: None,
            owed_limit: None,
            has_queued_item,
        });
    }
    Ok(RestartFacts {
        pending_interrupt: read_pending_interrupt(reader, &run.run_id)?,
        owed_limit: read_owed_limit(reader, &run.run_id)?,
        has_queued_item: false,
    })
}

/// The limit `run_id` still owes, read on `reader` from its log alone: every limit reached event
/// that no end of the run by that limit followed, a token limit's before a step limit's, with the
/// turns those events reached. Whether an interrupt was recorded, is pending or failed since does
/// not decide it. Fails when SQLite refuses the read or a stored turn number is not one.
pub(crate) fn read_owed_limit(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Option<OwedLimit>> {
    let mut statement = reader.prepare_cached(&SELECT_OWED_LIMIT_SQL)?;
    let mut rows = statement.query(named_params! { "@run_id": run_id.text().as_str() })?;
    let mut owed_limit: Option<OwedLimit> = None;
    while let Some(row) = rows.next()? {
        let reached_type: String = row.get(0)?;
        let reaching_turn = match row.get_ref(1)?.data_type() {
            Type::Null => None,
            Type::Integer | Type::Real | Type::Text | Type::Blob => Some(safe_int_column(row, 1)?),
        };
        // Every row is of the one winning limit, and the read selects only the two reached types.
        let owed = owed_limit.get_or_insert_with(|| OwedLimit {
            limit: if reached_type == SessionEventType::AgentRunTokenLimitReached.as_str() {
                RunLimit::TokenLimit
            } else {
                RunLimit::StepLimit
            },
            reaching_turns: Vec::new(),
        });
        if let Some(turn_number) = reaching_turn
            && !owed.reaching_turns.contains(&turn_number)
        {
            owed.reaching_turns.push(turn_number);
        }
    }
    Ok(owed_limit)
}

/// Decides how `run` settles, or `None` for a run left as it is. A queued run is left while a
/// message waits to start it and fails otherwise, since nothing else will. An owed token limit
/// stops the run whatever else is pending, its end being final; a pending interrupt settles by
/// its limit, or as the person's own; an owed step limit interrupts the run with it; a limit's
/// cause goes to the turns its reached events reached. A child held in a pause the restart
/// orphaned reads interrupted and continues from its own box; any other run fails.
pub(crate) fn decide_restart_settlement(
    run: &LiveRun,
    facts: &RestartFacts,
) -> Option<RestartDecision> {
    if run.run.state == RunState::Queued {
        return (!facts.has_queued_item).then_some(RestartDecision {
            settlement: RestartSettlement::Failed,
            open_turn_end: None,
            cut_turns: Vec::new(),
        });
    }
    let interrupted_by_restart = RestartDecision {
        settlement: RestartSettlement::Interrupted {
            trigger: Some(InterruptReason::DaemonRestart),
        },
        open_turn_end: Some(RestartTurnEnd::Interrupted {
            cause: TurnEndCause::DaemonRestart,
        }),
        cut_turns: Vec::new(),
    };
    let owed_limit = facts.owed_limit.as_ref();
    // The person's pending interrupt, if any, is applied by the token limit's end in its write.
    if let Some(owed) = owed_limit.filter(|owed| owed.limit == RunLimit::TokenLimit) {
        return Some(limit_end(owed.limit, Some(owed)));
    }
    if let Some(pending) = &facts.pending_interrupt {
        return Some(match pending.record.limit() {
            Some(limit) => limit_end(limit, owed_limit),
            // The person's interrupt stays theirs: the run carries no trigger of the daemon's.
            None => RestartDecision {
                settlement: RestartSettlement::Interrupted { trigger: None },
                ..interrupted_by_restart
            },
        });
    }
    if let Some(owed) = owed_limit {
        return Some(limit_end(owed.limit, Some(owed)));
    }
    if run.parent_run_id.is_some() && matches!(run.run.state, RunState::Paused | RunState::Pausing)
    {
        return Some(interrupted_by_restart);
    }
    Some(RestartDecision {
        settlement: RestartSettlement::Failed,
        open_turn_end: Some(RestartTurnEnd::Failed {
            cause: TurnEndCause::DaemonRestart,
        }),
        cut_turns: Vec::new(),
    })
}

// The end `limit` gives its run, the limit's cause on the turns `owed_limit` reached where it is
// owed at that limit, else on the newest open turn.
fn limit_end(limit: RunLimit, owed_limit: Option<&OwedLimit>) -> RestartDecision {
    RestartDecision {
        settlement: match limit {
            RunLimit::StepLimit => RestartSettlement::Interrupted {
                trigger: Some(InterruptReason::StepLimit),
            },
            RunLimit::SpendLimit => RestartSettlement::Interrupted {
                trigger: Some(InterruptReason::SpendLimit),
            },
            RunLimit::TokenLimit => RestartSettlement::Stopped {
                trigger: StopTrigger::TokenLimit,
            },
        },
        open_turn_end: Some(RestartTurnEnd::Interrupted {
            cause: limit_turn_cause(limit),
        }),
        cut_turns: owed_limit
            .filter(|owed| owed.limit == limit)
            .map(|owed| owed.reaching_turns.clone())
            .unwrap_or_default(),
    }
}

/// The turn end cause a limit cuts a turn with.
pub(crate) fn limit_turn_cause(limit: RunLimit) -> TurnEndCause {
    match limit {
        RunLimit::StepLimit => TurnEndCause::StepLimit,
        RunLimit::SpendLimit => TurnEndCause::SpendLimit,
        RunLimit::TokenLimit => TurnEndCause::TokenLimit,
    }
}

// The interrupt of `run_id` that has no outcome yet, read on `reader`, or `None`. Fails when
// SQLite refuses the read or a stored column does not read as its type; a stored record that is
// neither a person's interrupt nor the daemon's at a limit fails it too.
fn read_pending_interrupt(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Option<PendingInterrupt>> {
    reader
        .prepare_cached(&SELECT_PENDING_INTERRUPT_SQL)?
        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            Ok(PendingInterrupt {
                intervention_id: text_column(row, 0, |text| InterventionId::new(&text))?,
                // The read selects only the two states before an outcome; any other reads as a
                // broken row.
                state: text_column(row, 1, |text| {
                    closed_word::<InterventionState>(text)
                        .map_err(UnresolvedStateError::Unreadable)
                        .and_then(|state| {
                            UnresolvedInterventionState::try_from(state)
                                .map_err(UnresolvedStateError::Resolved)
                        })
                })?,
                // A row the daemon wrote for itself names no device.
                actor: optional_text_column(row, 2, closed_word::<InterventionDeviceActor>)?
                    .map_or(
                        InterventionActor::Daemon(DaemonInterventionActor::Value),
                        InterventionActor::Device,
                    ),
                record: text_column(row, 3, |text| {
                    serde_json::from_str::<InterruptInterventionRecord>(&text)
                })?,
            })
        })
        .optional()
}

// Why a stored state is not one an interrupt leaves.
#[derive(Debug, thiserror::Error)]
enum UnresolvedStateError {
    #[error("the stored state is not an intervention state")]
    Unreadable(#[source] serde_json::Error),
    #[error(transparent)]
    Resolved(InterventionResolvedError),
}

/// The statement that refuses a settle decided with no pending interrupt once one has appeared, so
/// the settle never contradicts the person's last word.
pub(crate) fn no_pending_interrupt_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_PENDING_INTERRUPT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(0),
    }
}

/// The statement that refuses a queued run's `failed` settle once a queued message targets it
/// again, so a run its queue still starts is never ended.
pub(crate) fn no_waiting_item_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_WAITING_FOR_RUN_SQL.as_str()),
        bindings: StatementBindings::Positional(vec![Value::Text(
            run_id.text().as_str().to_owned(),
        )]),
        expected_row_count: Some(0),
    }
}

/// The pending interrupt of `run` moved to `applied`, with its event, for the write that ends the
/// run. Fails when the event breaks a check of its type.
pub(crate) fn applied_pending_interrupt_of(
    run: &LiveRun,
    pending_interrupt: &PendingInterrupt,
) -> Result<RunStateChangeCompanions, SessionEventDraftError> {
    let applied = AgentInterventionAppliedPayload {
        session_id: run.run.session_id,
        intervention_id: pending_interrupt.intervention_id,
        target_run_id: run.run_id,
        intervention_type: InterventionType::Interrupt,
        state: AgentInterventionAppliedState::Value,
        actor: pending_interrupt.actor.clone(),
    };
    Ok(RunStateChangeCompanions {
        statements: vec![move_intervention_statement(
            &pending_interrupt.intervention_id,
            &InterventionTransition::Apply {
                from: pending_interrupt.state,
            },
        )],
        preceding_events: vec![SessionEventDraft::of_session(
            run.run.session_id,
            &SessionEvent::AgentInterventionApplied(applied),
        )?],
        leading_event: None,
    })
}

/// The queue table with the columns the queue's reads name, for a test's database file.
#[cfg(test)]
pub(crate) const QUEUE_ITEMS_TABLE_SQL: &str = "
CREATE TABLE queue_items (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'queued'
                        CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled',
                                        'notDelivered')),
  not_delivered_reason  TEXT,
  payload               TEXT NOT NULL DEFAULT '{}',
  target_run_id         TEXT,
  child_handle          TEXT,
  position              INTEGER NOT NULL DEFAULT 0,
  client_idempotency_key TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;
";

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::orchestration::InterruptReason;
    use sidekicks_contracts::run::control::StopTrigger;
    use sidekicks_contracts::run::events::{
        DaemonInterventionActor, InterventionActor, TurnEndCause,
    };
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::intervention::{
        InterruptInterventionRecord, InterventionId, RunLimit,
    };
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{
        OwedLimit, PendingInterrupt, QUEUE_ITEMS_TABLE_SQL, RestartDecision, RestartFacts,
        RestartSettlement, RestartTurnEnd, decide_restart_settlement, no_waiting_item_statement,
    };
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
    use crate::interventions::store::UnresolvedInterventionState;
    use crate::session::run::read::{LiveRun, RunRead};
    use crate::uuid_v7::mint_uuid_v7;

    fn ends(settlement: RestartSettlement, turn_end: RestartTurnEnd) -> Option<RestartDecision> {
        Some(RestartDecision {
            settlement,
            open_turn_end: Some(turn_end),
            cut_turns: Vec::new(),
        })
    }

    fn turns(turn_numbers: &[u64]) -> Vec<SafeInt<1>> {
        turn_numbers
            .iter()
            .map(|&turn_number| SafeInt::new(turn_number).expect("the test's turns count from 1"))
            .collect()
    }

    // `decision` with its cause on turns `turn_numbers`.
    fn on_turns(
        decision: Option<RestartDecision>,
        turn_numbers: &[u64],
    ) -> Option<RestartDecision> {
        decision.map(|decision| RestartDecision {
            cut_turns: turns(turn_numbers),
            ..decision
        })
    }

    fn owed(limit: RunLimit, reaching_turns: &[u64]) -> Option<OwedLimit> {
        Some(OwedLimit {
            limit,
            reaching_turns: turns(reaching_turns),
        })
    }

    fn stopped_at_token_limit() -> Option<RestartDecision> {
        ends(
            RestartSettlement::Stopped {
                trigger: StopTrigger::TokenLimit,
            },
            RestartTurnEnd::Interrupted {
                cause: TurnEndCause::TokenLimit,
            },
        )
    }

    fn interrupted(
        trigger: Option<InterruptReason>,
        cause: TurnEndCause,
    ) -> Option<RestartDecision> {
        ends(
            RestartSettlement::Interrupted { trigger },
            RestartTurnEnd::Interrupted { cause },
        )
    }

    fn failed_with_its_turn() -> Option<RestartDecision> {
        ends(
            RestartSettlement::Failed,
            RestartTurnEnd::Failed {
                cause: TurnEndCause::DaemonRestart,
            },
        )
    }

    // Killed by leaving every queued run alone or failing one a message still waits to start
    // (`queued_*`), by reading a limit from the person's reason text (`person_naming_step_limit`),
    // by settling a limit stop as the person's or another limit's (`*_limit`), by failing a run
    // whose log still owes a limit (`step_limit_owed*`), by letting a pending interrupt win over an
    // owed token limit (`*_beside_an_owed_token_limit`), by giving the cause to the newest turn
    // rather than every turn the limit reached (`*_owed`, `*_and_owed`), by dropping the held
    // child's rule (`held_child_*`), and by giving a run the wrong turn end or none.
    #[rstest]
    #[case::queued_behind_a_message(RunState::Queued, false, None, None, true, None)]
    #[case::queued_with_nothing_to_start_it(
        RunState::Queued,
        false,
        None,
        None,
        false,
        Some(RestartDecision {
            settlement: RestartSettlement::Failed,
            open_turn_end: None,
            cut_turns: Vec::new(),
        })
    )]
    #[case::person_interrupt(
        RunState::Running,
        false,
        Some(r#"{"pending":"nextTurn"}"#),
        None,
        false,
        interrupted(None, TurnEndCause::DaemonRestart)
    )]
    #[case::person_naming_step_limit(
        RunState::Running,
        false,
        Some(r#"{"pending":"returnToDraft","reason":"stepLimit"}"#),
        None,
        false,
        interrupted(None, TurnEndCause::DaemonRestart)
    )]
    #[case::step_limit(
        RunState::Running,
        false,
        Some(r#"{"limit":"stepLimit"}"#),
        None,
        false,
        interrupted(Some(InterruptReason::StepLimit), TurnEndCause::StepLimit)
    )]
    #[case::step_limit_pending_and_owed(
        RunState::Running,
        false,
        Some(r#"{"limit":"stepLimit"}"#),
        owed(RunLimit::StepLimit, &[1]),
        false,
        on_turns(
            interrupted(Some(InterruptReason::StepLimit), TurnEndCause::StepLimit),
            &[1]
        )
    )]
    #[case::spend_limit(
        RunState::WaitingForApproval,
        false,
        Some(r#"{"limit":"spendLimit"}"#),
        None,
        false,
        interrupted(Some(InterruptReason::SpendLimit), TurnEndCause::SpendLimit)
    )]
    #[case::token_limit(
        RunState::Paused,
        true,
        Some(r#"{"limit":"tokenLimit"}"#),
        None,
        false,
        stopped_at_token_limit()
    )]
    #[case::person_interrupt_beside_an_owed_token_limit(
        RunState::Running,
        false,
        Some(r#"{"pending":"nextTurn"}"#),
        owed(RunLimit::TokenLimit, &[2]),
        false,
        on_turns(stopped_at_token_limit(), &[2])
    )]
    #[case::spend_limit_beside_an_owed_token_limit(
        RunState::Running,
        false,
        Some(r#"{"limit":"spendLimit"}"#),
        owed(RunLimit::TokenLimit, &[1]),
        false,
        on_turns(stopped_at_token_limit(), &[1])
    )]
    #[case::person_interrupt_beside_an_owed_step_limit(
        RunState::Running,
        false,
        Some(r#"{"pending":"nextTurn"}"#),
        owed(RunLimit::StepLimit, &[1]),
        false,
        interrupted(None, TurnEndCause::DaemonRestart)
    )]
    #[case::held_child_paused(
        RunState::Paused,
        true,
        None,
        None,
        false,
        interrupted(Some(InterruptReason::DaemonRestart), TurnEndCause::DaemonRestart)
    )]
    #[case::held_child_pausing(
        RunState::Pausing,
        true,
        None,
        None,
        false,
        interrupted(Some(InterruptReason::DaemonRestart), TurnEndCause::DaemonRestart)
    )]
    #[case::paused_lead(RunState::Paused, false, None, None, false, failed_with_its_turn())]
    #[case::running_child(RunState::Running, true, None, None, false, failed_with_its_turn())]
    #[case::step_limit_owed(
        RunState::Running,
        false,
        None,
        owed(RunLimit::StepLimit, &[1, 2]),
        false,
        on_turns(
            interrupted(Some(InterruptReason::StepLimit), TurnEndCause::StepLimit),
            &[1, 2]
        )
    )]
    #[case::step_limit_owed_with_no_turn_reached(
        RunState::Running,
        false,
        None,
        owed(RunLimit::StepLimit, &[]),
        false,
        interrupted(Some(InterruptReason::StepLimit), TurnEndCause::StepLimit)
    )]
    #[case::running(RunState::Running, false, None, None, false, failed_with_its_turn())]
    fn a_restart_settles_each_live_run_by_what_it_was_waiting_on(
        #[case] state: RunState,
        #[case] has_parent: bool,
        #[case] pending_record: Option<&str>,
        #[case] owed_limit: Option<OwedLimit>,
        #[case] has_queued_item: bool,
        #[case] expected: Option<RestartDecision>,
    ) {
        let run = LiveRun {
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            run: RunRead {
                version: 4,
                session_id: test_session_id(),
                state,
            },
            parent_run_id: has_parent
                .then(|| RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")),
            reached_by: None,
        };
        let pending_interrupt = pending_record.map(|record| PendingInterrupt {
            intervention_id: InterventionId::try_from(mint_uuid_v7())
                .expect("a minted UUID is an intervention id"),
            state: UnresolvedInterventionState::Accepted,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
            record: serde_json::from_str::<InterruptInterventionRecord>(record)
                .expect("the test's record reads as stored"),
        });
        let facts = RestartFacts {
            pending_interrupt,
            owed_limit,
            has_queued_item,
        };

        assert_eq!(decide_restart_settlement(&run, &facts), expected);
    }

    // Killed by the guard reading a state other than the stored `queued` word, or by dropping its
    // run condition: either lets the settle end a run its queue still starts, or refuses one whose
    // message is gone.
    #[tokio::test]
    async fn the_waiting_item_guard_holds_only_while_a_queued_message_targets_the_run() {
        let database = TestDatabase::new();
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let connection = database.reader();
        connection
            .execute_batch(QUEUE_ITEMS_TABLE_SQL)
            .expect("the test makes the queue table");
        connection
            .execute(
                "INSERT INTO queue_items (id, session_id, state, target_run_id, created_at,
                   updated_at)
                 VALUES ('item', 'session', 'queued', ?1, '', '')",
                [run_id.text().as_str()],
            )
            .expect("the test queues a message for the run");

        let while_queued = writer.write(vec![no_waiting_item_statement(&run_id)]).await;
        assert!(
            matches!(
                while_queued,
                Err(WriteError::Refused {
                    statement_index: 0,
                    row_count: 1,
                })
            ),
            "a run a queued message targets is not settled: {while_queued:?}"
        );

        connection
            .execute("UPDATE queue_items SET state = 'admitted'", [])
            .expect("the test admits the message");
        writer
            .write(vec![no_waiting_item_statement(&run_id)])
            .await
            .expect("a run with no queued message behind it is settled");
    }
}
