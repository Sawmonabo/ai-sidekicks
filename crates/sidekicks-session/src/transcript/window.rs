//! One `transcript.read` window: a bounded stretch of one session's rows, projected and cut to one
//! page. A row stands at its first event; a later piece of a reply or of reasoning, or a stored
//! part of a tool completion's patched files, is never a row of its own, and joins its row's body
//! through the read's head, which every page names as `joinedThrough`. A cursor is a log position:
//! `afterCursor` reads the rows after it forward, `beforeCursor` the rows at or below it backward,
//! nearest the cursor first chosen, and both together the rows between them, read forward. Rows
//! run oldest to newest either way. An unbounded forward read that reaches the end names the head
//! as its next cursor, so a stream opened there sends no piece the read already joined; one
//! bounded by `beforeCursor` names its bound.
//!
//! `aroundCursor` anchors the window at one row: the row standing at that cursor, or the row a
//! piece there joins, up to half the limit of the rows before it and the rest after it, read from
//! that position on both sides and never from the whole log. No readable event there refuses the
//! read with `transcript.row.notFound`; the budget keeps the nearest rows on each side and never
//! cuts the anchor, and the page continues toward the start as a `beforeCursor` page does.
//!
//! A page stops at the caller's limit or the page byte budget, whichever trips first, and says
//! whether more remain. One candidate past the limit is read to learn that, never projected. An
//! event that stands as no row, a task-list call, takes a place in the limit; a stretch with none is
//! passed over, so a page that continues holds a row, up to [`PASSED_OVER_STRETCHES_MAX`] stretches
//! a request, past which the page continues empty after the last. Each page carries the facts of
//! the runs its rows name, folded from the whole log through the head, which share the page's
//! budget with its rows.

use std::collections::HashSet;
use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, SessionEventCursorUnresolvable, decode_event_cursor, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::limits::TRANSCRIPT_READ_LIMIT_MAX;
use sidekicks_contracts::transcript::operations::{
    ReadEntries, TranscriptReadContinuing, TranscriptReadRequest, TranscriptReadResponse,
    TranscriptReadTerminal, WindowRunFacts,
};
use sidekicks_contracts::transcript::row::TranscriptReadRow;
use sidekicks_contracts::transcript::run_facts::{FoldedThroughSequence, TranscriptRunFacts};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::count_bound;
use sidekicks_contracts::wire::{False, True};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::session::read::{
    SessionEventReads, SessionLogReadError, resolve_event_cursor,
};
use sidekicks_store::transcript::rejoin::RowReads;

use crate::transcript::block_cut::BlockParse;
use crate::transcript::child_run::stamp_child_run_summaries;
use crate::transcript::projector::{TranscriptProjectionError, project_window};
use crate::transcript::run_facts::TranscriptRunFactsReader;

/// The most stretches of events standing as no row one read passes over: a request projects at
/// most this many times its limit of events, and past them its page continues empty.
pub(crate) const PASSED_OVER_STRETCHES_MAX: usize = 4;

