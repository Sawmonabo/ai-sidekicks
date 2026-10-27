//! `session.search`: every session's hits from the search index, archived sessions included, one
//! page at a time, so every hit is reachable while each answer stays inside its budget and one
//! message. Hits are grouped by session, the sessions in the order of their best hit.
//!
//! Words rank by the index's BM25 order. The first page opens a view of the index and holds it, and
//! every later page reads that view, so a write between pages neither repeats nor drops a hit the
//! view held. A hit's line is read from the database by its key and marked on the row's text as it
//! is now: a hit whose row is gone is passed over, and so is one whose rowid a later row has taken
//! since the view, which the rowid floor log tells. A `tag:<tag>` term keeps the sessions that
//! carry that tag or one nested under it, which the index finds without scoring: with words, the
//! index ranks only those sessions' rows; with no word, the sessions come most recently active
//! first and their hits are the tags that matched. Names, groups and lines are read only for a
//! page's own sessions. The search box names no session, so no relation rank takes part.

use std::collections::{HashMap, VecDeque};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use rusqlite::Connection;
use sidekicks_contracts::session::event_cursor::{
    EventCursorPositionOutOfRange, START_OF_LOG_POSITION, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionSearchContinuing, SessionSearchCursor, SessionSearchHit, SessionSearchRequest,
    SessionSearchResponse, SessionSearchTerminal,
};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::session::search::{
    SESSION_SEARCH_HIT_LINE_MAX_LEN, SESSION_SEARCH_PAGE_LIMIT_MAX,
};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_contracts::wire::{False, True};
use sidekicks_search::index::{HeldSearch, IndexRowKind, SearchIndex, SearchIndexError};

use crate::search::cursor::{
    SearchCursorPosition, SearchPagePosition, decode_search_cursor, encode_search_cursor,
    search_cursor_unresolvable,
};
use crate::search::hits::{HitLine, HitLineReader};
use crate::search::index::columns::index_key_of;
use crate::search::index::rows::IndexRowReader;
use crate::search::page::{PageCandidate, PageHit, SearchPage, assemble_search_page};
use crate::search::query::{ParsedSearchQuery, parse_session_search_query};
use crate::search::rowid_floors::{HeldRowCheck, RowidFloorLog};
use crate::search::snapshots::{DEFAULT_SEARCH_SNAPSHOT_LIMITS, SearchSnapshot, SearchSnapshots};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::database::stored_column::{optional_text_column, rowid_column, text_column};

// The sessions the directory holds among these keys; a session since purged has no row.
const SESSIONS_BY_KEY_SQL: &str = "
  SELECT rowid AS session_key, id AS session_id, name
    FROM sessions WHERE rowid IN (SELECT value FROM json_each(?))";

// Sessions are read a batch at a time while a page fills. A read costs what its sessions' hits
// cost, so the first batch is small and each later one holds the sessions the page's room takes at
// the last batch's hits per session, sessions further down holding fewer, and the one after them,
// which tells where the next page starts: at least the first batch's size and at most four times
// the last. A page of sessions that each hold many hits reads few sessions it never shows, and a
// page of sessions with one hit each still takes three reads.
const FIRST_READ_BATCH_SIZE: usize = 16;
const READ_BATCH_GROWTH: usize = 4;

// How many sessions a search's first ranking holds: a page of the most hits, one a session, reads
// that many sessions and the one after them, which tells where the next page starts, so such a
// first page ranks once.
const FIRST_RANKED_SESSIONS: usize = SESSION_SEARCH_PAGE_LIMIT_MAX + 1;

