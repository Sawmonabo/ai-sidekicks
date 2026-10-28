//! `transcript.search`: one session's hits from the search index, over every row the session holds
//! whether or not a screen has loaded it. Hits come newest first, one per row, and the match count
//! covers every match in the session, counted as the lines are marked, so a find box's count speaks
//! for all of it. A hit's line is read from the database by its key and marked on its text there;
//! a row gone since the index saw it is passed over, and so is a key whose rowid a later row may
//! have taken since, which the rowid floor log names until the index has caught up.

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::session::event_cursor::{
    EventCursorPositionOutOfRange, SessionEventCursorUnresolvable, decode_event_cursor,
    encode_event_cursor,
};
use sidekicks_contracts::transcript::limits::{
    TRANSCRIPT_READ_LIMIT_MAX, TRANSCRIPT_SEARCH_TEXT_MAX_LEN,
};
use sidekicks_contracts::transcript::search::{
    TranscriptSearchContinuing, TranscriptSearchHit, TranscriptSearchRequest,
    TranscriptSearchResponse, TranscriptSearchTerminal,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText, TextError};
use sidekicks_contracts::wire::{False, True};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_search::index::{SearchIndex, SearchIndexError, SearchQuery, SessionFind};
use sidekicks_store::database::stored_column::rowid_column;

use crate::search::hits::{HitLine, HitLineReader};
use crate::search::index::rows::IndexRowReader;
use crate::search::query::parse_find_query;
use crate::search::rowid_floors::RowidFloorLog;

const SESSION_KEY_SQL: &str = "SELECT rowid FROM sessions WHERE id = ?";

