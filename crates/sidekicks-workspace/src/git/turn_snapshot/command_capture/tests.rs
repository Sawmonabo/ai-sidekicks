use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use rstest::rstest;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::{make_folder_link, real_path};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    CommandCaptureService, IgnoredListing, TreeChange, TreeEntry, read_diff_tree_records,
    read_ignored_listing,
};
use crate::git::process::test_repository::{commit_empty, git_in, make_test_repository};
use crate::git::process::{GitRunner, test_git_runner};
use crate::git::turn_snapshot::capture::{
    CheckoutCaptureInput, GitFloorReports, LARGE_FILE_BYTES, LargeFile,
};
use crate::git::turn_snapshot::capture_folder::CaptureFolder;
use crate::git::turn_snapshot::capture_steps::DiffTreeReadError;
use crate::git::turn_snapshot::repack::CapturePacking;
use crate::git::turn_snapshot::service::TurnSnapshotCaptureOutcome;
use crate::git::turn_snapshot::service::test_support::{
    answer_in_git_folder, answer_with_captures, made_capture_folder, minted_run_id,
    service_reading, turn_of, utf8,
};
use crate::git::worktree::schema::schema_parts;

// Past the size bound, so a file of this size is never hashed.
const ELEVEN_MIB: u64 = 11 * 1024 * 1024;

const CAPTURED_SECOND: i64 = 1_800_000_000;

const SHA1_A: &str = "1111111111111111111111111111111111111111";
const SHA1_B: &str = "2222222222222222222222222222222222222222";
const SHA1_ZERO: &str = "0000000000000000000000000000000000000000";
const SHA256_A: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const SHA256_B: &str = "4444444444444444444444444444444444444444444444444444444444444444";

// A command capture of the checkout `repository`, owned by `owner`.
pub(super) fn command_in(repository: &Path, owner: &Path) -> CheckoutCaptureInput {
    CheckoutCaptureInput {
        owner_folder: owner.to_path_buf(),
        execution_root: repository.to_path_buf(),
        checkout_root: repository.to_path_buf(),
        captured_at: Timestamp::from_second(CAPTURED_SECOND).expect("the instant is in range"),
    }
}

// A file of `size` zero bytes at `path`, none of them written.
fn write_sized(path: &Path, size: u64) {
    File::create(path)
        .expect("the file is made")
        .set_len(size)
        .expect("the file is sized");
}

// Writes each `(path, text)` under `folder`, making its parent folders.
pub(super) fn write_files(folder: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let path = folder.join(path);
        std::fs::create_dir_all(path.parent().expect("a file has a parent"))
            .expect("the parent folder is made");
        std::fs::write(path, text).expect("the file is written");
    }
}

// The paths `tree` holds, read in `repository` with `capture_folder` attached.
async fn tree_paths(
    git: &GitRunner,
    repository: &Path,
    capture_folder: &CaptureFolder,
    tree: &str,
) -> Vec<String> {
    let arguments = ["ls-tree", "-r", "--name-only", tree];
    let listing = answer_with_captures(git, repository, capture_folder, &arguments).await;
    listing.lines().map(str::to_owned).collect()
}

// Each change's letter and path.
fn letters(changes: &[TreeChange]) -> Vec<(char, &str)> {
    changes
        .iter()
        .map(|change| match change {
            TreeChange::Added { path, .. } => ('A', utf8(path)),
            TreeChange::Deleted { path, .. } => ('D', utf8(path)),
            TreeChange::Modified { path, .. } => ('M', utf8(path)),
            TreeChange::TypeChanged { path, .. } => ('T', utf8(path)),
        })
        .collect()
}

