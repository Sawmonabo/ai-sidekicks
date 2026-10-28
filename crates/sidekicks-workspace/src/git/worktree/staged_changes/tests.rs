use std::path::Path;

use sidekicks_platforms::real_path;

use super::StagedChangesWorktrees;
use crate::git::process::test_git_runner;
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::worktree::reads::{LINKED_RECORDS_FOLDER_NAME, read_record_git_file};

// The `.git` files the repository's linked records name, sorted.
async fn recorded_git_files(repository: &Path) -> Vec<std::path::PathBuf> {
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
