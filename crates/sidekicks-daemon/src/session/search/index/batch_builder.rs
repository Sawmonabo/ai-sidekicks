//! Fills the batches handed to the index row by row, a row's text read a page at a time: a row of
//! one page goes whole, a longer one as its pages, its edge documents and its terminal document,
//! which a search waits for before it sees the row. Each page is charged to
//! the batch's text bound, and a long row that fills it hands the batch so far to the index and
//! goes on in the next, so a batch holds about the bound and one page, and a row of any length
//! one page and the tail its edges keep.

use std::ops::ControlFlow;

use sidekicks_search::index::{IndexBatch, IndexRow, LongRowDocuments};

use crate::session::search::index::rows::{IndexRowReader, SourceRow};

/// One batch being filled, with the text bound its pages are charged to.
pub(crate) struct IndexBatchBuilder {
    /// The batch so far; a caller adds its removals and group members here.
    pub(crate) batch: IndexBatch,
    // The bound, in UTF-8 bytes, past which a long row's next page goes in a new batch.
    text_limit: usize,
    // The text the batch holds, in UTF-8 bytes.
    text_bytes: usize,
}

impl IndexBatchBuilder {
    /// An empty batch whose rows' text is bound to `text_limit` UTF-8 bytes, past a long row's
    /// page at most.
    pub(crate) fn new(text_limit: usize) -> Self {
        Self {
            batch: IndexBatch {
                last_outbox_id: 0,
                rows: Vec::new(),
                long_row_documents: Vec::new(),
                continued_key: None,
                removed_keys: Vec::new(),
                removed_owners: Vec::new(),
                group_members: Vec::new(),
            },
            text_limit,
            text_bytes: 0,
        }
    }

    /// Adds `row`, its text read through `rows` a page at a time. Once its pages fill the text
    /// bound before its end, the batch so far goes to `flush` recording `applied_through`, the
    /// outbox id before the row's entry, and the row goes on in a new batch that continues its key.
    /// Fails as the row's read or `flush` fails.
    pub(crate) fn add_row<Failure>(
        &mut self,
        rows: &IndexRowReader<'_>,
        row: SourceRow,
        applied_through: u64,
        flush: &mut impl FnMut(&IndexBatch) -> Result<(), Failure>,
    ) -> Result<(), Failure>
    where
        Failure: From<rusqlite::Error>,
    {
        // A page is held until the next arrives, so a row of one page goes whole.
        let mut held: Option<String> = None;
        let mut long_row: Option<LongRowDocuments> = None;
        let stopped = rows.for_each_page(&row, |page| {
            let Some(earlier) = held.replace(page) else {
                return ControlFlow::Continue(());
            };
            let documents = long_row
                .get_or_insert_with(|| LongRowDocuments::new(row.key, row.kind, row.owner_key));
            match self.add_page(documents, &earlier, row.key, applied_through, flush) {
                Ok(()) => ControlFlow::Continue(()),
                Err(failure) => ControlFlow::Break(failure),
            }
        })?;
        if let Some(failure) = stopped {
            return Err(failure);
        }
        let last = held.expect("a row's text is handed as at least one page");
        let Some(mut documents) = long_row else {
            self.text_bytes += last.len();
            self.batch.rows.push(IndexRow {
                key: row.key,
                kind: row.kind,
                owner_key: row.owner_key,
                text: last,
                tag: row.tag,
            });
            return Ok(());
        };
        self.add_page(&mut documents, &last, row.key, applied_through, flush)?;
        let long_row_documents = &mut self.batch.long_row_documents;
        documents.finish(&mut |document| long_row_documents.push(document));
        Ok(())
    }

    /// The batch, recording `last_outbox_id`.
    pub(crate) fn finish(mut self, last_outbox_id: u64) -> IndexBatch {
        self.batch.last_outbox_id = last_outbox_id;
        self.batch
    }