// Fails when an ignored folder is told by the plain trailing-slash test (`mixed/` named), when the
// ignored listing is dropped (`.env`, `src/k.pem` and `mixed/only.log` missing), when a large file
// is staged (`big.bin` in the tree), when the live index is written, or when the turn snapshot
// stages into the kept index (it then holds `.env`).
#[tokio::test]
async fn a_before_capture_stages_ignored_files_outside_ignored_folders_and_leaves_large_ones_out() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = make_test_repository(&git, root.path(), "repository").await;
    write_files(
        &repository,
        &[
            (".gitignore", "*.pem\n*.log\n.env\nbuild/\nemptyign/\n"),
            ("a.txt", "a\n"),
        ],
    );
    git_in(&git, &repository, &["add", ".gitignore", "a.txt"]).await;
    commit_empty(&git, &repository, "tracked").await;
    write_files(
        &repository,
        &[
            ("src/main.c", "int main;\n"),
            ("src/k.pem", "key\n"),
            (".env", "SECRET=1\n"),
            ("build/out.o", "object\n"),
            ("mixed/only.log", "log\n"),
        ],
    );
    std::fs::create_dir(repository.join("emptyign")).expect("the empty folder is made");
    write_sized(&repository.join("big.bin"), ELEVEN_MIB);
    let live_index = repository.join(".git").join("index");
    let index_before = std::fs::read(&live_index).expect("the live index reads");
    let owner = root.path().join("owner");
    let service = CommandCaptureService::new(
        git.clone(),
        Arc::new(KeyedLock::new()),
        Arc::new(CapturePacking::new(git.clone(), Arc::default())),
        Arc::new(GitFloorReports::default()),
    );
    let database = TestDatabase::new(schema_parts());
    let packing = Arc::new(CapturePacking::new(
        git.clone(),
        Arc::new(GitFloorReports::default()),
    ));
    let turns = service_reading(git.clone(), &database, Arc::new(KeyedLock::new()), packing);

    let captured = service
        .capture_before(None, &command_in(&repository, &owner))
        .await
        .expect("the before-capture is taken");
    let turn = turns
        .capture_turn_snapshot(None, &turn_of(&repository, &owner, minted_run_id(), 0))
        .await;

    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    assert_eq!(
        tree_paths(&git, &repository, &capture_folder, captured.tree.as_str()).await,
        [
            ".env",
            ".gitignore",
            "a.txt",
            "mixed/only.log",
            "src/k.pem",
            "src/main.c"
        ]
    );
    assert_eq!(
        captured.ignored_folders,
        [PathBuf::from("build/"), PathBuf::from("emptyign/")]
    );
    assert_eq!(
        captured.large_files,
        [LargeFile {
            path: PathBuf::from("big.bin"),
            size: ELEVEN_MIB,
        }]
    );
    let TurnSnapshotCaptureOutcome::Captured {
        snapshot_commit, ..
    } = turn
    else {
        panic!("the turn is captured, got {turn:?}");
    };
    assert_eq!(
        tree_paths(&git, &repository, &capture_folder, snapshot_commit.as_str()).await,
        [".gitignore", "a.txt", "src/main.c"]
    );
    assert_eq!(
        std::fs::read(&live_index).expect("the live index reads"),
        index_before
    );
}

// Fails when a sparse root stages its whole listing: the out-of-cone `b/2`, absent on disk, is
// then removed from the kept index and lost from the tree.
#[tokio::test]
async fn a_before_capture_in_a_sparse_root_keeps_the_paths_outside_its_cone() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = make_test_repository(&git, root.path(), "repository").await;
    write_files(&repository, &[("a/1", "one\n"), ("b/2", "two\n")]);
    git_in(&git, &repository, &["add", "a", "b"]).await;
    commit_empty(&git, &repository, "two folders").await;
    git_in(
        &git,
        &repository,
        &["sparse-checkout", "set", "--cone", "a"],
    )
    .await;
    assert!(
        !repository.join("b").join("2").exists(),
        "b/2 is outside the cone"
    );
    let owner = root.path().join("owner");
    let service = CommandCaptureService::new(
        git.clone(),
        Arc::new(KeyedLock::new()),
        Arc::new(CapturePacking::new(git.clone(), Arc::default())),
        Arc::new(GitFloorReports::default()),
    );

    let captured = service
        .capture_before(None, &command_in(&repository, &owner))
        .await
        .expect("the before-capture is taken");

    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    assert_eq!(
        tree_paths(&git, &repository, &capture_folder, captured.tree.as_str()).await,
        ["a/1", "b/2"]
    );
}

