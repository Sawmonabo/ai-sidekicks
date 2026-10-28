//! Undoing a put-back from its mark, so the kept copy stands whole again: the tree's placement and
//! the put-back's own record settle together, then its own branch goes. Only what the put-back
//! made is undone: a record a later tree took, a branch moved, held or claimed since, and a folder
//! holding no copy of the kept tree are left as they are.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};

use super::{PutBackBranch, PutBackMark, PutBackTools};
use crate::git::process::{GitCall, GitError, in_folder};
use crate::git::worktree::claims::KeptCopyClaimsReadError;
use crate::git::worktree::kept_copy::folder_move::{
    FolderMoveError, LeftoverRemovalError, move_folder, remove_folder_as_leftover,
};
use crate::git::worktree::kept_copy::saved_state::{RepositoryStoreSettings, SavedStateError};
use crate::git::worktree::kept_copy::{KEPT_TREE_ENTRY, RowWriteError};
use crate::git::worktree::reads::{
    BRANCH_REF_PREFIX, GIT_FILE_NAME, LINKED_RECORDS_FOLDER_NAME, common_folder_of_record,
    read_ref_heads,
};
use crate::git::worktree::service::remove_folder;
use crate::git::worktree::stale_record::{
    StaleRecordError, is_record_named_by, is_same_git_file, read_named_git_file,
};

