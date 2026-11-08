use serde_json::value::RawValue;

use super::{ToolCallArgumentBounds, ToolCallArgumentStore, tool_call_arguments_folder};
use crate::driver::test_registry::new_session_id;

// Arguments as Claude Code writes them, with spacing a parse would lose.
fn arguments(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_owned()).expect("the test's arguments are JSON")
}

// The files the store keeps in `data_folder`.
fn kept_files(data_folder: &std::path::Path) -> Vec<std::path::PathBuf> {
    let folder = tool_call_arguments_folder(data_folder);
    if !folder.exists() {
        return Vec::new();
    }
    std::fs::read_dir(folder)
        .expect("the folder reads")
        .map(|entry| entry.expect("the folder reads").path())
        .collect()
}

// Past the bound on calls the oldest arguments go to the file and come back word for word; the
// file goes once its last arguments are read or forgotten. Mutations: no write (no file); a
// range read off by one (the text differs); the file left once empty (a file remains).
#[tokio::test]
async fn arguments_past_the_bound_are_written_and_read_back_word_for_word() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let store = ToolCallArgumentStore::with_bounds(
        data_folder.path(),
        new_session_id(),
        ToolCallArgumentBounds {
            calls: 1,
            bytes: 1024,
        },
    );
    let oldest = store.keep(arguments(r#"{ "command" : "ls" }"#));
    let forgotten = store.keep(arguments(r#"{"file_path": "/repo/a"}"#));
    let newest = store.keep(arguments(r#"{"query":"x"}"#));
    store.spill_past_bounds().await;

    let files = kept_files(data_folder.path());
    assert_eq!(files.len(), 1, "one file holds what passed the bound");
    let written = std::fs::read_to_string(&files[0]).expect("the file reads");
    assert_eq!(written, r#"{ "command" : "ls" }{"file_path": "/repo/a"}"#);

    drop(forgotten);
    assert_eq!(
        oldest.read().await.expect("read back").get(),
        r#"{ "command" : "ls" }"#
    );
    assert_eq!(
        kept_files(data_folder.path()),
        Vec::<std::path::PathBuf>::new()
    );
    assert_eq!(
        newest.read().await.expect("in memory").get(),
        r#"{"query":"x"}"#
    );
}

// A write that finds the file's forgotten bytes outgrew its live ones and the bound first copies
// the live arguments into a fresh file, which keeps each word for word at its new place.
// Mutations: a compaction that copies a range from its new offset, or keeps the old offsets
// (the pinned call reads the wrong bytes); no compaction (the file keeps every byte written).
#[tokio::test]
async fn a_compacted_file_keeps_its_live_arguments_word_for_word() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let store = ToolCallArgumentStore::with_bounds(
        data_folder.path(),
        new_session_id(),
        ToolCallArgumentBounds { calls: 0, bytes: 0 },
    );
    let pinned_text = r#"{"pinned": true}"#;
    let pinned = store.keep(arguments(pinned_text));
    store.spill_past_bounds().await;
    let answered_text = format!(r#"{{"content":"{}"}}"#, "x".repeat(64));
    for _ in 0..4 {
        let answered = store.keep(arguments(&answered_text));
        store.spill_past_bounds().await;
        assert_eq!(
            answered.read().await.expect("read back").get(),
            answered_text
        );
    }
    let last = store.keep(arguments(r#"{"last":1}"#));
    store.spill_past_bounds().await;

    let files = kept_files(data_folder.path());
    assert_eq!(files.len(), 1, "the compaction's copy replaced the file");
    let written = std::fs::read_to_string(&files[0]).expect("the file reads");
    assert!(
        written.len() < pinned_text.len() + 2 * answered_text.len() + r#"{"last":1}"#.len(),
        "the forgotten bytes were compacted away: {written}"
    );
    assert_eq!(pinned.read().await.expect("read back").get(), pinned_text);
    assert_eq!(last.read().await.expect("read back").get(), r#"{"last":1}"#);
    assert_eq!(
        kept_files(data_folder.path()),
        Vec::<std::path::PathBuf>::new()
    );
}
