//! What a child's head reads from its own run's log: the tool calls it made and the newest of
//! them, when it ended, why it failed, its final message, and the ask a run of its own was
//! admitted with.

use std::collections::HashMap;
use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::orchestration::{
    CHILD_RUN_RESULT_MAX_LEN, ChildRunActivity, ChildRunFailureReason,
};
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::MessageContent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::database::stored_column::{
    StoredJsonFault, optional_text_column, safe_int_column, text_column,
};
use sidekicks_store::events::session::read::{SessionEventReads, readable_event_sql};
use sidekicks_store::transcript::rejoin::{RowReads, row_condition_sql};

use crate::run::transitions::RUN_TERMINAL_EVENT_TYPES_SQL;

// Each listed run's tool calls, counted over the same rows as its tokens.
static SELECT_TOOL_COUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id, COUNT(*)
  FROM session_events
  WHERE session_id = @session_id
    AND type = '{invoked}'
    AND run_id IN (SELECT value FROM json_each(@run_ids))
  GROUP BY run_id",
        invoked = SessionEventType::AgentToolCallInvoked.as_str(),
    )
});

// Each listed run's newest readable tool call's tool; the bare column reads from the row `MAX`
// picks.
static SELECT_NEWEST_TOOLS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT invoked.run_id, MAX(invoked.sequence),
       json_extract(invoked.payload, '$.toolName')
  FROM session_events AS invoked
  WHERE invoked.session_id = @session_id
    AND invoked.type = '{invoked}'
    AND invoked.run_id IN (SELECT value FROM json_each(@run_ids))
    AND {readable}
  GROUP BY invoked.run_id",
        invoked = SessionEventType::AgentToolCallInvoked.as_str(),
        readable = readable_event_sql("invoked"),
    )
});

// Each listed run's newest readable terminal record: when it was written, and the cause and the
// provider's words a failure carries.
static SELECT_ENDS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT ended.run_id, MAX(ended.sequence), ended.occurred_at, ended.type,
       json_extract(ended.payload, '$.failureCause'),
       json_extract(ended.payload, '$.providerFailureDetail')
  FROM session_events AS ended
  WHERE ended.session_id = @session_id
    AND ended.type IN ({terminal})
    AND ended.run_id IN (SELECT value FROM json_each(@run_ids))
    AND {readable}
  GROUP BY ended.run_id",
        terminal = *RUN_TERMINAL_EVENT_TYPES_SQL,
        readable = readable_event_sql("ended"),
    )
});

// Each listed run's newest readable message that stands as a row, by its row's sequence.
static SELECT_NEWEST_MESSAGES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sent.run_id, MAX(sent.sequence)
  FROM session_events AS sent
  WHERE sent.session_id = @session_id
    AND sent.type = '{sent}'
    AND sent.run_id IN (SELECT value FROM json_each(@run_ids))
    AND {readable} AND {row}
  GROUP BY sent.run_id",
        sent = SessionEventType::AgentMessageSent.as_str(),
        readable = readable_event_sql("sent"),
        row = row_condition_sql("sent"),
    )
});

// Each listed run's first readable admitted message, as the person's or the dispatcher's send
// wrote its words; the bare column reads from the row `MIN` picks.
static SELECT_ADMITTED_ASKS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(admitted.payload, '$.runId'), MIN(admitted.sequence),
       json_extract(sent.payload, '$.message')
  FROM session_events AS admitted
  JOIN session_events AS sent
    ON sent.session_id = admitted.session_id
   AND sent.type = '{sent}'
   AND json_extract(sent.payload, '$.queueItemId')
       = json_extract(admitted.payload, '$.queueItemId')
  WHERE admitted.session_id = @session_id
    AND admitted.type = '{admitted}'
    AND json_extract(admitted.payload, '$.runId') IN (SELECT value FROM json_each(@run_ids))
    AND {readable_admitted} AND {readable_sent}
  GROUP BY json_extract(admitted.payload, '$.runId')",
        sent = SessionEventType::UserMessageSent.as_str(),
        admitted = SessionEventType::AgentQueueItemAdmitted.as_str(),
        readable_admitted = readable_event_sql("admitted"),
        readable_sent = readable_event_sql("sent"),
    )
});

