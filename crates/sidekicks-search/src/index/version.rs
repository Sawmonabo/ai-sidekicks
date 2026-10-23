//! One published view of the index: Tantivy's searcher over one commit, the live counts that keep
//! scores exact with deleted rows still on disk and a row longer than a page counted once, and the
//! group members of the same commit.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tantivy::columnar::ColumnValues;
use tantivy::index::SegmentId;
use tantivy::{DocId, Opstamp, Searcher, SegmentReader, TERMINATED};

use crate::index::cursor::{CursorPurpose, RowsAsked, open_phrase_cursor};
use crate::index::long_row::matches::phrase_long_row_counts;
use crate::index::long_row::rows::LongRows;
use crate::index::membership::GroupMembership;
use crate::index::phrase::Phrase;
use crate::index::schema::IndexFields;

/// The most phrases a version, or a segment, keeps counts for; past it the counts are dropped and
/// counted again when asked.
const PHRASE_ROWS_CAPACITY: usize = 1024;

// Counts by phrase, all dropped at once past `PHRASE_ROWS_CAPACITY`.
#[derive(Default)]
struct PhraseCounts(Mutex<HashMap<Phrase, u64>>);

impl PhraseCounts {
    fn get(&self, phrase: &Phrase) -> Option<u64> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(phrase)
            .copied()
    }

    fn insert(&self, phrase: &Phrase, count: u64) {
        let mut counts = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if counts.len() >= PHRASE_ROWS_CAPACITY {
            counts.clear();
        }
        counts.insert(phrase.clone(), count);
    }
}

/// A segment's columns, read once and carried to every later version that keeps the segment.
pub(crate) struct SegmentColumns {
    /// Each row's key.
    pub(crate) key: Arc<dyn ColumnValues<u64>>,
    /// Each row's owner as `owner_value` encodes it.
    pub(crate) owner: Arc<dyn ColumnValues<u64>>,
    /// Each row's kind code.
    pub(crate) kind: Arc<dyn ColumnValues<u64>>,
    /// Each row's length: its token count plus one.
    pub(crate) length: Arc<dyn ColumnValues<u64>>,
    /// A tag row's session's last activity; 0 on every other row.
    pub(crate) activity: Arc<dyn ColumnValues<u64>>,
    /// Each document's piece code: a page's, an edge's or the terminal document's of a row longer
    /// than a page, 0 on a whole row.
    pub(crate) piece: Arc<dyn ColumnValues<u64>>,
    /// A page's or an edge document's first place in its row.
    pub(crate) place: Arc<dyn ColumnValues<u64>>,
    /// An edge document's boundary: the row's place of the first place after it.
    pub(crate) boundary: Arc<dyn ColumnValues<u64>>,
    /// The documents that are pieces of rows longer than a page, deleted ones included, ascending.
    pub(crate) piece_documents: Vec<DocId>,
    /// Every row's length summed, deleted rows included. Tantivy's own token total is an estimate
    /// once a merge has expunged deleted rows, so the live total is summed from the length column.
    total_length: u64,
}

impl SegmentColumns {
    fn load(segment: &SegmentReader) -> tantivy::Result<SegmentColumns> {
        let columns = segment.fast_fields();
        let length = columns.u64("length")?.first_or_default_col(0);
        let total_length = (0..segment.max_doc()).map(|doc| length.get_val(doc)).sum();
        let piece = columns.u64("piece")?.first_or_default_col(0);
        let piece_documents = (0..segment.max_doc())
            .filter(|doc| piece.get_val(*doc) != 0)
            .collect();
        Ok(SegmentColumns {
            key: columns.u64("key")?.first_or_default_col(0),
            owner: columns.u64("owner")?.first_or_default_col(0),
            kind: columns.u64("kind")?.first_or_default_col(0),
            length,
            activity: columns.u64("activity")?.first_or_default_col(0),
            piece,
            place: columns.u64("place")?.first_or_default_col(0),
            boundary: columns.u64("boundary")?.first_or_default_col(0),
            piece_documents,
            total_length,
        })
    }
}

// A segment's deleted rows as of one delete generation.
struct SegmentDeletions {
    delete_opstamp: Option<Opstamp>,
    // The deleted rows, ascending.
    docs: Vec<DocId>,
    // The deleted rows' lengths summed.
    length: u64,
}

impl SegmentDeletions {
    fn load(segment: &SegmentReader, columns: &SegmentColumns) -> SegmentDeletions {
        let docs: Vec<DocId> = match segment.alive_bitset() {
            Some(alive) => (0..segment.max_doc())
                .filter(|doc| alive.is_deleted(*doc))
                .collect(),
            None => Vec::new(),
        };
        let length = docs.iter().map(|doc| columns.length.get_val(*doc)).sum();
        SegmentDeletions {
            delete_opstamp: segment.delete_opstamp(),
            docs,
            length,
        }
    }
}

