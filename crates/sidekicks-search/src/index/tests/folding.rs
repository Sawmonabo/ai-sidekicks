//! Case and diacritics fold away in the index and in the marks, while a mark that spells a sound
//! stays, and a typed word that splits into several tokens matches only where they sit next to
//! each other in order. The case fold equals full Unicode case folding on every code point.

use std::fmt::Write as _;
use std::ops::RangeInclusive;

use caseless::Caseless;
use unicode_normalization::char::decompose_canonical;

use crate::index::find::mark_matches;
use crate::index::tokenizer::{fold_into, is_dropped_mark};

use super::support::{FIRST_RANKED_SESSIONS, ScratchFolder, batch, event, open_index, query};

// The code points whose fold differs from `caseless`'s: those Unicode 17.0 gave a case folding
// that Unicode 16.0, the version `caseless` is built on, did not, since the index folds by Unicode
// 17.0 data. They are three Latin capitals and the Beria Erfe capitals added in 17.0.
const NEWLY_FOLDED: [RangeInclusive<char>; 4] = [
    '\u{A7CE}'..='\u{A7CE}',
    '\u{A7D2}'..='\u{A7D2}',
    '\u{A7D4}'..='\u{A7D4}',
    '\u{16EA0}'..='\u{16EB8}',
];

fn marks(text: &str, words: &[&str], last_word_is_prefix: bool) -> Vec<(u32, u32)> {
    mark_matches(text, &query(words, last_word_is_prefix))
        .into_iter()
        .map(|range| (range.start, range.end))
        .collect()
}

// The index's fold with `caseless` doing the case folding: canonical decomposition, diacritics
// removed, then full case folding; folding can itself produce a letter with a diacritic, which is
// decomposed and dropped the same way.
fn caseless_fold_into(character: char, folded: &mut String) {
    if character.is_ascii() {
        folded.push(character.to_ascii_lowercase());
        return;
    }
    decompose_canonical(character, |part| {
        if is_dropped_mark(part) {
            return;
        }
        for case_folded in std::iter::once(part).default_case_fold() {
            decompose_canonical(case_folded, |piece| {
                if !is_dropped_mark(piece) {
                    folded.push(piece);
                }
            });
        }
    });
}

#[test]
fn folded_words_match_and_split_words_need_adjacent_tokens() {
    let folder = ScratchFolder::new("folding");
    let index = open_index(folder.path());
    let rows = vec![
        event(4, 1, "Ångström units"),
        event(8, 2, "a NAÏVE approach"),
        event(12, 3, "Die Straße"),
        event(16, 4, "foo-bar baz"),
        event(20, 5, "foo baz bar"),
        event(24, 6, "bar foo"),
        event(28, 7, "A\u{30A}ngstro\u{308}m, decomposed"),
        event(32, 8, "काम पूरा"),
    ];
    index.apply(&batch(1, rows)).expect("the batch applies");
    let sessions = |words: &[&str], last_word_is_prefix: bool| -> Vec<u64> {
        let query = query(words, last_word_is_prefix);
        let mut search = index
            .open_search(Vec::new(), FIRST_RANKED_SESSIONS, Some(&query))
            .expect("opens");
        search.sessions_at(0, 10).expect("ranks")
    };

    assert_eq!(sessions(&["angstrom"], false), vec![1, 7]);
    assert_eq!(sessions(&["ÅNGSTRÖM"], false), vec![1, 7]);
    assert_eq!(sessions(&["naive"], false), vec![2]);
    assert_eq!(sessions(&["strasse"], false), vec![3]);
    assert_eq!(sessions(&["STRASSE"], false), vec![3]);
    assert_eq!(sessions(&["foo-bar"], false), vec![4]);
    assert_eq!(sessions(&["foo.b"], true), vec![4, 5]);
    // A Devanagari vowel sign is part of its word, not a diacritic.
    assert_eq!(sessions(&["काम"], false), vec![8]);
    assert_eq!(sessions(&["कम"], false), Vec::<u64>::new());

    assert_eq!(marks("Ångström units", &["angstrom"], false), vec![(0, 8)]);
    assert_eq!(
        marks("A\u{30A}ngstro\u{308}m units", &["ÅNGSTRÖM"], false),
        vec![(0, 10)]
    );
    assert_eq!(
        marks("x Straße 😀 straße", &["strasse"], false),
        vec![(2, 8), (12, 18)]
    );
    assert_eq!(marks("a NAÏVE approach", &["naive"], false), vec![(2, 7)]);
    assert_eq!(
        marks("foo-bar baz foo bar", &["foo-bar"], false),
        vec![(0, 3), (4, 7), (12, 15), (16, 19)],
    );
    assert_eq!(marks("foo baz bar", &["foo-bar"], false), vec![]);
}

#[test]
fn the_fold_equals_caseless_on_every_code_point_but_those_unicode_17_newly_folds() {
    let mut differing: Vec<char> = Vec::new();
    let mut report = String::new();
    let (mut folded, mut scratch, mut caseless_folded) =
        (String::new(), String::new(), String::new());
    for character in (0..=u32::from(char::MAX)).filter_map(char::from_u32) {
        folded.clear();
        caseless_folded.clear();
        fold_into(character, &mut folded, &mut scratch);
        caseless_fold_into(character, &mut caseless_folded);
        if folded != caseless_folded {
            differing.push(character);
            writeln!(
                report,
                "U+{:04X}: folds to {folded:?}, caseless to {caseless_folded:?}",
                u32::from(character)
            )
            .expect("writing to a String cannot fail");
        }
    }
    let expected: Vec<char> = NEWLY_FOLDED.into_iter().flatten().collect();
    assert_eq!(
        differing, expected,
        "the code points whose two folds differ:\n{report}"
    );
}
