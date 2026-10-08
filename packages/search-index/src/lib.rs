//! The daemon's session search index: Tantivy behind a Node-API addon only the daemon loads.

mod collector;
mod cursor;
mod directory;
mod engine;
mod find;
mod membership;
mod merge_policy;
mod phrase;
mod schema;
mod scorer;
#[cfg(test)]
mod tests;
mod tokenizer;
mod version;
mod view;

use std::path::Path;
use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Status, Task};
use napi_derive::napi;
use tantivy::TantivyError;

use crate::directory::ReadMode;
use crate::engine::{IndexEngine, OpenFailure, keys_of, non_negative};
use crate::view::SearchView;

// One indexing thread, so a rebuild or a batch leaves the machine's other cores free.
const INDEXING_THREADS: usize = 1;

/// What an index row holds; the daemon's index key scheme gives each its own slot.
#[napi(string_enum = "lowercase")]
#[cfg_attr(test, derive(Clone, Copy, Debug, PartialEq, Eq))]
pub enum IndexRowKind {
    Event,
    Title,
    Group,
    Tag,
}

/// One row handed to the index, with its text as the database holds it now.
#[napi(object, object_to_js = false)]
#[cfg_attr(test, derive(Clone, Debug))]
pub struct IndexRow {
    /// The row's key, unique across the index: its source row's rowid times four plus its kind's
    /// slot.
    pub key: i64,
    pub kind: IndexRowKind,
    /// The session key the row belongs to; for a `group` row, the group key whose name it is.
    pub owner_key: i64,
    pub text: String,
}

/// An owner all of whose rows leave the index: a purged session, a deleted group.
#[napi(object, object_to_js = false)]
pub struct RemovedOwner {
    pub owner_key: i64,
    pub is_group: bool,
}

/// One batch of outbox rows, applied as one durable commit.
#[napi(object, object_to_js = false)]
pub struct IndexBatch {
    /// The highest outbox id the batch carries; the commit records it.
    pub last_outbox_id: i64,
    /// Rows to index; a row already indexed under the same key is replaced.
    pub rows: Vec<IndexRow>,
    pub removed_keys: Vec<i64>,
    pub removed_owners: Vec<RemovedOwner>,
    /// Groups whose members changed, each replaced in this commit; a group with no members is
    /// forgotten.
    pub group_members: Vec<GroupMembers>,
}

/// The sessions a group's name row counts toward, in session id order (the order ties break in).
#[napi(object, object_to_js = false)]
pub struct GroupMembers {
    pub group_key: i64,
    pub session_keys: Vec<i64>,
}

/// What the search box or the find box asks for.
#[napi(object, object_to_js = false)]
pub struct SearchQuery {
    /// The typed words in order, as typed; the addon tokenizes and folds each into a phrase.
    pub words: Vec<String>,
    /// Whether the last word is still being typed, so it matches as a prefix.
    pub last_word_is_prefix: bool,
}

/// A matched stretch of a text, in UTF-16 code units, end exclusive.
#[napi(object, object_from_js = false)]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

/// How the index is opened.
#[napi(object, object_to_js = false)]
pub struct SearchIndexOptions {
    /// The indexing arena's size; a commit flushes no later than when it fills.
    pub writer_memory_bytes: i64,
}

/// One session's matching log rows, for the find box.
#[napi(object, object_from_js = false)]
pub struct SessionFind {
    /// The session's matching `event` rows' keys, newest (highest key) first.
    pub row_keys: Vec<i64>,
    /// Each row's match count, in `rowKeys` order, counted as `markMatches` marks the row.
    pub match_counts: Vec<u32>,
    /// Every match in the session: the sum of `matchCounts`.
    pub total_match_count: i64,
}

fn failure(error: TantivyError) -> Error {
    let status = match error {
        TantivyError::InvalidArgument(_) => Status::InvalidArg,
        _ => Status::GenericFailure,
    };
    Error::new(status, error.to_string())
}

fn closed() -> Error {
    Error::new(Status::GenericFailure, "the search index is closed")
}

fn to_js_keys(keys: Vec<u64>) -> Vec<i64> {
    keys.into_iter().map(|key| key as i64).collect()
}

/// `SearchIndex.apply`'s work on the libuv thread pool: index one batch and commit it durably.
pub struct ApplyBatch {
    engine: Option<Arc<IndexEngine>>,
    batch: IndexBatch,
}

#[napi]
impl Task for ApplyBatch {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        let engine = self.engine.as_ref().ok_or_else(closed)?;
        engine.apply(&self.batch).map_err(failure)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// `SearchIndex.mergeWhileIdle`'s work on the libuv thread pool: one merge step.
pub struct MergeSegments {
    engine: Option<Arc<IndexEngine>>,
}

#[napi]
impl Task for MergeSegments {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        let engine = self.engine.as_ref().ok_or_else(closed)?;
        engine.merge_while_idle().map_err(failure)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// `SearchIndex.close`'s work on the libuv thread pool: finish writes, then release the index.
pub struct CloseIndex {
    engine: Option<Arc<IndexEngine>>,
}

#[napi]
impl Task for CloseIndex {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        match self.engine.take() {
            Some(engine) => engine.close().map_err(failure),
            None => Ok(()),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// The daemon's session search index in one folder. One instance per folder.
#[napi]
pub struct SearchIndex {
    engine: Option<Arc<IndexEngine>>,
}

impl SearchIndex {
    fn engine(&self) -> Result<&Arc<IndexEngine>> {
        self.engine.as_ref().ok_or_else(closed)
    }
}

#[napi]
impl SearchIndex {
    /// Opens the index in `folderPath`, creating an empty one when the folder holds none. Throws an
    /// error whose `code` is `"SEARCH_INDEX_UNREADABLE"` when the folder's files cannot be read as
    /// an index; the caller then removes the folder and rebuilds from the database.
    #[napi(factory)]
    pub fn open(folder_path: String, options: SearchIndexOptions) -> Result<Self, &'static str> {
        let writer_memory_bytes = usize::try_from(options.writer_memory_bytes)
            .map_err(|_| Error::new("InvalidArg", "writerMemoryBytes must not be negative"))?;
        let folder = Path::new(&folder_path);
        match IndexEngine::open(
            folder,
            writer_memory_bytes,
            INDEXING_THREADS,
            ReadMode::DEFAULT,
        ) {
            Ok(engine) => Ok(SearchIndex {
                engine: Some(Arc::new(engine)),
            }),
            Err(OpenFailure::Unreadable(error)) => {
                Err(Error::new("SEARCH_INDEX_UNREADABLE", error.to_string()))
            }
            Err(OpenFailure::Other(error)) => Err(Error::new("GenericFailure", error.to_string())),
        }
    }