/// What a version knows of one of its searcher's segments, in the searcher's segment order.
#[derive(Clone)]
pub(crate) struct SegmentFacts {
    segment_id: SegmentId,
    /// The segment's columns, shared with every version that keeps the segment.
    pub(crate) columns: Arc<SegmentColumns>,
    deletions: Arc<SegmentDeletions>,
    /// How many rows each phrase of several terms matches, deleted rows included: fixed while the
    /// segment lives, so carried like its columns.
    matches: Arc<PhraseCounts>,
}

/// One published view of the index, shared by every search opened on it.
pub(crate) struct IndexVersion {
    /// Tantivy's searcher over the commit this view reads.
    pub(crate) searcher: Searcher,
    /// The index's fields.
    pub(crate) fields: IndexFields,
    /// What this view knows of each of the searcher's segments, in the searcher's order.
    pub(crate) segments: Vec<SegmentFacts>,
    /// N: the rows not deleted, a row longer than a page counted once.
    pub(crate) live_rows: u64,
    /// The live rows' lengths summed, a row longer than a page's as one row's; the average length
    /// is this over `live_rows`.
    pub(crate) live_tokens: u64,
    /// The live rows longer than a page.
    pub(crate) long_rows: Arc<LongRows>,
    /// The group members of the same commit.
    pub(crate) membership: Arc<GroupMembership>,
    /// The outbox id the commit under this view records.
    pub(crate) last_applied_outbox_id: u64,
    phrase_rows: PhraseCounts,
}

impl IndexVersion {
    /// The view `searcher` reads, reusing the columns and deletions `previous` already read for
    /// the segments it shares. Fails when Tantivy fails to read a segment's columns.
    pub(crate) fn build(
        searcher: Searcher,
        fields: IndexFields,
        previous: Option<&IndexVersion>,
        membership: Arc<GroupMembership>,
        last_applied_outbox_id: u64,
    ) -> tantivy::Result<IndexVersion> {
        let mut segments = Vec::with_capacity(searcher.segment_readers().len());
        let mut live_rows = 0u64;
        let mut live_tokens = 0u64;
        for segment in searcher.segment_readers() {
            let carried = previous.and_then(|version| version.facts_of(segment.segment_id()));
            let columns = match carried {
                Some(facts) => facts.columns.clone(),
                None => Arc::new(SegmentColumns::load(segment)?),
            };
            let deletions = match carried {
                Some(facts) if facts.deletions.delete_opstamp == segment.delete_opstamp() => {
                    facts.deletions.clone()
                }
                Some(_) | None => Arc::new(SegmentDeletions::load(segment, &columns)),
            };
            live_rows += u64::from(segment.num_docs());
            live_tokens += columns.total_length - deletions.length;
            segments.push(SegmentFacts {
                segment_id: segment.segment_id(),
                columns,
                deletions,
                matches: carried.map_or_else(Arc::default, |facts| facts.matches.clone()),
            });
        }
        let long_rows = LongRows::collect(
            searcher
                .segment_readers()
                .iter()
                .zip(segments.iter().map(|facts| facts.columns.as_ref())),
        );
        live_rows -= long_rows.extra_documents;
        live_tokens -= long_rows.extra_length;
        Ok(IndexVersion {
            searcher,
            fields,
            segments,
            live_rows,
            live_tokens,
            long_rows: Arc::new(long_rows),
            membership,
            last_applied_outbox_id,
            phrase_rows: PhraseCounts::default(),
        })
    }

    /// This view with other group members, for members loaded outside a commit.
    pub(crate) fn with_membership(&self, membership: Arc<GroupMembership>) -> IndexVersion {
        IndexVersion {
            searcher: self.searcher.clone(),
            fields: self.fields,
            segments: self.segments.clone(),
            live_rows: self.live_rows,
            live_tokens: self.live_tokens,
            long_rows: self.long_rows.clone(),
            membership,
            last_applied_outbox_id: self.last_applied_outbox_id,
            phrase_rows: PhraseCounts::default(),
        }
    }

    fn facts_of(&self, segment_id: SegmentId) -> Option<&SegmentFacts> {
        self.segments
            .iter()
            .find(|facts| facts.segment_id == segment_id)
    }

