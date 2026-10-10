//! The find box's counts are the marks: on every log row of a session, the count `findInSession`
//! gives equals the number of stretches `markMatches` marks, and it finds exactly the rows every
//! phrase of the query occurs in. A ranking's count of a typed word of several tokens is how often
//! the tokens sit in order in a row, on exactly the rows where they do.

use std::collections::BTreeMap;

use tantivy::TERMINATED;

use crate::cursor::{CursorPurpose, RowsAsked, open_phrase_cursor};
use crate::find::{find_in_session, mark_matches};
use crate::phrase::{Phrase, query_phrases};
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
    // The long prefix after a word, beside a word its first four characters begin but it does not,
    // so the pair those four characters make holds a place the phrase lacks.
    rows.push(event(
        1,
        LARGEST_SESSION,
        &format!("zo {RARE_PREFIX}a zo qqqqbz"),
    ));
    // Every token of the phrase and the pair of its first two cuts, but never in its order.
    rows.push(event(
        2,
        LARGEST_SESSION,
        &format!("zo {RARE_PREFIX}b {RARE_PREFIX}a"),
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
    let row_words: Vec<Vec<String>> = session_rows
        .iter()
        .map(|(_, text)| {
            tokenize(text)
                .into_iter()
                .map(|token| token.folded)
                .collect()
        })
        .collect();
    let long_first_joined = row_words
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
    let three_joined = row_words
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
        query(&[format!("zo-{RARE_PREFIX}").as_str()], true),
        query(&[format!("zo-{RARE_PREFIX}a").as_str()], false),
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

// How many times `phrase`'s tokens sit in order in `text`, by the index's own tokens.
fn occurrences(text: &str, phrase: &Phrase) -> u32 {
    let tokens = tokenize(text);
    let occurs_at = |start: usize| {
        (0..phrase.parts.len()).all(|offset| {
            tokens.get(start + offset).is_some_and(|token| {
                token.position == tokens[start].position + offset as u32
                    && phrase.part_matches(offset, &token.folded)
            })
        })
    };
    (0..tokens.len()).filter(|start| occurs_at(*start)).count() as u32
}

#[test]
fn a_ranked_typed_word_counts_each_place_its_tokens_sit_in_order() {
    let mut rows: Vec<IndexRow> = Vec::new();
    generate(SIZE, |row| rows.push(row));
    // Look-alikes the pair field also holds beside the words: `pushed` begins with `push`, `login`
    // with `log`, `command` with `comm` and `файлы` with `файл`.
    let texts = [
        "git push origin",
        "git pushed origin",
        "git log, git login",
        "git commit, git command",
        "файл да",
        "файлы да",
    ];
    for (offset, text) in texts.into_iter().enumerate() {
        let key = (SIZE.messages as u64 + 1 + offset as u64) * 4;
        rows.push(event(key, LARGEST_SESSION, text));
    }
    // Two-letter, four- and six-letter prefixes and three- and four-letter whole words after a
    // short token; after a four-letter one a prefix and a whole word; a seeded long first token
    // and three tokens.
    let row_words: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            tokenize(&row.text)
                .into_iter()
                .map(|token| token.folded)
                .collect()
        })
        .collect();
    let seeded = |width: usize, is_long_first: bool| {
        row_words
            .iter()
            .find_map(|words| {
                words
                    .windows(width)
                    .find(|run| is_long_first == (run[0].chars().count() > PREFIX_FIELD_COUNT))
            })
            .map(|run| run.join("-"))
            .expect("a seeded row holds the run")
    };
    let words = [
        ("git.co".to_string(), true),
        ("git.comm".to_string(), true),
        ("git.commit".to_string(), true),
        ("git.log".to_string(), false),
        ("git.push".to_string(), false),
        ("push.or".to_string(), true),
        ("push.origin".to_string(), false),
        ("файл.да".to_string(), false),
        ("git.push.or".to_string(), true),
        (seeded(2, true), false),
        (seeded(2, true), true),
        (seeded(3, false), true),
    ];

    let folder = ScratchFolder::new("ranked-counts");
    let engine = open_engine(folder.path());
    engine
        .apply(&batch(1, rows.clone()))
        .expect("the set applies");
    let version = engine.current_version();
    for (word, is_prefix) in &words {
        let phrase = query_phrases(&query(&[word.as_str()], *is_prefix)).remove(0);
        let expected: BTreeMap<u64, u32> = rows
            .iter()
            .map(|row| (row.key as u64, occurrences(&row.text, &phrase)))
            .filter(|(_, count)| *count > 0)
            .collect();
        assert!(!expected.is_empty(), "{word:?} occurs in a row");
        // Walked, and sought at few rows, a prefix's words are read two ways.
        for asked in [RowsAsked::Every, RowsAsked::AtMost(1)] {
            let mut counted = BTreeMap::new();
            for (ordinal, segment) in version.searcher.segment_readers().iter().enumerate() {
                let opened = open_phrase_cursor(
                    segment,
                    &version.fields,
                    &phrase,
                    CursorPurpose::Score,
                    asked,
                )
                .expect("the cursor opens");
                let Some(mut cursor) = opened else {
                    continue;
                };
                let keys = &version.segments[ordinal].columns.key;
                let mut doc = cursor.doc();
                while doc != TERMINATED {
                    counted.insert(keys.get_val(doc), cursor.frequency());
                    doc = cursor.advance();
                }
            }
            assert_eq!(counted, expected, "{word:?} asked {asked:?}");
        }
    }
}