    /// The outbox id the newest durable commit records; 0 for a new index.
    #[napi]
    pub fn last_applied_outbox_id(&self) -> Result<i64> {
        Ok(self.engine()?.current_version().last_applied_outbox_id as i64)
    }

    /// Indexes a batch and commits it durably, off the calling thread; resolves once the commit is
    /// durable and searches opened afterward see it. Applying the same batch twice leaves the index
    /// as one apply does: rows replace by key, removals of absent rows do nothing.
    #[napi]
    pub fn apply(&self, batch: IndexBatch) -> AsyncTask<ApplyBatch> {
        AsyncTask::new(ApplyBatch {
            engine: self.engine.clone(),
            batch,
        })
    }

    /// Loads every group's members once after open, before the first search; later changes arrive
    /// in an `IndexBatch`'s `groupMembers`, so a search sees members and rows from the same commit.
    #[napi]
    pub fn set_group_members(&self, groups: Vec<GroupMembers>) -> Result<()> {
        let groups = groups
            .iter()
            .map(|group| {
                Ok((
                    non_negative(group.group_key)?,
                    keys_of(&group.session_keys)?,
                ))
            })
            .collect::<tantivy::Result<Vec<_>>>()
            .map_err(failure)?;
        self.engine()?.set_group_members(groups).map_err(failure)
    }

    /// A search over the index as it is now, held until released. With `withinSessions`, only those
    /// sessions' rows and their groups' rows count, and the order covers every one of them that
    /// matches.
    #[napi(ts_args_type = "query: SearchQuery, withinSessions?: number[]")]
    pub fn open_search(
        &self,
        query: SearchQuery,
        within_sessions: Option<Vec<i64>>,
    ) -> Result<HeldSearch> {
        let within = within_sessions
            .as_deref()
            .map(keys_of)
            .transpose()
            .map_err(failure)?;
        let version = self.engine()?.current_version();
        let view = SearchView::open(version, &query, within.as_deref()).map_err(failure)?;
        Ok(HeldSearch { view: Some(view) })
    }

    /// One session's matching log rows and every match in them.
    #[napi]
    pub fn find_in_session(&self, session_key: i64, query: SearchQuery) -> Result<SessionFind> {
        let session_key = non_negative(session_key).map_err(failure)?;
        let version = self.engine()?.current_version();
        find::find_in_session(&version, session_key, &query).map_err(failure)
    }

    /// Where the query's words match in `text`, in order, as the index tokenizes and folds it.
    #[napi]
    pub fn mark_matches(&self, text: String, query: SearchQuery) -> Vec<MatchRange> {
        find::mark_matches(&text, &query)
    }

    /// Runs one merge of segments; resolves whether more merging remains. Called while idle.
    #[napi]
    pub fn merge_while_idle(&self) -> AsyncTask<MergeSegments> {
        AsyncTask::new(MergeSegments {
            engine: self.engine.clone(),
        })
    }

    /// Waits for writes under way, then lets go of files and threads.
    #[napi]
    pub fn close(&mut self) -> AsyncTask<CloseIndex> {
        AsyncTask::new(CloseIndex {
            engine: self.engine.take(),
        })
    }
}

/// A search's point-in-time view: every page of it reads the index as it was when it opened.
#[napi]
pub struct HeldSearch {
    view: Option<SearchView>,
}

fn released() -> Error {
    Error::new(Status::GenericFailure, "the search was released")
}

#[napi]
impl HeldSearch {
    /// The sessions ranked `from` to `from + count - 1`, best first; fewer past the end.
    #[napi]
    pub fn sessions_at(&mut self, from: u32, count: u32) -> Result<Vec<i64>> {
        let view = self.view.as_mut().ok_or_else(released)?;
        let sessions = view
            .sessions_at(from as usize, count as usize)
            .map_err(failure)?;
        Ok(to_js_keys(sessions))
    }

    /// Each named session's matching row keys, best first, in the order the sessions were named.
    #[napi]
    pub fn hits_of(&self, session_keys: Vec<i64>) -> Result<Vec<Vec<i64>>> {
        let view = self.view.as_ref().ok_or_else(released)?;
        let sessions = keys_of(&session_keys).map_err(failure)?;
        let hits = view.hits_of(&sessions).map_err(failure)?;
        Ok(hits.into_iter().map(to_js_keys).collect())
    }

    /// Lets go of the view; any later call throws.
    #[napi]
    pub fn release(&mut self) {
        self.view = None;
    }
}
