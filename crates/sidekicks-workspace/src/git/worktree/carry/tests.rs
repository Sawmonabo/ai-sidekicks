use std::path::Path;

use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;

use super::{carry_uncommitted_work, drop_carried_stash};
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};

async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str]) -> String {
    let output = git
        .run(None, GitCall::read(in_folder(folder, arguments)))
        .await
        .expect("git runs in the test repository");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

// A repository at `<scratch>/app` with `a.txt` and `b.txt` committed on `main`, and a linked tree
// at `<scratch>/tree` on a new branch `feature` cut from it.
async fn repository_with_tree(git: &GitRunner, scratch: &Path) {
    git_in(
        git,
        scratch,
        &["init", "--quiet", "--initial-branch=main", "app"],
    )
    .await;
    let repository = scratch.join("app");
    git_in(git, &repository, &["config", "user.name", "Test"]).await;
    git_in(
        git,
        &repository,
        &["config", "user.email", "test@example.invalid"],
    )
    .await;
    git_in(git, &repository, &["config", "commit.gpgSign", "false"]).await;
    std::fs::write(repository.join("a.txt"), "a\n").expect("a.txt is written");
    std::fs::write(repository.join("b.txt"), "b\n").expect("b.txt is written");
    git_in(git, &repository, &["add", "a.txt", "b.txt"]).await;
    git_in(git, &repository, &["commit", "--quiet", "-m", "start"]).await;
    let tree = scratch.join("tree");
    git_in(
        git,
        &repository,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "feature",
            &tree.to_string_lossy(),
        ],
    )
    .await;
}

// Staged, unstaged and untracked work in the checkout.
async fn make_work(git: &GitRunner, repository: &Path) {
    std::fs::write(repository.join("a.txt"), "a staged\n").expect("a.txt is changed");
    git_in(git, repository, &["add", "a.txt"]).await;
    std::fs::write(repository.join("b.txt"), "b unstaged\n").expect("b.txt is changed");
    std::fs::write(repository.join("c.txt"), "c untracked\n").expect("c.txt is written");
}

// Each stash's commit, newest first.
async fn stash_commits(git: &GitRunner, repository: &Path) -> Vec<String> {
    git_in(git, repository, &["stash", "list", "--format=%H"])
        .await
        .lines()
        .map(str::to_owned)
        .collect()
}

fn new_worktree_id() -> WorktreeId {
    WorktreeId::new(&mint_uuid_v7().to_string()).expect("a minted id is a worktree id")
}

// Kills: a match by `contains`, `pop` in place of `apply`, `--index` dropped, and a drop by the
// newest selector rather than the carried commit.
#[tokio::test]
async fn work_arrives_with_its_staged_set_and_its_stash_is_kept_until_dropped() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let git = test_git_runner();
    repository_with_tree(&git, scratch.path()).await;
    let repository = scratch.path().join("app");
    let tree = scratch.path().join("tree");
    let worktree_id = new_worktree_id();

    // An older stash whose subject holds the carry's message but does not end with it.
    std::fs::write(repository.join("b.txt"), "older\n").expect("b.txt is changed");
    let lookalike = format!("uncommitted work carried to a new worktree ({worktree_id}) earlier");
    git_in(
        &git,
        &repository,
        &["stash", "push", "--quiet", "--message", &lookalike],
    )
    .await;
    let lookalike_commit = stash_commits(&git, &repository).await;

    // Nothing to carry: no stash is made and the lookalike is not taken.
    let carried = carry_uncommitted_work(&git, None, &repository, &tree, &worktree_id)
        .await
        .expect("a carry with nothing to carry succeeds");
    assert_eq!(carried, None);
    assert_eq!(stash_commits(&git, &repository).await, lookalike_commit);

    make_work(&git, &repository).await;
    let carried = carry_uncommitted_work(&git, None, &repository, &tree, &worktree_id)
        .await
        .expect("the work is carried")
        .expect("there was work to carry");
    assert_eq!(
        git_in(&git, &tree, &["diff", "--cached", "--name-only"]).await,
        "a.txt\n"
    );
    assert_eq!(
        git_in(&git, &tree, &["diff", "--name-only"]).await,
        "b.txt\n"
    );
    assert_eq!(
        std::fs::read_to_string(tree.join("c.txt")).expect("the untracked file arrived"),
        "c untracked\n"
    );
    let mut kept = vec![carried.commit.clone()];
    kept.extend(lookalike_commit.iter().cloned());
    assert_eq!(stash_commits(&git, &repository).await, kept);

    // A stash pushed after the carry moves the carried one to `stash@{1}`.
    std::fs::write(repository.join("b.txt"), "later\n").expect("b.txt is changed");
    git_in(&git, &repository, &["stash", "push", "--quiet"]).await;
    let newer = stash_commits(&git, &repository).await[0].clone();
    drop_carried_stash(&git, None, &carried)
        .await
        .expect("the carried stash is dropped");
    let mut left = vec![newer];
    left.extend(lookalike_commit);
    assert_eq!(stash_commits(&git, &repository).await, left);
}

// Kills: the stash dropped or popped on a failed apply, and a recovery that names no commit.
#[tokio::test]
async fn a_failed_apply_keeps_the_stash_and_names_how_to_apply_it() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let git = test_git_runner();
    repository_with_tree(&git, scratch.path()).await;
    let repository = scratch.path().join("app");
    let tree = scratch.path().join("tree");
    make_work(&git, &repository).await;
    // The new tree already has the untracked file, so the apply refuses to overwrite it.
    std::fs::write(tree.join("c.txt"), "already here\n").expect("c.txt is written in the tree");

    let refusal = carry_uncommitted_work(&git, None, &repository, &tree, &new_worktree_id())
        .await
        .expect_err("the apply fails");

    let kept = stash_commits(&git, &repository).await;
    assert_eq!(kept.len(), 1);
    let WorktreeRefusal::CreateFailed {
        reason: WorktreeCreateFailureReason::CarryFailed { recovery },
        source: Some(_),
    } = refusal
    else {
        panic!("a failed apply is carryFailed with git's failure, not {refusal:?}");
    };
    assert!(
        recovery.contains(&format!("git stash apply --index {}", kept[0])),
        "the recovery names the kept stash's commit: {recovery}"
    );
}
