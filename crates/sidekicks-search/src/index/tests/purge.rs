//! A purged session's words and a deleted group's name leave the index's files at the merges
//! after their removal, however few of a segment's rows were theirs and even when the purge
//! commits while a merge of its segment runs, and a restart before those merges keeps them due:
//! each rewritten segment's files are deleted when its merge ends.

use std::path::Path;

use tantivy::Term;
use tantivy::index::SegmentId;

use crate::index::engine::RunningMerge;
use crate::index::{IndexBatch, IndexRowKind, RemovedOwner, SearchIndex};

use super::support::{ScratchFolder, batch, event, open_index, row};

const PURGED_SESSION: u64 = 1;
const KEPT_SESSION: u64 = 2;
const DELETED_GROUP: u64 = 3;

// Whether any segment's files still hold `word`, its deleted rows counted until a merge drops them.
fn files_hold(index: &SearchIndex, word: &str) -> bool {
    let version = index.current_version();
    let term = Term::from_field_text(version.fields.text, word);
    version.searcher.segment_readers().iter().any(|segment| {
        let inverted = segment
            .inverted_index(version.fields.text)
            .expect("the field reads");
        inverted.doc_freq(&term).expect("the term reads") > 0
    })
}

fn removal(owner_key: u64, is_group: bool, last_outbox_id: u64) -> IndexBatch {
    IndexBatch {
        removed_owners: vec![RemovedOwner {
            owner_key,
            is_group,
        }],
        ..batch(last_outbox_id, Vec::new())
    }
}

// The rows' one segment, which each removal below leaves at half a percent deleted, under the
// share that rewrites a segment on its own account.
fn only_segment(index: &SearchIndex) -> SegmentId {
    let version = index.current_version();
    let segments = version.searcher.segment_readers();
    assert_eq!(segments.len(), 1);
    segments[0].segment_id()
}

// Whether any file of `segment` is left in `folder`.
fn files_left(folder: &Path, segment: SegmentId) -> bool {
    let prefix = segment.uuid_string();
    std::fs::read_dir(folder)
        .expect("the folder lists")
        .map(|entry| entry.expect("an entry reads").file_name())
        .any(|name| name.to_string_lossy().starts_with(&prefix))
}

#[test]
fn rewrites_the_segments_a_purge_or_a_group_deletion_touched() {
    let folder = ScratchFolder::new("purge");
    {
        let index = open_index(folder.path());
        let mut rows: Vec<_> = (0..198)
            .map(|ordinal| event(ordinal * 4, KEPT_SESSION, "kept words"))
            .collect();
        rows.push(event(198 * 4, PURGED_SESSION, "purgedonly words"));
        rows.push(row(2, IndexRowKind::Group, DELETED_GROUP, "groupnameonly"));
        index.apply(&batch(1, rows)).expect("the rows apply");
        index
            .apply(&removal(PURGED_SESSION, false, 2))
            .expect("the purge applies");
        assert!(files_hold(&index, "purgedonly"));
        index.close().expect("the index closes");
    }
    // Noted in the purge's commit, so the rewrite is still due after a restart.
    let index = open_index(folder.path());
    let purged = only_segment(&index);
    while index.merge_segments().expect("a merge step runs") {}
    assert!(!files_hold(&index, "purgedonly"));
    assert!(files_hold(&index, "kept"));
    assert!(!files_left(folder.path(), purged));
    // A deleted group's name leaves the same way.
    index
        .apply(&removal(DELETED_GROUP, true, 3))
        .expect("the group's removal applies");
    let held_group = only_segment(&index);
    while index.merge_segments().expect("a merge step runs") {}
    assert!(!files_hold(&index, "groupnameonly"));
    assert!(!files_left(folder.path(), held_group));
}

// Two segments of 100 rows each, one holding the purged session's one row, merging while the purge
// commits: the merged segment holds that row deleted, half a percent of its rows, which alone
// would never rewrite it.
fn purge_during_a_merge(index: &SearchIndex) -> RunningMerge {
    let mut first: Vec<_> = (0..99)
        .map(|ordinal| event(ordinal * 4, KEPT_SESSION, "kept words"))
        .collect();
    first.push(event(99 * 4, PURGED_SESSION, "purgedonly words"));
    index.apply(&batch(1, first)).expect("the first rows apply");
    let second = (100..200)
        .map(|ordinal| event(ordinal * 4, KEPT_SESSION, "kept words"))
        .collect();
    index
        .apply(&batch(2, second))
        .expect("the second rows apply");
    let merge = index
        .start_merge()
        .expect("a merge starts")
        .expect("the two segments merge");
    index
        .apply(&removal(PURGED_SESSION, false, 3))
        .expect("the purge applies");
    merge
}

// After a restart, every merge expunges the purged session's words and keeps the rest.
fn assert_merges_expunge_the_purge(folder: &Path) {
    let index = open_index(folder);
    while index.merge_segments().expect("a merge step runs") {}
    assert!(!files_hold(&index, "purgedonly"));
    assert!(files_hold(&index, "kept"));
}

#[test]
fn a_purge_during_a_merge_leaves_the_merged_segment_due_for_rewriting() {
    let folder = ScratchFolder::new("purge-during-merge");
    {
        let index = open_index(folder.path());
        let merge = purge_during_a_merge(&index);
        assert!(index.finish_merge(merge).expect("the merge ends"));
        index.close().expect("the index closes");
    }
    assert_merges_expunge_the_purge(folder.path());
}

#[test]
fn a_stop_after_a_merge_the_purge_raced_still_rewrites_the_merged_segment() {
    let folder = ScratchFolder::new("purge-during-merge-stop");
    {
        let index = open_index(folder.path());
        let merge = purge_during_a_merge(&index);
        // The merge's segment replaces the two in the index's files, and the daemon stops before
        // the merge's end is noted.
        merge.wait().expect("the merge ends");
    }
    assert_merges_expunge_the_purge(folder.path());
}