// Fails when the execution root, here a link, is named as the checkout, or when the linked
// worktree's own git folder is named as the repository's.
#[tokio::test]
async fn a_capture_names_its_checkouts_real_path_and_its_repository() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = make_test_repository(&git, root.path(), "repository").await;
    write_files(&repository, &[("a.txt", "a\n")]);
    git_in(&git, &repository, &["add", "a.txt"]).await;
    commit_empty(&git, &repository, "base").await;
    let worktree = root.path().join("linked");
    git_in(
        &git,
        &repository,
        &["worktree", "add", "-q", "-b", "linked", utf8(&worktree)],
    )
    .await;
    let link = root.path().join("link");
    make_folder_link(&worktree, &link).expect("the link to the worktree is made");
    let service = CommandCaptureService::new(
        git.clone(),
        Arc::new(KeyedLock::new()),
        Arc::new(CapturePacking::new(git.clone(), Arc::default())),
        Arc::new(GitFloorReports::default()),
    );

    let captured = service
        .capture_before(None, &command_in(&link, &root.path().join("owner")))
        .await
        .expect("the before-capture is taken");

    let resolved = |path: &Path| real_path(path).expect("the path resolves");
    assert_eq!(resolved(&captured.checkout_real_path), resolved(&worktree));
    assert_eq!(
        resolved(&captured.common_folder),
        resolved(&repository.join(".git"))
    );
}

// Fails when the after-capture does not remove its large paths from the kept index (`grows.bin`
// and `stays.bin` then read unchanged, no letter), when the remove is aimed at the live index (its
// bytes change), or when a large file is hashed into the capture folder.
#[tokio::test]
async fn an_after_capture_reads_a_path_past_the_size_bound_as_deleted() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = make_test_repository(&git, root.path(), "repository").await;
    write_files(&repository, &[("grows.bin", "small\n"), ("x.txt", "x\n")]);
    for tracked_large in ["shrinks.bin", "gone.bin", "stays.bin"] {
        write_sized(&repository.join(tracked_large), ELEVEN_MIB);
    }
    git_in(&git, &repository, &["add", "-A"]).await;
    commit_empty(&git, &repository, "base").await;
    // Sizes apart from the tracked blob's, so a hashed one would be a new object in the folder.
    write_sized(&repository.join("loose.bin"), ELEVEN_MIB + 1);
    let live_index = repository.join(".git").join("index");
    let index_before = std::fs::read(&live_index).expect("the live index reads");
    let owner = root.path().join("owner");
    let service = CommandCaptureService::new(
        git.clone(),
        Arc::new(KeyedLock::new()),
        Arc::new(CapturePacking::new(git.clone(), Arc::default())),
        Arc::new(GitFloorReports::default()),
    );
    let input = command_in(&repository, &owner);

    let before = service
        .capture_before(None, &input)
        .await
        .expect("the before-capture is taken");
    write_sized(&repository.join("grows.bin"), ELEVEN_MIB + 2);
    write_files(
        &repository,
        &[
            ("shrinks.bin", "now small\n"),
            ("loose.bin", "loose now small\n"),
        ],
    );
    std::fs::remove_file(repository.join("gone.bin")).expect("the file is removed");
    write_sized(&repository.join("made.bin"), ELEVEN_MIB + 3);
    let after = service
        .capture_after(None, &input, &before.tree)
        .await
        .expect("the after-capture is taken");

    let capture_folder = made_capture_folder(&git, &owner, &repository).await;
    assert_eq!(
        tree_paths(&git, &repository, &capture_folder, before.tree.as_str()).await,
        ["gone.bin", "grows.bin", "shrinks.bin", "stays.bin", "x.txt"]
    );
    assert_eq!(
        letters(&after.changes),
        [
            ('D', "gone.bin"),
            ('D', "grows.bin"),
            ('A', "loose.bin"),
            ('M', "shrinks.bin"),
            ('D', "stays.bin"),
        ]
    );
    let mut large_paths: Vec<&str> = after
        .capture
        .large_files
        .iter()
        .map(|large_file| utf8(&large_file.path))
        .collect();
    large_paths.sort_unstable();
    assert_eq!(large_paths, ["grows.bin", "made.bin", "stays.bin"]);
    // The capture folder read alone, no repository attached.
    let sizes = answer_in_git_folder(
        &git,
        capture_folder.folder(),
        &[
            "cat-file",
            "--batch-check=%(objectsize)",
            "--batch-all-objects",
        ],
        &[],
    )
    .await;
    let sizes: Vec<u64> = sizes
        .lines()
        .map(|size| size.parse().expect("git prints a size"))
        .collect();
    assert!(!sizes.is_empty(), "the captures wrote objects");
    assert!(
        sizes.iter().all(|&size| size <= LARGE_FILE_BYTES),
        "no object past the bound is in the capture folder, got {sizes:?}"
    );
    assert_eq!(
        std::fs::read(&live_index).expect("the live index reads"),
        index_before
    );
}

