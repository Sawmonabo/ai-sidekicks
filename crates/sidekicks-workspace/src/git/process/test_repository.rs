//! Git in a test's scratch repository: running a call there and making a repository with one
//! commit.

use std::path::{Path, PathBuf};

use super::{GitCall, GitRunner, in_folder};

/// Runs git with `arguments` in `folder` and answers what it printed, trimmed. Panics when git
/// fails.
pub(crate) async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str]) -> String {
    let output = git
        .run(None, GitCall::read(in_folder(folder, arguments)))
        .await
        .expect("git runs in the test repository");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Makes the repository `name` in `parent` on branch `main`, with the test's author in its config
/// and one empty commit, and answers its folder. Panics when git fails.
pub(crate) async fn make_test_repository(git: &GitRunner, parent: &Path, name: &str) -> PathBuf {
    git_in(
        git,
        parent,
        &["init", "--quiet", "--initial-branch=main", name],
    )
    .await;
    let repository = parent.join(name);
    git_in(git, &repository, &["config", "user.name", "Test"]).await;
    git_in(
        git,
        &repository,
        &["config", "user.email", "test@example.invalid"],
    )
    .await;
    commit_empty(git, &repository, "start").await;
    repository
}

/// Commits what is staged in `folder` with `message`, unsigned, even when nothing is. Panics when
/// git fails.
pub(crate) async fn commit_empty(git: &GitRunner, folder: &Path, message: &str) {
    git_in(
        git,
        folder,
        &[
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            message,
        ],
    )
    .await;
}
