//! A row longer than a page is one document per page, one edge document per page boundary and a
//! terminal document under its one key: it is found once, counted and scored as the same text in
//! one document once its terminal document lands and not at all before, and its documents are
//! replaced together; a page never ends inside a word.

use rstest::rstest;

use crate::index::collector::{PreparedQuery, row_scores};
use crate::index::phrase::query_phrases;
use crate::index::{
    IndexBatch, IndexRow, IndexRowKind, LongRowDocument, LongRowDocuments, SearchIndex,
    SearchQuery, find_page_end, mark_matches,
};

use super::support::{
    FIRST_RANKED_SESSIONS, ScratchFolder, batch, event, live_counts, open_index, query,
};

const SESSION: u64 = 1;
const ROW_KEY: u64 = 4;

// Rows of other sessions holding the query's words, so N, each phrase's n and the average length
// are ones a miscount would change.
fn other_rows() -> Vec<IndexRow> {
    vec![
        event(8, 2, "words before deploy"),
        event(12, 2, "alpha and beta apart"),
        event(16, 3, "rollback words words"),
        event(20, 3, "beta words"),
    ]
}

// The row at `ROW_KEY` as its documents, its pages in order.
fn long_row(pages: &[&str]) -> Vec<LongRowDocument> {
    let mut long_row = LongRowDocuments::new(ROW_KEY, IndexRowKind::Event, SESSION);
    let mut documents = Vec::new();
    for page in pages {
        long_row.add_page(page, &mut |document| documents.push(document));
    }
    long_row.finish(&mut |document| documents.push(document));
    documents
}

// The sessions `words` ranks and each one's hit rows, through a held search as the daemon reads it.
fn search(index: &SearchIndex, words: &SearchQuery) -> (Vec<u64>, Vec<Vec<u64>>) {
    let mut search = index
        .open_search(Vec::new(), FIRST_RANKED_SESSIONS, Some(words))
        .expect("the search opens");
    let sessions = search.sessions_at(0, 10).expect("the sessions rank");
    let hits = search.hits_of(&sessions).expect("the hits read");
    (sessions, hits)
}

// Every matching row's score by key, as the collector scores it; none when a word matches no row.
fn scores(index: &SearchIndex, words: &SearchQuery) -> Vec<(u64, u64)> {
    let version = index.current_version();
    let Some(prepared) =
        PreparedQuery::prepare(&version, query_phrases(words)).expect("the query prepares")
    else {
        return Vec::new();
    };
    let mut scores: Vec<(u64, u64)> = row_scores(&version, &prepared)
        .expect("the rows score")
        .into_iter()
        .map(|(key, score)| (key, score.to_bits()))
        .collect();
    scores.sort_unstable();
    scores
}

// A row of two pages applied without its terminal document is found by nothing and leaves N, n, the
// token total and every other row's score as they were without it, to the bit. Once its terminal
// document lands in a later commit, it is found once by a phrase across its page edge, and by two
// words on different pages; its count is its whole text's, a token two phrases cover counted once;
// and N, n, the token total and every row's score equal the index holding the same text as one
// document, to the bit. Killed by admitting a row whose terminal document is not live, by leaving
// such a row's length or its matched pages in a total, by dropping the edge document (the phrase
// misses the row), by counting an edge's matches that do not cross, by a long row's length summed
// over its pages' lengths (each one too long), by counting each page or edge in N or n, and by a
// page's own hit beside its row's.
#[rstest]
#[case::a_phrase_across_the_page_edge(
    &["words before alpha ", "beta words after"],
    &["alpha-beta", "beta", "words"]
)]
#[case::words_on_different_pages(&["deploy words ", "words rollback"], &["deploy", "rollback"])]
fn a_long_row_is_found_counted_and_scored_as_its_whole_text(
    #[case] pages: &[&str],
    #[case] words: &[&str],
) {
    let mut documents = long_row(pages);
    let terminal = documents
        .pop()
        .expect("a row's documents end with its terminal document");
    let paged_folder = ScratchFolder::new("paged");
    let paged = open_index(paged_folder.path());
    paged
        .apply(&IndexBatch {
            long_row_documents: documents,
            ..batch(1, other_rows())
        })
        .expect("the paged row's pages apply");
    let whole_folder = ScratchFolder::new("whole");
    let whole = open_index(whole_folder.path());
    whole
        .apply(&batch(1, other_rows()))
        .expect("the other rows apply");
    let words = query(words, false);

    assert_eq!(search(&paged, &words), search(&whole, &words));
    assert_eq!(
        live_counts(&paged.current_version(), &words),
        live_counts(&whole.current_version(), &words)
    );
    assert_eq!(scores(&paged, &words), scores(&whole, &words));

    paged
        .apply(&IndexBatch {
            long_row_documents: vec![terminal],
            continued_key: Some(ROW_KEY),
            ..batch(2, Vec::new())
        })
        .expect("the paged row's terminal document applies");
    let text = pages.concat();
    whole
        .apply(&batch(2, vec![event(ROW_KEY, SESSION, &text)]))
        .expect("the whole row applies");

    assert_eq!(search(&paged, &words), (vec![SESSION], vec![vec![ROW_KEY]]));
    let found = paged
        .find_in_session(SESSION, &words)
        .expect("the find reads");
    assert_eq!(found.row_keys, [ROW_KEY]);
    assert_eq!(
        found.match_counts,
        [u32::try_from(mark_matches(&text, &words).len()).expect("a short text's marks")]
    );
    assert_eq!(
        live_counts(&paged.current_version(), &words),
        live_counts(&whole.current_version(), &words)
    );
    assert_eq!(scores(&paged, &words), scores(&whole, &words));
}

// Killed by a replacement that keeps the row's earlier pages or its edges, deleting only where a
// key repeats inside one batch.
#[test]
fn a_row_that_shrank_to_one_page_leaves_no_page_behind() {
    let folder = ScratchFolder::new("shrunk-pages");
    let index = open_index(folder.path());
    index
        .apply(&IndexBatch {
            long_row_documents: long_row(&["alpha words ", "beta words ", "gamma quokka"]),
            ..batch(1, Vec::new())
        })
        .expect("the pages apply");
    let shrunk = vec![event(ROW_KEY, SESSION, "delta words")];
    index
        .apply(&batch(2, shrunk))
        .expect("the shrunk row applies");

    for word in ["alpha", "beta", "quokka", "words-beta"] {
        assert_eq!(
            search(&index, &query(&[word], false)),
            (Vec::new(), Vec::new()),
            "{word}"
        );
    }
    assert_eq!(
        search(&index, &query(&["delta"], false)),
        (vec![SESSION], vec![vec![ROW_KEY]])
    );
    let found = index
        .find_in_session(SESSION, &query(&["words"], false))
        .expect("the find reads");
    assert_eq!(found.match_counts, [1]);
    assert_eq!(index.current_version().live_rows, 1);
}

// Killed by ending a page at the text's end whatever it ends inside, which cuts a word in two.
#[test]
fn a_page_ends_before_the_word_it_would_cut() {
    assert_eq!(find_page_end("one two thr"), "one two ".len());
    assert_eq!(find_page_end("one two "), "one two ".len());
    assert_eq!(find_page_end("unbroken"), "unbroken".len());
}