/// One step of undoing a put-back that failed; the mark stays for the next try.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PutBackUndoError {
    /// A file or folder could not be read or removed.
    #[error("{} could not be read or removed", path.display())]
    File {
        /// The entry.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// The tree could not be moved back into the kept folder.
    #[error("the put-back's tree could not be moved back")]
    Move(#[source] FolderMoveError),
    /// The put-back's copy of the tree could not be removed.
    #[error("the put-back's copy of the tree could not be removed")]
    Leftover(#[source] LeftoverRemovalError),
    /// The tree is neither in the kept folder nor where it went.
    #[error("the put-back's tree is neither in {} nor where it went", kept_folder.display())]
    TreeLost {
        /// The kept copy's folder.
        kept_folder: PathBuf,
    },
    /// The stored record folder is no worktree record, so nothing is removed there.
    #[error(
        "the put-back's stored record folder {} is not a worktree record",
        record_folder.display()
    )]
    NotARecord {
        /// The stored record folder.
        record_folder: PathBuf,
    },
    /// The record or the tree's `.git` could not be read to compare it.
    #[error(transparent)]
    Record(StaleRecordError),
    /// Where the repository keeps its refs could not be read.
    #[error(transparent)]
    StoreSettings(SavedStateError),
    /// What live trees and put-backs claim could not be read.
    #[error(transparent)]
    Claims(KeptCopyClaimsReadError),
    /// git could not read or delete the put-back's branch.
    #[error("git could not read or delete the put-back's branch")]
    Branch(#[source] GitError),
    /// The mark could not be cleared once everything was undone.
    #[error("the put-back's mark could not be cleared")]
    ClearMark(#[source] RowWriteError),
}

fn at(path: &Path) -> impl FnOnce(io::Error) -> PutBackUndoError {
    let path = path.to_path_buf();
    move |source| PutBackUndoError::File { path, source }
}

/// Undoes the put-back `mark` names: the tree's placement and the put-back's own record together,
/// then its own branch, reporting a copy back as `copy`. Fails with every step's failure once all
/// have settled.
pub(crate) async fn undo_put_back(
    tools: PutBackTools<'_>,
    mark: &PutBackMark,
    copy: &WorktreeCopy,
) -> Result<(), SettleFailures<PutBackUndoError>> {
    settle_all(
        tokio::join!(
            undo_tree_placement(tools, mark, copy),
            remove_own_record(tools, mark)
        ),
        "undoing the put-back",
    )?;
    if let Some(branch) = &mark.new_branch {
        delete_own_branch(tools, &mark.record_folder, branch)
            .await
            .map_err(SettleFailures::One)?;
    }
    Ok(())
}

// Puts the tree back in the kept folder, or removes the put-back's own copy of it.
async fn undo_tree_placement(
    tools: PutBackTools<'_>,
    mark: &PutBackMark,
    copy: &WorktreeCopy,
) -> Result<(), PutBackUndoError> {
    let kept_tree = mark.kept_folder.join(KEPT_TREE_ENTRY);
    let target = &mark.target_folder;
    let (has_kept_tree, has_target) = tokio::join!(
        tokio::fs::try_exists(&kept_tree),
        tokio::fs::try_exists(target)
    );
    let has_kept_tree = has_kept_tree.map_err(at(&kept_tree))?;
    match (has_target.map_err(at(target))?, has_kept_tree) {
        (true, true) => {
            // The tree never moved, so the folder is the empty one that took the name.
            let mut entries = tokio::fs::read_dir(target).await.map_err(at(target))?;
            if entries.next_entry().await.map_err(at(target))?.is_none() {
                return tokio::fs::remove_dir(target).await.map_err(at(target));
            }
            // The kept tree is whole, so only the put-back's own copy goes: it carries the kept
            // tree's `.git` file or the one the put-back wrote, which names the put-back's record.
            let target_git_file = target.join(GIT_FILE_NAME);
            let kept_git_file = kept_tree.join(GIT_FILE_NAME);
            let (target_git_text, kept_git_text) = tokio::join!(
                tokio::fs::read(&target_git_file),
                tokio::fs::read(&kept_git_file)
            );
            let target_git_text = target_git_text
                .none_if_missing()
                .map_err(at(&target_git_file))?;
            let kept_git_text = kept_git_text
                .none_if_missing()
                .map_err(at(&kept_git_file))?;
            if target_git_text == kept_git_text
                || is_record_named_by(&target_git_file, &mark.record_folder)
                    .await
                    .map_err(PutBackUndoError::Record)?
            {
                return remove_folder_as_leftover(tools.kept.folder_moves.names_in_use, target)
                    .await
                    .map_err(PutBackUndoError::Leftover);
            }
            tracing::warn!(
                kept_folder = %mark.kept_folder.display(),
                target_folder = %target.display(),
                "the put-back's folder holds no copy of the kept tree, so it is left as it is; \
                 the kept tree is whole"
            );
            Ok(())
        }
        (true, false) => move_folder(tools.kept.folder_moves, target, &kept_tree, copy.clone())
            .await
            .map_err(PutBackUndoError::Move),
        (false, false) => Err(PutBackUndoError::TreeLost {
            kept_folder: mark.kept_folder.clone(),
        }),
        (false, true) => Ok(()),
    }
}

// Removes the put-back's record, with the refs a repository keeps apart under its name. The record
// is the put-back's own only while it names the put-back's tree or nothing yet; one a later tree
// took after an earlier undo removed it is left alone.
async fn remove_own_record(
    tools: PutBackTools<'_>,
    mark: &PutBackMark,
) -> Result<(), PutBackUndoError> {
    let record = &mark.record_folder;
    // The stored folder comes from the database, so a recursive delete reaches only a record.
    let common_folder = common_folder_of_record(record).filter(|_| {
        record.is_absolute()
            && record.parent().and_then(Path::file_name)
                == Some(OsStr::new(LINKED_RECORDS_FOLDER_NAME))
    });
    let (Some(common_folder), Some(record_name)) = (common_folder, record.file_name()) else {
        return Err(PutBackUndoError::NotARecord {
            record_folder: record.clone(),
        });
    };
    let named_git_file = read_named_git_file(record)
        .await
        .map_err(PutBackUndoError::Record)?;
    let target_git_file = mark.target_folder.join(GIT_FILE_NAME);
    if named_git_file.is_some()
        && !is_same_git_file(named_git_file.as_deref(), Some(target_git_file.as_path()))
            .await
            .map_err(PutBackUndoError::Record)?
    {
        return Ok(());
    }
    let store_settings = RepositoryStoreSettings::read(tools.git(), tools.place(), common_folder)
        .await
        .map_err(PutBackUndoError::StoreSettings)?;
    let refs_folder = store_settings
        .ref_store_payload(common_folder)
        .map(|payload| payload.tree_refs_folder(&record_name.to_string_lossy()));
    for folder in [Some(record.clone()), refs_folder].into_iter().flatten() {
        remove_folder(&folder).await.map_err(at(&folder))?;
    }
    Ok(())
}

// Runs once the put-back's record is gone, so a tree git still lists on the branch is another's.
// By its ref, at the commit it was made at: a branch moved since is someone's work, and one a live
// tree's row or another put-back's mark names in this repository is that tree's.
async fn delete_own_branch(
    tools: PutBackTools<'_>,
    record_folder: &Path,
    branch: &PutBackBranch,
) -> Result<(), PutBackUndoError> {
    let common_folder = common_folder_of_record(record_folder)
        .expect("the record was checked to sit in the folder of records before its removal");
    if is_branch_claimed(tools, branch, common_folder, record_folder).await? {
        return Ok(());
    }
    let branch_ref = format!("{BRANCH_REF_PREFIX}{}", branch.name);
    let heads = read_ref_heads(
        tools.git(),
        tools.place(),
        common_folder,
        &[branch_ref.as_str()],
    )
    .await
    .map_err(PutBackUndoError::Branch)?;
    let is_unmoved_and_unheld = heads
        .get(&branch_ref)
        .is_some_and(|head| head.commit == branch.commit.as_str() && head.checked_out_at.is_none());
    // Read again just before the delete, so a put-back that marked the branch since keeps it.
    if !is_unmoved_and_unheld
        || is_branch_claimed(tools, branch, common_folder, record_folder).await?
    {
        return Ok(());
    }
    tools
        .git()
        .run(
            tools.place(),
            GitCall::write(in_folder(
                common_folder,
                &[
                    "update-ref",
                    "-d",
                    branch_ref.as_str(),
                    branch.commit.as_str(),
                ],
            )),
        )
        .await
        .map_err(PutBackUndoError::Branch)?;
    Ok(())
}

// Whether a live tree's row or another put-back's mark claims `branch` in the repository whose git
// common folder is `common_folder`.
async fn is_branch_claimed(
    tools: PutBackTools<'_>,
    branch: &PutBackBranch,
    common_folder: &Path,
    record_folder: &Path,
) -> Result<bool, PutBackUndoError> {
    tools
        .claims
        .is_branch_claimed(&branch.name, common_folder, record_folder)
        .await
        .map_err(PutBackUndoError::Claims)
}
