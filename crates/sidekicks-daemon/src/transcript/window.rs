//! One `transcript.read` window: a bounded stretch of one session's log, projected into transcript
//! rows and cut to one page. A cursor is a log position: `afterCursor` reads the events after it
//! forward, `beforeCursor` the events at or below it backward, nearest the cursor first chosen, and
//! both together the events between them, read forward. Rows run oldest to newest either way.
//!
//! A page stops at the caller's limit or the page byte budget, whichever trips first, and says
//! whether more remain. One candidate past the limit is read to learn that, never projected. Each
//! page carries the facts of the runs its rows name, folded from the whole log through the head,
//! which share the page's budget with its rows.

use std::collections::HashSet;

use rusqlite::Connection;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, EventCursorUnresolvable, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::limits::TRANSCRIPT_READ_LIMIT_MAX;
use sidekicks_contracts::transcript::operations::{
    ReadEntries, TranscriptReadContinuing, TranscriptReadRequest, TranscriptReadResponse,
    TranscriptReadTerminal, WindowRunFacts,
};
use sidekicks_contracts::transcript::row::TranscriptReadRow;
use sidekicks_contracts::transcript::run_facts::{FoldedThroughSequence, TranscriptRunFacts};
use sidekicks_contracts::wire::integer::count_bound;
use sidekicks_contracts::wire::{False, True};

use crate::events::session::read::{
    SessionEventFilter, SessionEventReads, SessionLogReadError, resolve_event_cursor,
};
use crate::ipc::domain_error::DomainError;
use crate::session::not_found::session_not_found;
use crate::transcript::projector::{TranscriptProjectionError, project_window};
use crate::transcript::run_facts::TranscriptRunFactsReader;

/// Why a transcript read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptReadError {
    /// The session is not one this daemon holds (`session.not_found`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A cursor names no position, or one past the session's newest event.
    #[error(transparent)]
    CursorUnresolvable(#[from] EventCursorUnresolvable),
    /// A read of the session's log failed, or a stored row is not a well-formed event.
    #[error(transparent)]
    Log(#[from] SessionLogReadError),
    /// SQLite refused the run facts' or the snapshot's read, or a stored value does not read.
    #[error("a read of a transcript window failed")]
    Database(#[from] rusqlite::Error),
    /// The window's events could not be projected into rows.
    #[error(transparent)]
    Projection(#[from] TranscriptProjectionError),
}

/// The head a transcript read checks its cursors against, `None` for a session whose history is
/// damaged before its first readable event. Fails with [`TranscriptReadError::Refused`]
/// (`session.not_found`) for a session this daemon holds no events for.
pub(crate) fn read_transcript_head<DamagedFrom>(
    reads: &SessionEventReads<'_, DamagedFrom>,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: &SessionId,
) -> Result<Option<i64>, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    let head = reads.read_head(session_id)?;
    if head.is_none() && read_damaged_from_sequence(session_id).is_none() {
        return Err(session_not_found(session_id).into());
    }
    Ok(head)
}

/// Reads one window on `reader`, its head, events and projection in one snapshot; a session whose
/// history is damaged before its first readable event reads as an empty log, and
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with
/// [`TranscriptReadError::Refused`] for a session this daemon holds no events for and
/// [`TranscriptReadError::CursorUnresolvable`] for a cursor that names no position or one past the
/// newest event. A page whose one row alone is over the page budget is returned as that row, for
/// the reply's check to refuse.
pub(crate) fn read_transcript_window<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    request: &TranscriptReadRequest,
) -> Result<TranscriptReadResponse, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    let snapshot = reader.unchecked_transaction()?;
    let window = WindowReads {
        reader,
        read_damaged_from_sequence,
        session_id: &request.session_id,
    };
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let head = read_transcript_head(&reads, read_damaged_from_sequence, &request.session_id)?;
    let after_position = resolve_event_cursor(request.after_cursor.as_ref(), head)?;
    let before_position = request
        .before_cursor
        .as_ref()
        .map(|cursor| resolve_event_cursor(Some(cursor), head))
        .transpose()?;
    let limit = request.limit.map_or(TRANSCRIPT_READ_LIMIT_MAX, |limit| {
        usize::try_from(limit.get()).expect("a read's limit is from 1 to its cap")
    });
    let response = match (before_position, request.after_cursor.is_some()) {
        (Some(before_position), false) => {
            window.read_backward(&reads, head, before_position, limit)?
        }
        (before_position, _) => {
            window.read_forward(&reads, head, after_position, before_position, limit)?
        }
    };
    snapshot.commit()?;
    Ok(response)
}