/// Why a `transcript.search` call failed.
#[derive(Debug, thiserror::Error)]
pub enum TranscriptSearchError {
    /// The session is not one this daemon holds.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The before cursor names no position in the session's log.
    #[error(transparent)]
    CursorUnresolvable(#[from] SessionEventCursorUnresolvable),
    /// A database read failed, or a stored value did not read as its type.
    #[error("the transcript search's database read failed")]
    Database(#[from] rusqlite::Error),
    /// The search index failed a read or is closed.
    #[error("the transcript search's index read failed")]
    Index(#[from] SearchIndexError),
    /// A hit's stored sequence names no position an event cursor can carry.
    #[error("a hit's stored sequence names no position an event cursor can carry")]
    HitPosition(#[from] EventCursorPositionOutOfRange),
    /// A hit's stored event id is not text a row id can carry.
    #[error("a hit's stored event id is not text a row id can carry")]
    HitRowId(#[from] TextError),
}

/// One page of the session's hits, newest first, before `before_cursor` when it is given, read on
/// `reader` and `index` in one read transaction. A session whose history is damaged from
/// `damaged_from_sequence` on is searched before that point alone, its hits and its match count
/// both, as its reads stop there; `applied_floor_position` is where the rowid floor log stood when
/// the index last matched the database, read before the call. Fails with `session.notFound` for a
/// session the daemon does not hold, with [`SessionEventCursorUnresolvable`] for a cursor that
/// names no position, and as a database or index read fails.
pub(crate) fn search_transcript(
    reader: &Connection,
    index: &SearchIndex,
    request: &TranscriptSearchRequest,
    damaged_from_sequence: Option<i64>,
    applied_floor_position: i64,
) -> Result<TranscriptSearchResponse, TranscriptSearchError> {
    let transaction = reader.unchecked_transaction()?;
    let response = answer(
        &transaction,
        index,
        request,
        damaged_from_sequence,
        applied_floor_position,
    )?;
    transaction.commit()?;
    Ok(response)
}

fn answer(
    reader: &Connection,
    index: &SearchIndex,
    request: &TranscriptSearchRequest,
    damaged_from_sequence: Option<i64>,
    applied_floor_position: i64,
) -> Result<TranscriptSearchResponse, TranscriptSearchError> {
    let session_key: Option<u64> = reader
        .prepare_cached(SESSION_KEY_SQL)?
        .query_row([request.session_id.text().as_str()], |row| {
            rowid_column(row, 0)
        })
        .optional()?;
    let Some(session_key) = session_key else {
        return Err(session_not_found(&request.session_id).into());
    };
    let before_sequence = request
        .before_cursor
        .as_ref()
        .map(decode_event_cursor)
        .transpose()?;
    let Some(search_query) = parse_find_query(request.query.as_str()) else {
        return Ok(terminal_page(SafeInt::ZERO, Vec::new()));
    };
    let SessionFind {
        row_keys,
        match_counts,
    } = held_matches(
        reader,
        index,
        session_key,
        &search_query,
        applied_floor_position,
    )?;
    // The first place, highest key first, whose row sits before `sequence`.
    let place_before = |sequence: Option<i64>| -> rusqlite::Result<usize> {
        let Some(sequence) = sequence else {
            return Ok(0);
        };
        let highest_key =
            IndexRowReader::new(reader).highest_key_before(&request.session_id, sequence)?;
        Ok(highest_key.map_or(row_keys.len(), |highest_key| {
            row_keys.partition_point(|&key| key > highest_key)
        }))
    };
    // The rows a damaged session's reads still reach, which the count covers whole.
    let first_readable_place = place_before(damaged_from_sequence)?;
    let first_place = first_readable_place.max(place_before(before_sequence)?);
    let match_count: u64 = match_counts[first_readable_place..]
        .iter()
        .map(|&row_match_count| u64::from(row_match_count))
        .sum();
    let match_count = SafeInt::new(match_count)
        .expect("each match marks a character, so a session's count is far below 2^53");
    let limit = request.limit.map_or(TRANSCRIPT_READ_LIMIT_MAX, |limit| {
        usize::try_from(limit.get()).expect("a read limit is from 1 to the read limit's bound")
    });
    let hit_lines = HitLineReader::new(IndexRowReader::new(reader), TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
    // One candidate past the limit shows whether more remain.
    let lines = hit_lines
        .read_lines(&[&row_keys[first_place..]], &search_query, limit + 1)?
        .into_iter()
        .next()
        .unwrap_or_default();
    let mut candidates = lines
        .into_iter()
        .filter_map(|hit_line| hit_of(hit_line).transpose())
        .collect::<Result<Vec<_>, _>>()?;
    let page_size =
        count_entries_fitting_one_frame(&candidates, limit, PAGE_MAX_BYTES, json_utf8_byte_length)
            .expect("a transcript search hit serializes: it holds only text and integers");
    let has_more = candidates.len() > page_size;
    candidates.truncate(page_size);
    let next_cursor = candidates.last().map(|last_hit| last_hit.cursor.clone());
    Ok(match next_cursor.filter(|_| has_more) {
        Some(next_cursor) => TranscriptSearchResponse::Continuing(TranscriptSearchContinuing {
            match_count,
            hits: BoundedVec::new(candidates)
                .expect("a page with more after it holds 1 to the read limit's hits"),
            has_more: True::default(),
            next_cursor,
        }),
        None => terminal_page(match_count, candidates),
    })
}

// The last page, holding `hits`.
fn terminal_page(
    match_count: SafeInt<0>,
    hits: Vec<TranscriptSearchHit>,
) -> TranscriptSearchResponse {
    TranscriptSearchResponse::Terminal(TranscriptSearchTerminal {
        match_count,
        hits: BoundedVec::new(hits).expect("a page holds at most the read limit's hits"),
        has_more: False::default(),
    })
}

// The session's hits, highest key first, and each one's match count, without a key whose rowid a
// later row may have taken since the index last matched the database: that row can be another
// session's, and its position would start the next page in another session's log.
fn held_matches(
    reader: &Connection,
    index: &SearchIndex,
    session_key: u64,
    search_query: &SearchQuery,
    applied_floor_position: i64,
) -> Result<SessionFind, TranscriptSearchError> {
    let held_row_check = RowidFloorLog::new(reader).held_row_check(applied_floor_position)?;
    let found = index.find_in_session(session_key, search_query)?;
    let Some(check) = held_row_check else {
        return Ok(found);
    };
    let (row_keys, match_counts) = found
        .row_keys
        .into_iter()
        .zip(found.match_counts)
        .filter(|&(key, _)| check.is_held(key))
        .unzip();
    Ok(SessionFind {
        row_keys,
        match_counts,
    })
}

// A hit as the page shows it; `None` for a row that names no place in the session's log.
fn hit_of(hit_line: HitLine) -> Result<Option<TranscriptSearchHit>, TranscriptSearchError> {
    let HitLine {
        log_row, marked, ..
    } = hit_line;
    let Some(log_row) = log_row else {
        return Ok(None);
    };
    Ok(Some(TranscriptSearchHit {
        row_id: FreeFormText::new(log_row.event_id)?,
        cursor: encode_event_cursor(log_row.sequence)?,
        snippet: BoundedText::new(marked.line)
            .expect("a snippet holds its first match and is cut to its bound in code points"),
        match_ranges: BoundedVec::new(marked.match_ranges)
            .expect("a hit's first match starts inside its cut line, so its range is kept"),
    }))
}
