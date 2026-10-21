//! Child runs in the transcript. A child's creation row, the `agent.run.queued` that names its
//! parent, carries the child's summary: its state, the events the daemon holds for it through the
//! read's head, and whether those are all of them, counted for every child of a page in one
//! statement. `transcript.childRun.expand` reads one child's rows as a window of their own: its
//! events, the events filed under it, and its own children's creation rows, live or finished alike.

use std::collections::HashMap;
use std::error::Error;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::json;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::event_cursor::{EventCursor, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::child_run_summary::{
    ChildRunCompleteness, ChildRunIncompleteCause, ChildRunSummary,
};
use sidekicks_contracts::transcript::limits::TRANSCRIPT_READ_LIMIT_MAX;
use sidekicks_contracts::transcript::operations::{
    ReadEntries, TranscriptChildRunExpandContinuing, TranscriptChildRunExpandRequest,
    TranscriptChildRunExpandResponse, TranscriptChildRunExpandTerminal,
};
use sidekicks_contracts::transcript::row::TranscriptReadRow;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{SafeInt, count_bound};
use sidekicks_contracts::wire::{False, True};

use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::events::session::read::{SessionEventReads, readable_event_sql, resolve_event_cursor};
use crate::ipc::domain_error::DomainError;
use crate::session::run::refusals::RunRefusal;
use crate::transcript::block_cut::BlockParse;
use crate::transcript::projector::project_window;
use crate::transcript::rejoin::{RowReads, RowScope};
use crate::transcript::window::{TranscriptReadError, read_transcript_head};

/// The payload member of an `agent.run.queued` that names the run it is a child of.
const PARENT_RUN_ID_PAYLOAD_KEY: &str = "parentRunId";

// Each child's state and its events through the head: all of them, and those the log can read.
static CHILD_COUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT runs.run_id, runs.state,
            (SELECT count(*) FROM session_events AS held
              WHERE held.session_id = @session_id AND held.run_id = runs.run_id
                AND held.sequence <= @head),
            (SELECT count(*) FROM session_events AS event
              WHERE event.session_id = @session_id AND event.run_id = runs.run_id
                AND event.sequence <= @head AND {})
       FROM runs
      WHERE runs.run_id IN (SELECT value FROM json_each(@run_ids))",
        readable_event_sql("event")
    )
});

// Each child's state alone, read when its events could not be counted.
const CHILD_STATES_SQL: &str =
    "SELECT run_id, state FROM runs WHERE run_id IN (SELECT value FROM json_each(@run_ids))";

const RUN_SQL: &str = "SELECT session_id, parent_run_id, state FROM runs WHERE run_id = ?";

/// A child's state and its events through a head, as one count read them.
pub(crate) struct ChildCount {
    /// The child's state.
    pub(crate) state: RunState,
    /// Every event the log holds for it.
    pub(crate) total: u64,
    /// Those the log can read.
    pub(crate) readable: u64,
    /// Whether its events were counted; a child whose count failed holds none it can show.
    pub(crate) is_counted: bool,
}

impl ChildCount {
    /// Whether every event the log holds for the child was counted and can be read.
    pub(crate) fn is_complete(&self) -> bool {
        self.is_counted && self.readable == self.total
    }
}

