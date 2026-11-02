//! The read of a run's tool calls whose result a transcript folds: a call the provider moved to
//! the background, and a call answered by more than one close.

use std::sync::LazyLock;

use rusqlite::named_params;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use super::{SessionEventReads, SessionLogReadError, payload_damage_of, readable_event_sql};
use crate::events::session::insert::TOOL_CALL_ID_PAYLOAD_KEY;
use crate::transcript::rejoin::row_condition_sql;

/// One of a run's tool calls whose result folds: where its closes, its `completed` and `failed`
/// rows, sit in the log, and whether the provider moved it to the background.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCallCloses {
    /// The provider's id of the call.
    pub tool_call_id: String,
    /// Whether the call has an `agent.toolCall.backgrounded` row.
    pub is_backgrounded: bool,
    /// The sequence of the call's first close; `None` for a held call no close has answered.
    pub first_close: Option<i64>,
    /// The sequence of the call's last close; `None` as `first_close` is.
    pub last_close: Option<i64>,
}

// A run's calls with a `backgrounded` row or more than one close, grouped by the call id in the
// payload. Each type is a literal so the run-and-type index serves the read; a row with no call id
// is left out, and a row counts only where the page reads take it as a row.
static TOOL_CALL_CLOSES_SQL: LazyLock<String> = LazyLock::new(|| {
    let backgrounded = SessionEventType::AgentToolCallBackgrounded.as_str();
    let completed = SessionEventType::AgentToolCallCompleted.as_str();
    let failed = SessionEventType::AgentToolCallFailed.as_str();
    format!(
        "SELECT json_extract(event.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}'),
            MAX(event.type = '{backgrounded}'),
            MIN(CASE WHEN event.type <> '{backgrounded}' THEN event.sequence END),
            MAX(CASE WHEN event.type <> '{backgrounded}' THEN event.sequence END)
       FROM session_events AS event
      WHERE event.session_id = @session_id AND event.run_id = @run_id
        AND event.type IN ('{backgrounded}', '{completed}', '{failed}')
        AND json_extract(event.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}') IS NOT NULL
        AND {readable} AND {row}
      GROUP BY json_extract(event.payload, '$.{TOOL_CALL_ID_PAYLOAD_KEY}')
     HAVING MAX(event.type = '{backgrounded}')
         OR COUNT(CASE WHEN event.type <> '{backgrounded}' THEN 1 END) > 1",
        readable = readable_event_sql("event"),
        row = row_condition_sql("event"),
    )
});

impl<DamagedFrom> SessionEventReads<'_, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    /// Run `run_id`'s tool calls below the read bound `before_sequence` sets, as
    /// [`Self::read_bound`] answers it, that have a `backgrounded` row or more than one close, in
    /// no set order. Fails as every read does, naming the first row whose payload no JSON function
    /// reads, as [`payload_damage_of`] names it.
    pub fn read_run_tool_call_closes(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        before_sequence: Option<i64>,
    ) -> Result<Vec<ToolCallCloses>, SessionLogReadError> {
        let read_bound = self.read_bound(session_id, before_sequence);
        let read = || {
            self.reader
                .prepare_cached(&TOOL_CALL_CLOSES_SQL)?
                .query_map(
                    named_params! {
                        "@session_id": session_id.text().as_str(),
                        "@run_id": run_id.text().as_str(),
                        "@read_bound": read_bound,
                    },
                    |row| {
                        Ok(ToolCallCloses {
                            tool_call_id: row.get(0)?,
                            is_backgrounded: row.get(1)?,
                            first_close: row.get(2)?,
                            last_close: row.get(3)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()
        };
        read().map_err(|error| payload_damage_of(self.reader, session_id, error).into())
    }
}
