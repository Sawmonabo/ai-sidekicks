//! The runs of one session, as its close and its purge find them, the runs of one agent in it, and
//! whether a run is one of them.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;

use crate::run::agent::queued_run_agent_sql;

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

// Each run of the session whose `agent.run.queued` row is for the agent.
static SELECT_AGENT_RUN_IDS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT queued.run_id FROM session_events AS queued
  WHERE queued.session_id = @sessionId
    AND queued.type = '{run_queued}'
    AND queued.run_id IS NOT NULL
    AND {agent} = @agentId",
        run_queued = SessionEventType::AgentRunQueued.as_str(),
        agent = queued_run_agent_sql("queued"),
    )
});

/// The ids of `session_id`'s runs queued for `agent_id`, as a run's agent is read, on `reader`,
/// inside the caller's snapshot where it holds one. Fails as SQLite fails or a stored id does not
/// read.
pub(crate) fn read_agent_run_ids(
    reader: &Connection,
    session_id: &SessionId,
    agent_id: &AgentId,
) -> rusqlite::Result<Vec<RunId>> {
    reader
        .prepare_cached(&SELECT_AGENT_RUN_IDS_SQL)?
        .query_map(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@agentId": agent_id.text().as_str(),
            },
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

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_store::database::writer::test_file::{test_run_id, test_session_id};

    use super::read_agent_run_ids;
    use crate::agent_tree::read::tests::{SessionLog, agent_id, at};
    use crate::agents::projection::test_fixture::write_log_row;

    // The lead's runs are its named one and the one whose queued row names no agent; the other
    // agent's is its own. Killed by the agent filter dropped (every run read), by the lead's
    // fallback dropped (the unnamed run missing), and by the session filter dropped (another
    // session's run of the lead read).
    #[test]
    fn an_agents_runs_are_the_runs_of_the_session_queued_for_it() {
        let mut session = SessionLog::new();
        let lead = session.lead;
        let other = agent_id();
        let lead_run = session.run(None, RunState::Running, lead, &at(0));
        let other_run = session.run(None, RunState::Running, other, &at(1));
        let unnamed_run = test_run_id();
        session.event(
            SessionEventType::AgentRunQueued,
            &json!({}),
            Some(unnamed_run),
            &at(2),
        );
        write_log_row(
            &session.connection,
            test_session_id(),
            0,
            (
                SessionEventType::AgentRunQueued,
                &json!({ "agentId": lead }),
            ),
            Some(test_run_id()),
            &at(3),
        );

        let runs_of = |agent| {
            read_agent_run_ids(&session.connection, &session.session_id, &agent)
                .expect("the runs read")
                .into_iter()
                .collect::<HashSet<_>>()
        };
        assert_eq!(runs_of(lead), HashSet::from([lead_run, unnamed_run]));
        assert_eq!(runs_of(other), HashSet::from([other_run]));
    }
}
