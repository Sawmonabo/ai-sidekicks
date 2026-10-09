//! The find box's counts are the marks: on every log row of a session, the count `findInSession`
//! gives equals the number of stretches `markMatches` marks, and it finds exactly the rows every
//! phrase of the query occurs in.

use crate::find::{find_in_session, mark_matches};
use crate::tokenizer::tokenize;
use crate::{IndexRow, IndexRowKind, SearchQuery};

use super::seeded_set::{SeededSetSize, generate};
use super::support::{ScratchFolder, batch, open_engine, query};

const SIZE: SeededSetSize = SeededSetSize {
    sessions: 20,
    messages: 2_000,
    groups: 2,
    tags: 20,
};
// Every fiftieth message goes to this session, so it holds the most rows.
const LARGEST_SESSION: u64 = 2;

// Whether every phrase of `searched` occurs in `text` on its own.
fn every_phrase_occurs(text: &str, searched: &SearchQuery) -> bool {
    let last = searched.words.len() - 1;
    searched.words.iter().enumerate().all(|(index, word)| {
        let alone = query(
            &[word.as_str()],
            searched.last_word_is_prefix && index == last,
        );
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
    session_rows.sort_unstable_by_key(|(key, _)| std::cmp::Reverse(*key));
    let tokens: Vec<String> = tokenize(&session_rows[3].1)
        .into_iter()
        .map(|token| token.folded)
        .collect();
    let first = tokens[0].as_str();
    let first_letter: String = first.chars().take(1).collect();
    let first_letter = first_letter.as_str();
    let joined = format!("{first}-{}", tokens[1]);
    let joined_prefix = format!("{first}-{}", &tokens[1][..1]);
    let queries = vec![
        query(&[first], false),
        query(&[first_letter], true),
        query(&[first, first_letter], true),
        query(&[first, first], false),
        query(&[joined.as_str()], false),
        query(&[joined_prefix.as_str()], true),
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
        assert!(
            !expected.is_empty(),
            "{:?} occurs in the session",
            query.words
        );
        let found = find_in_session(&version, LARGEST_SESSION, query).expect("finds");
        let counted: Vec<(u64, u32)> = found
            .row_keys
            .iter()
            .zip(found.match_counts.iter())
            .map(|(key, count)| (*key as u64, *count))
            .collect();
        assert_eq!(counted, expected, "{:?}", query.words);
    }
}