/// The reads of one window, all on one connection inside its snapshot.
struct WindowReads<'window, DamagedFrom> {
    reader: &'window Connection,
    read_damaged_from_sequence: &'window DamagedFrom,
    session_id: &'window SessionId,
}

impl<DamagedFrom> WindowReads<'_, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    // The oldest rows after `after_position`, up to `before_position` when one bounds the window.
    fn read_forward(
        &self,
        reads: &SessionEventReads<'_, &DamagedFrom>,
        head: Option<i64>,
        after_position: i64,
        before_position: Option<i64>,
        limit: usize,
    ) -> Result<TranscriptReadResponse, TranscriptReadError> {
        // The read's bound is strict, so the window keeps the event at `before_position`.
        let candidates = match before_position {
            None => self.read_after(reads, after_position, limit, None)?,
            Some(before) if before > after_position => {
                self.read_after(reads, after_position, limit, Some(before + 1))?
            }
            Some(_) => Vec::new(),
        };
        let stretch = &candidates[..limit.min(candidates.len())];
        let mut rows = self.project(stretch)?;
        let stretch_runs = self.run_facts_of(head, &rows)?;
        // Counted from the oldest end, so a budget cut keeps the rows nearest `afterCursor`,
        // whether or not `beforeCursor` bounds the window.
        let page_count =
            count_entries_fitting_one_frame(&rows, limit, row_budget_beside(&stretch_runs))
                .expect("a transcript row serializes");
        rows.truncate(page_count);
        let runs = runs_named_by(&rows, stretch_runs);
        // An empty page leaves the reader where it asked to read after.
        let newest_kept = page_count
            .checked_sub(1)
            .and_then(|index| stretch.get(index))
            .map_or(after_position, |event| i64::from(event.sequence));
        let next_cursor = cursor_at(newest_kept);
        Ok(if page_count < candidates.len() {
            TranscriptReadResponse::Continuing(TranscriptReadContinuing {
                entries: ReadEntries::new(rows)
                    .expect("a page that leaves more holds 1 to limit rows"),
                runs,
                has_more: True::default(),
                next_cursor,
            })
        } else {
            TranscriptReadResponse::Terminal(TranscriptReadTerminal {
                entries: ReadEntries::new(rows).expect("a page holds at most limit rows"),
                runs,
                has_more: False::default(),
                next_cursor: Some(next_cursor),
            })
        })
    }

    // The newest rows at or below `before_position`, returned oldest first.
    fn read_backward(
        &self,
        reads: &SessionEventReads<'_, &DamagedFrom>,
        head: Option<i64>,
        before_position: i64,
        limit: usize,
    ) -> Result<TranscriptReadResponse, TranscriptReadError> {
        let candidates =
            reads.read_before(self.session_id, before_position, count_bound(limit + 1))?;
        let stretch = &candidates[candidates.len().saturating_sub(limit)..];
        let mut rows = self.project(stretch)?;
        let stretch_runs = self.run_facts_of(head, &rows)?;
        // Counted from the newest end, so a budget cut drops the rows farthest from the cursor.
        let newest_first: Vec<&TranscriptReadRow> = rows.iter().rev().collect();
        let page_count =
            count_entries_fitting_one_frame(&newest_first, limit, row_budget_beside(&stretch_runs))
                .expect("a transcript row serializes");
        let entries = rows.split_off(rows.len() - page_count);
        let runs = runs_named_by(&entries, stretch_runs);
        // Every candidate made the page (an empty one included): the page reached the start of the
        // log, so no earlier window remains to name.
        let oldest_kept = stretch.get(stretch.len() - page_count);
        if let Some(oldest_kept) = oldest_kept
            && page_count < candidates.len()
        {
            return Ok(TranscriptReadResponse::Continuing(
                TranscriptReadContinuing {
                    entries: ReadEntries::new(entries)
                        .expect("a page that leaves more holds 1 to limit rows"),
                    runs,
                    has_more: True::default(),
                    next_cursor: cursor_at(i64::from(oldest_kept.sequence) - 1),
                },
            ));
        }
        Ok(TranscriptReadResponse::Terminal(TranscriptReadTerminal {
            entries: ReadEntries::new(entries).expect("a page holds at most limit rows"),
            runs,
            has_more: False::default(),
            next_cursor: None,
        }))
    }

    // Up to `limit` events after `after_position`, one more to learn whether more remain.
    fn read_after(
        &self,
        reads: &SessionEventReads<'_, &DamagedFrom>,
        after_position: i64,
        limit: usize,
        before_sequence: Option<i64>,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        reads.read_after(
            self.session_id,
            after_position,
            count_bound(limit + 1),
            SessionEventFilter {
                event_types: None,
                before_sequence,
            },
        )
    }

    fn project(
        &self,
        stretch: &[EventEnvelope],
    ) -> Result<Vec<TranscriptReadRow>, TranscriptReadError> {
        Ok(project_window(
            self.reader,
            self.read_damaged_from_sequence,
            self.session_id,
            stretch,
        )?)
    }

    // The facts of every run `rows` name, in the order each is first named. A head that is absent
    // reads no rows, so it names no run.
    fn run_facts_of(
        &self,
        head: Option<i64>,
        rows: &[TranscriptReadRow],
    ) -> rusqlite::Result<Vec<TranscriptRunFacts>> {
        let Some(head) = head else {
            return Ok(Vec::new());
        };
        let mut named = HashSet::new();
        let run_ids: Vec<RunId> = rows
            .iter()
            .filter_map(TranscriptReadRow::run_id)
            .filter(|run_id| named.insert(*run_id))
            .cloned()
            .collect();
        TranscriptRunFactsReader::new(self.reader, self.read_damaged_from_sequence).read(
            self.session_id,
            &run_ids,
            FoldedThroughSequence::new(head).expect("a session's head is a log position"),
        )
    }
}

// The bytes a page's rows may take beside the facts of every run its stretch names, which the
// kept rows' facts never exceed: at most one fact per row, each far below the page budget.
fn row_budget_beside(stretch_runs: &[TranscriptRunFacts]) -> usize {
    let runs_bytes = json_utf8_byte_length(&stretch_runs).expect("run facts serialize");
    PAGE_MAX_BYTES
        .checked_sub(runs_bytes)
        .expect("a window's run facts stay within the page budget")
}

// The facts of the runs `entries` name, from those of the stretch they were cut from.
fn runs_named_by(
    entries: &[TranscriptReadRow],
    stretch_runs: Vec<TranscriptRunFacts>,
) -> WindowRunFacts {
    let named: HashSet<&RunId> = entries
        .iter()
        .filter_map(TranscriptReadRow::run_id)
        .collect();
    let runs = stretch_runs
        .into_iter()
        .filter(|facts| named.contains(&facts.run_id))
        .collect();
    WindowRunFacts::new(runs).expect("a page names at most one run per row")
}

fn cursor_at(position: i64) -> EventCursor {
    encode_event_cursor(position).expect("a position read from the log is a cursor position")
}
