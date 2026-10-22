//! The live rows longer than a page in one version: each one's documents across segments, its
//! owner and its length, and what they change in the version's totals so each counts as one row.

use std::collections::HashMap;

use tantivy::{DocId, SegmentReader};

use crate::index::schema::EDGE_PIECE;
use crate::index::version::SegmentColumns;

/// One live row longer than a page.
#[derive(Clone, Debug)]
pub(crate) struct LongRow {
    /// The row's owner as `owner_value` encodes it.
    pub(crate) owner: u64,
    /// The row's kind code.
    pub(crate) kind: u64,
    /// The row's length as a whole row's: its pages' tokens plus one, each page's length counting
    /// its own tokens plus one.
    pub(crate) length: u64,
}

/// A segment's live documents of rows longer than a page, ascending, each with its row's key.
#[derive(Debug, Default)]
pub(crate) struct SegmentLongRowDocuments {
    /// The documents and their rows' keys, by document.
    pub(crate) documents: Vec<(DocId, u64)>,
}

/// Every live row longer than a page in one version, and its documents in each segment.
#[derive(Debug, Default)]
pub(crate) struct LongRows {
    /// The rows by key.
    pub(crate) rows: HashMap<u64, LongRow>,
    /// Each segment's live documents of those rows, in the version's segment order.
    pub(crate) segments: Vec<SegmentLongRowDocuments>,
    /// The live documents beyond one per row: every edge document and every page but one per row,
    /// which N leaves out.
    pub(crate) extra_documents: u64,
    /// What the live documents' summed lengths hold beyond the rows' own: every edge document's
    /// length and one per page beyond a row's first.
    pub(crate) extra_length: u64,
}

impl LongRows {
    /// The live rows longer than a page among `segments`, each read with its columns.
    pub(crate) fn collect<'a>(
        segments: impl IntoIterator<Item = (&'a SegmentReader, &'a SegmentColumns)>,
    ) -> LongRows {
        let mut long_rows = LongRows::default();
        let mut pages: HashMap<u64, u64> = HashMap::new();
        for (segment, columns) in segments {
            let alive = segment.alive_bitset();
            let mut documents = Vec::new();
            for doc in &columns.piece_documents {
                if !alive.is_none_or(|alive| alive.is_alive(*doc)) {
                    continue;
                }
                let key = columns.key.get_val(*doc);
                let length = columns.length.get_val(*doc);
                documents.push((*doc, key));
                long_rows.extra_documents += 1;
                if columns.piece.get_val(*doc) == EDGE_PIECE {
                    long_rows.extra_length += length;
                    continue;
                }
                *pages.entry(key).or_default() += 1;
                long_rows
                    .rows
                    .entry(key)
                    .and_modify(|row| row.length += length - 1)
                    .or_insert(LongRow {
                        owner: columns.owner.get_val(*doc),
                        kind: columns.kind.get_val(*doc),
                        length,
                    });
            }
            long_rows
                .segments
                .push(SegmentLongRowDocuments { documents });
        }
        long_rows.extra_documents -= long_rows.rows.len() as u64;
        long_rows.extra_length += pages.values().map(|count| count - 1).sum::<u64>();
        long_rows
    }
}
