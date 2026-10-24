//! What the tests share: scratch folders, an index opened on one, and rows, batches, queries and
//! rankings built in a line.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::index::collector::{PreparedQuery, score_every_session};
use crate::index::directory::ReadMode;
use crate::index::phrase::query_phrases;
use crate::index::tokenizer::tokenize;
use crate::index::version::IndexVersion;
use crate::index::{
    GroupMembers, IndexBatch, IndexRow, IndexRowKind, SearchIndex, SearchIndexOptions, SearchQuery,
};

/// An arena just above Tantivy's 15 MB floor.
pub(super) const TEST_ARENA_BYTES: usize = 16 * 1024 * 1024;

/// The options every test index opens with.
pub(super) const TEST_OPTIONS: SearchIndexOptions = SearchIndexOptions {
    writer_memory_bytes: TEST_ARENA_BYTES,
};

/// How many sessions a test search first ranks; a ranking orders sessions the same at any size.
pub(super) const FIRST_RANKED_SESSIONS: usize = 16;

/// A folder the index creates inside a fresh temporary folder, both removed when dropped.
pub(super) struct ScratchFolder {
    // Held so the temporary folder lives as long as the test.
    _parent: TempDir,
    path: PathBuf,
}

impl ScratchFolder {
    /// A folder named for `name` that does not exist yet; the index creates it.
    pub(super) fn new(name: &str) -> ScratchFolder {
        let parent = tempfile::Builder::new()
            .prefix("search-index-")
            .tempdir()
            .expect("the temporary folder is writable");
        let path = parent.path().join(name);
        ScratchFolder {
            _parent: parent,
            path,
        }
    }

    /// Where the folder is.
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

/// The index in `folder`, read by positioned reads as on every platform but macOS.
pub(super) fn open_index(folder: &Path) -> SearchIndex {
    SearchIndex::open_in(folder, TEST_OPTIONS, ReadMode::Positioned).unwrap_or_else(|failure| {
        panic!(
            "the index in {} did not open: {failure:?}",
            folder.display()
        )
    })
}

/// A row of `kind` with `key`, owned by `owner_key`.
pub(super) fn row(key: u64, kind: IndexRowKind, owner_key: u64, text: &str) -> IndexRow {
    IndexRow {
        key,
        kind,
        owner_key,
        text: text.to_string(),
        tag: None,
    }
}

/// An `event` row of `session`.
pub(super) fn event(key: u64, session: u64, text: &str) -> IndexRow {
    row(key, IndexRowKind::Event, session, text)
}

/// A batch of `rows` with nothing removed.
pub(super) fn batch(last_outbox_id: u64, rows: Vec<IndexRow>) -> IndexBatch {
    IndexBatch {
        last_outbox_id,
        rows,
        long_row_documents: Vec::new(),
        continued_key: None,
        removed_keys: Vec::new(),
        removed_owners: Vec::new(),
        group_members: Vec::new(),
    }
}

/// A query of `words`.
pub(super) fn query(words: &[&str], last_word_is_prefix: bool) -> SearchQuery {
    SearchQuery {
        words: words.iter().map(ToString::to_string).collect(),
        last_word_is_prefix,
    }
}

/// Every session `query` matches in rank order, and each one's hits best first.
pub(super) fn rank_all(
    version: &IndexVersion,
    query: &SearchQuery,
) -> (Vec<u64>, HashMap<u64, Vec<u64>>) {
    PreparedQuery::prepare(version, query_phrases(query))
        .expect("the query prepares")
        .map_or_else(
            || (Vec::new(), HashMap::new()),
            |prepared| {
                let scored =
                    score_every_session(version, &prepared, None).expect("the query ranks");
                (scored.order, scored.hits)
            },
        )
}

/// N, the live tokens and each phrase's live row count, the figures every score is built from.
pub(super) fn live_counts(version: &IndexVersion, query: &SearchQuery) -> (u64, u64, Vec<u64>) {
    let phrase_rows = query_phrases(query)
        .iter()
        .map(|phrase| version.phrase_rows(phrase).expect("the phrase counts"))
        .collect();
    (version.live_rows, version.live_tokens, phrase_rows)
}

/// Groups as a batch carries them, from `(group key, member session keys)` pairs.
pub(super) fn members(groups: &[(u64, Vec<u64>)]) -> Vec<GroupMembers> {
    groups
        .iter()
        .map(|(group_key, session_keys)| GroupMembers {
            group_key: *group_key,
            session_keys: session_keys.clone(),
        })
        .collect()
}

/// Words, prefixes of each length the index serves differently, and split words, all drawn from
/// the event rows of `rows`.
pub(super) fn queries_over(rows: &[IndexRow]) -> Vec<SearchQuery> {
    let events: Vec<Vec<String>> = rows
        .iter()
        .filter(|row| row.kind == IndexRowKind::Event)
        .map(|row| {
            tokenize(&row.text)
                .into_iter()
                .map(|token| token.folded)
                .collect()
        })
        .collect();
    let long_word = events
        .iter()
        .flatten()
        .find(|token| token.chars().count() >= 6)
        .expect("the set has words of three syllables")
        .clone();
    let (first, second) = (&events[5][0], &events[5][1]);
    let before_long_word = events
        .iter()
        .find(|tokens| tokens.len() > 1 && tokens[1].chars().count() >= 6)
        .expect("a row holds a word of three syllables after another");
    let three_tokens = events
        .iter()
        .find(|tokens| tokens.len() > 2)
        .expect("a row holds three words");
    let prefix = |token: &str, length: usize| token.chars().take(length).collect::<String>();
    let search = |words: Vec<String>, last_word_is_prefix: bool| SearchQuery {
        words,
        last_word_is_prefix,
    };
    vec![
        search(vec![first.clone()], false),
        search(vec![prefix(second, 1)], true),
        search(vec![prefix(second, 2)], true),
        search(vec![prefix(&long_word, 4)], true),
        search(vec![prefix(&long_word, 5)], true),
        search(vec![first.clone(), second.clone()], false),
        search(vec![format!("{}-{}", events[50][0], events[50][1])], false),
        search(
            vec![format!("{}-{}", events[50][0], prefix(&events[50][1], 1))],
            true,
        ),
        search(
            vec![format!(
                "{}-{}",
                before_long_word[0],
                prefix(&before_long_word[1], 5)
            )],
            true,
        ),
        search(
            vec![format!(
                "{}-{}-{}",
                three_tokens[0],
                three_tokens[1],
                prefix(&three_tokens[2], 2)
            )],
            true,
        ),
    ]
}
