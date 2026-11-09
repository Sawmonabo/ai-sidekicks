//! The tool calls a session's log still holds in the background: those a provider moved there with
//! no close since, and those whose last close is the daemon's settle naming why the call ended with
//! no result, so a later ending of theirs still lands; and the sessions that hold an open one. The
//! driver reads a session's held calls through [`StoredHeldToolCalls`].

use std::error::Error;
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, named_params};
use sidekicks_contracts::event::declared_variants::{
    ToolCallBackgroundedPayload, ToolCallEndCause,
};
use sidekicks_contracts::event::envelope::EventOccurredAt;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::port::held_tool_calls::{
    HELD_TOOL_CALLS_READ_MAX, HeldToolCall, HeldToolCallReads,
};
use sidekicks_provider::runtime_binding::store::StoredBindingIdInvalid;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::{
    StoredJsonFault, closed_word, optional_text_column, text_column,
};
use sidekicks_store::events::session::insert::TOOL_CALL_ID_PAYLOAD_KEY;

use crate::run::read::{NEAREST_LINEAGE_BINDING_ORDER_SQL, provider_lineage_sql};

// The payload member that names why a call ended with no result.
const END_CAUSE_PAYLOAD_KEY: &str = "endCause";

/// The statements a read connection keeps prepared for the held calls of one session; the sessions
/// that hold one are read at the start, whose set counts that statement.
pub const HELD_TOOL_CALLS_STATEMENT_CAPACITY: usize = 1;

// The SQL condition that `close` is a close of the call `held` moved to the background, written
// after it.
fn closes_held_call_sql() -> String {
    format!(
        "close.session_id = held.session_id
        AND close.type IN ('{completed}', '{failed}')
        AND close.run_id = held.run_id
        AND close.sequence > held.sequence
        AND json_extract(close.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}')
          = json_extract(held.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}')",
        completed = SessionEventType::AgentToolCallCompleted.as_str(),
        failed = SessionEventType::AgentToolCallFailed.as_str(),
    )
}

// Each background row of the session with its call's last close, kept while there is none or it
// is a `failed` row naming why the call ended with no result, newest first: its payload, its
// call's latest opening's stored time before it, the close's `endCause`, and the binding its close
// is appended on. That binding is the nearest run's up the provider subagent lineage that has one,
// that run's newest by when each was recorded and then by id, so a helper's call answers its lead's
// binding, which its process runs on; a run with none anywhere up its lineage reads NULL, which
// fails the read. `background` is read twice, so SQLite keeps it once. The type is written as a
// literal so the planner can match the background index.
static SELECT_HELD_TOOL_CALLS_SQL: LazyLock<String> = LazyLock::new(|| {
    let failed = SessionEventType::AgentToolCallFailed.as_str();
    format!(
        "WITH RECURSIVE background AS (
  SELECT held.sequence, held.run_id, held.payload,
    (SELECT close.sequence FROM session_events AS close
      WHERE {closes_held_call}
      ORDER BY close.sequence DESC
      LIMIT 1) AS close_sequence
  FROM session_events AS held
  WHERE held.session_id = @session_id
    AND held.type = '{backgrounded}'
),
{lineage}
SELECT background.payload,
  (SELECT invoked.occurred_at FROM session_events AS invoked
    WHERE invoked.session_id = @session_id
      AND invoked.type = '{invoked}'
      AND invoked.run_id = background.run_id
      AND invoked.sequence < background.sequence
      AND json_extract(invoked.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}')
        = json_extract(background.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}')
    ORDER BY invoked.sequence DESC
    LIMIT 1),
  json_extract(close.payload, '$.{END_CAUSE_PAYLOAD_KEY}'),
  (SELECT binding.id FROM lineage
    JOIN runtime_bindings AS binding ON binding.run_id = lineage.run_id
    WHERE lineage.origin_run_id = background.run_id
    {NEAREST_LINEAGE_BINDING_ORDER_SQL})
FROM background
LEFT JOIN session_events AS close
  ON close.session_id = @session_id AND close.sequence = background.close_sequence
WHERE close.sequence IS NULL
  OR (close.type = '{failed}'
    AND json_extract(close.payload, '$.{END_CAUSE_PAYLOAD_KEY}') IS NOT NULL)
ORDER BY background.sequence DESC
LIMIT {HELD_TOOL_CALLS_READ_MAX}",
        closes_held_call = closes_held_call_sql(),
        backgrounded = SessionEventType::AgentToolCallBackgrounded.as_str(),
        invoked = SessionEventType::AgentToolCallInvoked.as_str(),
        lineage =
            provider_lineage_sql("SELECT DISTINCT background.run_id AS run_id FROM background"),
    )
});