/// Why a `session.search` call failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionSearchError {
    /// The cursor continues no search held for this query.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A database read failed, or a stored value did not read as its type.
    #[error("the session search's database read failed")]
    Database(#[from] rusqlite::Error),
    /// The search index failed a read or is closed.
    #[error("the session search's index read failed")]
    Index(#[from] SearchIndexError),
    /// A hit's stored sequence names no position an event cursor can carry.
    #[error("a hit's stored sequence names no position an event cursor can carry")]
    HitPosition(#[from] EventCursorPositionOutOfRange),
}

/// Answers `session.search` from the search index and the read connection its caller lends, holding
/// the searches whose later pages are still to be read; shared by every search, which run at once.
/// It runs no timer: its owner reads [`SessionSearchService::next_held_search_expiry`] and lets go
/// of what has expired.
pub(crate) struct SessionSearchService {
    snapshots: SearchSnapshots,
}

// A cursor read back, which a later page resumes from.
#[derive(Clone, Copy)]
struct PageResume<'request> {
    cursor: &'request SessionSearchCursor,
    position: SearchPagePosition,
}

impl SessionSearchService {
    /// A service holding no search yet.
    pub(crate) fn new() -> Self {
        Self {
            snapshots: SearchSnapshots::new(DEFAULT_SEARCH_SNAPSHOT_LIMITS),
        }
    }

    /// One page of the query's hits, grouped by session, read on `reader` and `index`, from
    /// `after_cursor` when it is given; a query that names nothing answers an empty last page.
    /// `applied_floor_position` is where the rowid floor log stood when the index last matched the
    /// database, read before the call, and `now` the wall time held searches expire by. A page
    /// reads the database in one read transaction, and every page after the first reads the view
    /// the first one held. Fails with `session.search.cursorUnresolvable` for a cursor that
    /// continues no search held for this query, and as a database or index read fails.
    pub(crate) fn search(
        &self,
        reader: &Connection,
        index: &SearchIndex,
        request: &SessionSearchRequest,
        applied_floor_position: i64,
        now: SystemTime,
    ) -> Result<SessionSearchResponse, SessionSearchError> {
        let transaction = reader.unchecked_transaction()?;
        let response = answer(
            &transaction,
            index,
            &self.snapshots,
            request,
            applied_floor_position,
            now,
        )?;
        transaction.commit()?;
        Ok(response)
    }

    /// The lowest place in the rowid floor log a held search still reads from; `None` while none
    /// is held.
    pub(crate) fn oldest_held_floor_position(&self) -> Option<i64> {
        self.snapshots.oldest_floor_position()
    }

    /// When the first held search expires, by the wall clock; `None` while none is held.
    pub(crate) fn next_held_search_expiry(&self) -> Option<SystemTime> {
        self.snapshots.next_expiry()
    }

    /// Lets go of every held search that has gone unpaged too long or been held too long by `now`;
    /// their cursors are refused from then on.
    pub(crate) fn let_go_of_expired_searches(&self, now: SystemTime) {
        self.snapshots.let_go_expired(now);
    }

    /// Lets go of every held search, as the index closes; their cursors are refused from then on.
    pub(crate) fn let_go_of_held_searches(&self) {
        self.snapshots.let_go_of_all();
    }
}

fn answer(
    reader: &Connection,
    index: &SearchIndex,
    snapshots: &SearchSnapshots,
    request: &SessionSearchRequest,
    applied_floor_position: i64,
    now: SystemTime,
) -> Result<SessionSearchResponse, SessionSearchError> {
    let query = parse_session_search_query(request.query.as_str());
    let limit = request
        .limit
        .map_or(SESSION_SEARCH_PAGE_LIMIT_MAX, |limit| {
            usize::try_from(limit.get()).expect("a page limit is from 1 to 256")
        });
    let limit = NonZeroUsize::new(limit).expect("a page limit is at least 1");
    if let Some(after_cursor) = &request.after_cursor {
        let SearchCursorPosition {
            snapshot_id,
            position,
        } = decode_search_cursor(after_cursor)?;
        let snapshot = snapshots
            .find(&snapshot_id, now)
            .filter(|snapshot| snapshot.query == query)
            .ok_or_else(|| search_cursor_unresolvable(after_cursor))?;
        let resume = PageResume {
            cursor: after_cursor,
            position,
        };
        let page = read_held_page(reader, &snapshot, limit, Some(resume))?;
        return Ok(response_of(page, || snapshot_id));
    }
    let Some(snapshot) = open_search(index, query, applied_floor_position)? else {
        return Ok(SessionSearchResponse::Terminal(SessionSearchTerminal {
            groups: Vec::new(),
            has_more: False::default(),
        }));
    };
    // A failed first page drops the search here, letting go of its view, since no cursor names it.
    let snapshot = Arc::new(snapshot);
    let page = read_held_page(reader, &snapshot, limit, None)?;
    // A search answered whole on its first page has no later page to hold it for: the last page
    // never calls the hold, so the search drops with it and lets go of its view.
    Ok(response_of(page, move || snapshots.hold(snapshot, now)))
}

// The search a first page opens, a view of the index with its order of sessions; `None` when the
// query names neither a word nor a tag.
fn open_search(
    index: &SearchIndex,
    query: ParsedSearchQuery,
    applied_floor_position: i64,
) -> Result<Option<SearchSnapshot>, SearchIndexError> {
    if query.search_query.is_none() && query.tag_folds.is_empty() {
        return Ok(None);
    }
    let view = index.open_search(
        query.tag_folds.clone(),
        FIRST_RANKED_SESSIONS,
        query.search_query.as_ref(),
    )?;
    Ok(Some(SearchSnapshot {
        query,
        view: Mutex::new(view),
        floor_position: applied_floor_position,
    }))
}

// A page of a held search, from where `resume` names when a cursor continues it, its view locked
// for the page.
fn read_held_page(
    reader: &Connection,
    snapshot: &SearchSnapshot,
    limit: NonZeroUsize,
    resume: Option<PageResume<'_>>,
) -> Result<SearchPage, SessionSearchError> {
    let held_row_check = RowidFloorLog::new(reader).held_row_check(snapshot.floor_position)?;
    let mut view = snapshot.lock_view();
    let hit_lines =
        HitLineReader::new(IndexRowReader::new(reader), SESSION_SEARCH_HIT_LINE_MAX_LEN);
    let first_index = resume.map_or(0, |resume| resume.position.session_index);
    let candidates = SessionCandidates {
        reader,
        hit_lines,
        query: &snapshot.query,
        view: &mut view,
        held_row_check,
        resume,
        limit: limit.get(),
        first_index,
        batch_start: first_index,
        batch_size: FIRST_READ_BATCH_SIZE,
        hits_offered: 0,
        batch: None,
        ready: VecDeque::new(),
        is_done: false,
    };
    assemble_search_page(candidates, limit)
}

// A session the directory holds, as a page names it.
struct SessionRow {
    session_id: SessionId,
    name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
}

// A session of a read batch that may show hits: its place in the search's order, the last hit an
// earlier page showed in it, and its hit keys after that one that still name their indexed rows.
struct ShownSession {
    session: SessionRow,
    session_index: usize,
    resume_after: Option<u64>,
    hit_keys: Vec<u64>,
}

// A batch of sessions read from the search's order: how many it took, the hits its sessions have
// offered so far, and those of its sessions whose lines are still to be read.
struct ReadBatch {
    session_count: usize,
    hits: usize,
    unread: VecDeque<ShownSession>,
}

// The sessions of a held search's order from where `resume` names on, a batch at a time, each with
// its hits that still hold a match, the lines of the sessions up to where the page may end read
// together, each session's one past what a page holds so a session with more splits across pages;
// the first with only those after the last hit an earlier page showed. A session since purged, or
// one whose rowid a later session took, is passed over, and so is a hit whose row is gone or was
// taken. Fails with `session.search.cursorUnresolvable` when the cursor's hit is none of its
// session's hits; after a failure it offers nothing more.
struct SessionCandidates<'read> {
    reader: &'read Connection,
    hit_lines: HitLineReader<'read>,
    query: &'read ParsedSearchQuery,
    view: &'read mut HeldSearch,
    held_row_check: Option<HeldRowCheck>,
    resume: Option<PageResume<'read>>,
    limit: usize,
    first_index: usize,
    batch_start: usize,
    batch_size: usize,
    hits_offered: usize,
    batch: Option<ReadBatch>,
    ready: VecDeque<PageCandidate>,
    is_done: bool,
}

