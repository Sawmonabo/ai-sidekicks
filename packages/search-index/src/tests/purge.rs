//! A purged session's words leave the index's files at the idle merges after the purge, however
//! few of a segment's rows were its own, and a restart before those merges keeps them due: the
//! rewritten segment's files are deleted when its merge ends.

use tantivy::Term;

use crate::engine::IndexEngine;
use crate::{IndexBatch, RemovedOwner};

use super::support::{ScratchFolder, batch, event, open_engine};

const PURGED_SESSION: u64 = 1;
const KEPT_SESSION: u64 = 2;

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

#[test]
fn rewrites_the_segments_a_purge_touched_after_a_restart() {
    let folder = ScratchFolder::new("purge");
    {
        let engine = open_engine(folder.path());
        // One segment of 200 rows, one of them the purged session's: half a percent deleted, under
        // the share that rewrites a segment on its own account.
        let mut rows: Vec<_> = (0..199)
            .map(|index| event(index * 4, KEPT_SESSION, "kept words"))
            .collect();
        rows.push(event(199 * 4, PURGED_SESSION, "purgedonly words"));
        engine.apply(&batch(1, rows)).expect("the rows apply");
        let purge = IndexBatch {
            removed_owners: vec![RemovedOwner {
                owner_key: PURGED_SESSION as i64,
                is_group: false,
            }],
            ..batch(2, Vec::new())
        };
        engine.apply(&purge).expect("the purge applies");
        assert!(files_hold(&engine, "purgedonly"));
        engine.close().expect("the index closes");
    }
    let engine = open_engine(folder.path());
    let touched = engine.current_version().searcher.segment_readers()[0].segment_id();
    while engine.merge_while_idle().expect("a merge step runs") {}
    assert!(!files_hold(&engine, "purgedonly"));
    assert!(files_hold(&engine, "kept"));
    // The rewritten segment's own files are gone from the folder too.
    let prefix = touched.uuid_string();
    let left: Vec<_> = std::fs::read_dir(folder.path())
        .expect("the folder lists")
        .map(|entry| entry.expect("an entry reads").file_name())
        .filter(|name| name.to_string_lossy().starts_with(&prefix))
        .collect();
    assert_eq!(left, Vec::<std::ffi::OsString>::new());
}
