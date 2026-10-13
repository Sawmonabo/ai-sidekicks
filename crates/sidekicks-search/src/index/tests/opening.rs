//! An index opens in the read mode its platform ships, and a commit payload it cannot read sends
//! the daemon to rebuild the index rather than to read it wrong.

use std::fs;

use crate::index::directory::ReadMode;
use crate::index::{SearchIndex, SearchIndexError};

use super::support::{
    FIRST_RANKED_SESSIONS, ScratchFolder, TEST_OPTIONS, batch, event, open_index, query,
};

#[test]
fn the_index_in_its_platform_read_mode_answers_before_and_after_a_reopen() {
    let folder = ScratchFolder::new("platform-read-mode");
    let open = || {
        SearchIndex::open(folder.path(), TEST_OPTIONS)
            .unwrap_or_else(|failure| panic!("the index did not open: {failure:?}"))
    };
    let sessions = |index: &SearchIndex| -> Vec<u64> {
        let words = query(&["mapped"], false);
        let mut search = index
            .open_search(Vec::new(), FIRST_RANKED_SESSIONS, Some(&words))
            .expect("opens");
        search.sessions_at(0, 10).expect("ranks")
    };
    {
        let index = open();
        let rows = vec![event(4, 1, "mapped words"), event(8, 2, "other words")];
        index.apply(&batch(1, rows)).expect("the rows apply");
        assert_eq!(sessions(&index), vec![1]);
        index.close().expect("the index closes");
    }
    assert_eq!(sessions(&open()), vec![1]);
}

#[test]
fn an_unreadable_commit_payload_fails_the_open_as_unreadable() {
    let folder = ScratchFolder::new("unreadable-payload");
    {
        let index = open_index(folder.path());
        index
            .apply(&batch(1, vec![event(4, 1, "words")]))
            .expect("the row applies");
        index.close().expect("the index closes");
    }
    let meta_path = folder.path().join("meta.json");
    let mut meta: serde_json::Value =
        serde_json::from_slice(&fs::read(&meta_path).expect("meta.json reads")).expect("parses");
    meta["payload"] = serde_json::Value::from("not a payload");
    fs::write(&meta_path, meta.to_string()).expect("meta.json writes");
    let opened = SearchIndex::open_in(folder.path(), TEST_OPTIONS, ReadMode::Positioned);
    assert!(
        matches!(opened, Err(SearchIndexError::Unreadable(_))),
        "the open fails as unreadable"
    );
}
