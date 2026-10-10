//! What the tests share: scratch folders, an index opened on one, and rows, batches, queries and
//! rankings built in a line.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::collector::{PreparedQuery, score_every_session};
use crate::directory::ReadMode;
use crate::engine::IndexEngine;
use crate::phrase::query_phrases;
use crate::tokenizer::tokenize;
use crate::version::IndexVersion;
use crate::{GroupMembers, IndexBatch, IndexRow, IndexRowKind, SearchQuery};

/// An arena just above Tantivy's 15 MB floor.
pub const TEST_ARENA_BYTES: usize = 16 * 1024 * 1024;

/// How many sessions a test search first ranks; a ranking orders sessions the same at any size.
pub const FIRST_RANKED_SESSIONS: usize = 16;

static NEXT_FOLDER: AtomicU64 = AtomicU64::new(0);

/// A fresh folder under the system's temporary folder, removed when dropped.
pub struct ScratchFolder {
    path: PathBuf,
}

impl ScratchFolder {
    /// A folder named for `name`, this process and a counter; the index creates it.
    pub fn new(name: &str) -> ScratchFolder {
        let unique = NEXT_FOLDER.fetch_add(1, Ordering::Relaxed);
        let folder = format!("search-index-{name}-{}-{unique}", std::process::id());
        ScratchFolder {
            path: std::env::temp_dir().join(folder),
        }
    }

    /// Where the folder is.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchFolder {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!("left {} behind: {error}", self.path.display());
        }
    }
}

/// The index in `folder`, read by positioned reads as on every platform but macOS.
pub fn open_engine(folder: &Path) -> IndexEngine {
    match IndexEngine::open(folder, TEST_ARENA_BYTES, 1, ReadMode::Positioned) {
        Ok(engine) => engine,
        Err(failure) => panic!(
            "the index in {} did not open: {failure:?}",
            folder.display()
        ),
    }
}

/// A row of `kind` with `key`, owned by `owner_key`.
pub fn row(key: u64, kind: IndexRowKind, owner_key: u64, text: &str) -> IndexRow {
    IndexRow {
        key: key as i64,
        kind,
        owner_key: owner_key as i64,
        text: text.to_string(),
        tag: None,
    }
}

/// An `event` row of `session`.
pub fn event(key: u64, session: u64, text: &str) -> IndexRow {
    row(key, IndexRowKind::Event, session, text)
}

/// A batch of `rows` with nothing removed.
pub fn batch(last_outbox_id: i64, rows: Vec<IndexRow>) -> IndexBatch {
    IndexBatch {
        last_outbox_id,
        rows,
        removed_keys: Vec::new(),
        removed_owners: Vec::new(),
        group_members: Vec::new(),
    }
}

/// A query of `words`.
pub fn query(words: &[&str], last_word_is_prefix: bool) -> SearchQuery {
    SearchQuery {
        words: words.iter().map(|word| word.to_string()).collect(),
        last_word_is_prefix,
    }
}

/// Every session `query` matches in rank order, and each one's hits best first.
pub fn rank_all(version: &IndexVersion, query: &SearchQuery) -> (Vec<u64>, HashMap<u64, Vec<u64>>) {
    match PreparedQuery::prepare(version, query_phrases(query)).expect("the query prepares") {
        Some(prepared) => {
            let scored = score_every_session(version, &prepared, None).expect("the query ranks");
            (scored.order, scored.hits)
        }
        None => (Vec::new(), HashMap::new()),
    }
}

/// N, the live tokens and each phrase's live row count, the figures every score is built from.
pub fn live_counts(version: &IndexVersion, query: &SearchQuery) -> (u64, u64, Vec<u64>) {
    let phrase_rows = query_phrases(query)
        .iter()
        .map(|phrase| version.phrase_rows(phrase).expect("the phrase counts"))
        .collect();
    (version.live_rows, version.live_tokens, phrase_rows)
}

/// Groups as a batch carries them.
pub fn members(groups: &[(u64, Vec<u64>)]) -> Vec<GroupMembers> {
    groups
        .iter()
        .map(|(group, sessions)| GroupMembers {
            group_key: *group as i64,
            session_keys: sessions.iter().map(|session| *session as i64).collect(),
        })
        .collect()
}

/// The row's key as the index holds it.
pub fn key_of(row: &IndexRow) -> u64 {
    row.key as u64
}

/// Words, prefixes of each length the index serves differently, and split words, all drawn from
/// the event rows of `rows`.
pub fn queries_over(rows: &[IndexRow]) -> Vec<SearchQuery> {
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
