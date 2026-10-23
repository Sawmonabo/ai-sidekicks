//! Each live row longer than a page matched as one row: a phrase counts on its pages, and on an
//! edge document only where it covers both sides of the boundary, read from its positions. Rows
//! found here are scored and counted as one document; the main passes skip their documents.

use std::collections::{HashMap, HashSet};

use tantivy::DocId;

use crate::index::cursor::{CursorPurpose, PhraseCursor, RowsAsked, open_phrase_cursor};
use crate::index::long_row::rows::LongRow;
use crate::index::phrase::Phrase;
use crate::index::schema::{EDGE_PIECE, EVENT_KIND, Owner, PAGE_PIECE, owner_value};
use crate::index::version::IndexVersion;

/// A live row longer than a page that every phrase of a query matches.
#[derive(Clone, Debug)]
pub(crate) struct LongRowMatch {
    /// The row's key.
    pub(crate) key: u64,
    /// The row's owner, kind and length.
    pub(crate) row: LongRow,
    /// How many times each phrase occurs in the row, in phrase order.
    pub(crate) frequencies: Vec<u32>,
}

/// What a phrase matches among the live documents of rows longer than a page.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LongPhraseCounts {
    /// The live pages and edge documents the phrase matches, wherever it sits in them.
    pub(crate) matched_documents: u64,
    /// The whole rows the phrase matches on a page or across a boundary; a row whose terminal
    /// document has not landed adds none.
    pub(crate) matched_rows: u64,
}

// Where a document sits in its long row: a page from `place`, or an edge document from `place`
// whose boundary falls before its own place `boundary`.
#[derive(Clone, Copy)]
enum Placed {
    Page { place: u32 },
    Edge { place: u32, boundary: u32 },
}

/// The live rows longer than a page that `keeps` keeps and every one of `phrases` matches, each
/// with its phrases' frequencies summed over its pages and its edges' crossings. Fails when Tantivy
/// fails a read.
pub(crate) fn matching_long_rows(
    version: &IndexVersion,
    phrases: &[Phrase],
    keeps: impl Fn(&LongRow) -> bool,
) -> tantivy::Result<Vec<LongRowMatch>> {
    let mut frequencies: HashMap<u64, Vec<u32>> = HashMap::new();
    let mut starts = Vec::new();
    walk_documents(
        version,
        phrases,
        CursorChoice::ForCounts,
        // A terminal document holds no text, so no phrase matches it.
        |code| code != 0,
        |row| row.is_some_and(&keeps),
        |key, placed, cursors, on| {
            for (index, cursor) in cursors.iter_mut().enumerate() {
                let Some(cursor) = cursor.as_mut().filter(|_| on[index]) else {
                    continue;
                };
                let added = match placed {
                    Placed::Page { .. } => cursor.frequency(),
                    Placed::Edge { place, boundary } => {
                        cursor.starts_across(boundary - place, &mut starts);
                        u32::try_from(starts.len()).expect("a document holds far fewer than 2^32")
                    }
                };
                if added > 0 {
                    frequencies
                        .entry(key)
                        .or_insert_with(|| vec![0; phrases.len()])[index] += added;
                }
            }
        },
    )?;
    let rows = &version.long_rows.rows;
    Ok(frequencies
        .into_iter()
        .filter(|(_, frequencies)| frequencies.iter().all(|frequency| *frequency > 0))
        .map(|(key, frequencies)| LongRowMatch {
            key,
            row: rows[&key].clone(),
            frequencies,
        })
        .collect())
}

/// What `phrase` matches among the live documents of rows longer than a page. Fails when Tantivy
/// fails a read.
pub(crate) fn phrase_long_row_counts(
    version: &IndexVersion,
    phrase: &Phrase,
) -> tantivy::Result<LongPhraseCounts> {
    let mut matched_documents = 0;
    let mut rows = HashSet::new();
    let mut starts = Vec::new();
    // A row not yet whole is walked too: the documents of it that a phrase matches leave n, and it
    // adds no row.
    walk_documents(
        version,
        std::slice::from_ref(phrase),
        CursorChoice::ForCounts,
        |code| code != 0,
        |_| true,
        |key, placed, cursors, _| {
            matched_documents += 1;
            if !version.long_rows.rows.contains_key(&key) {
                return;
            }
            let Some(cursor) = cursors[0].as_mut() else {
                return;
            };
            let is_row_match = match placed {
                Placed::Page { .. } => true,
                Placed::Edge { place, boundary } => {
                    cursor.starts_across(boundary - place, &mut starts);
                    !starts.is_empty()
                }
            };
            if is_row_match {
                rows.insert(key);
            }
        },
    )?;
    Ok(LongPhraseCounts {
        matched_documents,
        matched_rows: rows.len() as u64,
    })
}

