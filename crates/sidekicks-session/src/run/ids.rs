//! The runs of one session, as its close and its purge find them, and whether a run is one of them.

use std::borrow::Cow;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;

/// The ids, in one `runId` column, of the runs of the session the `@sessionId` parameter names:
/// the rows the rebuild wrote, every run its events name, so a run the rebuild never reached past
/// a damaged event is still found, and those that had an execution root.
pub const SESSION_RUN_IDS_SQL: &str = "
  SELECT run_id AS runId FROM runs WHERE session_id = @sessionId
  UNION
  SELECT run_id FROM session_events WHERE session_id = @sessionId AND run_id IS NOT NULL
  UNION
  SELECT run_id FROM run_execution_contexts WHERE session_id = @sessionId";

/// The ids of `session_id`'s runs, as [`SESSION_RUN_IDS_SQL`] finds them, read on `reader`, inside
/// the caller's snapshot where it holds one. Fails as SQLite fails or a stored id does not read.
pub(crate) fn read_session_run_ids(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<RunId>> {
    reader
        .prepare_cached(SESSION_RUN_IDS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| text_column(row, 0, |text| RunId::new(&text)),
        )?
        .collect()
}

/// Reads a row only while the `@runId` parameter names a run of the `@sessionId` session.
pub const RUN_IN_SESSION_SQL: &str =
    "SELECT 1 FROM runs WHERE run_id = @runId AND session_id = @sessionId";

/// A statement that holds only while `run_id` names a run of `session_id`.
pub fn run_in_session_statement(session_id: &SessionId, run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_IN_SESSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@runId", run_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}