// Every session with a background row and no close of its call after it, and whether the session
// is closed. The type is written as a literal so the planner can match the background index.
static SELECT_SESSIONS_HOLDING_TOOL_CALLS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT held.session_id,
    EXISTS (SELECT 1 FROM sessions
      WHERE sessions.id = held.session_id AND sessions.state = '{closed}')
  FROM session_events AS held
  WHERE held.type = '{backgrounded}'
    AND NOT EXISTS (SELECT 1 FROM session_events AS close WHERE {closes_held_call})
  ORDER BY held.session_id",
        closed = <&'static str>::from(SessionState::Closed),
        backgrounded = SessionEventType::AgentToolCallBackgrounded.as_str(),
        closes_held_call = closes_held_call_sql(),
    )
});

/// `session_id`'s held calls read on `reader`, newest first and at most
/// [`HELD_TOOL_CALLS_READ_MAX`]: each call moved to the background with no close after it, and
/// each whose last close is a `failed` row naming why it ended with no result, each with the
/// binding its close is appended on: the newest of the nearest run up its provider subagent
/// lineage that has one. Fails when SQLite refuses the read, a stored background payload, opening
/// time, end cause or binding id does not read as its type, or no run up the call's lineage has a
/// binding.
pub fn read_held_tool_calls(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<HeldToolCall>> {
    reader
        .prepare_cached(&SELECT_HELD_TOOL_CALLS_SQL)?
        .query_map(
            named_params! { "@session_id": session_id.text().as_str() },
            |row| {
                let held = text_column(row, 0, |text| {
                    serde_json::from_str::<ToolCallBackgroundedPayload>(&text)
                        .map_err(StoredJsonFault::from)
                })?;
                Ok(HeldToolCall {
                    run_id: held.run_id,
                    binding_id: text_column(row, 3, |text| {
                        RuntimeBindingId::new(text).ok_or(StoredBindingIdInvalid)
                    })?,
                    tool_call_id: held.tool_call_id,
                    tool_name: held.tool_name,
                    task_id: held.task_id,
                    survives_restart: held.survives_restart,
                    invoked_at: optional_text_column(row, 1, EventOccurredAt::new)?,
                    end_cause: optional_text_column(row, 2, closed_word::<ToolCallEndCause>)?,
                })
            },
        )?
        .collect()
}

/// The session logs' held calls, each read through the daemon's read pool.
pub struct StoredHeldToolCalls {
    pool: Arc<DatabaseReadPool>,
}

impl StoredHeldToolCalls {
    /// The held calls read through `pool`.
    pub fn new(pool: Arc<DatabaseReadPool>) -> Self {
        Self { pool }
    }
}

impl HeldToolCallReads for StoredHeldToolCalls {
    fn read_held_tool_calls(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Vec<HeldToolCall>, Box<dyn Error + Send + Sync>>> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok(read_held_tool_calls(reader, &session_id)?)
            })
            .boxed()
    }
}

/// A session holding a call moved to the background with no close after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SessionHoldingToolCalls {
    /// The session.
    pub session_id: SessionId,
    /// Whether the session itself closed, so no resume of it settles the call.
    pub is_closed: bool,
}