    /// The live rows' average length.
    #[expect(
        clippy::cast_precision_loss,
        reason = "token and row totals stay far below 2^52, where f64 holds them exactly"
    )]
    pub(crate) fn average_length(&self) -> f64 {
        self.live_tokens as f64 / self.live_rows as f64
    }

    /// n: how many live rows `phrase` matches, counted once per view, a row longer than a page
    /// once when the phrase matches on one of its pages or across one of its page boundaries.
    /// Fails when Tantivy fails a read.
    pub(crate) fn phrase_rows(&self, phrase: &Phrase) -> tantivy::Result<u64> {
        if let Some(rows) = self.phrase_rows.get(phrase) {
            return Ok(rows);
        }
        let mut rows = 0u64;
        for (segment, facts) in self.searcher.segment_readers().iter().zip(&self.segments) {
            rows += self.phrase_rows_in(segment, facts, phrase)?;
        }
        // The live documents the phrase matches count each long row's pieces; they give way to the
        // long rows it matches.
        let long = phrase_long_row_counts(self, phrase)?;
        rows = rows - long.matched_documents + long.matched_rows;
        self.phrase_rows.insert(phrase, rows);
        Ok(rows)
    }

    /// How many rows of segment `ordinal` `phrase` matches, deleted rows included: Tantivy's count
    /// for a one-term phrase, and any other phrase's walked once and kept with the segment.
    pub(crate) fn phrase_matches_in(
        &self,
        ordinal: usize,
        phrase: &Phrase,
    ) -> tantivy::Result<u64> {
        let segment = &self.searcher.segment_readers()[ordinal];
        Ok(
            match self.segment_matches(segment, &self.segments[ordinal], phrase)? {
                SegmentMatches::Counted(matches) => matches,
                SegmentMatches::Walked(walked) => walked.matches,
            },
        )
    }

    // The rows the phrase matches, deleted rows included, less the deleted rows it matches, found
    // by seeking its cursor to each one; a walk counted the live rows on the way.
    fn phrase_rows_in(
        &self,
        segment: &SegmentReader,
        facts: &SegmentFacts,
        phrase: &Phrase,
    ) -> tantivy::Result<u64> {
        let matches = match self.segment_matches(segment, facts, phrase)? {
            SegmentMatches::Counted(matches) => matches,
            SegmentMatches::Walked(walked) => return Ok(walked.live_rows),
        };
        let deleted = &facts.deletions.docs;
        if deleted.is_empty() {
            return Ok(matches);
        }
        let asked = RowsAsked::AtMost(
            u64::try_from(deleted.len()).expect("a segment's row count fits in 64 bits"),
        );
        let cursor =
            open_phrase_cursor(segment, &self.fields, phrase, CursorPurpose::Score, asked)?;
        let Some(mut cursor) = cursor else {
            return Ok(0);
        };
        let mut deleted_matches = 0u64;
        for deleted in deleted {
            let doc = cursor.seek(*deleted);
            if doc == TERMINATED {
                break;
            }
            if doc == *deleted {
                deleted_matches += 1;
            }
        }
        Ok(matches - deleted_matches)
    }

    // The rows the phrase matches in the segment, deleted rows included: Tantivy's count for a
    // one-term phrase, the count kept with the segment for any other, or, the first time the
    // segment is asked, a walk of every row.
    fn segment_matches(
        &self,
        segment: &SegmentReader,
        facts: &SegmentFacts,
        phrase: &Phrase,
    ) -> tantivy::Result<SegmentMatches> {
        if let Some(term) = phrase.single_term(&self.fields) {
            let matches = segment.inverted_index(term.field())?.doc_freq(&term)?;
            return Ok(SegmentMatches::Counted(u64::from(matches)));
        }
        Ok(match facts.matches.get(phrase) {
            Some(matches) => SegmentMatches::Counted(matches),
            None => SegmentMatches::Walked(self.walk_matches(segment, facts, phrase)?),
        })
    }

    // Walks every row the phrase matches in the segment, keeping the count with the segment.
    fn walk_matches(
        &self,
        segment: &SegmentReader,
        facts: &SegmentFacts,
        phrase: &Phrase,
    ) -> tantivy::Result<WalkedMatches> {
        let mut walked = WalkedMatches {
            matches: 0,
            live_rows: 0,
        };
        let every = RowsAsked::Every;
        let cursor =
            open_phrase_cursor(segment, &self.fields, phrase, CursorPurpose::Score, every)?;
        if let Some(mut cursor) = cursor {
            let alive = segment.alive_bitset();
            let mut doc = cursor.doc();
            while doc != TERMINATED {
                walked.matches += 1;
                if alive.is_none_or(|alive| alive.is_alive(doc)) {
                    walked.live_rows += 1;
                }
                doc = cursor.advance();
            }
        }
        facts.matches.insert(phrase, walked.matches);
        Ok(walked)
    }
}

// A phrase's rows in one segment, deleted rows included, and those of them alive.
struct WalkedMatches {
    matches: u64,
    live_rows: u64,
}

// A phrase's rows in one segment: counted, or walked just now with the live rows among them.
enum SegmentMatches {
    Counted(u64),
    Walked(WalkedMatches),
}
