//! A row longer than a page is indexed one document per page under its one key: a word on any page
//! finds the row once, a row's pages replace together, and a page never ends inside a word.

use crate::index::{SearchIndex, find_page_end};

use super::support::{FIRST_RANKED_SESSIONS, ScratchFolder, batch, event, open_index, query};

const SESSION: u64 = 1;
const ROW_KEY: u64 = 4;

// The sessions `word` ranks and each one's hit rows, through a held search as the daemon reads it.
fn search(index: &SearchIndex, word: &str) -> (Vec<u64>, Vec<Vec<u64>>) {
    let words = query(&[word], false);
    let mut search = index
        .open_search(Vec::new(), FIRST_RANKED_SESSIONS, Some(&words))
        .expect("the search opens");
    let sessions = search.sessions_at(0, 10).expect("the sessions rank");
    let hits = search.hits_of(&sessions).expect("the hits read");
    (sessions, hits)
}

// Killed by deleting a key before each page (the second page erases the first), by a page's own
// hit beside its row's (one row listed per page) and by a find that lists a row once per page.
#[test]
fn a_word_on_any_page_finds_the_row_once() {
    let folder = ScratchFolder::new("pages");
    let index = open_index(folder.path());
    let pages = vec![
        event(ROW_KEY, SESSION, "alpha words"),
        event(ROW_KEY, SESSION, "beta words"),
        event(ROW_KEY, SESSION, "gamma words quokka"),
    ];
    index.apply(&batch(1, pages)).expect("the pages apply");

    for word in ["alpha", "quokka", "words"] {
        assert_eq!(
            search(&index, word),
            (vec![SESSION], vec![vec![ROW_KEY]]),
            "{word}"
        );
    }
    let found = index
        .find_in_session(SESSION, &query(&["words"], false))
        .expect("the find reads");
    assert_eq!(found.row_keys, [ROW_KEY]);
    assert_eq!(found.match_counts, [3]);
}

// Killed by a replacement that keeps the row's earlier pages, deleting only where a key repeats
// inside one batch.
#[test]
fn a_row_that_shrank_to_one_page_leaves_no_page_behind() {
    let folder = ScratchFolder::new("shrunk-pages");
    let index = open_index(folder.path());
    let pages = vec![
        event(ROW_KEY, SESSION, "alpha words"),
        event(ROW_KEY, SESSION, "beta words"),
        event(ROW_KEY, SESSION, "gamma quokka"),
    ];
    index.apply(&batch(1, pages)).expect("the pages apply");
    let shrunk = vec![event(ROW_KEY, SESSION, "delta words")];
    index
        .apply(&batch(2, shrunk))
        .expect("the shrunk row applies");

    for word in ["alpha", "beta", "quokka"] {
        assert_eq!(search(&index, word), (Vec::new(), Vec::new()), "{word}");
    }
    assert_eq!(
        search(&index, "delta"),
        (vec![SESSION], vec![vec![ROW_KEY]])
    );
    let found = index
        .find_in_session(SESSION, &query(&["words"], false))
        .expect("the find reads");
    assert_eq!(found.match_counts, [1]);
}

// Killed by ending a page at the text's end whatever it ends inside, which cuts a word in two.
#[test]
fn a_page_ends_before_the_word_it_would_cut() {
    assert_eq!(find_page_end("one two thr"), "one two ".len());
    assert_eq!(find_page_end("one two "), "one two ".len());
    assert_eq!(find_page_end("unbroken"), "unbroken".len());
}