/// Every session that holds a call moved to the background with no close after it, read on
/// `reader`, uncapped. Fails when SQLite refuses the read or a stored session id is not one.
pub fn read_sessions_holding_tool_calls(
    reader: &Connection,
) -> rusqlite::Result<Vec<SessionHoldingToolCalls>> {
    reader
        .prepare_cached(&SELECT_SESSIONS_HOLDING_TOOL_CALLS_SQL)?
        .query_map([], |row| {
            Ok(SessionHoldingToolCalls {
                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                is_closed: row.get(1)?,
            })
        })?
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rusqlite::{Connection, params};
    use serde_json::{Value, json};
    use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
    use sidekicks_contracts::event::envelope::EventOccurredAt;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionState;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_provider::port::held_tool_calls::HeldToolCall;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_test_event, test_run_id, test_session_id,
    };

    use super::{SessionHoldingToolCalls, read_held_tool_calls, read_sessions_holding_tool_calls};
    use crate::questions::schema::schema_parts;

    // The instant every row is stored at but the opening whose time the read carries.
    const LATER: &str = "2026-10-14T09:01:00.000Z";

    // Writes a row of `event_type` for `tool_call_id` of `run_id` in `session_id`, its payload
    // `members` beside the members every tool row carries, stored at `occurred_at`.
    fn write_tool_row(
        writer: &Connection,
        (session_id, run_id): (SessionId, RunId),
        event_type: &str,
        tool_call_id: &str,
        mut members: Value,
        occurred_at: &str,
    ) {
        members["sessionId"] = json!(session_id);
        members["runId"] = json!(run_id);
        members["toolName"] = json!("Bash");
        members["toolCallId"] = json!(tool_call_id);
        insert_test_event(
            writer,
            session_id,
            json!({ "type": event_type, "payload": members }),
            None,
            occurred_at,
        );
    }

    // The background row of `tool_call_id`, stored at `LATER`.
    fn write_backgrounded(writer: &Connection, run: (SessionId, RunId), tool_call_id: &str) {
        write_tool_row(
            writer,
            run,
            "agent.toolCall.backgrounded",
            tool_call_id,
            json!({ "taskId": format!("task-of-{tool_call_id}"), "survivesRestart": true }),
            LATER,
        );
    }

    // Binds `run_id` as `binding_id`, recorded at `created_at`.
    fn write_binding(writer: &Connection, run_id: RunId, binding_id: &str, created_at: &str) {
        writer
            .execute(
                "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
                   cli_version_raw, created_at, updated_at)
                 VALUES (?1, ?2, 'claude', '1.0.0', '1.0.0', ?3, ?3)",
                params![binding_id, run_id.text().as_str(), created_at],
            )
            .expect("the test binds the run");
    }

    // Writes `run_id` of `session_id` as a provider subagent of `parent_run_id`.
    fn write_subagent_run(
        writer: &Connection,
        (session_id, run_id): (SessionId, RunId),
        parent_run_id: RunId,
    ) {
        writer
            .execute(
                "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state,
                   run_version)
                 VALUES (?1, ?2, ?3, 'providerSubagent', 'running', 1)",
                params![
                    run_id.text().as_str(),
                    session_id.text().as_str(),
                    parent_run_id.text().as_str()
                ],
            )
            .expect("the test writes the subagent run");
    }

    // The held call `tool_call_id` of `run_id` on `binding_id` as the read answers it.
    fn held(
        (run_id, binding_id): (RunId, &str),
        tool_call_id: &str,
        invoked_at: Option<&str>,
        end_cause: Option<ToolCallEndCause>,
    ) -> HeldToolCall {
        HeldToolCall {
            run_id,
            binding_id: RuntimeBindingId::new(binding_id.to_owned()).expect("a binding id"),
            tool_call_id: ToolCallId::new(tool_call_id.to_owned()).expect("a call id"),
            tool_name: FreeFormText::new("Bash".to_owned()).expect("a tool name"),
            task_id: FreeFormText::new(format!("task-of-{tool_call_id}")).expect("a task id"),
            survives_restart: true,
            invoked_at: invoked_at
                .map(|at| EventOccurredAt::new(at.to_owned()).expect("a stored instant")),
            end_cause,
        }
    }

    // Killed by the last close's rule reversed or dropped (`call-3` and `call-4` answered), by
    // daemon-settled calls left out (`call-2` missing), by the background row's time read for the
    // opening's (`call-1` at 09:01), by a sessions list that counts a closed call (`B` listed) or a
    // daemon-settled one (`D` listed), or reads no session's own close (`C` open), by the binding
    // read without its run or its lineage's origin (`binding-a2`, the newest of all, answered for
    // `call-1` and `call-9`), by its order reversed (`binding-a-older` answered), and by the
    // lineage left unclimbed (the helper's `call-9` reads no binding and fails the read).
    #[test]
    fn the_held_call_read_keeps_open_and_daemon_settled_calls() {
        let database = TestDatabase::new(schema_parts());
        let writer = database.opener()().expect("the test creates its database");
        let session_a = (test_session_id(), test_run_id());
        let session_b = (test_session_id(), test_run_id());
        let session_c = (test_session_id(), test_run_id());
        let session_d = (test_session_id(), test_run_id());
        let second_run = (session_a.0, test_run_id());
        let helper = (session_a.0, test_run_id());
        let failed = "agent.toolCall.failed";
        let completed = "agent.toolCall.completed";
        write_binding(
            &writer,
            session_a.1,
            "binding-a-older",
            "2026-10-14T08:00:00.000Z",
        );
        write_binding(
            &writer,
            session_a.1,
            "binding-a-newer",
            "2026-10-14T08:30:00.000Z",
        );
        write_binding(
            &writer,
            second_run.1,
            "binding-a2",
            "2026-10-14T08:45:00.000Z",
        );

        // Open.
        write_tool_row(
            &writer,
            session_a,
            "agent.toolCall.invoked",
            "call-1",
            json!({}),
            "2026-10-14T09:00:00.000Z",
        );
        write_backgrounded(&writer, session_a, "call-1");
        // Settled by the daemon, on the session's second run.
        write_backgrounded(&writer, second_run, "call-2");
        write_tool_row(
            &writer,
            second_run,
            failed,
            "call-2",
            json!({ "endCause": "processExit" }),
            LATER,
        );
        // Settled by the daemon, then closed by its provider.
        write_backgrounded(&writer, session_a, "call-3");
        write_tool_row(
            &writer,
            session_a,
            failed,
            "call-3",
            json!({ "endCause": "stopped" }),
            LATER,
        );
        write_tool_row(&writer, session_a, completed, "call-3", json!({}), LATER);
        // Failed by its provider.
        write_backgrounded(&writer, session_a, "call-4");
        write_tool_row(&writer, session_a, failed, "call-4", json!({}), LATER);
        // Never moved to the background.
        write_tool_row(
            &writer,
            session_a,
            "agent.toolCall.invoked",
            "call-5",
            json!({}),
            LATER,
        );
        write_backgrounded(&writer, session_b, "call-6");
        write_tool_row(&writer, session_b, completed, "call-6", json!({}), LATER);
        write_backgrounded(&writer, session_c, "call-7");
        write_backgrounded(&writer, session_d, "call-8");
        write_tool_row(
            &writer,
            session_d,
            failed,
            "call-8",
            json!({ "endCause": "processExit" }),
            LATER,
        );
        // A helper's call, on its lead's binding.
        write_subagent_run(&writer, helper, session_a.1);
        write_backgrounded(&writer, helper, "call-9");
        let reader = database.reader();

        assert_eq!(
            read_held_tool_calls(&reader, &session_a.0).expect("session A's held calls read"),
            [
                held((helper.1, "binding-a-newer"), "call-9", None, None),
                held(
                    (second_run.1, "binding-a2"),
                    "call-2",
                    None,
                    Some(ToolCallEndCause::ProcessExit)
                ),
                held(
                    (session_a.1, "binding-a-newer"),
                    "call-1",
                    Some("2026-10-14T09:00:00.000Z"),
                    None
                ),
            ]
        );
        insert_session_row(&writer, session_c.0.text().as_str(), None, None);
        writer
            .execute(
                "UPDATE sessions SET state = ?1 WHERE id = ?2",
                params![
                    <&'static str>::from(SessionState::Closed),
                    session_c.0.text().as_str()
                ],
            )
            .expect("the test closes the session");
        assert_eq!(
            read_sessions_holding_tool_calls(&reader)
                .expect("the sessions holding calls read")
                .into_iter()
                .collect::<HashSet<_>>(),
            HashSet::from([
                SessionHoldingToolCalls {
                    session_id: session_a.0,
                    is_closed: false,
                },
                SessionHoldingToolCalls {
                    session_id: session_c.0,
                    is_closed: true,
                },
            ])
        );
    }
}
