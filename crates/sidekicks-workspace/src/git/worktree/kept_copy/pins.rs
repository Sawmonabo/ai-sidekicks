//! A kept copy's pins: the commits its saved state names, kept as refs under
//! `refs/sidekicks/removed/<removed id>/`, which `git gc` keeps. They are written and deleted in
//! one ref transaction each, as the daemon's own refs, so no hook of the repository runs.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::worktree::lifecycle::RemovedWorktreeId;

use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::worktree::reads::{RefHead, read_ref_heads};

/// Where a kept copy's pins live, each under `<prefix>/<removed id>/<pin>`.
const PIN_REF_PREFIX: &str = "refs/sidekicks/removed";

/// One commit a kept copy pins, by the name its ref takes under the copy's prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeptPin {
    /// HEAD's commit.
    Head,
    /// `ORIG_HEAD`'s commit.
    OrigHead,
    /// A merge's first `MERGE_HEAD`.
    MergeHead,
    /// The commit a rebase goes onto.
    RebaseOnto,
    /// The commit a rebase started from, which its branch named.
    RebaseOrigHead,
}

impl KeptPin {
    /// Every pin, in the order its refs are written.
    pub(crate) const ALL: [Self; 5] = [
        Self::Head,
        Self::OrigHead,
        Self::MergeHead,
        Self::RebaseOnto,
        Self::RebaseOrigHead,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Head => "head",
            Self::OrigHead => "orig-head",
            Self::MergeHead => "merge-head",
            Self::RebaseOnto => "rebase-onto",
            Self::RebaseOrigHead => "rebase-orig-head",
        }
    }

    /// The full name of this pin's ref for the kept copy `removed_worktree_id`.
    pub(crate) fn ref_name(self, removed_worktree_id: &RemovedWorktreeId) -> String {
        format!(
            "{PIN_REF_PREFIX}/{}/{}",
            removed_worktree_id.text().as_str(),
            self.name()
        )
    }
}

/// The commits a kept copy pins, by pin.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct KeptWorktreePins {
    commits: [Option<GitObjectId>; KeptPin::ALL.len()],
}

impl KeptWorktreePins {
    /// The commit `pin` names, when the copy pins one.
    pub(crate) fn commit(&self, pin: KeptPin) -> Option<&GitObjectId> {
        self.commits[pin as usize].as_ref()
    }

    /// Sets the commit `pin` names, `None` for no pin.
    pub(crate) fn set(&mut self, pin: KeptPin, commit: Option<GitObjectId>) {
        self.commits[pin as usize] = commit;
    }
}

/// The full names of every pin ref the kept copy `removed_worktree_id` may have, for one read.
pub(crate) fn pin_ref_names(removed_worktree_id: &RemovedWorktreeId) -> Vec<String> {
    KeptPin::ALL
        .iter()
        .map(|pin| pin.ref_name(removed_worktree_id))
        .collect()
}

/// The pinned commits of the kept copy `removed_worktree_id`, picked from refs read by their full
/// names; a ref naming no object id is no pin.
pub(crate) fn pick_pins(
    refs: &HashMap<String, RefHead>,
    removed_worktree_id: &RemovedWorktreeId,
) -> KeptWorktreePins {
    let mut pins = KeptWorktreePins::default();
    for pin in KeptPin::ALL {
        let commit = refs
            .get(&pin.ref_name(removed_worktree_id))
            .and_then(|head| GitObjectId::new(head.commit.clone()));
        pins.set(pin, commit);
    }
    pins
}

/// Writes `pins` as the kept copy's refs in the repository whose git common folder is
/// `common_folder`, in one transaction, so every pin lands or none does, with no hook run. Fails
/// with git's failure.
pub(crate) async fn write_pins(
    git: &GitRunner,
    place: Option<&Place>,
    common_folder: &Path,
    removed_worktree_id: &RemovedWorktreeId,
    pins: &KeptWorktreePins,
) -> Result<(), GitError> {
    let commands: Vec<String> = KeptPin::ALL
        .iter()
        .filter_map(|pin| {
            pins.commit(*pin).map(|commit| {
                format!(
                    "create {} {}",
                    pin.ref_name(removed_worktree_id),
                    commit.as_str()
                )
            })
        })
        .collect();
    run_ref_transaction(git, place, common_folder, &commands).await
}

/// Deletes every pin of the kept copy `removed_worktree_id` in the repository whose git common
/// folder is `common_folder`, in one transaction with no hook run, each at the commit read just
/// before; a pin already gone is left out, so a second call finishes one that failed part way.
/// Fails with git's failure.
pub(crate) async fn delete_pins(
    git: &GitRunner,
    place: Option<&Place>,
    common_folder: &Path,
    removed_worktree_id: &RemovedWorktreeId,
) -> Result<(), GitError> {
    let names = pin_ref_names(removed_worktree_id);
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let present = read_ref_heads(git, place, common_folder, &name_refs).await?;
    let commands: Vec<String> = names
        .iter()
        .filter_map(|name| {
            present
                .get(name)
                .map(|head| format!("delete {name} {}", head.commit))
        })
        .collect();
    run_ref_transaction(git, place, common_folder, &commands).await
}

// One `update-ref --stdin` transaction of `commands` in the git folder `common_folder`, the
// daemon's own refs written with no hook; none is run for no commands.
async fn run_ref_transaction(
    git: &GitRunner,
    place: Option<&Place>,
    common_folder: &Path,
    commands: &[String],
) -> Result<(), GitError> {
    if commands.is_empty() {
        return Ok(());
    }
    let input = format!("start\n{}\nprepare\ncommit\n", commands.join("\n"));
    let arguments: Vec<OsString> = vec![
        "--git-dir".into(),
        common_folder.as_os_str().to_owned(),
        "update-ref".into(),
        "--no-deref".into(),
        "--stdin".into(),
    ];
    git.run(
        place,
        GitCall::private_ref_write(arguments).with_input(input.into_bytes()),
    )
    .await?;
    Ok(())
}