impl Iterator for SessionCandidates<'_> {
    type Item = Result<PageCandidate, SessionSearchError>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(candidate) = self.ready.pop_front() {
                return Some(Ok(candidate));
            }
            if self.is_done {
                return None;
            }
            match self.read_more() {
                Ok(is_more) => self.is_done = !is_more,
                Err(error) => {
                    self.is_done = true;
                    return Some(Err(error));
                }
            }
        }
    }
}

impl SessionCandidates<'_> {
    // Reads the next group of the batch's sessions, or the next batch once this one is read;
    // answers whether the search's order holds more.
    fn read_more(&mut self) -> Result<bool, SessionSearchError> {
        if let Some(batch) = &mut self.batch {
            if !batch.unread.is_empty() {
                let group = take_group(&mut batch.unread, self.hits_offered, self.limit);
                let candidates = read_group(&self.hit_lines, self.query, group, self.limit + 1)?;
                let hit_count: usize = candidates
                    .iter()
                    .map(|candidate| candidate.hits.len())
                    .sum();
                batch.hits += hit_count;
                self.hits_offered += hit_count;
                self.ready.extend(candidates);
                return Ok(true);
            }
            self.batch_start += batch.session_count;
            self.batch_size = next_read_batch_size(
                self.limit.saturating_sub(self.hits_offered),
                batch.hits,
                batch.session_count,
                self.batch_size,
            );
        }
        self.batch = self.read_batch()?;
        Ok(self.batch.is_some())
    }

    // The next batch of the search's order, with each session the directory still holds and its
    // hit keys; `None` past the order's end.
    fn read_batch(&mut self) -> Result<Option<ReadBatch>, SessionSearchError> {
        let session_keys = self.view.sessions_at(self.batch_start, self.batch_size)?;
        if session_keys.is_empty() {
            return Ok(None);
        }
        let held_row_check = self.held_row_check;
        let titles_held: Vec<u64> = session_keys
            .iter()
            .copied()
            .filter(|&session_key| {
                held_row_check.is_none_or(|check| {
                    check.is_held(index_key_of(session_key, IndexRowKind::Title))
                })
            })
            .collect();
        let mut sessions = read_sessions(self.reader, &titles_held)?;
        let held_keys: Vec<u64> = session_keys
            .iter()
            .copied()
            .filter(|session_key| sessions.contains_key(session_key))
            .collect();
        let hit_key_lists = if held_keys.is_empty() {
            Vec::new()
        } else {
            self.view.hits_of(&held_keys)?
        };
        let mut hit_keys_by_session: HashMap<u64, Vec<u64>> =
            held_keys.into_iter().zip(hit_key_lists).collect();
        let mut unread = VecDeque::new();
        for (offset, session_key) in session_keys.iter().enumerate() {
            let Some(session) = sessions.remove(session_key) else {
                continue;
            };
            let session_index = self.batch_start + offset;
            let mut hit_keys = hit_keys_by_session.remove(session_key).unwrap_or_default();
            let resume_after = self
                .resume
                .filter(|_| session_index == self.first_index)
                .and_then(|resume| {
                    resume
                        .position
                        .after_hit_key
                        .map(|after_hit_key| (after_hit_key, resume.cursor))
                });
            if let Some((after_hit_key, cursor)) = resume_after {
                let shown_through = hit_keys
                    .iter()
                    .position(|&hit_key| hit_key == after_hit_key)
                    .ok_or_else(|| search_cursor_unresolvable(cursor))?;
                hit_keys.drain(..=shown_through);
            }
            if let Some(check) = held_row_check {
                hit_keys.retain(|&hit_key| check.is_held(hit_key));
            }
            unread.push_back(ShownSession {
                session,
                session_index,
                resume_after: resume_after.map(|(after_hit_key, _)| after_hit_key),
                hit_keys,
            });
        }
        Ok(Some(ReadBatch {
            session_count: session_keys.len(),
            hits: 0,
            unread,
        }))
    }
}

