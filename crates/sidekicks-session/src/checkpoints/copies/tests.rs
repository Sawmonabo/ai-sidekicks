use std::ffi::OsString;
use std::fs::{self, File};
use std::path::Path;

use rstest::rstest;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_platforms::{
    file_mode_of, harness_test_name, is_superuser, make_folder_link, make_unreadable,
    scratch_volume,
};

use super::{CopyStore, FileCopyError, FileCopyOutcome};

/// The SHA-256 of `abc`.
const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/// The hash of `abc`, which [`write_read_only_source`] writes.
pub(crate) fn abc_hash() -> Sha256Hex {
    Sha256Hex::new(ABC_SHA256.to_owned()).expect("a SHA-256 in lowercase hex")
}

/// Writes `abc` to `path` and makes it read-only, so its mode is no file's default and no copy's,
/// and answers that mode as the file reads it, whatever the umask left.
pub(crate) fn write_read_only_source(path: &Path) -> u32 {
    fs::write(path, b"abc").expect("the source is written");
    let mut permissions = fs::metadata(path).expect("the source reads").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).expect("the source is made read-only");
    file_mode_of(&File::open(path).expect("the source opens")).expect("the source's mode reads")
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

// Kills hashing the path, uppercase hex, a second copy of one content, a temporary file left and
// a mode not read from the file (a default one answers `0o644`, `0o666` or `0o600`).
#[test]
fn a_content_is_kept_once_under_its_hash() {
    let owner = tempfile::tempdir().expect("an owner folder");
    let source = owner.path().join("source");
    let source_mode = write_read_only_source(&source);
    let store = CopyStore::open(owner.path()).expect("the copies folder opens");

    assert_eq!(
        store.keep_file_copy(&source).expect("the file is copied"),
        FileCopyOutcome::Copied {
            hash: abc_hash(),
            mode: source_mode
        }
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

/// Makes a folder `linked` in `owner` and a link to it at `path`.
pub(crate) fn make_link_to_folder(owner: &Path, path: &Path) {
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

// Kills the byte copy the clone falls back to across volumes, and a mode read from the copy, which
// a byte copy makes its owner's alone.
#[test]
fn a_file_on_another_volume_is_byte_copied() {
    let Some(volume) = scratch_volume(
        &harness_test_name(module_path!(), "a_file_on_another_volume_is_byte_copied"),
        Path::new("scratch"),
    ) else {
        return;
    };
    let source = volume.mount_point().join("source");
    let source_mode = write_read_only_source(&source);
    let store = CopyStore::open(volume.root()).expect("the copies folder opens");

    assert_eq!(
        store.keep_file_copy(&source).expect("the file is copied"),
        FileCopyOutcome::Copied {
            hash: abc_hash(),
            mode: source_mode
        }
    );
    assert_eq!(copy_names(&store), vec![OsString::from(ABC_SHA256)]);
    assert_eq!(
        fs::read(store.copy_path(&abc_hash())).expect("the copy reads"),
        b"abc"
    );
}