/// Stamps every child-creation row of `rows`, projected from `events`, with its child's summary
/// through `head`, read on `reader`: a child whose events cannot all be read, because its session
/// skipped or cannot yet read some of them or its count failed, is marked incomplete as of
/// `observed_at` with the count the log can read, and its row is kept. Fails when SQLite refuses
/// the children's states as well as their count.
pub(crate) fn stamp_child_run_summaries<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    session_id: &SessionId,
    rows: &mut [TranscriptReadRow],
    events: &[EventEnvelope],
    head: i64,
    observed_at: &WireInstant,
) -> rusqlite::Result<()>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let parents: Vec<(usize, RunId, RunId)> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.event_type.0.as_str() == SessionEventType::AgentRunQueued.as_str()
        })
        .filter_map(|(index, event)| {
            let parent_run_id = event
                .payload
                .get(PARENT_RUN_ID_PAYLOAD_KEY)?
                .as_str()
                .and_then(|text| RunId::new(text).ok())?;
            let run_id = *rows[index].run_id()?;
            (run_id != parent_run_id).then_some((index, run_id, parent_run_id))
        })
        .collect();
    if parents.is_empty() {
        return Ok(());
    }
    let run_ids: Vec<String> = parents
        .iter()
        .map(|(_, run_id, _)| run_id.to_string())
        .collect();
    let read_bound =
        SessionEventReads::new(reader, read_damaged_from_sequence).read_bound(session_id, None);
    let counts = read_child_counts(reader, session_id, &run_ids, head, read_bound)?;
    for (index, run_id, parent_run_id) in parents {
        // A child the runs table does not hold has no state to show; its row stays as it is.
        let Some(count) = counts.get(&run_id.to_string()) else {
            continue;
        };
        let completeness = if count.is_complete() {
            ChildRunCompleteness::Complete {}
        } else {
            ChildRunCompleteness::Incomplete {
                cause: ChildRunIncompleteCause::DetailFetchFailed,
                observed_at: observed_at.clone(),
            }
        };
        let summary = ChildRunSummary {
            run_id,
            parent_run_id,
            state: count.state,
            event_count: SafeInt::new(count.readable).expect("an event count is a safe integer"),
            completeness,
        };
        set_child_run_summary(&mut rows[index], summary);
    }
    Ok(())
}

/// The state and event counts through `head` of each of `run_ids` in `session_id`, by run id, read
/// on `reader`; `read_bound` is where the session's reads stop. A run the runs table does not hold
/// is left out. When the count fails, it is logged and each run comes with its state alone, not
/// counted. Fails when SQLite refuses the states' read too.
pub(crate) fn read_child_counts(
    reader: &Connection,
    session_id: &SessionId,
    run_ids: &[String],
    head: i64,
    read_bound: i64,
) -> rusqlite::Result<HashMap<String, ChildCount>> {
    let run_ids_json = serde_json::to_string(run_ids).expect("a list of strings serializes");
    match count_child_events(reader, session_id, &run_ids_json, head, read_bound) {
        Ok(counts) => Ok(counts),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "child runs' events could not be counted; their summaries are marked incomplete"
            );
            reader
                .prepare_cached(CHILD_STATES_SQL)?
                .query_map(named_params! { "@run_ids": run_ids_json }, |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        ChildCount {
                            state: text_column(row, 1, closed_word)?,
                            total: 0,
                            readable: 0,
                            is_counted: false,
                        },
                    ))
                })?
                .collect()
        }
    }
}

// The counts of `read_child_counts`, failing when SQLite refuses them.
fn count_child_events(
    reader: &Connection,
    session_id: &SessionId,
    run_ids_json: &str,
    head: i64,
    read_bound: i64,
) -> rusqlite::Result<HashMap<String, ChildCount>> {
    reader
        .prepare_cached(&CHILD_COUNTS_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@run_ids": run_ids_json,
                "@head": head,
                "@read_bound": read_bound,
            },
            |row| {
                let total: i64 = row.get(2)?;
                let readable: i64 = row.get(3)?;
                Ok((
                    row.get::<_, String>(0)?,
                    ChildCount {
                        state: text_column(row, 1, closed_word)?,
                        total: u64::try_from(total).expect("a count is not negative"),
                        readable: u64::try_from(readable).expect("a count is not negative"),
                        is_counted: true,
                    },
                ))
            },
        )?
        .collect()
}

fn set_child_run_summary(row: &mut TranscriptReadRow, summary: ChildRunSummary) {
    let slot = match row {
        TranscriptReadRow::RollbackBoundary(row) => &mut row.child_run_summary,
        TranscriptReadRow::Run(row) => &mut row.child_run_summary,
        TranscriptReadRow::General(row) => &mut row.child_run_summary,
    };
    *slot = Some(summary);
}

