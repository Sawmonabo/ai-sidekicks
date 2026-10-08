//! The find box's counts are the marks: on every log row of a session, the count `findInSession`
//! gives equals the number of stretches `markMatches` marks, and it finds exactly the rows every
//! phrase of the query occurs in.

use crate::find::{find_in_session, mark_matches};
use crate::tokenizer::tokenize;
use crate::{IndexRow, IndexRowKind, SearchQuery};

use super::seeded_set::{SeededSetSize, generate};
use super::support::{ScratchFolder, batch, open_engine};

const SIZE: SeededSetSize =
    SeededSetSize { sessions: 20, messages: 2_000, groups: 2, tags: 20, links: 0 };
// Every fiftieth message goes to this session, so it holds the most rows.
const LARGEST_SESSION: u64 = 2;

fn search(words: Vec<String>, last_word_is_prefix: bool) -> SearchQuery {
    SearchQuery { words, last_word_is_prefix }
}

// Whether every phrase of `query` occurs in `text` on its own.
fn every_phrase_occurs(text: &str, query: &SearchQuery) -> bool {
    let last = query.words.len() - 1;
    query.words.iter().enumerate().all(|(index, word)| {
        let alone = search(vec![word.clone()], query.last_word_is_prefix && index == last);
        !mark_matches(text, &alone).is_empty()
    })
}

#[test]
fn find_counts_equal_the_marks_on_every_row() {
    let mut rows: Vec<IndexRow> = Vec::new();
    generate(SIZE, |row| rows.push(row));
    let mut session_rows: Vec<(u64, String)> = rows
        .iter()
        .filter(|row| row.kind == IndexRowKind::Event && row.owner_key as u64 == LARGEST_SESSION)
        .map(|row| (row.key as u64, row.text.clone()))
        .collect();
    session_rows.sort_unstable_by(|left, right| right.0.cmp(&left.0));
    let tokens: Vec<String> =
        tokenize(&session_rows[3].1).into_iter().map(|token| token.folded).collect();
    let first_letter: String = tokens[0].chars().take(1).collect();
    let queries = vec![
        search(vec![tokens[0].clone()], false),
        search(vec![first_letter.clone()], true),
        search(vec![tokens[0].clone(), first_letter.clone()], true),
        search(vec![tokens[0].clone(), tokens[0].clone()], false),
        search(vec![format!("{}-{}", tokens[0], tokens[1])], false),
        search(vec![format!("{}-{}", tokens[0], &tokens[1][..1])], true),
    ];

    let folder = ScratchFolder::new("find");
    let engine = open_engine(folder.path());
    engine.apply(&batch(1, rows)).expect("the set applies");
    let version = engine.current_version();
    for query in &queries {
        let expected: Vec<(u64, u32)> = session_rows
            .iter()
            .filter(|(_, text)| every_phrase_occurs(text, query))
            .map(|(key, text)| (*key, mark_matches(text, query).len() as u32))
            .collect();
        assert!(!expected.is_empty(), "{:?} occurs in the session", query.words);
        let found = find_in_session(&version, LARGEST_SESSION, query).expect("finds");
        let counted: Vec<(u64, u32)> = found
            .row_keys
            .iter()
            .zip(&found.match_counts)
            .map(|(key, count)| (*key as u64, *count))
            .collect();
        assert_eq!(counted, expected, "{:?}", query.words);
        let total: u32 = expected.iter().map(|(_, count)| count).sum();
        assert_eq!(found.total_match_count, i64::from(total), "{:?}", query.words);
    }
}
