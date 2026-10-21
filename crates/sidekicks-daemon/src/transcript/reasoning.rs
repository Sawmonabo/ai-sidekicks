//! A run's reasoning, kept whole: a text longer than one entry is stored as consecutive pieces of
//! its row, and `transcript.reasoning.read` answers each row's pieces joined into entries of at
//! most one entry's length, in log order, so a reader joining a row's entries reads the text the
//! provider sent. A run with no reasoning answers `unavailable` on a first read, and a
//! continuation at the end answers an empty `available` page.

use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::session::event_cursor::{EventCursor, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::operations::{
    REASONING_ENTRY_CONTENT_MAX_LEN, REASONING_SURFACE_ENTRIES_MAX, ReasoningAvailable,
    ReasoningEntries, ReasoningEntry, ReasoningSurfaceContinuing, ReasoningSurfaceTerminal,
    ReasoningSurfaceUnavailable, ReasoningUnavailable, TranscriptReasoningReadRequest,
    TranscriptReasoningReadResponse,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_contracts::wire::{False, True};

use crate::database::stored_column::optional_utf8_blob_column;
use crate::events::session::read::{SessionEventReads, readable_event_sql, resolve_event_cursor};
use crate::ipc::domain_error::DomainError;
use crate::session::run::read::RunStateReader;
use crate::session::run::refusals::RunRefusal;
use crate::transcript::projector::TranscriptProjectionError;
use crate::transcript::window::{TranscriptReadError, read_transcript_head};

/// `text` cut into consecutive parts of at most one reasoning entry's length in Unicode scalar
/// values, cut on scalar boundaries; an empty text is one empty part.
pub(crate) fn split_reasoning_text(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some((cut, _)) = rest.char_indices().nth(REASONING_ENTRY_CONTENT_MAX_LEN) {
        let (part, after) = rest.split_at(cut);
        parts.push(part);
        rest = after;
    }
    parts.push(rest);
    parts
}

// The run's readable reasoning pieces after a position, in log order, each with the id of the row
// it belongs to: its row's first event, or the row's first readable piece when that one is not.
static REASONING_PIECES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT event.sequence, event.occurred_at, event.content_payload,
            coalesce(
              (SELECT anchor.id FROM session_events AS anchor
                WHERE anchor.session_id = event.session_id
                  AND anchor.sequence = coalesce(event.joins_sequence, event.sequence)
                  AND {readable_anchor}),
              (SELECT earlier.id FROM session_events AS earlier
                WHERE earlier.session_id = event.session_id
                  AND earlier.joins_sequence = event.joins_sequence AND {readable_earlier}
                ORDER BY earlier.sequence LIMIT 1))
       FROM session_events AS event
      WHERE event.session_id = @session_id AND event.type = '{thinking}'
        AND event.run_id = @run_id AND event.sequence > @after_position AND {readable_event}
      ORDER BY event.sequence",
        readable_anchor = readable_event_sql("anchor"),
        readable_earlier = readable_event_sql("earlier"),
        readable_event = readable_event_sql("event"),
        thinking = SessionEventType::AgentThinkingUpdated.as_str(),
    )
});

/// One reasoning entry being built from its row's pieces.
struct EntryDraft {
    sequence: i64,
    row_id: String,
    occurred_at: String,
    content: String,
    content_length: usize,
}