/// A run as the expansion reads it from the runs table.
struct ExpandedRun {
    session_id: SessionId,
    parent_run_id: Option<RunId>,
    state: RunState,
}

/// Reads one page of `request`'s child run's rows on `reader`, oldest first, each child-creation
/// row among them summarized as of `observed_at` and each reply cut into blocks by `parse`;
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with [`TranscriptReadError::Refused`] for a run this daemon
/// does not hold (`agent.run.notFound`) or one with no parent (`agent.run.notChild`), and with
/// [`TranscriptReadError::CursorUnresolvable`] for a cursor that names no position.
pub(crate) fn expand_child_run<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    request: &TranscriptChildRunExpandRequest,
    observed_at: &WireInstant,
    parse: BlockParse,
) -> Result<TranscriptChildRunExpandResponse, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader.unchecked_transaction()?;
    let run_id = request.run_id;
    let Some(run) = read_run(reader, &run_id)? else {
        return Err(DomainError::from(RunRefusal::NotFound { run_id }).into());
    };
    let Some(parent_run_id) = run.parent_run_id else {
        return Err(DomainError::new(
            "That run has no parent, so it has no child rows to expand.",
            RefusalCode::AgentRunNotChild,
        )
        .with_detail(json!({ "runId": run_id }))
        .into());
    };
    let session_id = run.session_id;
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let head = read_transcript_head(&reads, read_damaged_from_sequence, &session_id)?;
    let after_position = resolve_event_cursor(request.after_cursor.as_ref(), head)?;
    let Some(head) = head else {
        snapshot.commit()?;
        return Ok(TranscriptChildRunExpandResponse::Terminal(
            TranscriptChildRunExpandTerminal {
                run_id,
                parent_run_id,
                state: run.state,
                entries: ReadEntries::new(Vec::new()).expect("an empty page is a page"),
                has_more: False::default(),
                next_cursor: None,
                joined_through: None,
            },
        ));
    };
    let candidates = RowReads::new(&reads, reader, &session_id).rows_after(
        RowScope::Run(&run_id),
        after_position,
        None,
        count_bound(TRANSCRIPT_READ_LIMIT_MAX + 1),
    )?;
    let stretch = &candidates[..TRANSCRIPT_READ_LIMIT_MAX.min(candidates.len())];
    let mut rows = project_window(
        reader,
        read_damaged_from_sequence,
        &session_id,
        stretch,
        head,
        parse,
    )?;
    stamp_child_run_summaries(
        reader,
        read_damaged_from_sequence,
        &session_id,
        &mut rows,
        stretch,
        head,
        observed_at,
    )?;
    let page_count = count_entries_fitting_one_frame(
        &rows,
        TRANSCRIPT_READ_LIMIT_MAX,
        PAGE_MAX_BYTES,
        json_utf8_byte_length,
    )
    .expect("a transcript row serializes");
    rows.truncate(page_count);
    snapshot.commit()?;
    let joined_through = cursor_at(head);
    if page_count < candidates.len() {
        return Ok(TranscriptChildRunExpandResponse::Continuing(
            TranscriptChildRunExpandContinuing {
                run_id,
                parent_run_id,
                state: run.state,
                entries: ReadEntries::new(rows)
                    .expect("a page that leaves more holds 1 to limit rows"),
                has_more: True::default(),
                next_cursor: cursor_at(i64::from(stretch[page_count - 1].sequence)),
                joined_through,
            },
        ));
    }
    Ok(TranscriptChildRunExpandResponse::Terminal(
        TranscriptChildRunExpandTerminal {
            run_id,
            parent_run_id,
            state: run.state,
            entries: ReadEntries::new(rows).expect("a page holds at most limit rows"),
            has_more: False::default(),
            next_cursor: Some(cursor_at(head.max(after_position))),
            joined_through: Some(joined_through),
        },
    ))
}

