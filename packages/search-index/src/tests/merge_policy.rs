//! The capped merge policy: no merge writes more live rows than the cap or takes more segments
//! than its width, the build's merges down to the last included; a segment no merge takes, over
//! half the cap or alone at its size, is rewritten alone, once past its deleted share or once it
//! has held a purged session's or a deleted group's rows; and other segments' deleted and purged
//! rows leave with their merges.

use std::collections::HashSet;

use tantivy::index::SegmentId;
use tantivy::merge_policy::{MergeCandidate, MergePolicy};
use tantivy::schema::{INDEXED, Schema};
use tantivy::{Index, SegmentMeta};

use crate::engine::smallest_candidate;
use crate::merge_policy::{CappedMergePolicy, MERGE_WIDTH};

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
fn merges_a_build_down_without_writing_a_segment_over_the_cap_or_the_width() {
    let index = index();
    let policy = CappedMergePolicy::new(ROW_CAP, HashSet::new());
    // A build's commits: 300 segments of 123 rows, 36,900 rows in all, so the width binds first and
    // the cap later.
    let mut segments: Vec<SegmentMeta> = (0..300).map(|_| segment(&index, 123, 0)).collect();
    let mut merges = 0;
    while let Some(candidate) = policy.compute_merge_candidates(&segments).first().cloned() {
        let rows = live_rows(&segments, &candidate);
        assert!(rows <= ROW_CAP, "a merge writes {rows} rows, over the cap");
        assert!(
            candidate.0.len() <= MERGE_WIDTH,
            "a merge takes {} segments",
            candidate.0.len()
        );
        segments.retain(|segment| !candidate.0.contains(&segment.id()));
        segments.push(segment(&index, rows, 0));
        merges += 1;
        assert!(merges < 1_000, "the merges never end");
    }
    let total: u32 = segments.iter().map(SegmentMeta::num_docs).sum();
    assert_eq!(total, 300 * 123);
    // Every segment but at most one is over half the cap, so the build ends with few segments.
    let small = segments
        .iter()
        .filter(|segment| segment.num_docs() <= ROW_CAP / 2);
    assert!(small.count() <= 1, "{segments:?}");
}

#[test]
fn rewrites_a_segment_no_merge_takes_alone_past_its_deleted_share_or_after_a_purge() {
    let index = index();
    let past_share = segment(&index, ROW_CAP, 200);
    let barely_deleted = segment(&index, ROW_CAP, 50);
    // Held one row of a purged session or a deleted group: rewritten for it, however small its
    // deleted share.
    let held_removed_rows = segment(&index, ROW_CAP, 1);
    // Over half the cap, so no merge takes it beside the small one it would fit with, and with no
    // row deleted it is not rewritten.
    let full = segment(&index, 6_000, 0);
    // The one segment of its size, so no merge takes it, and past its deleted share it is
    // rewritten alone.
    let small = segment(&index, 3_000, 100);
    let policy = CappedMergePolicy::new(ROW_CAP, HashSet::from([held_removed_rows.id()]));
    let segments = vec![
        past_share.clone(),
        barely_deleted,
        held_removed_rows.clone(),
        full,
        small.clone(),
    ];
    let mut candidates: Vec<Vec<SegmentId>> = policy
        .compute_merge_candidates(&segments)
        .into_iter()
        .map(|candidate| candidate.0)
        .collect();
    candidates.sort();
    let mut expected = vec![
        vec![past_share.id()],
        vec![held_removed_rows.id()],
        vec![small.id()],
    ];
    expected.sort();
    assert_eq!(candidates, expected);
}

#[test]
fn an_idle_pass_merges_away_small_segments_deleted_and_purged_rows() {
    let index = index();
    // Steady writes leave small segments, each with a row a later write replaced, and one held a
    // purged session's row.
    let mut segments: Vec<SegmentMeta> = (0..13).map(|_| segment(&index, 2, 1)).collect();
    let purged = segment(&index, 2, 1);
    segments.push(purged.clone());
    segments.push(segment(&index, 3_000, 0));
    let mut to_expunge = HashSet::from([purged.id()]);
    let mut steps = 0;
    loop {
        // As the engine notes them: a segment a merge has rewritten is gone from the set.
        to_expunge.retain(|noted| segments.iter().any(|segment| segment.id() == *noted));
        let policy = CappedMergePolicy::new(ROW_CAP, to_expunge.clone());
        let Some(merged) = smallest_candidate(&policy, &segments) else {
            break;
        };
        let rows = segments
            .iter()
            .filter(|segment| merged.contains(&segment.id()))
            .map(SegmentMeta::num_docs)
            .sum();
        segments.retain(|segment| !merged.contains(&segment.id()));
        segments.push(segment(&index, rows, 0));
        steps += 1;
        assert!(steps < 100, "the merges never end");
    }
    assert!(
        to_expunge.is_empty(),
        "the purged session's segment is left"
    );
    assert!(
        segments
            .iter()
            .all(|segment| segment.num_deleted_docs() == 0),
        "{segments:?}"
    );
    assert_eq!(segments.len(), 1);
    // Two merges of ten and of the rest, where rewriting each small segment alone first takes
    // fourteen steps more.
    assert_eq!(steps, 2);
}