/// Reads one page of `request`'s run's reasoning on `reader`; `read_damaged_from_sequence` answers
/// where a damaged session's reads stop. Fails with [`TranscriptReadError::Refused`]
/// (`agent.run.notFound`) for a run this daemon does not hold, with
/// [`TranscriptReadError::CursorUnresolvable`] for a cursor that names no position, and with
/// [`TranscriptReadError::OversizedReasoningPiece`] for a stored piece longer than one entry.
pub(crate) fn read_reasoning<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    request: &TranscriptReasoningReadRequest,
) -> Result<TranscriptReasoningReadResponse, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader.unchecked_transaction()?;
    let Some(run) = RunStateReader::new(reader).read_run(&request.run_id)? else {
        return Err(DomainError::from(RunRefusal::NotFound {
            run_id: request.run_id,
        })
        .into());
    };
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let head = read_transcript_head(&reads, read_damaged_from_sequence, &run.session_id)?;
    let after_position = resolve_event_cursor(request.after_cursor.as_ref(), head)?;
    let mut statement = reader.prepare_cached(&REASONING_PIECES_SQL)?;
    let mut pieces = statement.query(named_params! {
        "@session_id": run.session_id.text().as_str(),
        "@run_id": request.run_id.text().as_str(),
        "@after_position": after_position,
        "@read_bound": reads.read_bound(&run.session_id, None),
    })?;
    let mut drafts: Vec<EntryDraft> = Vec::new();
    // The text read so far: once it passes a page, the page is cut below and the rest stays.
    let mut read_bytes = 0;
    let mut is_cut = false;
    while let Some(piece) = pieces.next()? {
        if drafts.len() > REASONING_SURFACE_ENTRIES_MAX || read_bytes > PAGE_MAX_BYTES {
            is_cut = true;
            break;
        }
        let sequence: i64 = piece.get(0)?;
        let Some(text) = optional_utf8_blob_column(piece, 2)?.filter(|text| !text.is_empty())
        else {
            continue;
        };
        let content_length = text.chars().count();
        if content_length > REASONING_ENTRY_CONTENT_MAX_LEN {
            return Err(TranscriptReadError::OversizedReasoningPiece { sequence });
        }
        read_bytes += text.len();
        let row_id: String = piece.get(3)?;
        match drafts.last_mut() {
            Some(draft)
                if draft.row_id == row_id
                    && draft.content_length + content_length <= REASONING_ENTRY_CONTENT_MAX_LEN =>
            {
                draft.sequence = sequence;
                draft.content.push_str(&text);
                draft.content_length += content_length;
            }
            _ => drafts.push(EntryDraft {
                sequence,
                row_id,
                occurred_at: piece.get(1)?,
                content: text,
                content_length,
            }),
        }
    }
    drop(pieces);
    drop(statement);
    snapshot.commit()?;
    if drafts.is_empty() && request.after_cursor.is_none() {
        return Ok(TranscriptReasoningReadResponse::Unavailable(
            ReasoningSurfaceUnavailable {
                availability: ReasoningUnavailable::Value,
            },
        ));
    }
    let entries = drafts
        .into_iter()
        .map(entry_of)
        .collect::<Result<Vec<_>, _>>()?;
    let page_count =
        count_entries_fitting_one_frame(&entries, REASONING_SURFACE_ENTRIES_MAX, PAGE_MAX_BYTES)
            .expect("a reasoning entry serializes");
    let has_more = is_cut || page_count < entries.len();
    let mut entries = entries;
    entries.truncate(page_count);
    let next_cursor = entries
        .last()
        .map(|entry| cursor_at(i64::from(entry.sequence)))
        .or_else(|| request.after_cursor.clone());
    if has_more {
        return Ok(TranscriptReasoningReadResponse::Continuing(
            ReasoningSurfaceContinuing {
                availability: ReasoningAvailable::Value,
                reasoning_entries: ReasoningEntries::new(entries)
                    .expect("a page that leaves more holds 1 to the cap of entries"),
                has_more: True::default(),
                next_cursor: next_cursor.expect("a page that leaves more holds an entry"),
            },
        ));
    }
    Ok(TranscriptReasoningReadResponse::Terminal(
        ReasoningSurfaceTerminal {
            availability: ReasoningAvailable::Value,
            reasoning_entries: ReasoningEntries::new(entries)
                .expect("a page holds at most the cap of entries"),
            has_more: False::default(),
            next_cursor,
        },
    ))
}

// The entry a draft makes; its row id and time were read from the log, which holds an event's id
// and a full instant.
fn entry_of(draft: EntryDraft) -> Result<ReasoningEntry, TranscriptReadError> {
    let sequence = u64::try_from(draft.sequence)
        .ok()
        .and_then(SafeInt::new)
        .expect("a stored sequence is a log position");
    Ok(ReasoningEntry {
        sequence,
        row_id: FreeFormText::new(draft.row_id).expect("a stored event id is an event id"),
        content: BoundedText::new(draft.content)
            .expect("an entry holds one to the cap's characters"),
        timestamp: WireInstant::try_from(draft.occurred_at).map_err(|cause| {
            TranscriptProjectionError::OccurredAt {
                sequence: sequence.get(),
                cause,
            }
        })?,
    })
}

