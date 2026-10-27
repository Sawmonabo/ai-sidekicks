//! Carrying a session's uncommitted work onto a new tree: stashed in the folder the session works
//! in, untracked files included, applied on the new tree with its staged set, and dropped only once
//! the session has adopted the new tree. Until then every failure keeps the stash and names the
//! command that recovers it.
//!
//! The stash is found again by its commit, never by its place in the list: `stash drop` takes only
//! a `stash@{n}` selector, which a stash pushed meanwhile moves, while `stash apply` takes the
//! commit itself.

use std::error::Error;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;

use crate::git::process::{GitCall, GitError, GitRunner, background_read, in_folder};
use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};
use crate::git::worktree::reads::{BRANCH_REF_PREFIX, read_current_branch};
use sidekicks_std::cleanup_failures::CleanupFailures;

const CARRY_STASH_MESSAGE: &str = "uncommitted work carried to a new worktree";

/// The stash a carry made, by its commit and the folder it was pushed in, kept until adoption.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CarriedStash {
    /// The stash's commit.
    pub(crate) commit: String,
    /// The folder the stash was pushed in, whose stash list holds it.
    pub(crate) folder: PathBuf,
}

/// How the person finds a kept stash: by its commit, or by its message when the commit could not
/// be read.
#[derive(Clone, Copy, Debug)]
pub(crate) enum KeptStash<'a> {
    /// The stash's commit.
    Commit(&'a str),
    /// The stash's message, as `git stash list` shows it.
    Message(&'a str),
}

/// Refuses the carry unless `base_ref` is the branch `folder` is on: the work was made against that
/// branch, so only a tree cut from it takes the work as it stands. Runs before any tree is made.
/// Fails with `createFailed`: `gitInvocationFailed` when the branch cannot be read,
/// `carryBaseMismatch` for another branch or a detached HEAD.
#[expect(
    dead_code,
    reason = "worktree creation carries the uncommitted work through it"
)]
pub(crate) async fn require_carry_onto_current_branch(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    base_ref: &str,
) -> Result<(), WorktreeRefusal> {
    let current_branch = read_current_branch(git, place, folder)
        .await
        .map_err(|failure| {
            create_failed(WorktreeCreateFailureReason::GitInvocationFailed, failure)
        })?;
    let base_branch = base_ref.strip_prefix(BRANCH_REF_PREFIX).unwrap_or(base_ref);
    // A detached HEAD is on no branch, so no base matches it.
    if current_branch.as_deref() != Some(base_branch) {
        return Err(WorktreeRefusal::CreateFailed {
            reason: WorktreeCreateFailureReason::CarryBaseMismatch,
            source: None,
        });
    }
    Ok(())
}

/// Stashes `from_folder`'s uncommitted work, untracked files included, and applies it on
/// `to_folder` with its staged set; the stash is kept. Nothing to carry is no stash and `None`.
/// The stash is found by a message naming `worktree_id`, so another stash pushed in the same
/// repository at the same moment is never taken for it. Fails with `createFailed`:
/// `gitInvocationFailed` when the push fails and left no stash, and `carryFailed`, naming the
/// command that recovers the kept stash, when a push that saved still fails, the stash cannot be
/// found again or the apply fails; the caller undoes the new tree.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "worktree creation carries the uncommitted work through it"
    )
)]
pub(crate) async fn carry_uncommitted_work(
    git: &GitRunner,
    place: Option<&Place>,
    from_folder: &Path,
    to_folder: &Path,
    worktree_id: &WorktreeId,
) -> Result<Option<CarriedStash>, WorktreeRefusal> {
    let message = format!("{CARRY_STASH_MESSAGE} ({worktree_id})");
    let subject_end = format!(": {message}");
    let is_carry_stash = |entry: &StashEntry| entry.subject.ends_with(&subject_end);
    let push = GitCall::write(in_folder(
        from_folder,
        &[
            "stash",
            "push",
            "--include-untracked",
            "--message",
            &message,
        ],
    ));
    if let Err(push_failure) = git.run(place, push).await {
        // A push can save the stash and still fail after, so a stash it left is named.
        return Err(
            match find_stash(git, place, from_folder, is_carry_stash).await {
                Ok(Some(left)) => kept_stash_failure(KeptStash::Commit(&left.commit), push_failure),
                Ok(None) => create_failed(
                    WorktreeCreateFailureReason::GitInvocationFailed,
                    push_failure,
                ),
                Err(lookup_failure) => create_failed(
                    WorktreeCreateFailureReason::GitInvocationFailed,
                    CleanupFailures::new(
                        push_failure,
                        vec![lookup_failure],
                        "carrying the uncommitted work",
                    ),
                ),
            },
        );
    }
    // The push took the work out of the folder, so a failure from here names the stash holding it.
    let stash = match find_stash(git, place, from_folder, is_carry_stash).await {
        Ok(Some(stash)) => stash,
        Ok(None) => return Ok(None),
        Err(lookup_failure) => {
            return Err(kept_stash_failure(
                KeptStash::Message(&message),
                lookup_failure,
            ));
        }
    };
    let apply = GitCall::write(in_folder(
        to_folder,
        &["stash", "apply", "--index", &stash.commit],
    ));
    if let Err(apply_failure) = git.run(place, apply).await {
        return Err(kept_stash_failure(
            KeptStash::Commit(&stash.commit),
            apply_failure,
        ));
    }
    Ok(Some(CarriedStash {
        commit: stash.commit,
        folder: from_folder.to_path_buf(),
    }))
}

