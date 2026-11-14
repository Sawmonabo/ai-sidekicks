use std::time::{Duration, SystemTime};

use rstest::rstest;

use super::read_ref_state;
use crate::git::process::test_repository::{commit_empty, git_in};
use crate::git::process::{read_git_common_folder, test_git_runner};
use crate::git::turn_snapshot::repack::CaptureFolderPass;
use crate::git::turn_snapshot::repack::object_folders::read_object_folder_state;

// A read well after the last ref write, outside the window in which a later write could keep the
// facts it read.
const SETTLED_READ_DELAY: Duration = Duration::from_secs(3);

// What the test does to the repository between the two reads.
#[derive(Clone, Copy, Debug)]
enum RefChange {
    Nothing,
    BranchDeleted,
    PackedBranchDeleted,
    LinkedHeadMoved,
    LinkedWorktreeRemoved,
    LinkedBisectRefAdded,
    ReadRightAfterAWrite,
}

// The sweep skips a folder only when the repository's refs read as its last pass left them. Fails
// when the skip reads `HEAD` alone, when `packed-refs`, `reftable/tables.list`, the `worktrees`
// folder or a linked worktree's own refs are left out of the read, or when a pass read within the
// coarsest time precision of a write is trusted.
#[rstest]
#[case::unchanged(RefChange::Nothing, true)]
#[case::a_loose_branch_deleted(RefChange::BranchDeleted, false)]
#[case::a_packed_branch_deleted(RefChange::PackedBranchDeleted, false)]
#[case::a_linked_head_moved(RefChange::LinkedHeadMoved, false)]
#[case::a_linked_worktree_removed(RefChange::LinkedWorktreeRemoved, false)]
#[case::a_linked_bisect_ref_added(RefChange::LinkedBisectRefAdded, false)]
#[case::a_read_right_after_a_write(RefChange::ReadRightAfterAWrite, false)]
#[tokio::test]
async fn a_pass_reads_unchanged_only_when_no_ref_of_any_worktree_moved(
    #[values("files", "reftable")] ref_format: &str,
    #[case] change: RefChange,
    #[case] is_unchanged: bool,
) {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let format = format!("--ref-format={ref_format}");
    git_in(
        &git,
        root.path(),
        &[
            "init",
            "--quiet",
            &format,
            "--initial-branch=main",
            "repository",
        ],
    )
    .await;
    let repository = root.path().join("repository");
    git_in(&git, &repository, &["config", "user.name", "Test"]).await;
    git_in(
        &git,
        &repository,
        &["config", "user.email", "test@example.invalid"],
    )
    .await;
    commit_empty(&git, &repository, "first").await;
    commit_empty(&git, &repository, "second").await;
    git_in(&git, &repository, &["branch", "other"]).await;
    let linked = root.path().join("linked");
    let linked_text = linked
        .to_str()
        .expect("the temporary folder's path is UTF-8");
    git_in(
        &git,
        &repository,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked_text,
            "HEAD",
        ],
    )
    .await;
    if matches!(change, RefChange::PackedBranchDeleted) {
        git_in(&git, &repository, &["pack-refs", "--all"]).await;
    }
    let common = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let read_at = match change {
        RefChange::ReadRightAfterAWrite => SystemTime::now(),
        RefChange::Nothing
        | RefChange::BranchDeleted
        | RefChange::PackedBranchDeleted
        | RefChange::LinkedHeadMoved
        | RefChange::LinkedWorktreeRemoved
        | RefChange::LinkedBisectRefAdded => SystemTime::now() + SETTLED_READ_DELAY,
    };
    let pass = CaptureFolderPass {
        ref_state: read_ref_state(&common).expect("the refs' facts are read"),
        object_folders: read_object_folder_state(&common.join("objects"))
            .expect("the object folders' facts are read"),
        counted_packs: None,
        read_at,
    };

    match change {
        RefChange::Nothing | RefChange::ReadRightAfterAWrite => {}
        RefChange::BranchDeleted | RefChange::PackedBranchDeleted => {
            git_in(&git, &repository, &["branch", "--quiet", "-D", "other"]).await;
        }
        RefChange::LinkedHeadMoved => {
            git_in(
                &git,
                &linked,
                &["checkout", "--quiet", "--detach", "HEAD~1"],
            )
            .await;
        }
        RefChange::LinkedWorktreeRemoved => {
            git_in(&git, &repository, &["worktree", "remove", linked_text]).await;
        }
        RefChange::LinkedBisectRefAdded => {
            git_in(&git, &linked, &["update-ref", "refs/bisect/bad", "HEAD"]).await;
        }
    }
    let current = read_ref_state(&common).expect("the refs' facts are read");

    assert_eq!(pass.is_unchanged_by(&current), is_unchanged);
}
