//! The session search index on Tantivy, its tokenizer and its case fold: SQLite stays the record,
//! and the daemon hands the index its outbox rows in batches, then searches it by session.
//!
//! `apply`, `merge_segments` and `close` block on disk writes and merges, so the daemon calls them
//! off its async runtime.

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
mod tags;
#[cfg(test)]
mod tests;
mod tokenizer;
mod version;
mod view;

use tantivy::TantivyError;

pub use self::engine::SearchIndex;
pub use self::find::mark_matches;
pub use self::tokenizer::find_page_end;
pub use self::view::HeldSearch;

/// Why the index failed a call.
#[derive(Debug, thiserror::Error)]
pub enum SearchIndexError {
    /// The folder's files cannot be read as this index; the caller removes the folder and rebuilds
    /// the index from the database.
    #[error("the search index folder cannot be read as an index")]
    Unreadable(#[source] TantivyError),
    /// The index was closed: every write, search and merge after `close` fails with this.
    #[error("the search index is closed")]
    Closed,
    /// Any other failure, which a rebuild would not cure: the folder could not be created, another
    /// process holds the writer's lock, Tantivy refused the arena size or failed a read, a write
    /// or a merge, or an earlier panic poisoned a lock.
    #[error("the search index failed")]
    Index(#[from] TantivyError),
}

/// What an index row holds; the daemon's index key scheme gives each its own slot, in this order,
/// and stores each by its camelCase name.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, strum::VariantArray, strum::IntoStaticStr, strum::EnumString,
)]
#[strum(serialize_all = "camelCase")]
pub enum IndexRowKind {
    /// A settled message or tool call of a session's log.
    Event,
    /// A session's title.
    Title,
    /// A group's name, which counts toward the group's member sessions.
    Group,
    /// One tag of a session.
    Tag,
}

/// One row handed to the index, with its text as the database holds it now; a row longer than a
/// page of text is handed as one `IndexRow` per page, each indexed as its own document.
#[derive(Clone, Debug)]
pub struct IndexRow {
    /// The row's key: its source row's rowid times four plus its kind's slot. Every page of one row
    /// carries it, so no two rows share it; a hit on any page is the row's hit.
    pub key: u64,
    /// What the row holds, which sets its key's slot and whom it counts toward.
    pub kind: IndexRowKind,
    /// The session key the row belongs to; for a `Group` row, the group key whose name it is. A
    /// rowid, so below 2^63.
    pub owner_key: u64,
    /// The row's text as the database holds it, or one page of it; the index keeps its tokens,
    /// never the text.
    pub text: String,
    /// What a `Tag` row carries besides its text; no other row carries it.
    pub tag: Option<IndexRowTag>,
}

/// A tag row's tag as a `tag:` term matches it, and its session's last activity, which orders a
/// search by tag alone.
#[derive(Clone, Debug)]
pub struct IndexRowTag {
    /// The tag folded as the tag store folds it.
    pub fold: String,
    /// The session's last activity, in milliseconds since the Unix epoch.
    pub session_last_activity_ms: u64,
}

/// An owner all of whose rows leave the index: a purged session, a deleted group.
#[derive(Clone, Copy, Debug)]
pub struct RemovedOwner {
    /// The session's key, or the group's when `is_group`; a rowid, so below 2^63.
    pub owner_key: u64,
    /// Whether the owner is a group rather than a session.
    pub is_group: bool,
}

/// One batch of outbox rows, applied as one durable commit.
#[derive(Clone, Debug)]
pub struct IndexBatch {
    /// The highest outbox id the batch carries; the commit records it.
    pub last_outbox_id: u64,
    /// Rows to index, every page of a row in this one batch; a row already indexed under the same
    /// key is replaced, all its pages at once.
    pub rows: Vec<IndexRow>,
    /// Keys of rows to remove; a key the index does not hold is passed over.
    pub removed_keys: Vec<u64>,
    /// Owners whose every row leaves the index, the files that held them rewritten by the merges.
    pub removed_owners: Vec<RemovedOwner>,
    /// Groups whose members changed, each replaced in this commit; a group with no members is
    /// forgotten.
    pub group_members: Vec<GroupMembers>,
}

/// The sessions a group's name row counts toward, in session id order (the order ties break in).
#[derive(Clone, Debug)]
pub struct GroupMembers {
    /// The group's key.
    pub group_key: u64,
    /// Its member sessions' keys, in session id order.
    pub session_keys: Vec<u64>,
}

/// What the search box or the find box asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchQuery {
    /// The typed words in order, as typed; the index tokenizes and folds each into a phrase.
    pub words: Vec<String>,
    /// Whether the last word is still being typed, so it matches as a prefix.
    pub last_word_is_prefix: bool,
}

/// A matched stretch of a text, in UTF-16 code units, end exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchRange {
    /// The first UTF-16 code unit marked.
    pub start: u32,
    /// One past the last UTF-16 code unit marked.
    pub end: u32,
}

/// How the index is opened.
#[derive(Clone, Copy, Debug)]
pub struct SearchIndexOptions {
    /// The indexing arena's size in bytes; a commit flushes no later than when it fills.
    pub writer_memory_bytes: usize,
}

/// One session's matching log rows, for the find box.
#[derive(Clone, Debug)]
pub struct SessionFind {
    /// The session's matching `Event` rows' keys, newest (highest key) first.
    pub row_keys: Vec<u64>,
    /// Each row's match count, in `row_keys` order, counted as `mark_matches` marks the row.
    pub match_counts: Vec<u32>,
}