fn cursor_at(position: i64) -> EventCursor {
    encode_event_cursor(position).expect("a position read from the log is a cursor position")
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::event_cursor::encode_event_cursor;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::transcript::operations::REASONING_ENTRY_CONTENT_MAX_LEN;

    use super::{read_reasoning, split_reasoning_text};
    use crate::transcript::test_log::{AT, TranscriptTestLog, wire_message};

    const THINKING: &str = "agent.thinking.updated";

    // The reasoning page of `run_id` after `after_cursor`, as JSON.
    fn read(log: &TranscriptTestLog, run_id: RunId, after_cursor: Option<i64>) -> Value {
        let mut request = json!({ "runId": run_id });
        if let Some(position) = after_cursor {
            request["afterCursor"] =
                json!(encode_event_cursor(position).expect("a test position is a cursor"));
        }
        let request = serde_json::from_value(request).expect("the test's request reads");
        let page = read_reasoning(&log.reader(), &|_: &SessionId| None, &request)
            .expect("the reasoning reads");
        wire_message(&page).0
    }

    // Killed by an entry holding pieces of two rows, by an entry past the cap, by an entry named
    // by its first piece, and by a row's entries named by another row.
    #[test]
    fn reasoning_entries_group_a_rows_consecutive_pieces_up_to_one_entry() {
        let log = TranscriptTestLog::new();
        let piece = "a".repeat(6_000);
        let (_, row_id) = log.piece(THINKING, log.run_id, "m1", Some(0), &piece, AT);
        let (second, _) = log.piece(THINKING, log.run_id, "m1", Some(0), &piece, AT);
        let (third, _) = log.piece(THINKING, log.run_id, "m1", Some(0), &piece, AT);
        let (other, other_row_id) = log.piece(THINKING, log.run_id, "m2", Some(0), "b", AT);

        let page = read(&log, log.run_id, None);
        let entries: Vec<(i64, String, usize)> = page["reasoningEntries"]
            .as_array()
            .expect("the page holds entries")
            .iter()
            .map(|entry| {
                (
                    entry["sequence"].as_i64().expect("an entry has a sequence"),
                    entry["rowId"]
                        .as_str()
                        .expect("an entry names its row")
                        .to_owned(),
                    entry["content"]
                        .as_str()
                        .expect("an entry holds text")
                        .len(),
                )
            })
            .collect();
        assert_eq!(
            entries,
            [
                (second, row_id.clone(), 12_000),
                (third, row_id, 6_000),
                (other, other_row_id, 1),
            ]
        );
    }

    // Killed by a run with no reasoning answering an empty page on its first read, and by a
    // continuation at the end answering `unavailable`.
    #[test]
    fn reasoning_is_unavailable_only_on_a_first_read_of_a_run_with_none() {
        let log = TranscriptTestLog::new();
        let (head, _) = log.reply("m1", Some(0), "No reasoning here.");

        assert_eq!(read(&log, log.run_id, None)["availability"], "unavailable");
        let at_end = read(&log, log.run_id, Some(head));
        assert_eq!(at_end["availability"], "available");
        assert_eq!(at_end["reasoningEntries"], json!([]));
        assert_eq!(at_end["hasMore"], false);
    }

    #[test]
    fn a_long_text_splits_on_scalar_boundaries_into_parts_of_at_most_one_entry() {
        // An astral character sits across the first cut, so a cut by bytes would split it.
        let text = format!(
            "{}\u{1f600}{}",
            "a".repeat(REASONING_ENTRY_CONTENT_MAX_LEN - 1),
            "b".repeat(2 * REASONING_ENTRY_CONTENT_MAX_LEN)
        );
        let parts = split_reasoning_text(&text);
        assert_eq!(parts.len(), 3);
        assert!(
            parts
                .iter()
                .all(|part| part.chars().count() <= REASONING_ENTRY_CONTENT_MAX_LEN)
        );
        assert_eq!(parts.concat(), text);
        assert_eq!(split_reasoning_text(""), [""]);
    }
}
