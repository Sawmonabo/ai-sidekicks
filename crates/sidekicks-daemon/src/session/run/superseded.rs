//! Which turns of a run an undo superseded, read from the log. Undone turns stay in the log, and
//! every accepted `agent.run.rolledBack` of the run adds its cut (`add_superseding_cut`).

use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use serde::Deserialize as _;
use serde_json::{Map, Value};
use sidekicks_contracts::run::control::AgentRunRolledBackEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::row::TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE;
use sidekicks_contracts::transcript::turn_attribution::{SupersededTurns, add_superseding_cut};

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
pub(crate) struct StoredRollbackMismatchError {
    /// The session whose log holds the event.
    pub(crate) session_id: SessionId,
    /// The event's sequence.
    pub(crate) sequence: i64,
    /// Why the payload does not read as the contract.
    #[source]
    pub(crate) cause: serde_json::Error,
}

/// Why a run's superseded turns could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SupersededTurnsReadError {
    /// SQLite refused the read, or a payload column is not JSON.
    #[error("the read of a run's rollbacks failed")]
    Database(#[from] rusqlite::Error),
    /// A stored rollback does not match its contract.
    #[error(transparent)]
    Rollback(#[from] StoredRollbackMismatchError),
}

/// Reads one stored `agent.run.rolledBack` payload into its contract. Fails with
/// [`StoredRollbackMismatchError`] when it does not match.
pub(crate) fn parse_stored_rollback(
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

// Seeks the run's readable rollbacks through the event log's run-and-type index.
static SELECT_RUN_ROLLBACKS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence, payload FROM session_events AS event
      WHERE session_id = @session_id AND type = @type AND run_id = @run_id
        AND {}
      ORDER BY sequence",
        readable_event_sql("event")
    )
});

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
    let mut statement = reader.prepare_cached(SELECT_RUN_ROLLBACKS_SQL.as_str())?;
    let mut rows = statement.query(named_params! {
        "@session_id": session_id.text().as_str(),
        "@type": TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
        "@run_id": run_id.text().as_str(),
        "@read_bound": session_read_bound(read_damaged_from_sequence, session_id, None),
    })?;
    let mut turns = SupersededTurns {
        run_id: *run_id,
        cuts: Vec::new(),
    };
    while let Some(row) = rows.next()? {
        let sequence: i64 = row.get(0)?;
        let payload = json_object_column(row, 1)?;
        let rollback = parse_stored_rollback(&payload, session_id, sequence)?;
        turns = add_superseding_cut(&turns, rollback.target_position);
    }
    Ok(turns)
}