// The sessions whose lines are read together: on through the first whose hit keys could fill the
// page's room, where the page may end, so no session past that is read for it.
fn take_group(
    unread: &mut VecDeque<ShownSession>,
    hits_offered: usize,
    limit: usize,
) -> Vec<ShownSession> {
    let mut keys_ahead = 0;
    let mut group_size = 0;
    for shown in &*unread {
        keys_ahead += shown.hit_keys.len();
        group_size += 1;
        if hits_offered + keys_ahead > limit {
            break;
        }
    }
    unread.drain(..group_size).collect()
}

// Reads and marks the lines of a group's sessions together, at most `count` a session, and offers
// each session with them.
fn read_group(
    hit_lines: &HitLineReader<'_>,
    query: &ParsedSearchQuery,
    group: Vec<ShownSession>,
    count: usize,
) -> Result<Vec<PageCandidate>, SessionSearchError> {
    let key_lists: Vec<&[u64]> = group
        .iter()
        .map(|shown| shown.hit_keys.as_slice())
        .collect();
    let lines_of_each = match &query.search_query {
        None => hit_lines.read_tag_lines(&key_lists, &query.tag_folds, count)?,
        Some(search_query) => hit_lines.read_lines(&key_lists, search_query, count)?,
    };
    group
        .into_iter()
        .zip(lines_of_each)
        .map(|(shown, lines)| {
            Ok(PageCandidate {
                session_id: shown.session.session_id,
                name: shown.session.name,
                hits: lines
                    .into_iter()
                    .map(page_hit_of)
                    .collect::<Result<_, _>>()?,
                session_index: shown.session_index,
                resume_after: shown.resume_after,
            })
        })
        .collect()
}

