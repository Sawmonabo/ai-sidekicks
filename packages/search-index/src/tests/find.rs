//! The find box's counts are the marks: on every log row of a session, the count `findInSession`
//! gives equals the number of stretches `markMatches` marks, and it finds exactly the rows every
//! phrase of the query occurs in.

use crate::find::{find_in_session, mark_matches};
use crate::schema::PREFIX_FIELD_COUNT;
use crate::tokenizer::tokenize;
use crate::{IndexRow, IndexRowKind, SearchQuery};

use super::seeded_set::{SeededSetSize, generate};
use super::support::{ScratchFolder, batch, event, open_engine, query};

const SIZE: SeededSetSize = SeededSetSize {
    sessions: 20,
    messages: 2_000,
    groups: 2,
    tags: 20,
};
// Every fiftieth message goes to this session, so it holds the most rows.
const LARGEST_SESSION: u64 = 2;
// A prefix longer than every prefix field that no seeded word begins.
const RARE_PREFIX: &str = "qqqqq";

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
    // Two words of a long prefix no other row holds, so the segment's few postings of it are
    // sorted and summed rather than added into an array as long as the segment. Its key is below
    // every other row's, so it is the session's oldest.
    rows.push(event(
        0,
        LARGEST_SESSION,
        &format!("{RARE_PREFIX}a {RARE_PREFIX}b {RARE_PREFIX}a"),
    ));
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
    // A prefix longer than every prefix field that two different words begin in one row, so a
    // row's count is its words' counts summed.
    let long_prefix = session_rows
        .iter()
        .find_map(|(_, text)| {
            let words: Vec<String> = tokenize(text)
                .into_iter()
                .map(|token| token.folded)
                .collect();
            words.iter().find_map(|word| {
                let prefix: String = word.chars().take(PREFIX_FIELD_COUNT + 1).collect();
                let begun = |other: &&String| other.starts_with(&prefix) && *other != word;
                (prefix.chars().count() > PREFIX_FIELD_COUNT
                    && words.iter().any(|other| begun(&other)))
                .then_some(prefix)
            })
        })
        .expect("a row holds two words one long prefix begins");
    // A word of the session followed by one a long prefix begins, the two joined into one phrase.
    let joined_long_prefix = session_rows
        .iter()
        .find_map(|(_, text)| {
            let words: Vec<String> = tokenize(text)
                .into_iter()
                .map(|token| token.folded)
                .collect();
            words.windows(2).find_map(|pair| {
                (pair[1].chars().count() > PREFIX_FIELD_COUNT).then(|| {
                    let prefix: String = pair[1].chars().take(PREFIX_FIELD_COUNT + 1).collect();
                    format!("{}-{prefix}", pair[0])
                })
            })
        })
        .expect("a row holds a word before a long one");
    // Joined words the pair field cuts: a first token longer than the cut before a one-letter
    // prefix, and three tokens.
    let session_words: Vec<Vec<String>> = session_rows
        .iter()
        .map(|(_, text)| {
            tokenize(text)
                .into_iter()
                .map(|token| token.folded)
                .collect()
        })
        .collect();
    let long_first_joined = session_words
        .iter()
        .find_map(|words| {
            words.windows(2).find_map(|pair| {
                (pair[0].chars().count() > PREFIX_FIELD_COUNT).then(|| {
                    let letter: String = pair[1].chars().take(1).collect();
                    format!("{}-{letter}", pair[0])
                })
            })
        })
        .expect("a row holds a long word before another");
    let three_joined = session_words
        .iter()
        .find_map(|words| {
            words.windows(3).next().map(|three| {
                let start: String = three[2].chars().take(2).collect();
                format!("{}-{}-{start}", three[0], three[1])
            })
        })
        .expect("a row holds three words");
    let queries = vec![
        query(&[first], false),
        query(&[first_letter], true),
        query(&[first, first_letter], true),
        query(&[first, first], false),
        query(&[joined.as_str()], false),
        query(&[joined_prefix.as_str()], true),
        query(&[long_prefix.as_str()], true),
        // The word and the prefix can mark one token, so their positions are read: the prefix's
        // from both its words in the row.
        query(&[format!("{RARE_PREFIX}a").as_str(), RARE_PREFIX], true),
        query(&[joined_long_prefix.as_str()], true),
        query(&[long_first_joined.as_str()], true),
        query(&[three_joined.as_str()], true),
        query(&[RARE_PREFIX], true),
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