    // Adds a long row's page and the edge documents it completes, charged to the bound; past it,
    // flushes the batch as `add_row` says.
    fn add_page<Failure>(
        &mut self,
        documents: &mut LongRowDocuments,
        page: &str,
        key: u64,
        applied_through: u64,
        flush: &mut impl FnMut(&IndexBatch) -> Result<(), Failure>,
    ) -> Result<(), Failure> {
        self.text_bytes += page.len();
        let long_row_documents = &mut self.batch.long_row_documents;
        documents.add_page(page, &mut |document| long_row_documents.push(document));
        if self.text_bytes < self.text_limit {
            return Ok(());
        }
        self.batch.last_outbox_id = applied_through;
        flush(&self.batch)?;
        self.batch = Self::new(self.text_limit).batch;
        self.batch.continued_key = Some(key);
        self.text_bytes = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
    use sidekicks_search::index::{
        IndexBatch, IndexRowKind, SearchIndex, SearchIndexOptions, SearchQuery, mark_matches,
    };

    use super::IndexBatchBuilder;
    use crate::session::directory::test_rows::insert_session_row;
    use crate::session::search::hits::HitLineReader;
    use crate::session::search::index::applier::SearchIndexApplyError;
    use crate::session::search::index::rows::{IndexRowReader, empty_index_batch_room};
    use crate::transcript::test_log::TranscriptTestLog;

    const OUTBOX_ID_BEFORE_ROW: u64 = 7;
    const LAST_OUTBOX_ID: u64 = 9;

    // `start`, then words, padded with spaces to one page of stored text: a stored frame's text.
    fn page_text(start: &str, end: &str) -> String {
        let mut text = start.to_string();
        let words = (PAGE_MAX_BYTES - start.len() - end.len()) / 6;
        text.push_str(&"words ".repeat(words));
        text.push_str(&" ".repeat(PAGE_MAX_BYTES - text.len() - end.len()));
        text.push_str(end);
        text
    }

    fn words(words: &[&str]) -> SearchQuery {
        SearchQuery {
            words: words.iter().map(ToString::to_string).collect(),
            last_word_is_prefix: false,
        }
    }

    // A reply of three pages, `zebra` on the first and `alpha beta` across the edge of the second
    // and third, applied under a bound of one page and a byte, goes in two batches: the first holds
    // two pages and records the outbox id before the row, the second continues the row's key. While
    // only the first is applied the row is found by nothing; once the batch holding its end is, it
    // reads back as one row: found once, counted as its whole text, its hit line marked across the
    // edge. Killed by admitting a row before its terminal document, by deleting the key before the
    // continued pages (the first page is lost), by recording the batch's own last id for the first
    // batch, and by a hit read without the tail.
    #[test]
    fn a_long_row_applied_over_two_batches_reads_back_as_one_row() {
        let log = TranscriptTestLog::new();
        insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
        let reply = [
            page_text("zebra ", ""),
            page_text("", "alpha "),
            "beta words".to_string(),
        ]
        .concat();
        log.reply("m1", None, &reply);
        let reader = log.reader();
        let rows = IndexRowReader::new(&reader);
        let mut room = empty_index_batch_room();
        let [row] = rows
            .read_rows_between(IndexRowKind::Event, 0, i64::MAX, &mut room, |_| true)
            .expect("the row reads")
            .try_into()
            .expect("one row reads");
        let (key, session_key) = (row.key, row.owner_key);
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let options = SearchIndexOptions {
            writer_memory_bytes: 16 * 1024 * 1024,
        };
        let index = SearchIndex::open(&scratch.path().join("index"), options).expect("it opens");

        let mut flushed = Vec::new();
        let mut builder = IndexBatchBuilder::new(PAGE_MAX_BYTES + 1);
        builder
            .add_row(
                &rows,
                row,
                OUTBOX_ID_BEFORE_ROW,
                &mut |batch: &IndexBatch| {
                    flushed.push((batch.last_outbox_id, batch.continued_key));
                    index.apply(batch).map_err(SearchIndexApplyError::from)
                },
            )
            .expect("the row's first batch applies");
        assert_eq!(flushed, [(OUTBOX_ID_BEFORE_ROW, None)]);
        assert_eq!(index.last_applied_outbox_id(), OUTBOX_ID_BEFORE_ROW);
        let first_page_find = index
            .find_in_session(session_key, &words(&["zebra"]))
            .expect("the find reads");
        assert!(
            first_page_find.row_keys.is_empty(),
            "{:?}",
            first_page_find.row_keys
        );
        let last = builder.finish(LAST_OUTBOX_ID);
        assert_eq!(last.continued_key, Some(key));
        index.apply(&last).expect("the row's last batch applies");

        let found_words = words(&["zebra", "alpha-beta"]);
        let found = index
            .find_in_session(session_key, &found_words)
            .expect("the find reads");
        assert_eq!(found.row_keys, [key]);
        assert_eq!(
            found.match_counts,
            [u32::try_from(mark_matches(&reply, &found_words).len()).expect("a few marks")]
        );
        let lines = HitLineReader::new(rows, 100)
            .read_lines(&[&[key]], &words(&["alpha-beta"]), 1)
            .expect("the hit line reads");
        let [list_lines] = lines.as_slice() else {
            panic!("one list's lines read, not {lines:?}");
        };
        let [line] = list_lines.as_slice() else {
            panic!("one hit line reads, not {list_lines:?}");
        };
        assert!(line.marked.line.contains("alpha beta"), "{:?}", line.marked);
        assert_eq!(line.marked.match_ranges.len(), 2, "{:?}", line.marked);
    }
}