/// The statements [`HeadLog::read`] prepares: its five, then a message row's pieces and a piece's
/// body.
pub(super) const HEAD_LOG_STATEMENT_CAPACITY: usize = 7;

// The most UTF-8 bytes a result of `CHILD_RUN_RESULT_MAX_LEN` code points takes.
const RESULT_MAX_BYTES: usize = CHILD_RUN_RESULT_MAX_LEN * 4;

/// How a run ended: when, and why where it failed.
pub(super) struct RunEnd {
    /// When its terminal record was written.
    pub(super) ended_at: WireInstant,
    /// Why it failed, `None` unless the record is a failure.
    pub(super) failure_reason: Option<ChildRunFailureReason>,
}

/// What the heads read from each listed run's log, by run.
#[derive(Default)]
pub(super) struct HeadLog {
    tool_counts: HashMap<RunId, SafeInt<0>>,
    activities: HashMap<RunId, ChildRunActivity>,
    ends: HashMap<RunId, RunEnd>,
    results: HashMap<RunId, FreeFormText<CHILD_RUN_RESULT_MAX_LEN>>,
    admitted_asks: HashMap<RunId, MessageContent>,
}

impl HeadLog {
    /// What the log of `session_id` holds for `head_runs`, each a head's own run, with the asks of
    /// `admitted_runs`, the runs of their own that a send started; what the log reports is read
    /// before `read_bound`, the tool count as the token count is, and a final message only for
    /// `ended_runs`. Fails as SQLite or a stored column does, and on a stored body that does not
    /// decode.
    pub(super) fn read(
        reader: &Connection,
        session_id: &SessionId,
        read_bound: i64,
        (head_runs, ended_runs, admitted_runs): (&[RunId], &[RunId], &[RunId]),
    ) -> rusqlite::Result<Self> {
        let session_text = session_id.text().as_str().to_owned();
        let head_ids = run_ids_json(head_runs);
        let tool_counts = reader
            .prepare_cached(&SELECT_TOOL_COUNTS_SQL)?
            .query_map(
                named_params! { "@session_id": session_text, "@run_ids": head_ids },
                |row| Ok((run_id_column(row, 0)?, safe_int_column::<0>(row, 1)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        let activities = reader
            .prepare_cached(&SELECT_NEWEST_TOOLS_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_text,
                    "@run_ids": head_ids,
                    "@read_bound": read_bound,
                },
                |row| {
                    Ok((
                        run_id_column(row, 0)?,
                        ChildRunActivity {
                            tool_name: text_column(row, 2, FreeFormText::new)?,
                        },
                    ))
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        let ends = reader
            .prepare_cached(&SELECT_ENDS_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_text,
                    "@run_ids": head_ids,
                    "@read_bound": read_bound,
                },
                |row| {
                    let is_failure =
                        row.get::<_, String>(3)? == SessionEventType::AgentRunFailed.as_str();
                    let failure_reason = if is_failure {
                        Some(ChildRunFailureReason {
                            failure_cause: optional_text_column(row, 4, |text| {
                                serde_json::from_str::<RunFailureCause>(&text)
                                    .map_err(StoredJsonFault::from)
                            })?,
                            provider_failure_detail: optional_text_column(
                                row,
                                5,
                                FreeFormText::new,
                            )?,
                        })
                    } else {
                        None
                    };
                    Ok((
                        run_id_column(row, 0)?,
                        RunEnd {
                            ended_at: text_column(row, 2, WireInstant::try_from)?,
                            failure_reason,
                        },
                    ))
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        let ended_ids = run_ids_json(ended_runs);
        let newest_messages: Vec<(RunId, i64)> = reader
            .prepare_cached(&SELECT_NEWEST_MESSAGES_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_text,
                    "@run_ids": ended_ids,
                    "@read_bound": read_bound,
                },
                |row| Ok((run_id_column(row, 0)?, row.get(1)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        let reads = SessionEventReads::new(reader, |_: &SessionId| Some(read_bound));
        let rows = RowReads::new(&reads, reader, session_id);
        let mut results = HashMap::with_capacity(newest_messages.len());
        for (run_id, row_sequence) in newest_messages {
            let text = message_opening(&rows, row_sequence, read_bound)?;
            // A provider's NUL is shown as the replacement character, as a lossy read shows it.
            let opening =
                cut_to_code_points(&text, CHILD_RUN_RESULT_MAX_LEN).replace('\0', "\u{FFFD}");
            match FreeFormText::new(opening) {
                Ok(result) => {
                    results.insert(run_id, result);
                }
                // A message of only whitespace draws no result line.
                Err(TextError::Blank) => {}
                Err(error @ (TextError::HoldsNul | TextError::OverCap { .. })) => {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    ));
                }
            }
        }
        let admitted_ids = run_ids_json(admitted_runs);
        let admitted_asks = reader
            .prepare_cached(&SELECT_ADMITTED_ASKS_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_text,
                    "@run_ids": admitted_ids,
                    "@read_bound": read_bound,
                },
                |row| {
                    Ok((
                        run_id_column(row, 0)?,
                        text_column(row, 2, FreeFormText::new)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self {
            tool_counts,
            activities,
            ends,
            results,
            admitted_asks,
        })
    }

    /// The tool calls `run_id` made, 0 where it made none.
    pub(super) fn tool_count(&self, run_id: RunId) -> SafeInt<0> {
        self.tool_counts
            .get(&run_id)
            .copied()
            .unwrap_or(SafeInt::ZERO)
    }

    /// The newest tool call `run_id` made, `None` before its first.
    pub(super) fn activity(&self, run_id: RunId) -> Option<ChildRunActivity> {
        self.activities.get(&run_id).cloned()
    }

    /// How `run_id` ended, `None` where the log holds no terminal record of it.
    pub(super) fn end(&self, run_id: RunId) -> Option<&RunEnd> {
        self.ends.get(&run_id)
    }

    /// The opening of `run_id`'s final message, `None` where it was not read or sent none.
    pub(super) fn result(&self, run_id: RunId) -> Option<FreeFormText<CHILD_RUN_RESULT_MAX_LEN>> {
        self.results.get(&run_id).cloned()
    }

    /// The words `run_id` was admitted with, `None` where no send started it.
    pub(super) fn admitted_ask(&self, run_id: RunId) -> Option<MessageContent> {
        self.admitted_asks.get(&run_id).cloned()
    }
}

// The opening of the message row at `row_sequence`, its pieces before `read_bound` decoded in order
// only until the bytes a cut result can hold.
fn message_opening<DamagedFrom>(
    rows: &RowReads<'_, '_, DamagedFrom>,
    row_sequence: i64,
    read_bound: i64,
) -> rusqlite::Result<String>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    let members = rows
        .row_members(&[row_sequence], read_bound - 1, -1)?
        .remove(&row_sequence)
        .unwrap_or_default();
    let mut text = String::new();
    for member in members {
        let room = RESULT_MAX_BYTES.saturating_sub(text.len());
        if room == 0 {
            break;
        }
        let length = usize::try_from(member.content_length).expect("a piece's length fits memory");
        if let Some(stretch) = rows.piece_stretch(member.sequence, 0, length.min(room))? {
            text.push_str(&stretch.text);
        }
    }
    Ok(text)
}

fn run_id_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<RunId> {
    text_column(row, index, |text| RunId::new(&text))
}

/// The JSON list of `run_ids`, which a statement reads through `json_each`.
pub(super) fn run_ids_json(run_ids: &[RunId]) -> String {
    serde_json::Value::from(
        run_ids
            .iter()
            .map(|run_id| run_id.text().as_str().to_owned())
            .collect::<Vec<_>>(),
    )
    .to_string()
}

#[cfg(test)]
mod tests;
