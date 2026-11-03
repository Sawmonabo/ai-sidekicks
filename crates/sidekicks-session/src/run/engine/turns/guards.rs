//! The guards a run's turn writes ride on and the SQL they and the run reads share: a turn start
//! refused once its number is held, a turn end refused once its turn holds one, a reply's piece
//! taken only while its run lives or a turn of it is open, and the run's started turns with no end.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::transcript::turn_attribution::TURN_END_EVENT_TYPES;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};

use crate::run::transitions::RUN_TERMINAL_STATES_SQL;

// Refuses a start once any start of the run holds its number or a later one, spelled as the
// unique index on turn starts spells its predicate.
static SELECT_TURN_START_FROM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type = '{}'
    AND run_id = @run_id
    AND turn_number >= @turn_number
  LIMIT 1",
        EventCategory::RunLifecycle.as_str(),
        SessionEventType::AgentTurnStarted.as_str()
    )
});

/// The three turn ends as an SQL list, in the order the unique index on turn ends spells them.
pub(crate) static TURN_END_TYPES_SQL: LazyLock<String> =
    LazyLock::new(|| sql_list_of(TURN_END_EVENT_TYPES));

// Refuses an end once the turn holds one.
static SELECT_TURN_END_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type IN ({})
    AND run_id = @run_id
    AND turn_number = @turn_number
  LIMIT 1",
        EventCategory::RunLifecycle.as_str(),
        *TURN_END_TYPES_SQL
    )
});

// Matches the run while it has not ended or a turn of it holds no end yet.
static RUN_LIVE_OR_TURN_OPEN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM runs WHERE run_id = @run_id
  AND (state NOT IN ({}) OR EXISTS ({}))",
        *RUN_TERMINAL_STATES_SQL,
        open_turns_sql("@run_id", "LIMIT 1")
    )
});

/// Holds when the turn start the enclosing query reads as `started` has no end, spelled in the
/// order the turn ends' unique index is declared so the probe reads that index.
pub(crate) fn turn_holds_no_end_sql() -> String {
    format!(
        "NOT EXISTS (
      SELECT 1 FROM session_events AS ended
       WHERE ended.category = '{}'
         AND ended.type IN ({})
         AND ended.run_id = started.run_id
         AND ended.turn_number = started.turn_number)",
        EventCategory::RunLifecycle.as_str(),
        *TURN_END_TYPES_SQL
    )
}

/// The started turns that hold no end of the run the SQL expression `run_id` names (a parameter
/// or a column of an outer query), ordered and bounded by `tail`.
pub(crate) fn open_turns_sql(run_id: &str, tail: &str) -> String {
    format!(
        "SELECT started.turn_number FROM session_events AS started
  WHERE started.category = '{}'
    AND started.type = '{}'
    AND started.run_id = {run_id}
    AND {}
  {tail}",
        EventCategory::RunLifecycle.as_str(),
        SessionEventType::AgentTurnStarted.as_str(),
        turn_holds_no_end_sql()
    )
}

/// Holds only while `run_id` has not ended or a turn of it is still open, so a piece of its reply
/// or reasoning is taken until the provider ends the turn it belongs to, even past the run's end.
pub(crate) fn run_live_or_turn_open_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_LIVE_OR_TURN_OPEN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(1),
    }
}

/// Refuses a start numbered `turn_number` of `run_id` once a start holds it or a later number.
pub(super) fn no_turn_start_from_statement(
    run_id: &RunId,
    turn_number: SafeInt<1>,
) -> WriteStatement {
    turn_guard(SELECT_TURN_START_FROM_SQL.as_str(), run_id, turn_number)
}

/// Refuses an end of `run_id`'s turn `turn_number` once it holds one.
pub(super) fn no_turn_end_statement(run_id: &RunId, turn_number: SafeInt<1>) -> WriteStatement {
    turn_guard(SELECT_TURN_END_SQL.as_str(), run_id, turn_number)
}

fn turn_guard(sql: &'static str, run_id: &RunId, turn_number: SafeInt<1>) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (
                Cow::Borrowed("@turn_number"),
                Value::Integer(i64::from(turn_number)),
            ),
        ]),
        expected_row_count: Some(0),
    }
}
