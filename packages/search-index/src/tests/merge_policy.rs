//! The capped merge policy: no merge writes more live rows than the cap, the build's merges down
//! to the last included, and a segment over half the cap is rewritten only alone, once past its
//! deleted share or once it has held a purged session's or a deleted group's rows.

use std::collections::HashSet;

use tantivy::index::SegmentId;
use tantivy::merge_policy::{MergeCandidate, MergePolicy};
use tantivy::schema::{INDEXED, Schema};
use tantivy::{Index, SegmentMeta};

use crate::merge_policy::CappedMergePolicy;

const ROW_CAP: u32 = 10_000;

fn segment(index: &Index, rows: u32, deleted: u32) -> SegmentMeta {
    let meta = index.new_segment_meta(SegmentId::generate_random(), rows);
    if deleted == 0 {
        meta
    } else {
        meta.with_delete_meta(deleted, 0)
    }
}

fn index() -> Index {
    let mut schema = Schema::builder();
    schema.add_u64_field("key", INDEXED);
    Index::create_in_ram(schema.build())
}

fn live_rows(segments: &[SegmentMeta], candidate: &MergeCandidate) -> u32 {
    segments
        .iter()
        .filter(|segment| candidate.0.contains(&segment.id()))
        .map(SegmentMeta::num_docs)
        .sum()
}

#[test]
fn merges_a_build_down_without_writing_a_segment_over_the_cap() {
    let index = index();
    let policy = CappedMergePolicy::new(ROW_CAP, HashSet::new());
    // A build's commits: 97 segments of 1,234 rows, 119,698 rows in all.
    let mut segments: Vec<SegmentMeta> = (0..97).map(|_| segment(&index, 1_234, 0)).collect();
    let mut merges = 0;
    while let Some(candidate) = policy.compute_merge_candidates(&segments).first().cloned() {
        let rows = live_rows(&segments, &candidate);
        assert!(rows <= ROW_CAP, "a merge writes {rows} rows, over the cap");
        segments.retain(|segment| !candidate.0.contains(&segment.id()));
        segments.push(segment(&index, rows, 0));
        merges += 1;
        assert!(merges < 1_000, "the merges never end");
    }
    let total: u32 = segments.iter().map(SegmentMeta::num_docs).sum();
    assert_eq!(total, 97 * 1_234);
    // Every segment but at most one is over half the cap, so the build ends with few segments.
    let small = segments
        .iter()
        .filter(|segment| segment.num_docs() <= ROW_CAP / 2);
    assert!(small.count() <= 1, "{segments:?}");
}

#[test]
fn rewrites_a_full_segment_only_alone_past_its_deleted_share_or_after_a_purge() {
    let index = index();
    let past_share = segment(&index, ROW_CAP, 200);
    let barely_deleted = segment(&index, ROW_CAP, 50);
    // Held one row of a purged session or a deleted group: rewritten for it, however small its
    // deleted share.
    let held_removed_rows = segment(&index, ROW_CAP, 1);
    // Over half the cap: merged with the small one it would fit, but it is not rewritten for it.
    let full = segment(&index, 6_000, 0);
    let small = segment(&index, 3_000, 0);
    let policy = CappedMergePolicy::new(ROW_CAP, HashSet::from([held_removed_rows.id()]));
    let segments = vec![
        past_share.clone(),
        barely_deleted,
        held_removed_rows.clone(),
        full,
        small,
    ];
    let mut candidates: Vec<Vec<SegmentId>> = policy
        .compute_merge_candidates(&segments)
        .into_iter()
        .map(|candidate| candidate.0)
        .collect();
    candidates.sort();
    let mut expected = vec![vec![past_share.id()], vec![held_removed_rows.id()]];
    expected.sort();
    assert_eq!(candidates, expected);
}
