//! An index opens in the read mode its platform ships, and a commit payload it cannot read sends
//! the daemon to rebuild the index rather than to read it wrong.

use std::fs;

use crate::directory::ReadMode;
use crate::engine::{IndexEngine, OpenFailure};

use super::support::{ScratchFolder, TEST_ARENA_BYTES, batch, event, open_engine};

#[cfg(target_os = "macos")]
#[test]
fn the_memory_mapped_index_answers_before_and_after_a_reopen() {
    use super::support::{FIRST_RANKED_SESSIONS, query};
    use crate::view::SearchView;

    let folder = ScratchFolder::new("memory-map");
    let open = || match IndexEngine::open(folder.path(), TEST_ARENA_BYTES, 1, ReadMode::MemoryMap) {
        Ok(engine) => engine,
        Err(failure) => panic!("the mapped index did not open: {failure:?}"),
    };
    let sessions = |engine: &IndexEngine| -> Vec<u64> {
        let words = query(&["mapped"], false);
        let mut view = SearchView::open(engine, Some(&words), Vec::new(), FIRST_RANKED_SESSIONS)
            .expect("opens");
        view.sessions_at(0, 10).expect("ranks")
    };
    {
        let engine = open();
        let rows = vec![event(4, 1, "mapped words"), event(8, 2, "other words")];
        engine.apply(&batch(1, rows)).expect("the rows apply");
        assert_eq!(sessions(&engine), vec![1]);
        engine.close().expect("the index closes");
    }
    assert_eq!(sessions(&open()), vec![1]);
}

#[test]
fn an_unreadable_commit_payload_fails_the_open_as_unreadable() {
    let folder = ScratchFolder::new("unreadable-payload");
    {
        let engine = open_engine(folder.path());
        engine
            .apply(&batch(1, vec![event(4, 1, "words")]))
            .expect("the row applies");
        engine.close().expect("the index closes");
    }
    let meta_path = folder.path().join("meta.json");
    let mut meta: serde_json::Value =
        serde_json::from_slice(&fs::read(&meta_path).expect("meta.json reads")).expect("parses");
    meta["payload"] = serde_json::Value::from("not a payload");
    fs::write(&meta_path, meta.to_string()).expect("meta.json writes");
    let opened = IndexEngine::open(folder.path(), TEST_ARENA_BYTES, 1, ReadMode::Positioned);
    assert!(
        matches!(opened, Err(OpenFailure::Unreadable(_))),
        "the open fails as unreadable"
    );
}