fn read_run(reader: &Connection, run_id: &RunId) -> rusqlite::Result<Option<ExpandedRun>> {
    reader
        .prepare_cached(RUN_SQL)?
        .query_row([run_id.text().as_str()], |row| {
            Ok(ExpandedRun {
                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                parent_run_id: optional_text_column(row, 1, |text| RunId::new(&text))?,
                state: text_column(row, 2, closed_word)?,
            })
        })
        .optional()
}

fn cursor_at(position: i64) -> EventCursor {
    encode_event_cursor(position).expect("a position read from the log is a cursor position")
}

#[cfg(test)]
mod tests {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::transcript::limits::TRANSCRIPT_READ_LIMIT_MAX;
    use sidekicks_contracts::transcript::operations::TranscriptChildRunExpandResponse;
    use sidekicks_contracts::wire::instant::WireInstant;

    use super::expand_child_run;
    use crate::transcript::block_cut::MARKDOWN_PARSE;
    use crate::transcript::test_log::{AT, TranscriptTestLog, wire_message};
    use crate::transcript::window::{TranscriptReadError, read_transcript_window};
    use crate::uuid_v7::mint_uuid_v7;

    // `run_id`'s expansion after `after_cursor`.
    fn expand(
        log: &TranscriptTestLog,
        run_id: RunId,
        after_cursor: Option<&Value>,
    ) -> Result<TranscriptChildRunExpandResponse, TranscriptReadError> {
        let mut request = json!({ "runId": run_id });
        if let Some(cursor) = after_cursor {
            request["afterCursor"] = cursor.clone();
        }
        let request = serde_json::from_value(request).expect("the test's request reads");
        expand_child_run(
            &log.reader(),
            &|_: &SessionId| None,
            &request,
            &WireInstant::now(),
            MARKDOWN_PARSE,
        )
    }

    // The summary on the creation row of `run_id` in the session's first page.
    fn summary_of(log: &TranscriptTestLog, run_id: RunId) -> Value {
        let request = serde_json::from_value(json!({ "sessionId": log.session_id }))
            .expect("the test's request reads");
        let page = read_transcript_window(
            &log.reader(),
            &|_: &SessionId| None,
            &request,
            MARKDOWN_PARSE,
        )
        .expect("the window reads");
        let page = wire_message(&page).0;
        page["entries"]
            .as_array()
            .expect("a page holds entries")
            .iter()
            .find(|row| row["type"] == "agent.run.queued" && row["runId"] == json!(run_id))
            .expect("the child's creation row is on the page")["childRunSummary"]
            .clone()
    }

    // Killed by a summary counting rows rather than events, by a child with skipped events read
    // as complete, and by its row dropped.
    #[test]
    fn a_child_run_summary_counts_its_readable_events_and_marks_skipped_ones() {
        let log = TranscriptTestLog::new();
        let child = log.child_run(log.run_id, "completed");
        log.piece("agent.message.sent", child, "m1", Some(0), "One ", AT);
        let (skipped, _) = log.piece("agent.message.sent", child, "m1", Some(0), "row.", AT);

        let complete = summary_of(&log, child);
        assert_eq!(complete["parentRunId"], json!(log.run_id));
        assert_eq!(complete["state"], "completed");
        assert_eq!(complete["eventCount"], 3);
        assert_eq!(complete["completeness"]["state"], "complete");

        log.skip(skipped, skipped);
        let incomplete = summary_of(&log, child);
        assert_eq!(incomplete["eventCount"], 2);
        assert_eq!(incomplete["completeness"]["state"], "incomplete");
        assert_eq!(incomplete["completeness"]["cause"], "detailFetchFailed");
    }

