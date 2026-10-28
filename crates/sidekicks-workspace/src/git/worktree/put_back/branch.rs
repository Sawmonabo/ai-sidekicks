//! Which branch a kept tree goes back on: its own while it still points at the recorded commit
//! (in a rebase, the recorded `orig-head`), no tree git lists has it checked out but the kept
//! copy's own stale record, and no live row or other put-back claims it; otherwise a new numbered
//! `<branch>-restored` at the recorded commit.

use std::io;
use std::path::Path;

use sidekicks_contracts::worktree::lifecycle::RemovedWorktreeId;
use sidekicks_std::settle_all::{SettleFailures, settle_all};

use super::{PutBackBranchChoice, PutBackTools};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::GitError;
use crate::git::worktree::claims::KeptCopyClaimsReadError;
use crate::git::worktree::kept_copy::KEPT_RECORD_ENTRY;
use crate::git::worktree::kept_copy::pins::{KeptPin, pick_pins, pin_ref_names};
use crate::git::worktree::kept_copy::saved_state::{SavedStateError, read_rebase_folder};
use crate::git::worktree::reads::{BRANCH_REF_PREFIX, read_ref_heads};
use crate::git::worktree::stale_record::{StaleRecordError, remove_stale_record_and_refs};

/// The kept copy whose branch a put-back chooses, as its row records it.
#[derive(Clone, Copy)]
pub(crate) struct PutBackBranchInput<'a> {
    /// The kept copy, whose id names its pins.
    pub(crate) removed_worktree_id: &'a RemovedWorktreeId,
    /// The branch the kept HEAD names, or in a rebase the one being rebased; else the tree's own.
    pub(crate) branch: &'a str,
    /// Whether `branch` is the one the kept HEAD names; `false` for a detached HEAD.
    pub(crate) is_on_branch: bool,
    /// The kept copy's folder.
    pub(crate) kept_folder: &'a Path,
    /// Git's record of the tree as git named it at the discard.
    pub(crate) record_folder: &'a Path,
    /// Where the tree lived.
    pub(crate) original_path: &'a Path,
    /// The repository's main checkout, which holds the pins and the branches.
    pub(crate) canonical_root: &'a Path,
    /// The repository's git common folder, in which a live tree or a put-back claims a branch.
    pub(crate) common_folder: &'a Path,
}

/// One read of a branch choice that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BranchChoiceStepError {
    /// The pins and the branch could not be read.
    #[error("the kept worktree's pins and branch could not be read")]
    Refs(#[source] GitError),
    /// Whether the kept tree was rebasing could not be read.
    #[error(transparent)]
    Rebase(SavedStateError),
    /// The tree's old record could not be cleared.
    #[error(transparent)]
    StaleRecord(StaleRecordError),
}

/// Why a put-back's branch could not be chosen.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BranchChoiceError {
    /// A read beside the choice failed.
    #[error(transparent)]
    Steps(#[from] SettleFailures<BranchChoiceStepError>),
    /// The pin of the commit the tree stood on is gone.
    #[error("kept worktree {removed_worktree_id} lost the pin of the commit it stood on")]
    LostPin {
        /// The kept copy.
        removed_worktree_id: RemovedWorktreeId,
    },
    /// A folder could not be resolved to compare it.
    #[error("a tree's folder could not be resolved to compare it")]
    Resolve(#[source] io::Error),
    /// What live trees and put-backs claim could not be read.
    #[error(transparent)]
    Claims(#[from] KeptCopyClaimsReadError),
}

/// Chooses whether a kept tree goes back on its own branch or a new one at the recorded commit, as
/// this module describes, removing the tree's old record beside the read when it is still the kept
/// copy's own, so git never counts it a duplicate of the tree put back. Fails with
/// [`BranchChoiceError::LostPin`] when the recorded commit's pin is gone, and as each read does.
pub(crate) async fn choose_put_back_branch(
    tools: PutBackTools<'_>,
    kept: PutBackBranchInput<'_>,
) -> Result<PutBackBranchChoice, BranchChoiceError> {
    let own_ref = format!("{BRANCH_REF_PREFIX}{}", kept.branch);
    let mut ref_names = pin_ref_names(kept.removed_worktree_id);
    if kept.is_on_branch {
        ref_names.push(own_ref.clone());
    }
    let ref_name_refs: Vec<&str> = ref_names.iter().map(String::as_str).collect();
    let kept_record = kept.kept_folder.join(KEPT_RECORD_ENTRY);
    let (refs, rebase_folder, is_stale_record_removed) = settle_all(
        tokio::join!(
            async {
                read_ref_heads(
                    tools.git(),
                    tools.place(),
                    kept.canonical_root,
                    &ref_name_refs,
                )
                .await
                .map_err(BranchChoiceStepError::Refs)
            },
            async {
                read_rebase_folder(&kept_record)
                    .await
                    .map_err(BranchChoiceStepError::Rebase)
            },
            async {
                remove_stale_record_and_refs(
                    tools.stale_record(),
                    tools.git(),
                    tools.place(),
                    kept.kept_folder,
                    kept.record_folder,
                    kept.original_path,
                )
                .await
                .map_err(BranchChoiceStepError::StaleRecord)
            },
        ),
        "reading the kept worktree",
    )?;
    if !kept.is_on_branch {
        return Ok(PutBackBranchChoice::OwnBranch);
    }
    let pins = pick_pins(&refs, kept.removed_worktree_id);
    let recorded_pin = if rebase_folder.is_some() {
        KeptPin::RebaseOrigHead
    } else {
        KeptPin::Head
    };
    let Some(recorded_commit) = pins.commit(recorded_pin).cloned() else {
        return Err(BranchChoiceError::LostPin {
            removed_worktree_id: *kept.removed_worktree_id,
        });
    };
    let own_head = refs.get(&own_ref);
    let holder = own_head.and_then(|head| head.checked_out_at.as_deref());
    // The removed record named the tree's old folder, so a branch only it held is free.
    let is_held_by_removed_record = match holder {
        Some(holder) if is_stale_record_removed => {
            canonical_folder_path(holder)
                .await
                .map_err(BranchChoiceError::Resolve)?
                == canonical_folder_path(kept.original_path)
                    .await
                    .map_err(BranchChoiceError::Resolve)?
        }
        Some(_) | None => false,
    };
    let is_own_branch_free = own_head.is_some_and(|head| head.commit == recorded_commit.as_str())
        && (holder.is_none() || is_held_by_removed_record);
    // A live tree's row on the branch holds it too, though git no longer reads that tree.
    if is_own_branch_free
        && !tools
            .claims
            .is_branch_claimed(kept.branch, kept.common_folder, kept.record_folder)
            .await?
    {
        return Ok(PutBackBranchChoice::OwnBranch);
    }
    Ok(PutBackBranchChoice::NewBranchAt(recorded_commit))
}
