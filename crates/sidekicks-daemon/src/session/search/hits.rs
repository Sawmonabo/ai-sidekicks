//! The line each hit shows, read from the database by the hit's key: the row's text as it is now,
//! read a page at a time with the tail of the page before, marked where the search first matches
//! it. The index stores no text, so a hit whose row is gone since the index saw it is passed over,
//! and one whose text changed is marked on its current text, or passed over once that text no
//! longer holds a match. A hit whose row is damaged, in a value of its own or its stored body,
//! shows no line and is logged: a search writes nothing, so the row leaves the index only when it
//! changes or a skipped range covers it. A search with words marks them as the index finds them; a
//! search by tags alone marks each tag's levels the queried tag names.

use std::collections::HashSet;
use std::error::Error;
use std::ops::ControlFlow;

use sidekicks_search::index::{MatchRange, SearchQuery, find_tail_start, mark_matches};

use crate::session::search::index::rows::{
    DamagedSourceRow, IndexRowReader, LogRowPosition, PageReadError, SourceRow, SourceRowRead,
};
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
    /// far as that takes, every list's in one read at a time. Fails as SQLite refuses the read.
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
    /// as the longest queried tag it is or is nested under has. Fails as SQLite refuses the read.
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
    // keys as it is short, all in one read. A damaged row is logged once a search, however many
    // lists hold it, and its pages are not read again.
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
        let mut damaged_keys = HashSet::new();
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
                    let row = match rows.get(key) {
                        None => continue,
                        Some(SourceRowRead::Damaged(damaged)) => {
                            if damaged_keys.insert(damaged.key) {
                                log_damaged_hit(damaged);
                            }
                            continue;
                        }
                        Some(SourceRowRead::Whole(row)) if damaged_keys.contains(&row.key) => {
                            continue;
                        }
                        Some(SourceRowRead::Whole(row)) => row,
                    };
                    // Each page is marked after the tail of the one before, so a match across their
                    // edge is marked; the first page with a match ends the read.
                    let mut tail = String::new();
                    let paged = self.rows.for_each_page(row, |page| {
                        let mut text = std::mem::take(&mut tail);
                        text.push_str(&page);
                        let ranges = marker(row, &text);
                        if let Some((first, later)) = ranges.split_first() {
                            let line = cut_marked_line(&text, *first, later, self.line_max_length);
                            return ControlFlow::Break(line);
                        }
                        tail = text.split_off(find_tail_start(&text));
                        ControlFlow::Continue(())
                    });
                    let marked = match paged {
                        Ok(marked) => marked,
                        Err(PageReadError::Damaged(damaged)) => {
                            damaged_keys.insert(damaged.key);
                            log_damaged_hit(&damaged);
                            None
                        }
                        Err(PageReadError::Refused(refused)) => return Err(refused),
                    };
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

// Logs a hit whose row is damaged, which shows no line.
fn log_damaged_hit(damaged: &DamagedSourceRow) {
    tracing::warn!(
        session_key = damaged.owner_key,
        sequence = damaged.sequence,
        error = &damaged.damage as &(dyn Error + 'static),
        "search_hit_row_damaged"
    );
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

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
    use sidekicks_search::index::{IndexRowKind, SearchQuery};

    use super::HitLineReader;
    use crate::provider::driver::diagnostics::RecordedEvents;
    use crate::session::directory::test_rows::insert_session_row;
    use crate::session::search::index::rows::{
        IndexRowReader, SourceRowRead, empty_index_batch_room,
    };
    use crate::transcript::test_log::{RowDamage, TranscriptTestLog};

    // A search whose two lists of hits both hold a reply damaged since it was indexed, in its
    // stored body's second frame or its payload's encoding, by a word no build writes or by one
    // flipped bit that leaves it no UTF-8, answers each list with the line of the session's other
    // reply, the damaged one showing none and logged once. Killed by a damaged body or row that
    // fails the search as a refused read does, and by a log per list.
    #[rstest]
    #[case::frame(RowDamage::Frame(1))]
    #[case::encoding(RowDamage::Encoding)]
    #[case::encoding_byte(RowDamage::EncodingByte)]
    fn a_search_answers_past_a_hit_whose_row_was_damaged(#[case] damage: RowDamage) {
        let log = TranscriptTestLog::new();
        insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
        let damaged_reply = format!("zebra {}", "words ".repeat(2 * PAGE_MAX_BYTES / 6));
        let (damaged, _) = log.reply("m1", None, &damaged_reply);
        log.reply("m2", None, "quokka");
        let reader = log.reader();
        let rows = IndexRowReader::new(&reader);
        let mut room = empty_index_batch_room();
        let keys: Vec<u64> = rows
            .read_rows_between(IndexRowKind::Event, 0, i64::MAX, &mut room, |_| true)
            .expect("the rows read")
            .iter()
            .map(SourceRowRead::key)
            .collect();
        log.damage_row(damaged, damage);

        let query = SearchQuery {
            words: vec!["quokka".to_owned()],
            last_word_is_prefix: false,
        };
        let recorded = RecordedEvents::default();
        let mut lines = Vec::new();
        recorded.record_during(|| {
            lines = HitLineReader::new(rows, 100)
                .read_lines(&[&keys, &keys], &query, 2)
                .expect("the search answers");
        });
        let line_keys: Vec<Vec<u64>> = lines
            .iter()
            .map(|list_lines| list_lines.iter().map(|line| line.key).collect())
            .collect();
        assert_eq!(line_keys, [vec![keys[1]], vec![keys[1]]]);
        let damage_logs = recorded
            .messages()
            .into_iter()
            .filter(|message| message == "search_hit_row_damaged")
            .count();
        assert_eq!(damage_logs, 1);
    }
}