/// The failure of a step after the carry's stash was pushed, carrying `failure` as its source:
/// `carryFailed`, its recovery naming the kept stash by its commit, or by its message when the
/// commit could not be read, and how to put it back.
pub(crate) fn kept_stash_failure(
    stash: KeptStash<'_>,
    failure: impl Error + Send + Sync + 'static,
) -> WorktreeRefusal {
    let recovery = match stash {
        KeptStash::Commit(commit) => {
            format!("`git stash apply --index {commit}` in the session's folder puts it back")
        }
        KeptStash::Message(message) => format!(
            "`git stash list` in the session's folder shows it as \"{message}\", and `git stash \
             apply --index` with that entry's `stash@{{n}}` puts it back"
        ),
    };
    create_failed(
        WorktreeCreateFailureReason::CarryFailed { recovery },
        failure,
    )
}

/// Drops the carry's stash, wherever another stash has pushed it in the list; a stash already gone
/// is nothing to drop. Fails with git's failure.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "worktree creation drops the stash once the session adopts the tree"
    )
)]
pub(crate) async fn drop_carried_stash(
    git: &GitRunner,
    place: Option<&Place>,
    stash: &CarriedStash,
) -> Result<(), GitError> {
    let entry = find_stash(git, place, &stash.folder, |listed| {
        listed.commit == stash.commit
    })
    .await?;
    if let Some(entry) = entry {
        let drop = GitCall::write(in_folder(
            &stash.folder,
            &["stash", "drop", &entry.selector],
        ));
        git.run(place, drop).await?;
    }
    Ok(())
}

// One entry of the stash list.
struct StashEntry {
    commit: String,
    // `stash@{n}`, its place in the list now.
    selector: String,
    // The reflog subject, `On <branch>: <message>`.
    subject: String,
}

// The first stash entry `matches` accepts, or `None`; a repository with no stash has none.
async fn find_stash(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    matches: impl Fn(&StashEntry) -> bool,
) -> Result<Option<StashEntry>, GitError> {
    let listing = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["stash", "list", "-z", "--format=%H%x00%gd%x00%gs"],
            )),
        )
        .await?;
    let listing = String::from_utf8_lossy(&listing.stdout);
    // Each entry is three NUL-ended fields, the last ended by the entry's own NUL.
    let fields: Vec<&str> = listing.split('\0').collect();
    Ok(fields
        .as_chunks::<3>()
        .0
        .iter()
        .map(|[commit, selector, subject]| StashEntry {
            commit: commit.trim().to_owned(),
            selector: (*selector).to_owned(),
            subject: (*subject).to_owned(),
        })
        .find(|entry| matches(entry)))
}

fn create_failed(
    reason: WorktreeCreateFailureReason,
    failure: impl Error + Send + Sync + 'static,
) -> WorktreeRefusal {
    WorktreeRefusal::CreateFailed {
        reason,
        source: Some(Box::new(failure)),
    }
}

#[cfg(test)]
mod tests;
