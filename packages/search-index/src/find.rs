//! One session's matching log rows with every match counted, and the matched stretches of one
//! text, both by the index's own tokens so a row's count is the number of stretches marked in it.

use napi::bindgen_prelude::{Float64Array, Uint32Array};
use tantivy::TERMINATED;
use tantivy::schema::IndexRecordOption;

use crate::collector::all_on;
use crate::cursor::{CursorPurpose, PhraseCursor, RowFilters, open_phrase_cursor, term_cursor};
use crate::phrase::{Phrase, query_phrases};
use crate::schema::{EVENT_KIND, Owner, owner_term};
use crate::tokenizer::tokenize;
use crate::version::IndexVersion;
use crate::{MatchRange, SearchQuery, SessionFind};

/// The session's live `event` rows matching every phrase, newest first, each with the number of
/// tokens `mark_matches` marks in it.
pub fn find_in_session(
    version: &IndexVersion,
    session_key: u64,
    query: &SearchQuery,
) -> tantivy::Result<SessionFind> {
    let phrases = query_phrases(query);
    let mut found: Vec<(u64, u32)> = Vec::new();
    if !phrases.is_empty() {
        // A row's count is its phrases' summed counts unless one token could be marked by two
        // phrases or a phrase spans tokens; then the marked positions are read and counted once.
        let purpose = if counts_need_positions(&phrases) {
            CursorPurpose::Mark
        } else {
            CursorPurpose::Score
        };
        let owner = owner_term(&version.fields, Owner::Session(session_key));
        for (ordinal, segment) in version.searcher.segment_readers().iter().enumerate() {
            let Some(mut rows) = term_cursor(segment, &owner, IndexRecordOption::Basic)? else {
                continue;
            };
            let mut cursors = Vec::with_capacity(phrases.len());
            for phrase in &phrases {
                match open_phrase_cursor(segment, &version.fields, phrase, purpose)? {
                    Some(cursor) => cursors.push(cursor),
                    None => break,
                }
            }
            if cursors.len() < phrases.len() {
                continue;
            }
            let mut filters = RowFilters::open(segment, &version.fields, &phrases)?;
            let columns = &version.segments[ordinal].columns;
            let alive = segment.alive_bitset();
            let mut marked = Vec::new();
            let mut doc = rows.doc();
            while doc != TERMINATED {
                if alive.is_none_or(|alive| alive.is_alive(doc))
                    && columns.kind.get_val(doc) == EVENT_KIND
                    && filters.admit(doc)
                    && all_on(&mut cursors, doc)
                {
                    let count = row_match_count(&mut cursors, purpose, &mut marked);
                    found.push((columns.key.get_val(doc), count));
                }
                doc = rows.advance();
            }
        }
    }
    found.sort_unstable_by_key(|(key, _)| std::cmp::Reverse(*key));
    // Keys are held below 2^53 (`MAX_KEY`), so each converts to an f64 exactly.
    Ok(SessionFind {
        row_keys: Float64Array::new(found.iter().map(|(key, _)| *key as f64).collect()),
        match_counts: Uint32Array::new(found.iter().map(|(_, count)| *count).collect()),
    })
}

fn counts_need_positions(phrases: &[Phrase]) -> bool {
    phrases.iter().any(|phrase| phrase.parts.len() > 1)
        || phrases.iter().enumerate().any(|(index, phrase)| {
            phrases[index + 1..]
                .iter()
                .any(|other| phrase.can_share_a_token_with(other))
        })
}

fn row_match_count(
    cursors: &mut [PhraseCursor],
    purpose: CursorPurpose,
    marked: &mut Vec<u32>,
) -> u32 {
    if purpose == CursorPurpose::Score {
        return cursors.iter_mut().map(PhraseCursor::frequency).sum();
    }
    let mut every_marked: Vec<u32> = Vec::new();
    for cursor in cursors.iter_mut() {
        cursor.marked_positions(marked);
        every_marked.extend_from_slice(marked);
    }
    every_marked.sort_unstable();
    every_marked.dedup();
    every_marked.len() as u32
}

/// Where the query's phrases match in `text`, in order: each token a phrase occurrence covers, in
/// UTF-16 code units, once however many phrases cover it.
pub fn mark_matches(text: &str, query: &SearchQuery) -> Vec<MatchRange> {
    let phrases = query_phrases(query);
    let tokens = tokenize(text);
    let mut marked = vec![false; tokens.len()];
    for phrase in &phrases {
        let width = phrase.parts.len();
        for start in 0..tokens.len() {
            let first_position = tokens[start].position;
            let occurs = (0..width).all(|offset| {
                tokens.get(start + offset).is_some_and(|token| {
                    token.position == first_position + offset as u32
                        && phrase.part_matches(offset, &token.folded)
                })
            });
            if occurs {
                marked[start..start + width].fill(true);
            }
        }
    }
    tokens
        .iter()
        .zip(marked)
        .filter(|(_, is_marked)| *is_marked)
        .map(|(token, _)| MatchRange {
            start: token.start,
            end: token.end,
        })
        .collect()
}
