//! Block skipping never drops a session that belongs in the top k, after the average row length
//! has moved far from the one a segment's block bounds were chosen under, among every session or
//! within a set of them, for a whole word and for a prefix longer than every prefix field; every
//! field a term can drive from holds each row's length, the bound's premise; a phrase walked
//! itself ranks as a full pass does; and the hits read for chosen sessions are the hits a full
//! pass scores.

use tantivy::tokenizer::MAX_TOKEN_LEN;

use crate::collector::{PreparedQuery, SessionSet, score_every_session, top_sessions};
use crate::phrase::query_phrases;
use crate::scorer::{phrase_idf, row_score};
use crate::{IndexBatch, IndexRow, RemovedOwner, SearchQuery};

use super::support::{ScratchFolder, batch, event, open_engine, query};

#[test]
fn every_driving_field_holds_each_row_as_long_as_its_text() {
    let folder = ScratchFolder::new("field-lengths");
    let engine = open_engine(folder.path());
    // A token too long to index leaves its place empty: one between two tokens, one closing a row.
    let unindexed = "q".repeat(MAX_TOKEN_LEN + 1);
    let texts = [
        "lo blemi x".to_string(),
        "x".to_string(),
        format!("lo {unindexed} blemi"),
        format!("lo blemi {unindexed}"),
    ];
    let rows = texts
        .iter()
        .enumerate()
        .map(|(index, text)| event(index as u64 * 4 + 4, 1, text))
        .collect();
    engine.apply(&batch(1, rows)).expect("the rows apply");
    let version = engine.current_version();
    let fields = version.fields;
    let segment = &version.searcher.segment_readers()[0];
    let text_lengths = segment.get_fieldnorms_reader(fields.text).expect("lengths");
    for field in fields.prefixes.into_iter().chain([fields.pair]) {
        let lengths = segment.get_fieldnorms_reader(field).expect("lengths");
        for doc in 0..segment.max_doc() {
            assert_eq!(
                lengths.fieldnorm(doc),
                text_lengths.fieldnorm(doc),
                "row {doc}"
            );
        }
    }
}

#[test]
fn a_phrase_walked_itself_ranks_as_a_full_pass() {
    let folder = ScratchFolder::new("own-walk");
    let engine = open_engine(folder.path());
    // `q` and words beginning with `w` fill most rows apart; a few rows hold `q` then such a word,
    // so `q-w` is far rarer than either and is walked itself.
    let mut rows = Vec::new();
    for index in 0..400u64 {
        let text = match index % 80 {
            0 => "q wa x q wb".to_string(),
            1 => "x q wa".to_string(),
            2 => format!("q wa {}", "x ".repeat(index as usize % 7)),
            _ if index % 2 == 0 => "q x".to_string(),
            _ => "wa x".to_string(),
        };
        rows.push(event(index * 4 + 4, 1_000 + index % 37, &text));
    }
    engine.apply(&batch(1, rows)).expect("the rows apply");
    let version = engine.current_version();
    let prepared = PreparedQuery::prepare(&version, query_phrases(&query(&["q-w"], true)))
        .expect("prepares")
        .expect("the phrase matches");
    let full = score_every_session(&version, &prepared, None)
        .expect("ranks")
        .order;
    assert!(full.len() > 4);
    for k in [1, 2, 4, full.len()] {
        let walked = top_sessions(&version, &prepared, k, None).expect("ranks");
        assert_eq!(walked, full[..k], "the best {k} sessions");
    }
}

// Segment one's postings for the searched word run in blocks of 128 rows. Block 0 opens with four
// sessions whose rows score just under the long row's once the average has moved; block 1 holds a
// short row that wins the block's stored bound under segment one's own short average, and the long
// row, which only wins under the moved one; a tail block follows so block 1 is full.
const CUTOFF_SESSIONS: [u64; 4] = [1, 2, 3, 4];
const SHORT_SESSION: u64 = 5;
const LONG_SESSION: u64 = 6;
// Two long rows of one session, ranked far down, whose order turns on each row's summed count: the
// row with two matches outranks the one with one only when a prefix's words' counts are summed.
const TWO_ROW_SESSION: u64 = 7;
const BLOCK: usize = 128;
const TAIL_ROWS: usize = 44;

fn repeated(word: &str, count: usize) -> String {
    vec![word; count].join(" ")
}

#[test]
fn pruned_rankings_equal_full_rankings_after_the_average_length_moves() {
    assert_pruned_rankings_equal_full_rankings(query(&["w"], false), |count| repeated("w", count));
    // Two words the prefix begins, alternating, so a row's count is the two words' counts summed.
    assert_pruned_rankings_equal_full_rankings(query(&["wwwwww"], true), |count| {
        let words: Vec<&str> = (0..count)
            .map(|index| if index % 2 == 0 { "wwwwwwa" } else { "wwwwwwb" })
            .collect();
        words.join(" ")
    });
}

