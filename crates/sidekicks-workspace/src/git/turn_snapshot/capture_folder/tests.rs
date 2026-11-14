use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use sha2::{Digest as _, Sha256};
use sidekicks_platforms::{Spawner, make_folder_link, os_text_stable_bytes, real_path};

use super::{CaptureFolder, git_folder_argument};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{
    GitCall, GitLimits, GitRunner, read_git_common_folder, strip_line_end, test_git_runner,
};
use crate::git::turn_snapshot::capture::TURN_SNAPSHOT_SUBJECT;
use crate::git::turn_snapshot::capture_steps::SnapshotCheckout;
use crate::git::turn_snapshot::repack::CapturePacking;

// What `arguments` against the git folder `folder` printed, its line end dropped, run with
// `environment`; `None` when git refused.
async fn answer_in_git_folder(
    git: &GitRunner,
    folder: &Path,
    arguments: &[&str],
    environment: &[(&str, &std::ffi::OsStr)],
) -> Option<String> {
    let mut call = GitCall::read(
        [git_folder_argument(folder)]
            .into_iter()
            .chain(arguments.iter().map(OsString::from)),
    );
    for (name, value) in environment {
        call = call.with_environment(*name, *value);
    }
    let output = git.run(None, call).await.ok()?;
    Some(String::from_utf8(strip_line_end(output.stdout)).expect("git answers in UTF-8"))
}

// Every file under `folder`, relative to it, sorted.
fn files_under(folder: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("the folder lists") {
            let path = entry.expect("the entry reads").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(
                    path.strip_prefix(folder)
                        .expect("the file is under the folder")
                        .to_path_buf(),
                );
            }
        }
    }
    files.sort();
    files
}

// A runner with no git, so any call it makes fails.
fn runner_without_git() -> GitRunner {
    GitRunner::new(
        Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
        None,
        Arc::from([]),
        GitLimits::DAEMON,
    )
}

// A SHA-256 repository gets a SHA-256 capture folder named for its git folder's real path, with
// automatic gc and maintenance off, reused as it stands and reached the same through a symlinked
// spelling. Fails when the object format is not passed on, the given path is hashed instead of the
// real one, or a present folder is made again.
#[tokio::test]
async fn a_repository_gets_one_capture_folder_in_its_object_format() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    git_in(
        &git,
        root.path(),
        &["init", "--quiet", "--object-format=sha256", "repository"],
    )
    .await;
    let repository = root.path().join("repository");
    let link = root.path().join("link");
    make_folder_link(&repository, &link).expect("the link to the repository is made");
    let git_common_folder = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let owner = root.path().join("owner");
    let packing = CapturePacking::new(git.clone(), Arc::default());

    let opened = CaptureFolder::open_or_create(&git, None, &packing, &owner, &git_common_folder)
        .await
        .expect("the capture folder is made");
    let without_git = runner_without_git();
    let reopened =
        CaptureFolder::open_or_create(&without_git, None, &packing, &owner, &git_common_folder)
            .await
            .expect("the present folder is reused without git");
    let through_link =
        CaptureFolder::open_or_create(&git, None, &packing, &owner, &link.join(".git"))
            .await
            .expect("the folder opens through the link");

    let real = canonical_folder_path(&git_common_folder)
        .await
        .expect("the git folder resolves");
    let name =
        base16ct::lower::encode_string(&Sha256::digest(os_text_stable_bytes(real.as_os_str())));
    assert_eq!(opened.folder(), owner.join("captures").join(name));
    assert_eq!(reopened.folder(), opened.folder());
    assert_eq!(through_link.folder(), opened.folder());
    let read = |arguments: &'static [&'static str]| {
        answer_in_git_folder(&git, opened.folder(), arguments, &[])
    };
    assert_eq!(
        read(&["rev-parse", "--show-object-format"])
            .await
            .as_deref(),
        Some("sha256")
    );
    assert_eq!(read(&["config", "gc.auto"]).await.as_deref(), Some("0"));
    assert_eq!(
        read(&["config", "maintenance.auto"]).await.as_deref(),
        Some("false")
    );
    assert_eq!(
        std::fs::read_dir(owner.join("captures"))
            .expect("the captures folder lists")
            .count(),
        1,
        "no folder being made is left beside it"
    );
}

// A snapshot written through the steps into a capture folder adds nothing to the repository's own
// objects or refs, and a call in the repository reads it once the folder is attached. Fails when
// a write keeps the repository's object folder, the ref goes to the repository, or the read leaves
// the folder unattached.
#[tokio::test]
async fn a_capture_writes_into_its_folder_and_leaves_the_repository_as_it_was() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = make_test_repository(&git, root.path(), "repository").await;
    let repository = real_path(&repository).expect("the repository resolves");
    // The person's signing setting would sign the snapshot commit.
    git_in(&git, &repository, &["config", "commit.gpgSign", "false"]).await;
    tokio::fs::write(repository.join("notes.txt"), "a note\n")
        .await
        .expect("the untracked file is written");
    let git_common_folder = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let capture_folder = CaptureFolder::open_or_create(
        &git,
        None,
        &CapturePacking::new(git.clone(), Arc::default()),
        &root.path().join("owner"),
        &git_common_folder,
    )
    .await
    .expect("the capture folder is made");
    let repository_objects = files_under(&git_common_folder.join("objects"));
    let checkout = SnapshotCheckout {
        git: &git,
        place: None,
        root: &repository,
        capture_folder: &capture_folder,
    };
    let scratch_index = root.path().join("scratch.index");
    let snapshot_ref = "refs/sidekicks/runs/test/epoch-0/turn-0";

    let base = checkout
        .resolve_base_commit()
        .await
        .expect("the base resolves")
        .expect("the repository has a commit");
    checkout
        .stage_listing(&scratch_index, b"notes.txt\0")
        .await
        .expect("the listing is staged");
    let tree = checkout
        .write_snapshot_tree(&scratch_index)
        .await
        .expect("the tree is written");
    let commit = checkout
        .commit_snapshot_tree(
            &tree,
            Some(&base),
            TURN_SNAPSHOT_SUBJECT,
            &[],
            None,
            &[],
            Timestamp::from_second(1_800_000_000).expect("the instant is in range"),
        )
        .await
        .expect("the snapshot is committed");
    let written = checkout
        .write_create_only_ref(snapshot_ref, &commit)
        .await
        .expect("the ref is written");

    assert_eq!(written, None);
    assert_eq!(
        files_under(&git_common_folder.join("objects")),
        repository_objects
    );
    assert_eq!(
        git_in(&git, &repository, &["for-each-ref", "refs/sidekicks/"]).await,
        ""
    );
    assert_eq!(
        answer_in_git_folder(
            &git,
            capture_folder.folder(),
            &["rev-parse", snapshot_ref],
            &[]
        )
        .await
        .as_deref(),
        Some(commit.as_str())
    );
    let attached = capture_folder.read_environment();
    let commit_type = answer_in_git_folder(
        &git,
        &git_common_folder,
        &["cat-file", "-t", commit.as_str()],
        &attached,
    )
    .await;
    assert_eq!(commit_type.as_deref(), Some("commit"));
}