/// Why a transcript read failed.
#[derive(Debug, thiserror::Error)]
pub enum TranscriptReadError {
    /// The session is not one this daemon holds (`session.notFound`), or no row stands at an
    /// anchor cursor (`transcript.row.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A cursor names no position, or one past the session's newest event.
    #[error(transparent)]
    CursorUnresolvable(#[from] SessionEventCursorUnresolvable),
    /// A read of the session's log failed, or a stored row is not a well-formed event.
    #[error(transparent)]
    Log(#[from] SessionLogReadError),
    /// SQLite refused the run facts' or the snapshot's read, or a stored value does not read.
    #[error("a read of a transcript window failed")]
    Database(#[from] rusqlite::Error),
    /// The window's events could not be projected into rows.
    #[error(transparent)]
    Projection(#[from] TranscriptProjectionError),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A stored reasoning piece holds more than one entry's text, which only a write outside the
    /// reasoning append can leave.
    #[error("the reasoning piece at sequence {sequence} is longer than one entry")]
    OversizedReasoningPiece {
        /// The piece's sequence.
        sequence: i64,
    },
}

impl From<TranscriptReadError> for HandlerError {
    /// A session the daemon does not hold or a row it does not hold answers by its code, a cursor
    /// it cannot read `session.event.cursorUnresolvable`; a failed read is a fault in the daemon.
    fn from(error: TranscriptReadError) -> Self {
        match error {
            TranscriptReadError::Refused(refusal) => Self::Refused(refusal),
            TranscriptReadError::CursorUnresolvable(unresolvable) => unresolvable.into(),
            fault @ (TranscriptReadError::Log(_)
            | TranscriptReadError::Database(_)
            | TranscriptReadError::Projection(_)
            | TranscriptReadError::Pool(_)
            | TranscriptReadError::OversizedReasoningPiece { .. }) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// The head a transcript read checks its cursors against, `None` for a session whose history is
/// damaged before its first readable event. Fails with [`TranscriptReadError::Refused`]
/// (`session.notFound`) for a session this daemon holds no events for.
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
/// newest event, and with [`TranscriptReadError::Refused`] (`transcript.row.notFound`) for an
/// `aroundCursor` at which no row stands. A page whose one row alone is over the page budget is
/// returned as that row, for the reply's check to refuse. A reply's body is cut into blocks by
/// `parse`, and a task-list call the driver `driver_of` answers for the session's provider reads
/// as one stands as no row.
pub fn read_transcript_window<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    driver_of: &dyn Fn(&ProviderId) -> Option<Arc<dyn ProviderDriver>>,
    request: &TranscriptReadRequest,
    parse: BlockParse,
) -> Result<TranscriptReadResponse, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader.unchecked_transaction()?;
    let window = WindowReads {
        reader,
        read_damaged_from_sequence,
        driver_of,
        session_id: &request.session_id,
        observed_at: WireInstant::now(),
        parse,
    };
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let head = read_transcript_head(&reads, read_damaged_from_sequence, &request.session_id)?;
    let limit = request.limit.map_or(TRANSCRIPT_READ_LIMIT_MAX, |limit| {
        usize::try_from(limit.get()).expect("a read's limit is from 1 to its cap")
    });
    if let Some(around_cursor) = &request.around_cursor {
        let response = window.read_around(&reads, head, around_cursor, limit)?;
        snapshot.commit()?;
        return Ok(response);
    }
    let after_position = resolve_event_cursor(request.after_cursor.as_ref(), head)?;
    let before_position = request
        .before_cursor
        .as_ref()
        .map(|cursor| resolve_event_cursor(Some(cursor), head))
        .transpose()?;
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
struct WindowReads<'window, DamagedFrom: ?Sized> {
    reader: &'window Connection,
    read_damaged_from_sequence: &'window DamagedFrom,
    // The driver that answers a provider, which reads the session's task-list calls.
    driver_of: &'window dyn Fn(&ProviderId) -> Option<Arc<dyn ProviderDriver>>,
    session_id: &'window SessionId,
    // When the read began, the time a child row's summary is marked incomplete as of.
    observed_at: WireInstant,
    // The parse a reply's body is cut into blocks by.
    parse: BlockParse,
}

impl<DamagedFrom> WindowReads<'_, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
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
        let rows_of = RowReads::new(reads, self.reader, self.session_id);
        // A stretch whose every event stands as no row is passed over while more follow, so a page
        // that continues holds a row, up to the request's cap.
        let mut stretch_after = after_position;
        let mut stretches = 0;
        let (stretch, mut rows, has_later) = loop {
            stretches += 1;
            // The read's bound is strict, so the window keeps the event at `before_position`.
            let mut stretch = match before_position {
                Some(before) if before <= stretch_after => Vec::new(),
                before_position => rows_of.rows_after(
                    stretch_after,
                    before_position.map(|before| before + 1),
                    count_bound(limit + 1),
                )?,
            };
            let has_later = stretch.len() > limit;
            stretch.truncate(limit);
            let rows = self.project(&stretch, head)?;
            let Some(newest) = stretch
                .last()
                .filter(|_| rows.is_empty() && has_later && stretches < PASSED_OVER_STRETCHES_MAX)
            else {
                break (stretch, rows, has_later);
            };
            stretch_after = i64::from(newest.sequence);
        };
        let projected_count = rows.len();
        let stretch_runs = self.run_facts_of(head, &rows)?;
        // Counted from the oldest end, so a budget cut keeps the rows nearest `afterCursor`,
        // whether or not `beforeCursor` bounds the window.
        let page_count = count_entries_fitting_one_frame(
            &rows,
            limit,
            row_budget_beside(&stretch_runs),
            json_utf8_byte_length,
        )
        .expect("a transcript row serializes");
        rows.truncate(page_count);
        let runs = runs_named_by(&rows, stretch_runs);
        let joined_through = head.map(cursor_at);
        if page_count < projected_count || has_later {
            // A budget cut continues after the newest row kept, else after the whole stretch.
            let continues_after = if page_count < projected_count {
                rows[page_count - 1].sequence()
            } else {
                stretch
                    .last()
                    .expect("a stretch with more after it is read")
                    .sequence
            };
            return Ok(TranscriptReadResponse::Continuing(
                TranscriptReadContinuing {
                    entries: ReadEntries::new(rows).expect("a page holds at most limit rows"),
                    runs,
                    has_more: True::default(),
                    next_cursor: cursor_at(i64::from(continues_after)),
                    joined_through: joined_through
                        .expect("a page that leaves more read a session with a head"),
                },
            ));
        }
        // The read reached its end: its bound where one was given, else the head it joined
        // through, else where it was asked to read after.
        let end = before_position
            .or(head)
            .map_or(stretch_after, |end| end.max(stretch_after));
        Ok(TranscriptReadResponse::Terminal(TranscriptReadTerminal {
            entries: ReadEntries::new(rows).expect("a page holds at most limit rows"),
            runs,
            has_more: False::default(),
            next_cursor: Some(cursor_at(end)),
            joined_through,
        }))
    }

    // The newest rows at or below `before_position`, returned oldest first.
    fn read_backward(
        &self,
        reads: &SessionEventReads<'_, &DamagedFrom>,
        head: Option<i64>,
        before_position: i64,
        limit: usize,
    ) -> Result<TranscriptReadResponse, TranscriptReadError> {
        let rows_of = RowReads::new(reads, self.reader, self.session_id);
        // A stretch whose every event stands as no row is passed over while more precede it, up
        // to the request's cap.
        let mut stretch_before = before_position;
        let mut stretches = 0;
        let (stretch, mut rows, has_earlier) = loop {
            stretches += 1;
            let mut candidates =
                rows_of.rows_at_or_before(stretch_before, count_bound(limit + 1))?;
            let has_earlier = candidates.len() > limit;
            let stretch = candidates.split_off(candidates.len().saturating_sub(limit));
            let rows = self.project(&stretch, head)?;
            let Some(oldest) = stretch.first().filter(|_| {
                rows.is_empty() && has_earlier && stretches < PASSED_OVER_STRETCHES_MAX
            }) else {
                break (stretch, rows, has_earlier);
            };
            stretch_before = i64::from(oldest.sequence) - 1;
        };
        let projected_count = rows.len();
        let stretch_runs = self.run_facts_of(head, &rows)?;
        // Counted from the newest end, so a budget cut drops the rows farthest from the cursor.
        let newest_first: Vec<&TranscriptReadRow> = rows.iter().rev().collect();
        let page_count = count_entries_fitting_one_frame(
            &newest_first,
            limit,
            row_budget_beside(&stretch_runs),
            json_utf8_byte_length,
        )
        .expect("a transcript row serializes");
        let entries = rows.split_off(rows.len() - page_count);
        let runs = runs_named_by(&entries, stretch_runs);
        let joined_through = head.map(cursor_at);
        // A page continues while a budget cut left rows out or an earlier event remains; else it
        // reached the start of the log (an empty page included), so no earlier window remains.
        if page_count < projected_count || has_earlier {
            // A budget cut continues before the oldest row kept, else before the whole stretch.
            let continues_before = if page_count < projected_count {
                entries[0].sequence()
            } else {
                stretch
                    .first()
                    .expect("a stretch with more before it is read")
                    .sequence
            };
            return Ok(TranscriptReadResponse::Continuing(
                TranscriptReadContinuing {
                    entries: ReadEntries::new(entries).expect("a page holds at most limit rows"),
                    runs,
                    has_more: True::default(),
                    next_cursor: cursor_at(i64::from(continues_before) - 1),
                    joined_through: joined_through
                        .expect("a page that leaves more read a session with a head"),
                },
            ));
        }
        Ok(TranscriptReadResponse::Terminal(TranscriptReadTerminal {
            entries: ReadEntries::new(entries).expect("a page holds at most limit rows"),
            runs,
            has_more: False::default(),
            next_cursor: None,
            joined_through,
        }))
    }

    // The row at `around_cursor`, or the row a piece there joins, with up to half of `limit` rows
    // before it and the rest after it, returned oldest first. Refused when no readable event sits
    // at that cursor.
    fn read_around(
        &self,
        reads: &SessionEventReads<'_, &DamagedFrom>,
        head: Option<i64>,
        around_cursor: &EventCursor,
        limit: usize,
    ) -> Result<TranscriptReadResponse, TranscriptReadError> {
        let rows_of = RowReads::new(reads, self.reader, self.session_id);
        let Some(anchor_position) = rows_of.row_at(decode_event_cursor(around_cursor)?)? else {
            return Err(transcript_row_not_found(around_cursor).into());
        };
        let earlier_limit = (limit - 1) / 2;
        let later_limit = limit - 1 - earlier_limit;
        // The anchor and the rows before it, newest last, one more to learn whether more remain.
        let at_or_before =
            rows_of.rows_at_or_before(anchor_position, count_bound(earlier_limit + 2))?;
        let Some((anchor, earlier_candidates)) = at_or_before
            .split_last()
            .filter(|(anchor, _)| i64::from(anchor.sequence) == anchor_position)
        else {
            return Err(transcript_row_not_found(around_cursor).into());
        };
        let earlier = &earlier_candidates[earlier_candidates.len().saturating_sub(earlier_limit)..];
        // The rows after it, exactly as many as the page holds: the page continues toward the
        // start alone, so nothing is read to learn whether more follow.
        let later = if later_limit == 0 {
            Vec::new()
        } else {
            rows_of.rows_after(anchor_position, None, count_bound(later_limit))?
        };
        let stretch: Vec<EventEnvelope> = earlier
            .iter()
            .chain(std::iter::once(anchor))
            .chain(&later)
            .cloned()
            .collect();
        let rows = self.project(&stretch, head)?;
        // An anchor that stands as no row, a task-list call, is no row to land on.
        let Some(anchor_index) = rows
            .iter()
            .position(|row| i64::from(row.sequence()) == anchor_position)
        else {
            return Err(transcript_row_not_found(around_cursor).into());
        };
        let stretch_runs = self.run_facts_of(head, &rows)?;
        // Nearest first: the anchor, then one row after and one before in turn, so a budget cut
        // drops the rows farthest from the anchor on each side and never the anchor itself.
        let nearest_first: Vec<usize> = std::iter::once(anchor_index)
            .chain(
                (1..rows.len())
                    .flat_map(|distance| {
                        [anchor_index + distance, anchor_index.wrapping_sub(distance)]
                    })
                    .filter(|&index| index < rows.len()),
            )
            .collect();
        let nearest_rows: Vec<&TranscriptReadRow> =
            nearest_first.iter().map(|&index| &rows[index]).collect();
        let page_count = count_entries_fitting_one_frame(
            &nearest_rows,
            limit,
            row_budget_beside(&stretch_runs),
            json_utf8_byte_length,
        )
        .expect("a transcript row serializes");
        let kept = &nearest_first[..page_count];
        let oldest_kept = *kept.iter().min().expect("a page keeps the anchor");
        let newest_kept = *kept.iter().max().expect("a page keeps the anchor");
        // A budget cut continues before the oldest row kept, else before the whole stretch.
        let continues_before = if oldest_kept > 0 {
            rows[oldest_kept].sequence()
        } else {
            stretch[0].sequence
        };
        let entries: Vec<TranscriptReadRow> = rows
            .into_iter()
            .skip(oldest_kept)
            .take(newest_kept + 1 - oldest_kept)
            .collect();
        let runs = runs_named_by(&entries, stretch_runs);
        let joined_through = head.map(cursor_at);
        // Rows remain before the page when the budget cut earlier rows or the read found one more
        // than it keeps; the page continues toward the start, as a `beforeCursor` page does.
        if oldest_kept > 0 || earlier_candidates.len() > earlier.len() {
            return Ok(TranscriptReadResponse::Continuing(
                TranscriptReadContinuing {
                    entries: ReadEntries::new(entries)
                        .expect("an anchored page holds the anchor and at most limit rows"),
                    runs,
                    has_more: True::default(),
                    next_cursor: cursor_at(i64::from(continues_before) - 1),
                    joined_through: joined_through
                        .expect("an anchored page read a session with a head"),
                },
            ));
        }
        Ok(TranscriptReadResponse::Terminal(TranscriptReadTerminal {
            entries: ReadEntries::new(entries).expect("a page holds at most limit rows"),
            runs,
            has_more: False::default(),
            next_cursor: None,
            joined_through,
        }))
    }

    fn project(
        &self,
        stretch: &[EventEnvelope],
        head: Option<i64>,
    ) -> Result<Vec<TranscriptReadRow>, TranscriptReadError> {
        // A head that is absent reads no rows, so nothing is joined.
        let Some(head) = head else {
            return Ok(Vec::new());
        };
        let mut rows = project_window(
            self.reader,
            self.read_damaged_from_sequence,
            self.driver_of,
            self.session_id,
            stretch,
            head,
            self.parse,
        )?;
        stamp_child_run_summaries(
            self.reader,
            self.read_damaged_from_sequence,
            self.session_id,
            &mut rows,
            head,
            &self.observed_at,
        )?;
        Ok(rows)
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
            .copied()
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

// The refusal of an anchor cursor at which no row of the session stands; the cursor goes out as
// the reply's `aroundCursor` field.
fn transcript_row_not_found(around_cursor: &EventCursor) -> DomainError {
    DomainError::new(
        "No row of this session stands at that cursor.",
        RefusalCode::TranscriptRowNotFound,
    )
    .with_detail(json!({ "aroundCursor": around_cursor }))
}

fn cursor_at(position: i64) -> EventCursor {
    encode_event_cursor(position).expect("a position read from the log is a cursor position")
}

#[cfg(test)]
mod tests;