// Builds the segments for `search`, `matches(n)` writing n words it matches, and checks the pruned
// rankings against the full ones.
fn assert_pruned_rankings_equal_full_rankings(
    search: SearchQuery,
    matches: impl Fn(usize) -> String,
) {
    let folder = ScratchFolder::new("pruning");
    let engine = open_engine(folder.path());
    let mut rows: Vec<IndexRow> = Vec::new();
    let mut next_filler_session = 100u64;
    let mut add = |session: Option<u64>, text: String| -> u64 {
        let session = session.unwrap_or_else(|| {
            next_filler_session += 1;
            next_filler_session
        });
        rows.push(event((rows.len() as u64 + 1) * 4, session, &text));
        session
    };
    let cutoff_text = format!("{} {}", matches(2), repeated("x", 7));
    for session in CUTOFF_SESSIONS {
        add(Some(session), cutoff_text.clone());
    }
    for _ in CUTOFF_SESSIONS.len()..BLOCK {
        add(None, format!("{} x", matches(1)));
    }
    add(Some(SHORT_SESSION), matches(1));
    add(
        Some(LONG_SESSION),
        format!("{} {}", matches(6), repeated("x", 33)),
    );
    for _ in BLOCK + 2..2 * BLOCK {
        add(None, format!("{} x", matches(1)));
    }
    let tail_sessions: Vec<u64> = (0..TAIL_ROWS)
        .map(|_| add(None, format!("{} x", matches(1))))
        .collect();
    let segment_one_rows = rows.len() as u64;
    let segment_one_tokens: u64 = 4 * 10 + 2 + 40 + (segment_one_rows - 6) * 3;
    engine.apply(&batch(1, rows)).expect("segment one applies");

    // A second segment of long rows without "w" raises the average; purging the tail's short rows
    // raises it further.
    let mut long_rows: Vec<IndexRow> = (0..300u64)
        .map(|index| event(100_000 + index * 4, 10_000 + index, &repeated("y", 76)))
        .collect();
    let two_row_texts = [
        format!("{} {}", matches(1), repeated("x", 21)),
        format!("{} {}", matches(2), repeated("x", 21)),
    ];
    for (index, text) in two_row_texts.iter().enumerate() {
        long_rows.push(event(200_000 + index as u64 * 4, TWO_ROW_SESSION, text));
    }
    engine
        .apply(&batch(2, long_rows))
        .expect("segment two applies");
    let purge = IndexBatch {
        removed_owners: tail_sessions
            .iter()
            .map(|session| RemovedOwner {
                owner_key: *session as i64,
                is_group: false,
            })
            .collect(),
        ..batch(3, Vec::new())
    };
    engine.apply(&purge).expect("the purge applies");

    let version = engine.current_version();
    let phrases = query_phrases(&search);
    let average = version.average_length();
    let written_average = f64::from(segment_one_tokens as f32 / segment_one_rows as f32);
    let idf = phrase_idf(
        version.live_rows,
        version.phrase_rows(&phrases[0]).expect("counts"),
    );
    let score = |frequency: u32, length: u64, average: f64| {
        row_score(&[idf], &[frequency], length, average)
    };
    // The construction's premises: the short row holds block 1's bound when written, the long row
    // outscores the cutoff sessions under the moved average, and the bound stays below them, so
    // only the drift between the two averages keeps block 1 from being skipped.
    assert!(score(1, 2, written_average) > score(6, 40, written_average));
    assert!(score(6, 40, average) > score(2, 10, average));
    assert!(score(1, 2, average) * (1.0 + 1e-3) < score(2, 10, average));

    let prepared = PreparedQuery::prepare(&version, phrases)
        .expect("prepares")
        .expect("the word matches");
    let scored = score_every_session(&version, &prepared, None).expect("ranks");
    assert_eq!(scored.hits[&TWO_ROW_SESSION], [200_004, 200_000]);
    // A session's hits read from its own rows, sought one by one, equal those of the full pass.
    for session in [LONG_SESSION, CUTOFF_SESSIONS[0], TWO_ROW_SESSION] {
        let alone = SessionSet::new(&[session], &version.membership);
        let within = score_every_session(&version, &prepared, Some(&alone)).expect("ranks");
        assert_eq!(within.hits[&session], scored.hits[&session]);
    }
    let full = scored.order;
    assert_eq!(full[0], LONG_SESSION);
    assert_eq!(full[1..5], CUTOFF_SESSIONS);
    // Within a set: two of the cutoff sessions, the short and the long one, and every other filler.
    let mut chosen = vec![
        CUTOFF_SESSIONS[1],
        CUTOFF_SESSIONS[3],
        SHORT_SESSION,
        LONG_SESSION,
    ];
    chosen.extend((101..next_filler_session).step_by(2));
    let set = SessionSet::new(&chosen, &version.membership);
    let full_within = score_every_session(&version, &prepared, Some(&set))
        .expect("ranks")
        .order;
    assert!(full_within.iter().all(|session| chosen.contains(session)));
    assert_eq!(full_within[..3], [LONG_SESSION, 2, 4]);
    for k in [1, 2, 4, 8] {
        let pruned = top_sessions(&version, &prepared, k, None).expect("ranks");
        assert_eq!(pruned, full[..k], "the best {k} sessions");
        let pruned_within = top_sessions(&version, &prepared, k, Some(&set)).expect("ranks");
        assert_eq!(
            pruned_within,
            full_within[..k],
            "the best {k} sessions of the set"
        );
    }
}
