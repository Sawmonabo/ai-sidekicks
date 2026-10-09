//! One published view of the index: Tantivy's searcher over one commit, the live counts that keep
//! scores exact with deleted rows still on disk, and the group members of the same commit.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tantivy::columnar::ColumnValues;
use tantivy::index::SegmentId;
use tantivy::{DocId, Opstamp, Searcher, SegmentReader, TERMINATED};

use crate::cursor::{CursorPurpose, open_phrase_cursor};
use crate::membership::GroupMembership;
use crate::phrase::Phrase;
use crate::schema::IndexFields;

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
pub struct SegmentColumns {
    pub key: Arc<dyn ColumnValues<u64>>,
    pub owner: Arc<dyn ColumnValues<u64>>,
    pub kind: Arc<dyn ColumnValues<u64>>,
    pub length: Arc<dyn ColumnValues<u64>>,
    /// A tag row's session's last activity; 0 on every other row.
    pub activity: Arc<dyn ColumnValues<u64>>,
    /// Every row's length summed, deleted rows included. Tantivy's own token total is an estimate
    /// once a merge has expunged deleted rows, so the live total is summed from the length column.
    total_length: u64,
}

impl SegmentColumns {
    fn load(segment: &SegmentReader) -> tantivy::Result<SegmentColumns> {
        let columns = segment.fast_fields();
        let length = columns.u64("length")?.first_or_default_col(0);
        let total_length = (0..segment.max_doc()).map(|doc| length.get_val(doc)).sum();
        Ok(SegmentColumns {
            key: columns.u64("key")?.first_or_default_col(0),
            owner: columns.u64("owner")?.first_or_default_col(0),
            kind: columns.u64("kind")?.first_or_default_col(0),
            length,
            activity: columns.u64("activity")?.first_or_default_col(0),
            total_length,
        })
    }
}

/// A segment's deleted rows as of one delete generation.
pub struct SegmentDeletions {
    delete_opstamp: Option<Opstamp>,
    /// The deleted rows, ascending.
    docs: Vec<DocId>,
    /// The deleted rows' lengths summed.
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
pub struct SegmentFacts {
    segment_id: SegmentId,
    pub columns: Arc<SegmentColumns>,
    deletions: Arc<SegmentDeletions>,
    /// How many rows each phrase of several terms matches, deleted rows included: fixed while the
    /// segment lives, so carried like its columns.
    matches: Arc<PhraseCounts>,
}

/// One published view of the index, shared by every search opened on it.
pub struct IndexVersion {
    pub searcher: Searcher,
    pub fields: IndexFields,
    pub segments: Vec<SegmentFacts>,
    /// N: the rows not deleted.
    pub live_rows: u64,
    /// The live rows' lengths summed; the average length is this over `live_rows`.
    pub live_tokens: u64,
    pub membership: Arc<GroupMembership>,
    /// The outbox id the commit under this view records.
    pub last_applied_outbox_id: u64,
    phrase_rows: PhraseCounts,
}

impl IndexVersion {
    /// The view `searcher` reads, reusing the columns and deletions `previous` already read for
    /// the segments it shares.
    pub fn build(
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
                _ => Arc::new(SegmentDeletions::load(segment, &columns)),
            };
            live_rows += u64::from(segment.num_docs());
            live_tokens += columns.total_length - deletions.length;
            segments.push(SegmentFacts {
                segment_id: segment.segment_id(),
                columns,
                deletions,
                matches: carried
                    .map(|facts| facts.matches.clone())
                    .unwrap_or_default(),
            });
        }
        Ok(IndexVersion {
            searcher,
            fields,
            segments,
            live_rows,
            live_tokens,
            membership,
            last_applied_outbox_id,
            phrase_rows: PhraseCounts::default(),
        })
    }

    /// This view with other group members, for members loaded outside a commit.
    pub fn with_membership(&self, membership: Arc<GroupMembership>) -> IndexVersion {
        IndexVersion {
            searcher: self.searcher.clone(),
            fields: self.fields,
            segments: self.segments.clone(),
            live_rows: self.live_rows,
            live_tokens: self.live_tokens,
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
    pub fn average_length(&self) -> f64 {
        self.live_tokens as f64 / self.live_rows as f64
    }

    /// n: how many live rows `phrase` matches, counted once per view.
    pub fn phrase_rows(&self, phrase: &Phrase) -> tantivy::Result<u64> {
        if let Some(rows) = self.phrase_rows.get(phrase) {
            return Ok(rows);
        }
        let mut rows = 0u64;
        for (segment, facts) in self.searcher.segment_readers().iter().zip(&self.segments) {
            rows += self.phrase_rows_in(segment, facts, phrase)?;
        }
        self.phrase_rows.insert(phrase, rows);
        Ok(rows)
    }

    // The rows the phrase matches, deleted rows included, less the deleted rows it matches, found
    // by seeking its cursor to each one. A one-term phrase's count is Tantivy's; any other phrase's
    // is walked the first time the segment is asked, counting its live rows on the way.
    fn phrase_rows_in(
        &self,
        segment: &SegmentReader,
        facts: &SegmentFacts,
        phrase: &Phrase,
    ) -> tantivy::Result<u64> {
        let cursor = open_phrase_cursor(segment, &self.fields, phrase, CursorPurpose::Score)?;
        let Some(mut cursor) = cursor else {
            return Ok(0);
        };
        let matches = match phrase.single_term(&self.fields) {
            Some(term) => u64::from(segment.inverted_index(term.field())?.doc_freq(&term)?),
            None => match facts.matches.get(phrase) {
                Some(matches) => matches,
                None => {
                    let alive = segment.alive_bitset();
                    let (mut matches, mut rows) = (0u64, 0u64);
                    let mut doc = cursor.doc();
                    while doc != TERMINATED {
                        matches += 1;
                        if alive.is_none_or(|alive| alive.is_alive(doc)) {
                            rows += 1;
                        }
                        doc = cursor.advance();
                    }
                    facts.matches.insert(phrase, matches);
                    return Ok(rows);
                }
            },
        };
        let mut deleted_matches = 0u64;
        for deleted in &facts.deletions.docs {
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
}