// The sessions the directory holds among these keys, by key.
fn read_sessions(
    reader: &Connection,
    session_keys: &[u64],
) -> rusqlite::Result<HashMap<u64, SessionRow>> {
    let mut sessions = HashMap::new();
    if session_keys.is_empty() {
        return Ok(sessions);
    }
    let session_keys_json = serde_json::to_string(session_keys)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let mut statement = reader.prepare_cached(SESSIONS_BY_KEY_SQL)?;
    let rows = statement.query_map([session_keys_json], |row| {
        Ok((
            rowid_column(row, 0)?,
            SessionRow {
                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                name: optional_text_column(row, 2, FreeFormText::new)?,
            },
        ))
    })?;
    for row in rows {
        let (session_key, session) = row?;
        sessions.insert(session_key, session);
    }
    Ok(sessions)
}

// How many sessions the next read takes. The page took every session offered so far, so its room
// is the limit less their hits. A full room needs only the one session that tells where the next
// page starts, so the read is the smallest. Otherwise the last batch's hits per session tell how
// many sessions fill the room, and a batch that offered no hit tells nothing, so the read grows by
// the most it may.
fn next_read_batch_size(
    room: usize,
    batch_hits: usize,
    batch_session_count: usize,
    batch_size: usize,
) -> usize {
    let largest_batch = batch_size.saturating_mul(READ_BATCH_GROWTH);
    if room == 0 {
        return FIRST_READ_BATCH_SIZE;
    }
    if batch_hits == 0 {
        return largest_batch;
    }
    let sessions_the_room_takes = (room * batch_session_count).div_ceil(batch_hits) + 1;
    sessions_the_room_takes
        .max(FIRST_READ_BATCH_SIZE)
        .min(largest_batch)
}

