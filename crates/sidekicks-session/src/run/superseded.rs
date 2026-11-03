//! Which turns of a run an undo superseded, read from the log. Undone turns stay in the log, and
//! every accepted `agent.run.rolledBack` of the run adds its cut (`add_superseding_cut`).

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, named_params};
use serde::Deserialize as _;
use serde_json::{Map, Value};
use sidekicks_contracts::run::control::AgentRunRolledBackEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::row::TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE;
use sidekicks_contracts::transcript::turn_attribution::{SupersededTurns, add_superseding_cut};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::json_object_column;
use sidekicks_store::events::session::read::{readable_event_sql, session_read_bound};

/// A stored `agent.run.rolledBack` payload that does not match its contract. The log is the
/// daemon's own, so a mismatch is a broken write, and skipping it would move every cut.
#[derive(Debug, thiserror::Error)]
#[error(
    "the {TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE} event at sequence {sequence} of session {} does not \
     match its contract, so the run's history cannot be read",
    .session_id
)]
pub struct StoredRollbackMismatchError {
    /// The session whose log holds the event.
    pub(crate) session_id: SessionId,
    /// The event's sequence.
    pub(crate) sequence: i64,
    /// Why the payload does not read as the contract.
    #[source]
    pub(crate) cause: serde_json::Error,
}

/// Why superseded turns could not be read, a run's or a session's.
#[derive(Debug, thiserror::Error)]
pub enum SupersededTurnsReadError {
    /// SQLite refused a read, or a payload column is not JSON.
    #[error("a database read of the superseded turns failed")]
    Database(#[from] rusqlite::Error),
    /// A stored rollback does not match its contract.
    #[error(transparent)]
    Rollback(#[from] StoredRollbackMismatchError),
}

/// Reads one stored `agent.run.rolledBack` payload into its contract. Fails with
/// [`StoredRollbackMismatchError`] when it does not match.
pub fn parse_stored_rollback(
    payload: &Map<String, Value>,
    session_id: &SessionId,
    sequence: i64,
) -> Result<AgentRunRolledBackEvent, StoredRollbackMismatchError> {
    AgentRunRolledBackEvent::deserialize(payload).map_err(|cause| StoredRollbackMismatchError {
        session_id: *session_id,
        sequence,
        cause,
    })
}

// Seeks the run's readable rollbacks past `@after_sequence` through the event log's run-and-type
// index: the read takes every one, and a write's guard expects none past the last the read took.
static SELECT_RUN_ROLLBACKS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence, payload FROM session_events AS event
      WHERE session_id = @session_id AND type = @type AND run_id = @run_id
        AND sequence > @after_sequence AND {}
      ORDER BY sequence",
        readable_event_sql("event")
    )
});

// The sequence below every event's, so a read past it takes the whole log.
const BEFORE_EVERY_SEQUENCE: i64 = -1;

/// A run's superseded turns from every rollback of it the log can read on `reader`, none past a
/// damaged session's last good point (`read_damaged_from_sequence`, `None` for a session that
/// reads whole) or in a range it skipped. Fails with [`SupersededTurnsReadError`] when SQLite
/// refuses the read or a stored rollback does not match its contract.
pub(crate) fn read_superseded_turns(
    reader: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: &SessionId,
    run_id: &RunId,
) -> Result<SupersededTurns, SupersededTurnsReadError> {
    let read_bound = session_read_bound(read_damaged_from_sequence, session_id, None);
    read_run_rollbacks(reader, session_id, run_id, read_bound).map(|(turns, _)| turns)
}

/// A run's superseded turns as [`read_superseded_turns`] reads them, with the guard that refuses
/// a write once a rollback of the run the read did not take is in the log, so what the turns
/// decide holds in the write they decide. Fails as [`read_superseded_turns`] does.
pub(crate) fn read_superseded_turns_guarded(
    reader: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: &SessionId,
    run_id: &RunId,
) -> Result<(SupersededTurns, WriteStatement), SupersededTurnsReadError> {
    let read_bound = session_read_bound(read_damaged_from_sequence, session_id, None);
    let (turns, last_sequence) = read_run_rollbacks(reader, session_id, run_id, read_bound)?;
    let guard = WriteStatement {
        sql: Cow::Borrowed(SELECT_RUN_ROLLBACKS_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@session_id", session_id.text().as_str()),
            text_binding("@type", TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE),
            text_binding("@run_id", run_id.text().as_str()),
            (
                Cow::Borrowed("@after_sequence"),
                SqlValue::Integer(last_sequence),
            ),
            (Cow::Borrowed("@read_bound"), SqlValue::Integer(read_bound)),
        ]),
        expected_row_count: Some(0),
    };
    Ok((turns, guard))
}

// The run's superseded turns from its readable rollbacks before `read_bound`, with the sequence
// of the last one, or the sequence below every event's when it has none.
fn read_run_rollbacks(
    reader: &Connection,
    session_id: &SessionId,
    run_id: &RunId,
    read_bound: i64,
) -> Result<(SupersededTurns, i64), SupersededTurnsReadError> {
    let mut statement = reader.prepare_cached(SELECT_RUN_ROLLBACKS_SQL.as_str())?;
    let mut rows = statement.query(named_params! {
        "@session_id": session_id.text().as_str(),
        "@type": TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
        "@run_id": run_id.text().as_str(),
        "@after_sequence": BEFORE_EVERY_SEQUENCE,
        "@read_bound": read_bound,
    })?;
    let mut turns = SupersededTurns {
        run_id: *run_id,
        cuts: Vec::new(),
    };
    let mut last_sequence = BEFORE_EVERY_SEQUENCE;
    while let Some(row) = rows.next()? {
        let sequence: i64 = row.get(0)?;
        let payload = json_object_column(row, 1)?;
        let rollback = parse_stored_rollback(&payload, session_id, sequence)?;
        turns = add_superseding_cut(&turns, rollback.target_position);
        last_sequence = sequence;
    }
    Ok((turns, last_sequence))
}
