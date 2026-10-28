use std::path::{Path, PathBuf};

use sidekicks_platforms::real_path;

use super::StagedChangesWorktrees;
use crate::git::process::test_git_runner;
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::worktree::reads::{LINKED_RECORDS_FOLDER_NAME, read_record_git_file};

// The `.git` files the repository's linked records name, sorted.
async fn recorded_git_files(repository: &Path) -> Vec<PathBuf> {
    let records = repository.join(".git").join(LINKED_RECORDS_FOLDER_NAME);
    let mut named = Vec::new();
    let mut entries = tokio::fs::read_dir(&records)
        .await
        .expect("the records are listed");
    while let Some(entry) = entries.next_entry().await.expect("a record is read") {
        if let Some(git_file) = read_record_git_file(&entry.path())
            .await
            .expect("a record's gitdir is read")
        {
            named.push(git_file);
        }
    }
    named.sort();
    named
}

// A repository-wide prune would drop the sibling's record, whose folder is missing. Kills a prune
// put back in the close or the sweep, and a removal that skips a locked record.
#[tokio::test]
async fn a_close_and_a_sweep_remove_only_the_review_trees_records() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let scratch_path = real_path(scratch.path()).expect("the scratch folder resolves");
    let git = test_git_runner();
    let repository = make_test_repository(&git, &scratch_path, "app").await;
    let sibling = scratch_path.join("sibling");
    git_in(
        &git,
        &repository,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "sibling",
            &sibling.to_string_lossy(),
        ],
    )
    .await;
    tokio::fs::remove_dir_all(&sibling)
        .await
        .expect("the sibling's folder goes missing");
    let sibling_git_file = vec![sibling.join(".git")];
    let worktrees = StagedChangesWorktrees::new(&scratch_path.join("worktrees"), git.clone());

    let closed = worktrees
        .open_staged_worktree(None, &repository)
        .await
        .expect("a review tree opens");
    closed.close().await.expect("the review tree closes");
    assert_eq!(recorded_git_files(&repository).await, sibling_git_file);

    let left = worktrees
        .open_staged_worktree(None, &repository)
        .await
        .expect("a review tree opens");
    git_in(
        &git,
        &repository,
        &["worktree", "lock", &left.folder().to_string_lossy()],
    )
    .await;
    // Dropped unclosed, as a stopped daemon leaves it.
    drop(left);
    let failures = worktrees.sweep_left_worktrees().await;
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(recorded_git_files(&repository).await, sibling_git_file);
}

// A daemon ended mid-`worktree add` leaves a tree with no `.git` and its record locked. Kills a
// sweep that finds the repository only through the tree's `.git`.
#[tokio::test]
async fn a_sweep_removes_the_locked_record_of_a_tree_left_without_its_git_file() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let scratch_path = real_path(scratch.path()).expect("the scratch folder resolves");
    let git = test_git_runner();
    let repository = make_test_repository(&git, &scratch_path, "app").await;
    let worktrees_folder = scratch_path.join("worktrees");
    let worktrees = StagedChangesWorktrees::new(&worktrees_folder, git.clone());
    let left = worktrees
        .open_staged_worktree(None, &repository)
        .await
        .expect("a review tree opens");
    let record = git_in(
        &git,
        left.folder(),
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    )
    .await;
    tokio::fs::write(Path::new(&record).join("locked"), "initializing\n")
        .await
        .expect("the record is locked");
    tokio::fs::remove_file(left.folder().join(".git"))
        .await
        .expect("the tree's .git is removed");
    drop(left);

    let failures = worktrees.sweep_left_worktrees().await;

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(recorded_git_files(&repository).await, Vec::<PathBuf>::new());
    assert!(!Path::new(&record).exists(), "the locked record is left");
    let mut staged = tokio::fs::read_dir(worktrees_folder.join(".staged-changes"))
        .await
        .expect("the staged-changes folder is listed");
    assert!(
        staged
            .next_entry()
            .await
            .expect("an entry is read")
            .is_none(),
        "the left tree's folder is left"
    );
}
