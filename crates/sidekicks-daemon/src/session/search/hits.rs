//! The line each hit shows, read from the database by the hit's key: the row's text as it is now,
//! marked where the search matches it on the first of its pages that holds a match. The index stores no text, so a hit whose row is gone since
//! the index saw it is passed over, and one whose text changed is marked on its current text, or
//! passed over once that text no longer holds a match. A search with words marks them as the index
//! finds them; a search by tags alone marks each tag's levels the queried tag names.

use sidekicks_search::index::{MatchRange, SearchQuery, mark_matches};

use crate::session::search::index::rows::{IndexRowReader, LogRowPosition, SourceRow};
use crate::session::search::marked_line::{MarkedLine, cut_marked_line};

/// A hit's row as the database holds it now, and the marked line the hit shows.
#[derive(Debug)]
pub(crate) struct HitLine {
    /// The row's index key.
    pub(crate) key: u64,
    /// The row's id and position in its session's log; `None` on a title, group or tag.
    pub(crate) log_row: Option<LogRowPosition>,
    /// The line it shows, marked.
    pub(crate) marked: MarkedLine,
}

/// Reads and marks hits' lines on one connection, each cut to the length its search shows.
pub(crate) struct HitLineReader<'connection> {
    rows: IndexRowReader<'connection>,
    line_max_length: usize,
}

// One list of hit keys being read: the place of its next unread key and the lines read so far.
struct KeyListRead<'keys> {
    keys: &'keys [u64],
    next: usize,
    lines: Vec<HitLine>,
}

impl<'connection> HitLineReader<'connection> {
    /// A reader of `rows` whose lines show at most `line_max_length` code points.
    pub(crate) fn new(rows: IndexRowReader<'connection>, line_max_length: usize) -> Self {
        Self {
            rows,
            line_max_length,
        }
    }

    /// For each list of keys, the lines of the first `count` of its rows that still hold a match of
    /// the query's words, marked as the index marks them, in the keys' order. Rows are read only as
    /// far as that takes, every list's in one read at a time. Fails as the row read fails.
    pub(crate) fn read_lines(
        &self,
        key_lists: &[&[u64]],
        query: &SearchQuery,
        count: usize,
    ) -> rusqlite::Result<Vec<Vec<HitLine>>> {
        self.read_marked_lines(key_lists, |_, page| mark_matches(page, query), count)
    }

    /// For each list of keys, the lines of the first `count` of its tag rows that a queried tag,
    /// each a tag fold, still matches, in the keys' order: each tag marked through as many levels
    /// as the longest queried tag it is or is nested under has. Fails as the row read fails.
    pub(crate) fn read_tag_lines(
        &self,
        key_lists: &[&[u64]],
        tag_folds: &[String],
        count: usize,
    ) -> rusqlite::Result<Vec<Vec<HitLine>>> {
        self.read_marked_lines(
            key_lists,
            |row, page| tag_match_ranges(row, page, tag_folds),
            count,
        )
    }

    // Each round reads, for every list short of `count` lines with keys left, as many of its next
    // keys as it is short, all in one read.
    fn read_marked_lines(
        &self,
        key_lists: &[&[u64]],
        marker: impl Fn(&SourceRow, &str) -> Vec<MatchRange>,
        count: usize,
    ) -> rusqlite::Result<Vec<Vec<HitLine>>> {
        let mut reads: Vec<KeyListRead<'_>> = key_lists
            .iter()
            .copied()
            .map(|keys| KeyListRead {
                keys,
                next: 0,
                lines: Vec::new(),
            })
            .collect();
        loop {
            let mut chunks: Vec<(usize, &[u64])> = Vec::new();
            for (place, read) in reads.iter_mut().enumerate() {
                if read.lines.len() >= count || read.next >= read.keys.len() {
                    continue;
                }
                let keys = read.keys;
                let end = keys.len().min(read.next + count - read.lines.len());
                chunks.push((place, &keys[read.next..end]));
                read.next = end;
            }
            if chunks.is_empty() {
                return Ok(reads.into_iter().map(|read| read.lines).collect());
            }
            let rows = self
                .rows
                .read_rows(chunks.iter().flat_map(|(_, chunk)| chunk.iter().copied()))?;
            for (place, chunk) in chunks {
                for key in chunk {
                    let Some(row) = rows.get(key) else {
                        continue;
                    };
                    let marked = row.pages.iter().find_map(|page| {
                        let ranges = marker(row, page);
                        let (first, later) = ranges.split_first()?;
                        Some(cut_marked_line(page, *first, later, self.line_max_length))
                    });
                    if let Some(marked) = marked {
                        // The rows read serve every list's chunk, so each line takes its own copy.
                        reads[place].lines.push(HitLine {
                            key: row.key,
                            log_row: row.log_row.clone(),
                            marked,
                        });
                    }
                }
            }
        }
    }
}

// A tag row's one page, `tag`, marked through the levels a queried tag names.
fn tag_match_ranges(row: &SourceRow, tag: &str, tag_folds: &[String]) -> Vec<MatchRange> {
    let Some(row_tag) = &row.tag else {
        return Vec::new();
    };
    let level_count = tag_folds
        .iter()
        .filter(|tag_fold| {
            row_tag.fold == **tag_fold
                || row_tag
                    .fold
                    .strip_prefix(tag_fold.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
        .map(|tag_fold| tag_fold.split('/').count())
        .max();
    level_count.map_or_else(Vec::new, |level_count| {
        vec![leading_levels_range(tag, level_count)]
    })
}

// The stretch of a tag holding its first `level_count` levels, at least one, in UTF-16 code
// units: up to the separator after the last of them, or the whole tag.
fn leading_levels_range(tag: &str, level_count: usize) -> MatchRange {
    let end_byte = tag
        .match_indices('/')
        .nth(level_count - 1)
        .map_or(tag.len(), |(separator, _)| separator);
    MatchRange {
        start: 0,
        end: u32::try_from(tag[..end_byte].encode_utf16().count())
            .expect("a tag is at most the session name's bound, far below 2^32 units"),
    }
}
