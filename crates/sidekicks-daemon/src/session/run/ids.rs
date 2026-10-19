//! The runs of one session, as its close and its purge find them, and whether a run is one of them.

use std::borrow::Cow;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};

/// The ids, in one `runId` column, of the runs of the session the `@sessionId` parameter names:
/// the rows the rebuild wrote, every run its events name, so a run the rebuild never reached past
/// a damaged event is still found, and those that had an execution root.
pub(crate) const SESSION_RUN_IDS_SQL: &str = "
  SELECT run_id AS runId FROM runs WHERE session_id = @sessionId
  UNION
  SELECT run_id FROM session_events WHERE session_id = @sessionId AND run_id IS NOT NULL
  UNION
  SELECT run_id FROM run_execution_contexts WHERE session_id = @sessionId";

/// Reads a row only while the `@runId` parameter names a run of the `@sessionId` session.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "an artifact's manifest write, which holds only while its run is the session's"
    )
)]
pub(crate) const RUN_IN_SESSION_SQL: &str =
    "SELECT 1 FROM runs WHERE run_id = @runId AND session_id = @sessionId";

/// A statement that holds only while `run_id` names a run of `session_id`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "an artifact's manifest write, which holds only while its run is the session's"
    )
)]
pub(crate) fn run_in_session_statement(session_id: &SessionId, run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_IN_SESSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@runId", run_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}
