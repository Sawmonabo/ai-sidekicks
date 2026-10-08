//! A purged session's words and a deleted group's name leave the index's files at the idle merges
//! after their removal, however few of a segment's rows were theirs, and a restart before those
//! merges keeps them due: each rewritten segment's files are deleted when its merge ends.

use std::path::Path;

use tantivy::Term;
use tantivy::index::SegmentId;

use crate::engine::IndexEngine;
use crate::{IndexBatch, IndexRowKind, RemovedOwner};

use super::support::{ScratchFolder, batch, event, open_engine, row};

const PURGED_SESSION: u64 = 1;
const KEPT_SESSION: u64 = 2;
const DELETED_GROUP: u64 = 3;

// Whether any segment's files still hold `word`, its deleted rows counted until a merge drops them.
fn files_hold(engine: &IndexEngine, word: &str) -> bool {
    let version = engine.current_version();
    let term = Term::from_field_text(version.fields.text, word);
    version.searcher.segment_readers().iter().any(|segment| {
        let inverted = segment
            .inverted_index(version.fields.text)
            .expect("the field reads");
        inverted.doc_freq(&term).expect("the term reads") > 0
    })
}

fn removal(owner_key: u64, is_group: bool, last_outbox_id: i64) -> IndexBatch {
    IndexBatch {
        removed_owners: vec![RemovedOwner {
            owner_key: owner_key as i64,
            is_group,
        }],
        ..batch(last_outbox_id, Vec::new())
    }
}

// The rows' one segment, which each removal below leaves at half a percent deleted, under the
// share that rewrites a segment on its own account.
fn only_segment(engine: &IndexEngine) -> SegmentId {
    let version = engine.current_version();
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
        let engine = open_engine(folder.path());
        let mut rows: Vec<_> = (0..198)
            .map(|index| event(index * 4, KEPT_SESSION, "kept words"))
            .collect();
        rows.push(event(198 * 4, PURGED_SESSION, "purgedonly words"));
        rows.push(row(2, IndexRowKind::Group, DELETED_GROUP, "groupnameonly"));
        engine.apply(&batch(1, rows)).expect("the rows apply");
        engine
            .apply(&removal(PURGED_SESSION, false, 2))
            .expect("the purge applies");
        assert!(files_hold(&engine, "purgedonly"));
        engine.close().expect("the index closes");
    }
    // Noted in the purge's commit, so the rewrite is still due after a restart.
    let engine = open_engine(folder.path());
    let purged = only_segment(&engine);
    while engine.merge_while_idle().expect("a merge step runs") {}
    assert!(!files_hold(&engine, "purgedonly"));
    assert!(files_hold(&engine, "kept"));
    assert!(!files_left(folder.path(), purged));
    // A deleted group's name leaves the same way.
    engine
        .apply(&removal(DELETED_GROUP, true, 3))
        .expect("the group's removal applies");
    let held_group = only_segment(&engine);
    while engine.merge_while_idle().expect("a merge step runs") {}
    assert!(!files_hold(&engine, "groupnameonly"));
    assert!(!files_left(folder.path(), held_group));
}