// The ids a refusal row writes for `{a}`, `{b}`, `{z}`, `{wa}` and `{wb}`.
fn diff_tree_output(template: &str) -> Vec<u8> {
    template
        .replace("{wa}", SHA256_A)
        .replace("{wb}", SHA256_B)
        .replace("{a}", SHA1_A)
        .replace("{b}", SHA1_B)
        .replace("{z}", SHA1_ZERO)
        .into_bytes()
}

fn object(id: &str) -> GitObjectId {
    GitObjectId::new(id.to_owned()).expect("the test's id is valid")
}

// Fails when a letter's sides are read the wrong way round or a mode is read as decimal.
#[test]
fn diff_tree_raw_records_read_as_changes() {
    let output = diff_tree_output(concat!(
        ":000000 100644 {z} {a} A\0new.txt\0",
        ":100644 000000 {a} {z} D\0gone.txt\0",
        ":100644 100755 {a} {b} M\0run.sh\0",
        ":100644 120000 {a} {b} T\0link\0",
        ":100644 100644 {wa} {wb} M\0wide\0",
    ));

    let changes = read_diff_tree_records(&output).expect("the records read");

    let file = |id| TreeEntry {
        mode: 0o100_644,
        object: object(id),
    };
    assert_eq!(
        changes,
        [
            TreeChange::Added {
                path: PathBuf::from("new.txt"),
                after: file(SHA1_A),
            },
            TreeChange::Deleted {
                path: PathBuf::from("gone.txt"),
                before: file(SHA1_A),
            },
            TreeChange::Modified {
                path: PathBuf::from("run.sh"),
                before: file(SHA1_A),
                after: TreeEntry {
                    mode: 0o100_755,
                    object: object(SHA1_B),
                },
            },
            TreeChange::TypeChanged {
                path: PathBuf::from("link"),
                before: file(SHA1_A),
                after: TreeEntry {
                    mode: 0o120_000,
                    object: object(SHA1_B),
                },
            },
            TreeChange::Modified {
                path: PathBuf::from("wide"),
                before: file(SHA256_A),
                after: file(SHA256_B),
            },
        ]
    );
}

