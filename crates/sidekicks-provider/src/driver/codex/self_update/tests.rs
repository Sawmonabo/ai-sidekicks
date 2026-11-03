use std::fs;
use std::path::{Path, PathBuf};

use super::read_codex_self_update;

// The marker file's folder under a Codex home, as the installer lays it out.
fn standalone_folder(codex_home: &Path) -> PathBuf {
    codex_home.join("packages").join("standalone")
}

// Killed by reading the file at any other path, and by not trimming the installer's text.
#[tokio::test]
async fn the_marker_file_names_the_followed_build() {
    let codex_home = tempfile::tempdir().expect("a scratch folder");
    let folder = standalone_folder(codex_home.path());
    fs::create_dir_all(&folder).expect("the standalone folder is made");
    fs::write(folder.join("auto-update-version"), "rust-v0.166.0\n")
        .expect("the marker file is written");

    let reading = read_codex_self_update(codex_home.path())
        .await
        .expect("the marker file is readable");

    assert_eq!(
        reading.auto_update_version.as_deref(),
        Some("rust-v0.166.0")
    );
}

// Killed by reading an absent file as a failure.
#[tokio::test]
async fn no_marker_file_reads_pinned() {
    let codex_home = tempfile::tempdir().expect("a scratch folder");

    let reading = read_codex_self_update(codex_home.path())
        .await
        .expect("an absent file is no failure");

    assert_eq!(reading.auto_update_version, None);
}

// Killed by reading every failure as an absent file, which would call a folder at the marker's
// path a pinned install.
#[tokio::test]
async fn an_unreadable_marker_surfaces() {
    let codex_home = tempfile::tempdir().expect("a scratch folder");
    fs::create_dir_all(standalone_folder(codex_home.path()).join("auto-update-version"))
        .expect("a folder is made at the marker's path");

    let read = read_codex_self_update(codex_home.path()).await;

    assert!(
        read.is_err(),
        "a folder at the marker's path reads {read:?}"
    );
}