    // Killed by a failed count failing the page, by the child's row dropped or left with no
    // summary, by a failed count read as complete, and by a page served when the child's state
    // cannot be read either.
    #[test]
    fn an_uncounted_child_is_marked_incomplete_and_an_unread_state_fails_the_page() {
        let log = TranscriptTestLog::new();
        let child = log.child_run(log.run_id, "completed");
        log.piece("agent.message.sent", child, "m1", Some(0), "One row.", AT);
        let request = serde_json::from_value(json!({ "sessionId": log.session_id }))
            .expect("the test's request reads");
        // Only the child counts call `count`, and in a session's window only the children's reads
        // read the runs table, so refusing either fails just those reads.
        let read_refusing = |refuses_runs: bool| {
            let reader = log.reader();
            reader
                .authorizer(Some(move |context: AuthContext<'_>| {
                    let is_refused = matches!(
                        context.action,
                        AuthAction::Function {
                            function_name: "count"
                        }
                    ) || (refuses_runs
                        && matches!(
                            context.action,
                            AuthAction::Read {
                                table_name: "runs",
                                ..
                            }
                        ));
                    if is_refused {
                        Authorization::Deny
                    } else {
                        Authorization::Allow
                    }
                }))
                .expect("the test sets its authorizer");
            read_transcript_window(&reader, &|_: &SessionId| None, &request, MARKDOWN_PARSE)
        };
        assert!(
            read_refusing(true).is_err(),
            "a page whose child states cannot be read fails"
        );
        let page = read_refusing(false).expect("the window reads with the count refused");
        let page = wire_message(&page).0;
        let summary = &page["entries"]
            .as_array()
            .expect("a page holds entries")
            .iter()
            .find(|row| row["type"] == "agent.run.queued" && row["runId"] == json!(child))
            .expect("the child's creation row is on the page")["childRunSummary"];
        assert_eq!(summary["state"], "completed");
        assert_eq!(summary["eventCount"], 0);
        assert_eq!(summary["completeness"]["state"], "incomplete");
        assert_eq!(summary["completeness"]["cause"], "detailFetchFailed");
    }

    // Killed by an expansion reading only the child's own events, by one leaving out the
    // interventions on it or its own children's rows, by one reading the parent's, by a page
    // that leaves more without saying so, and by a lead run or an unknown run expanded.
    #[test]
    fn a_child_run_expands_to_its_rows_interventions_and_children_in_pages() {
        let log = TranscriptTestLog::new();
        let child = log.child_run(log.run_id, "completed");
        log.reply("lead", Some(0), "The lead's own row.");
        for index in 0..TRANSCRIPT_READ_LIMIT_MAX {
            log.piece(
                "agent.message.sent",
                child,
                &format!("m{index}"),
                Some(0),
                "A child row.",
                AT,
            );
        }
        let (_, intervention_id) = log.intervention(child, "applied");
        let grandchild = log.child_run(child, "running");

        let Ok(TranscriptChildRunExpandResponse::Continuing(first)) = expand(&log, child, None)
        else {
            panic!("the child's rows fill more than one page");
        };
        let first = wire_message(&first).0;
        let next_cursor = first["nextCursor"].clone();
        let Ok(TranscriptChildRunExpandResponse::Terminal(last)) =
            expand(&log, child, Some(&next_cursor))
        else {
            panic!("the second page ends the child's rows");
        };
        let last = wire_message(&last).0;
        let rows: Vec<&Value> = [&first, &last]
            .iter()
            .flat_map(|page| page["entries"].as_array().expect("a page holds entries"))
            .collect();
        assert_eq!(rows.len(), TRANSCRIPT_READ_LIMIT_MAX + 3);
        assert!(
            rows.iter()
                .all(|row| row["content"]["body"] != "The lead's own row.")
        );
        assert!(rows.iter().any(|row| row["id"] == intervention_id));
        let grandchild_row = rows
            .iter()
            .find(|row| row["runId"] == json!(grandchild))
            .expect("the grandchild's creation row is read");
        assert_eq!(
            grandchild_row["childRunSummary"]["parentRunId"],
            json!(child)
        );

        let refusal_code = |run_id| match expand(&log, run_id, None) {
            Err(TranscriptReadError::Refused(refusal)) => refusal.code,
            other => panic!("the expansion is refused: {other:?}"),
        };
        assert_eq!(refusal_code(log.run_id), RefusalCode::AgentRunNotChild);
        assert_eq!(
            refusal_code(RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")),
            RefusalCode::AgentRunNotFound
        );
    }
}
