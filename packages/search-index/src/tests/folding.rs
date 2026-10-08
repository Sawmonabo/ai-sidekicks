//! Case and diacritics fold away in the index and in the marks, and a typed word that splits into
//! several tokens matches only where they sit next to each other in order.

use crate::find::mark_matches;
use crate::view::SearchView;

use super::support::{ScratchFolder, batch, event, open_engine, query};

fn marks(text: &str, words: &[&str], last_word_is_prefix: bool) -> Vec<(u32, u32)> {
    mark_matches(text, &query(words, last_word_is_prefix))
        .into_iter()
        .map(|range| (range.start, range.end))
        .collect()
}

#[test]
fn folded_words_match_and_split_words_need_adjacent_tokens() {
    let folder = ScratchFolder::new("folding");
    let engine = open_engine(folder.path());
    let rows = vec![
        event(4, 1, "Ångström units"),
        event(8, 2, "a NAÏVE approach"),
        event(12, 3, "Die Straße"),
        event(16, 4, "foo-bar baz"),
        event(20, 5, "foo baz bar"),
        event(24, 6, "bar foo"),
        event(28, 7, "A\u{30A}ngstro\u{308}m, decomposed"),
    ];
    engine.apply(&batch(1, rows)).expect("the batch applies");
    let sessions = |words: &[&str], last_word_is_prefix: bool| -> Vec<u64> {
        let query = query(words, last_word_is_prefix);
        let mut view = SearchView::open(engine.current_version(), &query, None).expect("opens");
        view.sessions_at(0, 10).expect("ranks")
    };

    assert_eq!(sessions(&["angstrom"], false), vec![1, 7]);
    assert_eq!(sessions(&["ÅNGSTRÖM"], false), vec![1, 7]);
    assert_eq!(sessions(&["naive"], false), vec![2]);
    assert_eq!(sessions(&["strasse"], false), vec![3]);
    assert_eq!(sessions(&["STRASSE"], false), vec![3]);
    assert_eq!(sessions(&["foo-bar"], false), vec![4]);
    assert_eq!(sessions(&["foo.b"], true), vec![4, 5]);

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
