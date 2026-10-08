//! Which segments merge while the daemon is idle, on Lucene's tiered model: no merge writes a
//! segment holding more than a cap of live rows, so a merge's time is bounded whatever the index's
//! size; segments of a similar size merge while their live rows fit the cap; and a segment with
//! more than one row in a hundred deleted, or that held a purged session's rows, is rewritten
//! alone, so a purge rewrites only the segments that held its rows and its words leave the index's
//! files. Tantivy's own `LogMergePolicy` has no such cap: its document bound only keeps larger
//! segments out of merges, so many smaller ones still merge past it, and a segment past it never
//! merges again, its deleted rows never expunged.

use std::collections::HashSet;

use tantivy::SegmentMeta;
use tantivy::index::SegmentId;
use tantivy::merge_policy::{MergeCandidate, MergePolicy};

/// The most live rows a merge writes into one segment, the build's merges included.
pub const SEGMENT_ROW_CAP: u32 = 250_000;

// A segment with more than this share of its rows deleted is rewritten to expunge them.
const DELETED_SHARE_BEFORE_REWRITE: f32 = 0.01;
// Segments whose sizes are within 2^0.75 of each other merge together, as in `LogMergePolicy`.
const LEVEL_LOG_SIZE: f64 = 0.75;
// Segments under this many live rows count as this size, so small segments merge as one level.
const LEVEL_FLOOR_ROWS: u32 = 10_000;

/// Proposes merges whose merged segment holds at most `row_cap` live rows, and a rewrite of each
/// segment that held a purged session's rows.
#[derive(Debug, Clone)]
pub struct CappedMergePolicy {
    row_cap: u32,
    purged_segments: HashSet<SegmentId>,
}

impl CappedMergePolicy {
    /// A policy that writes no segment of more than `row_cap` live rows, and rewrites each of
    /// `purged_segments` alone whatever share of its rows is deleted.
    pub fn new(row_cap: u32, purged_segments: HashSet<SegmentId>) -> CappedMergePolicy {
        CappedMergePolicy {
            row_cap,
            purged_segments,
        }
    }

    // A segment over half the cap is full: merged with any other, it could pass the cap.
    fn is_full(&self, segment: &SegmentMeta) -> bool {
        segment.num_docs() > self.row_cap / 2
    }

    // Each level of similar sizes, largest first, as `LogMergePolicy` groups them.
    fn levels<'a>(&self, segments: &[&'a SegmentMeta]) -> Vec<Vec<&'a SegmentMeta>> {
        let mut by_size = segments.to_vec();
        by_size.sort_by_key(|segment| std::cmp::Reverse(segment.num_docs()));
        let mut levels: Vec<Vec<&SegmentMeta>> = Vec::new();
        let mut level_log_size = 0.0;
        for segment in by_size {
            let log_size = f64::from(segment.num_docs().max(LEVEL_FLOOR_ROWS)).log2();
            match levels.last_mut() {
                Some(level) if log_size >= level_log_size - LEVEL_LOG_SIZE => level.push(segment),
                _ => {
                    level_log_size = log_size;
                    levels.push(vec![segment]);
                }
            }
        }
        levels
    }

    // The level's smallest segments whose live rows fit the cap together, when two or more do.
    fn fitting_merge(&self, level: &[&SegmentMeta]) -> Option<MergeCandidate> {
        let mut smallest_first = level.to_vec();
        smallest_first.sort_by_key(|segment| segment.num_docs());
        let mut rows = 0u32;
        let mut merged = Vec::new();
        for segment in smallest_first {
            if rows + segment.num_docs() > self.row_cap {
                break;
            }
            rows += segment.num_docs();
            merged.push(segment.id());
        }
        (merged.len() >= 2).then_some(MergeCandidate(merged))
    }
}

impl MergePolicy for CappedMergePolicy {
    fn compute_merge_candidates(&self, segments: &[SegmentMeta]) -> Vec<MergeCandidate> {
        let rewrites = segments
            .iter()
            .filter(|segment| {
                self.purged_segments.contains(&segment.id())
                    || deleted_share(segment) > DELETED_SHARE_BEFORE_REWRITE
            })
            .map(|segment| MergeCandidate(vec![segment.id()]));
        let open: Vec<&SegmentMeta> = segments
            .iter()
            .filter(|segment| !self.is_full(segment))
            .collect();
        let merges = self
            .levels(&open)
            .into_iter()
            .filter_map(|level| self.fitting_merge(&level));
        rewrites.chain(merges).collect()
    }
}

fn deleted_share(segment: &SegmentMeta) -> f32 {
    if segment.max_doc() == 0 {
        return 0.0;
    }
    segment.num_deleted_docs() as f32 / segment.max_doc() as f32
}
