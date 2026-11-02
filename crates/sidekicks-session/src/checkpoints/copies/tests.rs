use std::ffi::OsString;
use std::fs;
use std::path::Path;

use rstest::rstest;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_platforms::{
    harness_test_name, is_superuser, make_folder_link, make_unreadable, scratch_volume,
};

use super::{CopyStore, FileCopyError, FileCopyOutcome};

/// The SHA-256 of `abc`.
const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn abc_hash() -> Sha256Hex {
    Sha256Hex::new(ABC_SHA256.to_owned()).expect("a SHA-256 in lowercase hex")
}

// The names in the store's copies folder, in order.
fn copy_names(store: &CopyStore) -> Vec<OsString> {
    let mut names: Vec<OsString> = fs::read_dir(&store.folder)
        .expect("the copies folder lists")
        .map(|entry| entry.expect("an entry reads").file_name())
        .collect();
    names.sort();
    names
}

// Kills hashing the path, uppercase hex, a second copy of one content and a temporary file left.
#[test]
fn a_content_is_kept_once_under_its_hash() {
    let owner = tempfile::tempdir().expect("an owner folder");
    let source = owner.path().join("source");
    fs::write(&source, b"abc").expect("the source is written");
    let store = CopyStore::open(owner.path()).expect("the copies folder opens");

    assert_eq!(
        store.keep_file_copy(&source).expect("the file is copied"),
        FileCopyOutcome::Copied(abc_hash())
    );
    assert_eq!(
        store
            .keep_copy_from(&b"abc"[..])
            .expect("the bytes are copied"),
        abc_hash()
    );
    assert_eq!(copy_names(&store), vec![OsString::from(ABC_SHA256)]);
    assert_eq!(
        fs::read(store.copy_path(&abc_hash())).expect("the copy reads"),
        b"abc"
    );
}

fn leave_nothing(_owner: &Path, _path: &Path) {}

fn make_link_to_folder(owner: &Path, path: &Path) {
    let folder = owner.join("linked");
    fs::create_dir(&folder).expect("the linked folder is made");
    make_folder_link(&folder, path).expect("the link is made");
}

fn make_folder(_owner: &Path, path: &Path) {
    fs::create_dir(path).expect("the folder is made");
}

// Kills an absence read as an error and a link followed: a followed link opens the folder and
// answers `SpecialFile`.
#[rstest]
#[case::a_missing_path("missing", leave_nothing, FileCopyOutcome::Gone)]
#[case::a_path_in_a_missing_folder("missing/file", leave_nothing, FileCopyOutcome::Gone)]
#[case::a_link_to_a_folder("link", make_link_to_folder, FileCopyOutcome::Link)]
#[case::a_folder("folder", make_folder, FileCopyOutcome::SpecialFile)]
fn what_stands_at_a_path_is_answered_and_never_copied(
    #[case] relative: &str,
    #[case] place: fn(&Path, &Path),
    #[case] expected: FileCopyOutcome,
) {
    let owner = tempfile::tempdir().expect("an owner folder");
    let path = owner.path().join(relative);
    place(owner.path(), &path);
    let store = CopyStore::open(owner.path()).expect("the copies folder opens");

    assert_eq!(
        store.keep_file_copy(&path).expect("the path is answered"),
        expected
    );
    assert!(copy_names(&store).is_empty(), "nothing is copied");
}

// Kills an error mapped to `Gone`.
#[test]
fn an_unreadable_file_is_an_error_never_an_absence() {
    if is_superuser() {
        return;
    }
    let owner = tempfile::tempdir().expect("an owner folder");
    let source = owner.path().join("source");
    fs::write(&source, b"abc").expect("the source is written");
    let _unreadable = make_unreadable(&source).expect("the source is made unreadable");
    let store = CopyStore::open(owner.path()).expect("the copies folder opens");

    let failure = store
        .keep_file_copy(&source)
        .expect_err("an unreadable file is no absence");
    assert!(matches!(failure, FileCopyError::Io(_)), "{failure:?}");
    assert!(copy_names(&store).is_empty(), "nothing is copied");
}

// Kills the byte copy the clone falls back to across volumes.
#[test]
fn a_file_on_another_volume_is_byte_copied() {
    let Some(volume) = scratch_volume(
        &harness_test_name(module_path!(), "a_file_on_another_volume_is_byte_copied"),
        Path::new("scratch"),
    ) else {
        return;
    };
    let source = volume.mount_point().join("source");
    fs::write(&source, b"abc").expect("the source is written");
    let store = CopyStore::open(volume.root()).expect("the copies folder opens");

    assert_eq!(
        store.keep_file_copy(&source).expect("the file is copied"),
        FileCopyOutcome::Copied(abc_hash())
    );
    assert_eq!(copy_names(&store), vec![OsString::from(ABC_SHA256)]);
    assert_eq!(
        fs::read(store.copy_path(&abc_hash())).expect("the copy reads"),
        b"abc"
    );
}
