//! One `transcript.read` window: a bounded stretch of one session's log, projected into transcript
//! rows and cut to one page. A cursor is a log position: `afterCursor` reads the events after it
//! forward, `beforeCursor` the events at or below it backward, nearest the cursor first chosen, and
//! both together the events between them, read forward. Rows run oldest to newest either way.
//!
//! `aroundCursor` anchors the window at one row: the row standing at that cursor, up to half the
//! limit of the rows before it and the rest after it, read from that position on both sides and
//! never from the whole log. No row standing there refuses the read with
//! `transcript.row.notFound`; the budget keeps the nearest rows on each side and never cuts the
//! anchor, and the page continues toward the start as a `beforeCursor` page does.
//!
//! A page stops at the caller's limit or the page byte budget, whichever trips first, and says
//! whether more remain. One candidate past the limit is read to learn that, never projected. Each
//! page carries the facts of the runs its rows name, folded from the whole log through the head,
//! which share the page's budget with its rows.

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
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
use sidekicks_contracts::wire::integer::count_bound;
use sidekicks_contracts::wire::{False, True};

use crate::database::connection::read_pool::DatabaseReadError;
use crate::events::session::read::{
    SessionEventFilter, SessionEventReads, SessionLogReadError, resolve_event_cursor,
};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::session::not_found::session_not_found;
use crate::transcript::projector::{TranscriptProjectionError, project_window};
use crate::transcript::run_facts::TranscriptRunFactsReader;

