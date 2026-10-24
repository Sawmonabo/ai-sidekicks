//! One session's matching log rows with every match counted, and the matched stretches of one
//! text, both by the index's own tokens so a row's count is the number of stretches marked in it.

use tantivy::TERMINATED;
use tantivy::schema::IndexRecordOption;

use crate::index::cursor::token::term_cursor;
use crate::index::cursor::{CursorPurpose, GatedCursors, PhraseCursor, RowMatch};
use crate::index::long_row::matches::long_row_match_counts;
use crate::index::phrase::{Phrase, query_phrases};
use crate::index::schema::{EVENT_KIND, Owner, owner_term};
use crate::index::tokenizer::tokenize;
use crate::index::version::IndexVersion;
use crate::index::{MatchRange, SearchQuery, SessionFind};

/// The session's live `event` rows matching every phrase, newest first, each once with the number
/// of tokens `mark_matches` marks in it, a row longer than a page counted over its whole text.
/// Fails when Tantivy fails a read.
pub(crate) fn find_in_session(
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
            let asked = rows.cost();
            let mut gated = GatedCursors::new(segment, &version.fields, &phrases, purpose, asked)?;
            let columns = &version.segments[ordinal].columns;
            let alive = segment.alive_bitset();
            let mut marked = Vec::new();
            let mut doc = rows.doc();
            while doc != TERMINATED {
                // The phrases before the columns: most of a session's rows miss a typed word.
                match gated.at(doc)? {
                    RowMatch::Matches(cursors) => {
                        if alive.is_none_or(|alive| alive.is_alive(doc))
                            && columns.kind.get_val(doc) == EVENT_KIND
                            && columns.piece.get_val(doc) == 0
                        {
                            let count = row_match_count(cursors, purpose, &mut marked);
                            found.push((columns.key.get_val(doc), count));
                        }
                    }
                    RowMatch::Misses => {}
                    RowMatch::NoRowMatches => break,
                }
                doc = rows.advance();
            }
        }
        found.extend(long_row_match_counts(version, &phrases, session_key)?);
    }
    found.sort_unstable_by_key(|(key, _)| std::cmp::Reverse(*key));
    let (row_keys, match_counts) = found.into_iter().unzip();
    Ok(SessionFind {
        row_keys,
        match_counts,
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
    for cursor in cursors {
        cursor.marked_positions(marked);
        every_marked.extend_from_slice(marked);
    }
    every_marked.sort_unstable();
    every_marked.dedup();
    u32::try_from(every_marked.len()).expect("a row holds far fewer than 2^32 tokens")
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
                let offset_position =
                    u32::try_from(offset).expect("a phrase has far fewer parts than 2^32");
                tokens.get(start + offset).is_some_and(|token| {
                    token.position == first_position + offset_position
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