/// The live `event` rows longer than a page of the session at `session_key` that every one of
/// `phrases` matches, each with the number of tokens `mark_matches` marks in its whole text: its
/// pages' marked tokens, and those a match across a boundary covers that no page match covers.
/// Fails when Tantivy fails a read.
pub(crate) fn long_row_match_counts(
    version: &IndexVersion,
    phrases: &[Phrase],
    session_key: u64,
) -> tantivy::Result<Vec<(u64, u32)>> {
    let owner = owner_value(Owner::Session(session_key));
    let keeps =
        |row: Option<&LongRow>| row.is_some_and(|row| row.owner == owner && row.kind == EVENT_KIND);
    let mut matched: HashMap<u64, Vec<bool>> = HashMap::new();
    let mut note_match = |key: u64, index: usize| {
        matched
            .entry(key)
            .or_insert_with(|| vec![false; phrases.len()])[index] = true;
    };
    // The places, in the row, that a match across a boundary covers; one token covers no two
    // places, so only a phrase of several tokens has any.
    let mut crossing: HashMap<u64, Vec<u32>> = HashMap::new();
    if phrases.iter().any(|phrase| phrase.parts.len() > 1) {
        let mut starts = Vec::new();
        walk_documents(
            version,
            phrases,
            CursorChoice::ForPositions,
            |code| code == EDGE_PIECE,
            keeps,
            |key, placed, cursors, on| {
                let Placed::Edge { place, boundary } = placed else {
                    return;
                };
                for (index, cursor) in cursors.iter_mut().enumerate() {
                    let Some(cursor) = cursor.as_mut().filter(|_| on[index]) else {
                        continue;
                    };
                    cursor.starts_across(boundary - place, &mut starts);
                    if starts.is_empty() {
                        continue;
                    }
                    note_match(key, index);
                    let width = cursor.width();
                    let covered = crossing.entry(key).or_default();
                    for start in &starts {
                        covered.extend(place + start..place + start + width);
                    }
                }
            },
        )?;
        for covered in crossing.values_mut() {
            covered.sort_unstable();
            covered.dedup();
        }
    }
    let mut counts: HashMap<u64, u32> = HashMap::new();
    let mut marked = Vec::new();
    let mut page_marked = Vec::new();
    walk_documents(
        version,
        phrases,
        CursorChoice::ForPositions,
        |code| code == PAGE_PIECE,
        keeps,
        |key, placed, cursors, on| {
            let Placed::Page { place } = placed else {
                return;
            };
            page_marked.clear();
            for (index, cursor) in cursors.iter_mut().enumerate() {
                let Some(cursor) = cursor.as_mut().filter(|_| on[index]) else {
                    continue;
                };
                note_match(key, index);
                cursor.marked_positions(&mut marked);
                page_marked.extend_from_slice(&marked);
            }
            page_marked.sort_unstable();
            page_marked.dedup();
            let covered = crossing.get(&key).map_or(&[][..], Vec::as_slice);
            // A token a crossing match covers too is counted once, with the crossing ones.
            let also_crossed = page_marked
                .iter()
                .filter(|position| covered.binary_search(&(place + **position)).is_ok())
                .count();
            *counts.entry(key).or_default() += u32::try_from(page_marked.len() - also_crossed)
                .expect("a row holds far fewer than 2^32 tokens");
        },
    )?;
    Ok(matched
        .into_iter()
        .filter(|(_, phrases_matched)| phrases_matched.iter().all(|is_matched| *is_matched))
        .map(|(key, _)| {
            let crossed = crossing.get(&key).map_or(0, Vec::len);
            let count = counts.get(&key).copied().unwrap_or(0)
                + u32::try_from(crossed).expect("a row holds far fewer than 2^32 tokens");
            (key, count)
        })
        .collect())
}

// Which cursors a walk opens: counting cursors where a one-token phrase's count is all it needs, a
// phrase of several tokens reading positions for its crossings; or positions for every phrase.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CursorChoice {
    ForCounts,
    ForPositions,
}

// Walks the live documents of the long rows `keeps` keeps, handed each whole row or `None` for a
// row not yet whole, whose piece code `wants`, segment by segment in document order, calling
// `visit` with the row's key, where the document sits, each phrase's cursor in the segment (`None`
// where the segment holds none of its rows) and whether each one matches the document, wherever
// at least one does.
fn walk_documents(
    version: &IndexVersion,
    phrases: &[Phrase],
    choice: CursorChoice,
    wants: impl Fn(u64) -> bool,
    keeps: impl Fn(Option<&LongRow>) -> bool,
    mut visit: impl FnMut(u64, Placed, &mut [Option<PhraseCursor>], &[bool]),
) -> tantivy::Result<()> {
    let long_rows = &version.long_rows;
    let mut on = vec![false; phrases.len()];
    for (ordinal, segment) in version.searcher.segment_readers().iter().enumerate() {
        let columns = &version.segments[ordinal].columns;
        let documents: Vec<(DocId, u64)> = long_rows.segments[ordinal]
            .documents
            .iter()
            .copied()
            .filter(|(doc, key)| {
                wants(columns.piece.get_val(*doc)) && keeps(long_rows.rows.get(key))
            })
            .collect();
        if documents.is_empty() {
            continue;
        }
        let asked = RowsAsked::AtMost(documents.len() as u64);
        let mut cursors = Vec::with_capacity(phrases.len());
        for phrase in phrases {
            let purpose = if choice == CursorChoice::ForPositions || phrase.parts.len() > 1 {
                CursorPurpose::Mark
            } else {
                CursorPurpose::Score
            };
            cursors.push(open_phrase_cursor(
                segment,
                &version.fields,
                phrase,
                purpose,
                asked,
            )?);
        }
        for (doc, key) in documents {
            let mut is_any_on = false;
            for (is_on, cursor) in on.iter_mut().zip(&mut cursors) {
                *is_on = cursor.as_mut().is_some_and(|cursor| cursor.matches_at(doc));
                is_any_on |= *is_on;
            }
            if !is_any_on {
                continue;
            }
            let place = u32::try_from(columns.place.get_val(doc))
                .expect("a row's places are counted in 32 bits");
            let placed = if columns.piece.get_val(doc) == EDGE_PIECE {
                Placed::Edge {
                    place,
                    boundary: u32::try_from(columns.boundary.get_val(doc))
                        .expect("a row's places are counted in 32 bits"),
                }
            } else {
                Placed::Page { place }
            };
            visit(key, placed, &mut cursors, &on);
        }
    }
    Ok(())
}