// Fails when an unknown letter is read as a change (`X` or `Q` as `M`), when the zero id is taken
// as an object, or when a malformed record is read rather than refused, a good record before it
// included.
#[rstest]
#[case::copy(
    ":100644 100644 {a} {b} C75\0a\0b\0",
    DiffTreeReadError::UnreadLetter(String::new())
)]
#[case::rename(
    ":100644 100644 {a} {b} R100\0a\0b\0",
    DiffTreeReadError::UnreadLetter(String::new())
)]
#[case::unmerged(
    ":000000 000000 {z} {z} U\0a\0",
    DiffTreeReadError::UnreadLetter(String::new())
)]
#[case::unknown_x(
    ":100644 100644 {a} {b} X\0a\0",
    DiffTreeReadError::UnreadLetter(String::new())
)]
#[case::unknown_q(
    ":100644 100644 {a} {b} Q\0a\0",
    DiffTreeReadError::UnreadLetter(String::new())
)]
#[case::after_a_good_record(
    ":100644 100644 {a} {b} M\0a\0:100644 100644 {a} {b} R90\0b\0c\0",
    DiffTreeReadError::UnreadLetter(String::new())
)]
#[case::four_fields(":100644 100644 {a} {b}\0a\0", DiffTreeReadError::MalformedHeader)]
#[case::six_fields(":100644 100644 {a} {b} M M\0a\0", DiffTreeReadError::MalformedHeader)]
#[case::no_colon("100644 100644 {a} {b} M\0a\0", DiffTreeReadError::MalformedHeader)]
#[case::short_mode(":10064 100644 {a} {b} M\0a\0", DiffTreeReadError::MalformedMode)]
#[case::non_octal_mode(":100648 100644 {a} {b} M\0a\0", DiffTreeReadError::MalformedMode)]
#[case::upper_case_id(
    ":100644 100644 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA {b} M\0a\0",
    DiffTreeReadError::MalformedObjectId
)]
#[case::short_ids(
    ":100644 100644 111111111111111111111111111111111111111 \
     222222222222222222222222222222222222222 M\0a\0",
    DiffTreeReadError::MalformedObjectId
)]
#[case::mixed_id_lengths(
    ":100644 100644 {a} {wb} M\0a\0",
    DiffTreeReadError::MixedObjectIdLengths
)]
#[case::zero_id_as_an_object(":100644 100644 {z} {b} M\0a\0", DiffTreeReadError::HalfSide)]
#[case::object_without_a_mode(":000000 100644 {a} {b} A\0a\0", DiffTreeReadError::HalfSide)]
#[case::added_with_a_before(
    ":100644 100644 {a} {b} A\0a\0",
    DiffTreeReadError::SidesDisagree { letter: String::new() }
)]
#[case::deleted_with_an_after(
    ":100644 100644 {a} {b} D\0a\0",
    DiffTreeReadError::SidesDisagree { letter: String::new() }
)]
#[case::modified_without_a_before(
    ":000000 100644 {z} {b} M\0a\0",
    DiffTreeReadError::SidesDisagree { letter: String::new() }
)]
#[case::unterminated_header(":100644 100644 {a} {b} M", DiffTreeReadError::UnterminatedHeader)]
#[case::no_path(":100644 100644 {a} {b} M\0", DiffTreeReadError::MissingPath)]
#[case::unterminated_path(":100644 100644 {a} {b} M\0a", DiffTreeReadError::MissingPath)]
#[case::empty_path(":100644 100644 {a} {b} M\0\0", DiffTreeReadError::MissingPath)]
fn a_diff_tree_record_that_does_not_read_is_refused(
    #[case] template: &str,
    #[case] refusal: DiffTreeReadError,
) {
    let read = read_diff_tree_records(&diff_tree_output(template));

    let Err(error) = read else {
        panic!("the output is refused, got {read:?}");
    };
    assert_eq!(
        std::mem::discriminant(&error),
        std::mem::discriminant(&refusal),
        "got {error:?}"
    );
}

// Fails when the folder test depends on the listing's order: a folder listed after the file under
// it would be named and its file staged as well.
#[rstest]
#[case::as_git_lists_it(b".env\0build/\0emptyign/\0mixed/\0mixed/only.log\0src/k.pem\0")]
#[case::reversed(b"src/k.pem\0mixed/only.log\0mixed/\0emptyign/\0build/\0.env\0")]
fn an_ignored_folder_is_one_no_other_entry_sits_under(#[case] listing: &[u8]) {
    assert_eq!(
        read_ignored_listing(listing),
        IgnoredListing {
            staged_entries: vec![
                b".env".as_slice(),
                b"mixed/only.log".as_slice(),
                b"src/k.pem".as_slice()
            ],
            folders: vec![b"build/".as_slice(), b"emptyign/".as_slice()],
        }
    );
}