/// Why a transcript read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptReadError {
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
            | TranscriptReadError::Pool(_)) => Self::Internal(Box::new(fault)),
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
/// returned as that row, for the reply's check to refuse.
pub(crate) fn read_transcript_window<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    request: &TranscriptReadRequest,
) -> Result<TranscriptReadResponse, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader.unchecked_transaction()?;
    let window = WindowReads {
        reader,
        read_damaged_from_sequence,
        session_id: &request.session_id,
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
    session_id: &'window SessionId,
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

    // The row at `around_cursor` with up to half of `limit` rows before it and the rest after it,
    // returned oldest first. Refused when no row stands at that cursor.
    fn read_around(
        &self,
        reads: &SessionEventReads<'_, &DamagedFrom>,
        head: Option<i64>,
        around_cursor: &EventCursor,
        limit: usize,
    ) -> Result<TranscriptReadResponse, TranscriptReadError> {
        let anchor_position = decode_event_cursor(around_cursor)?;
        let earlier_limit = (limit - 1) / 2;
        let later_limit = limit - 1 - earlier_limit;
        // The anchor and the rows before it, newest last, one more to learn whether more remain.
        let at_or_before = reads.read_before(
            self.session_id,
            anchor_position,
            count_bound(earlier_limit + 2),
        )?;
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
            reads.read_after(
                self.session_id,
                anchor_position,
                count_bound(later_limit),
                SessionEventFilter {
                    event_types: None,
                    before_sequence: None,
                },
            )?
        };
        let stretch: Vec<EventEnvelope> = earlier
            .iter()
            .chain(std::iter::once(anchor))
            .chain(&later)
            .cloned()
            .collect();
        let rows = self.project(&stretch)?;
        let stretch_runs = self.run_facts_of(head, &rows)?;
        // Nearest first: the anchor, then one row after and one before in turn, so a budget cut
        // drops the rows farthest from the anchor on each side and never the anchor itself.
        let anchor_index = earlier.len();
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
        let page_count =
            count_entries_fitting_one_frame(&nearest_rows, limit, row_budget_beside(&stretch_runs))
                .expect("a transcript row serializes");
        let kept = &nearest_first[..page_count];
        let oldest_kept = *kept.iter().min().expect("a page keeps the anchor");
        let newest_kept = *kept.iter().max().expect("a page keeps the anchor");
        let entries: Vec<TranscriptReadRow> = rows
            .into_iter()
            .skip(oldest_kept)
            .take(newest_kept + 1 - oldest_kept)
            .collect();
        let runs = runs_named_by(&entries, stretch_runs);
        // Rows remain before the page when the budget cut earlier rows or the read found one more
        // than it keeps; the page continues toward the start, as a `beforeCursor` page does.
        if oldest_kept > 0 || earlier_candidates.len() > earlier.len() {
            return Ok(TranscriptReadResponse::Continuing(
                TranscriptReadContinuing {
                    entries: ReadEntries::new(entries)
                        .expect("an anchored page holds the anchor and at most limit rows"),
                    runs,
                    has_more: True::default(),
                    next_cursor: cursor_at(i64::from(stretch[oldest_kept].sequence) - 1),
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
mod tests {
    use rusqlite::params;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::event_cursor::encode_event_cursor;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::transcript::operations::{
        TranscriptReadRequest, TranscriptReadResponse,
    };

    use super::{TranscriptReadError, read_transcript_window};
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    const AT: &str = "2026-10-14T09:00:00.000Z";

    fn anchored_read(session_id: &SessionId, sequence: i64) -> TranscriptReadRequest {
        serde_json::from_value(json!({
            "sessionId": session_id,
            "aroundCursor": encode_event_cursor(sequence).expect("a test position is a cursor"),
            "limit": 3,
        }))
        .expect("the test's request reads")
    }

    fn refusal_code(result: Result<TranscriptReadResponse, TranscriptReadError>) -> RefusalCode {
        let Err(TranscriptReadError::Refused(refusal)) = result else {
            panic!("the read is refused");
        };
        refusal.code
    }

    #[test]
    fn an_anchored_read_lands_a_standing_row_and_refuses_one_that_left() {
        let database = TestDatabase::new();
        let writer = database.opener()().expect("the test creates its database");
        let session_id = test_session_id();
        let session = session_id.text();
        for sequence in 0..5 {
            writer
                .execute(
                    "INSERT INTO session_events
                       (id, session_id, sequence, occurred_at, monotonic_ns, category, type,
                        payload)
                     VALUES (?1, ?2, ?3, ?4, 0, 'sessionLifecycle', 'session.pinned', ?5)",
                    params![
                        mint_uuid_v7().to_string(),
                        session.as_str(),
                        sequence,
                        AT,
                        json!({ "sessionId": session_id, "at": AT }).to_string()
                    ],
                )
                .expect("the test writes its row");
        }
        // The row at sequence 2 is left out of every read, as a skipped damaged row is.
        writer
            .execute(
                "INSERT INTO session_events
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
                 VALUES (?1, ?2, 5, ?3, 0, 'recoveryEvents', 'session.damagedEvents.skipped', ?4)",
                params![
                    mint_uuid_v7().to_string(),
                    session.as_str(),
                    AT,
                    json!({ "sessionId": session_id, "fromSequence": 2, "toSequence": 2 })
                        .to_string()
                ],
            )
            .expect("the test writes the skip");
        let reader = database.reader();
        let no_damage = |_: &SessionId| None;

        let TranscriptReadResponse::Continuing(page) =
            read_transcript_window(&reader, &no_damage, &anchored_read(&session_id, 3))
                .expect("a standing row answers its window")
        else {
            panic!("rows remain before the window, so the page continues");
        };
        let sequences: Vec<u64> = page
            .entries
            .as_slice()
            .iter()
            .map(|row| row.sequence().get())
            .collect();
        assert_eq!(sequences, [1, 3, 4]);
        assert_eq!(
            page.next_cursor,
            encode_event_cursor(0).expect("a test position is a cursor")
        );

        assert_eq!(
            refusal_code(read_transcript_window(
                &reader,
                &no_damage,
                &anchored_read(&session_id, 2)
            )),
            RefusalCode::TranscriptRowNotFound
        );
        assert_eq!(
            refusal_code(read_transcript_window(
                &reader,
                &no_damage,
                &anchored_read(&test_session_id(), 3)
            )),
            RefusalCode::SessionNotFound
        );
    }
}