// A page as the wire carries it; `hold_search` answers the id of the held search the next page
// continues, called only when there is one.
fn response_of(page: SearchPage, hold_search: impl FnOnce() -> String) -> SessionSearchResponse {
    match page {
        SearchPage::Continuing { groups, next } => {
            SessionSearchResponse::Continuing(SessionSearchContinuing {
                groups,
                has_more: True::default(),
                next_cursor: encode_search_cursor(&hold_search(), next),
            })
        }
        SearchPage::Terminal { groups } => SessionSearchResponse::Terminal(SessionSearchTerminal {
            groups,
            has_more: False::default(),
        }),
    }
}

// A hit as a page shows it: its line, and the cursor that opens its session at it. A title, group
// or tag hit names no row of the session's log, so it opens the session at its start.
fn page_hit_of(hit_line: HitLine) -> Result<PageHit, EventCursorPositionOutOfRange> {
    let HitLine {
        key,
        log_row,
        marked,
    } = hit_line;
    let position = log_row.map_or(START_OF_LOG_POSITION, |log_row| log_row.sequence);
    Ok(PageHit {
        key,
        hit: SessionSearchHit {
            cursor: encode_event_cursor(position)?,
            line: BoundedText::new(marked.line)
                .expect("a hit line is cut to the hit line bound in code points"),
            match_ranges: BoundedVec::new(marked.match_ranges)
                .expect("a hit's first match starts inside its cut line, so its range is kept"),
        },
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime};

    use rusqlite::Connection;
    use sidekicks_contracts::session::methods::{
        SessionSearchCursor, SessionSearchLimit, SessionSearchRequest, SessionSearchResponse,
    };
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_search::index::SearchIndex;
    use tempfile::TempDir;

    use super::{SessionSearchError, SessionSearchService};
    use crate::questions::schema::schema_parts;
    use crate::search::cursor::decode_search_cursor;
    use crate::search::index::outbox::OutboxReader;
    use crate::search::index::rebuild::{
        SearchIndexOpening, build_search_index, open_search_index,
    };
    use crate::search::index::rows::IndexRowReader;
    use crate::search::index::schema::add_titled_session;
    use crate::search::snapshots::SearchSnapshot;
    use sidekicks_store::database::connection::writer_open::SEARCH_INDEX_FOLDER_NAME;

    // How long a page the test expects is waited for before the test fails.
    const PAGE_BOUND: Duration = Duration::from_secs(30);

    // Titled sessions in a database file, their index, and the service paging them; each page
    // reads on a connection of its own, as the read pool lends one to each search.
    struct HeldSearches {
        folder: TempDir,
        index: SearchIndex,
        service: SessionSearchService,
    }

    impl HeldSearches {
        async fn open() -> Arc<Self> {
            let folder = tempfile::tempdir().expect("the test makes a temporary folder");
            let connection =
                Connection::open(folder.path().join("daemon.db")).expect("the database opens");
            connection
                .execute_batch(schema_parts().into_schema().sql())
                .expect("the session's schema runs");
            for number in 1..=3 {
                add_titled_session(
                    &connection,
                    &format!("0190a5a0-0000-7000-8000-00000000000{number}"),
                );
            }
            let highest_id_given = OutboxReader::new(&connection)
                .highest_id_given()
                .expect("the outbox's highest id reads");
            let index_folder = folder.path().join(SEARCH_INDEX_FOLDER_NAME);
            build_search_index(
                &index_folder,
                &IndexRowReader::new(&connection),
                highest_id_given,
            )
            .expect("the index is built");
            let SearchIndexOpening::Opened(index) =
                open_search_index(index_folder, highest_id_given)
                    .await
                    .expect("the index opens")
            else {
                panic!("a built index serves");
            };
            Arc::new(Self {
                folder,
                index: *index,
                service: SessionSearchService::new(),
            })
        }

        fn database_path(&self) -> PathBuf {
            self.folder.path().join("daemon.db")
        }

        // One page of `query`, a hit a page, from `after_cursor` when it is given.
        fn page(
            &self,
            query: &str,
            after_cursor: Option<SessionSearchCursor>,
        ) -> Result<SessionSearchResponse, SessionSearchError> {
            let reader = Connection::open(self.database_path()).expect("the database opens");
            let request = SessionSearchRequest {
                query: FreeFormText::new(query.to_owned()).expect("a query"),
                after_cursor,
                limit: Some(SessionSearchLimit::new(1).expect("a limit")),
            };
            self.service
                .search(&reader, &self.index, &request, 0, SystemTime::now())
        }

        // A first page of `query`, whose search is held, and the cursor that continues it.
        fn held_search(&self, query: &str) -> (Arc<SearchSnapshot>, SessionSearchCursor) {
            let page = match self.page(query, None) {
                Ok(SessionSearchResponse::Continuing(page)) => page,
                other => panic!("a hit a page over three sessions continues: {other:?}"),
            };
            let snapshot_id = decode_search_cursor(&page.next_cursor)
                .expect("the cursor reads")
                .snapshot_id;
            let snapshot = self
                .service
                .snapshots
                .find(&snapshot_id, SystemTime::now())
                .expect("the search is held");
            (snapshot, page.next_cursor)
        }

        // Pages `query` from `cursor` on a thread of its own, sending its answer.
        fn page_on_a_thread(
            self: &Arc<Self>,
            query: &'static str,
            cursor: SessionSearchCursor,
            answers: mpsc::Sender<Result<SessionSearchResponse, SessionSearchError>>,
        ) {
            let searches = Arc::clone(self);
            thread::spawn(move || {
                answers
                    .send(searches.page(query, Some(cursor)))
                    .expect("the test waits for the answer");
            });
        }
    }

    #[tokio::test]
    async fn a_page_of_one_held_search_never_waits_on_another_s_page() {
        let searches = HeldSearches::open().await;
        let (first, _) = searches.held_search("billing");
        let (_, second_cursor) = searches.held_search("fix");
        // A page of the first search under way.
        let first_view = first.lock_view();
        let (answers, answered) = mpsc::channel();

        searches.page_on_a_thread("fix", second_cursor, answers);

        let answer = answered
            .recv_timeout(PAGE_BOUND)
            .expect("the second search pages while the first's page reads");
        assert!(
            answer.is_ok(),
            "the second search's page answers: {answer:?}"
        );
        drop(first_view);
    }

    #[tokio::test]
    async fn two_pages_of_one_held_search_read_at_once() {
        let searches = HeldSearches::open().await;
        let (held, cursor) = searches.held_search("billing");
        // Holds both pages at the view, past the lookup that finds their search.
        let view = held.lock_view();
        let (answers, answered) = mpsc::channel();

        searches.page_on_a_thread("billing", cursor.clone(), answers.clone());
        searches.page_on_a_thread("billing", cursor, answers);
        // The test's, the held set's and each page's hold on the search; a page that does not find
        // its search answers at once instead.
        let deadline = Instant::now() + PAGE_BOUND;
        let mut early = Vec::new();
        while Arc::strong_count(&held) < 4 && early.is_empty() && Instant::now() < deadline {
            early.extend(answered.try_recv());
            thread::sleep(Duration::from_millis(1));
        }
        drop(view);
        let mut pages = early;
        while pages.len() < 2 {
            pages.push(
                answered
                    .recv_timeout(PAGE_BOUND)
                    .expect("each page answers once the view is free"),
            );
        }

        for page in pages {
            assert!(
                matches!(page, Ok(SessionSearchResponse::Continuing(_))),
                "both pages of the held search answer its next page: {page:?}"
            );
        }
    }
}
