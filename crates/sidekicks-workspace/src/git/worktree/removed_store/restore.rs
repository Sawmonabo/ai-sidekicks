//! Putting a kept worktree back, under the kept copy's lock: a put-back of the copy a crash cut
//! short is undone first; then the refusals, the branch choice, the tree put back at a free name,
//! and the tree recorded with `worktree.created` naming the kept copy in the write that links the
//! copy to it and clears its mark. The press answers once that write has committed; a failure
//! undoes every step. What is left of the copy is deleted after the answer, in the background.

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};
use sidekicks_contracts::worktree::removed::{WorktreeRestoreRefusal, WorktreeRestoreResponse};
use sidekicks_std::cleanup_failures::CleanupFailures;

use super::rows::{
    KeptCopyMount, RemovedWorktreeRow, clear_put_back_mark_statement, mark_put_back_statement,
    mark_restored_statement, query_is_uncleaned_retired_at, query_project_mount,
};
use super::{RemovedWorktreeStore, RemovedWorktreeStoreError, put_back_copy};
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::kept_copy::held_work::{HeldWorkSubject, log_landed_late};
use crate::git::worktree::kept_copy::{KEPT_TREE_ENTRY, RowWriteError};
use crate::git::worktree::put_back::branch::{PutBackBranchInput, choose_put_back_branch};
use crate::git::worktree::put_back::{
    PlacedPutBack, PutBackAtFreeNameInput, PutBackMark, PutBackMarks,
    put_worktree_back_at_free_name,
};
use crate::git::worktree::service::RestoredWorktree;

// A project mount that records no git common folder, so no put-back can know its repository.
#[derive(Debug, thiserror::Error)]
#[error("project mount {mount_id} carries no repository identity")]
struct MountWithoutRepository {
    mount_id: RepoMountId,
}

// The tree put back as its row records it.
struct RecordedPutBack {
    worktree_id: WorktreeId,
    fs_root: FilesystemPath,
    branch: GitRefName,
}

impl RemovedWorktreeStore {
    /// Puts a kept worktree back, as this module describes, answering once the tree is recorded.
    /// Answers the result's refusal `projectNotAttached`, `repositoryMissing` or `keptTreeMissing`,
    /// keeping the copy; fails with `worktree.removed.notFound` when no listed copy has the id, or
    /// what is left of a copy put back is not listed, and otherwise with the failure, every step
    /// undone.
    pub async fn restore(
        self: &Arc<Self>,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<WorktreeRestoreResponse, RemovedWorktreeStoreError> {
        let store = Arc::clone(self);
        self.deps
            .kept_copy_lock
            .run_held(
                removed_worktree_id,
                async move { store.put_back(removed_worktree_id).await },
                log_landed_late(
                    "putting the kept worktree back",
                    HeldWorkSubject::KeptCopy(removed_worktree_id),
                ),
            )
            .await?
    }

    // The put-back itself, run under the kept copy's lock.
    async fn put_back(
        self: &Arc<Self>,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<WorktreeRestoreResponse, RemovedWorktreeStoreError> {
        // A put-back of this copy a crash cut short is undone first, so the copy is whole again.
        let kept = self.require_row(removed_worktree_id).await?;
        self.undo_interrupted_put_back(&kept).await?;
        let kept = self.require_row(removed_worktree_id).await?;
        // What is left of a copy put back is listed, and put back again, only while its live tree
        // put back is one git cannot read; a sound one, or one gone, leaves it hidden.
        if let Some(restored_worktree_id) = kept.restored_worktree_id
            && self
                .find_unsound_restored_tree(restored_worktree_id)
                .await?
                .is_none()
        {
            return Err(RemovedWorktreeStoreError::Refused(
                WorktreeRefusal::RemovedNotFound {
                    removed_worktree_id,
                },
            ));
        }
        let project_id = kept.project_id;
        let Some(mount) = self
            .read(move |connection| query_project_mount(connection, &project_id))
            .await?
        else {
            return Ok(refused(WorktreeRestoreRefusal::ProjectNotAttached {}));
        };
        let canonical_root = Path::new(mount.canonical_root.as_str());
        if !tokio::fs::try_exists(canonical_root)
            .await
            .map_err(RemovedWorktreeStoreError::failed)?
            || !self.is_same_repository(&kept, &mount).await?
        {
            return Ok(refused(WorktreeRestoreRefusal::RepositoryMissing {
                path: mount.canonical_root.clone(),
            }));
        }
        // A leftover's files went into its unreadable tree when the first put-back renamed them
        // there.
        let kept_folder = Path::new(kept.kept_path.as_str());
        if !tokio::fs::try_exists(kept_folder.join(KEPT_TREE_ENTRY))
            .await
            .map_err(RemovedWorktreeStoreError::failed)?
        {
            return Ok(refused(WorktreeRestoreRefusal::KeptTreeMissing {}));
        }
        let Some(common_folder) = &mount.common_folder else {
            return Err(RemovedWorktreeStoreError::failed(MountWithoutRepository {
                mount_id: mount.id,
            }));
        };
        let tools = self.put_back_tools(mount.place.as_ref());
        let original_path = Path::new(kept.original_path.as_str());
        let choice = choose_put_back_branch(
            tools,
            PutBackBranchInput {
                removed_worktree_id: &kept.removed_worktree_id,
                branch: kept.branch.as_str(),
                is_on_branch: kept.is_on_branch,
                head_commit: &kept.head_commit,
                kept_folder,
                record_folder: Path::new(kept.record_folder.as_str()),
                original_path,
                canonical_root,
                common_folder,
            },
        )
        .await
        .map_err(RemovedWorktreeStoreError::failed)?;
        let copy = put_back_copy(&kept);
        let marks = KeptCopyPutBackMarks {
            store: self,
            kept: &kept,
        };
        let placed = put_worktree_back_at_free_name(
            tools,
            PutBackAtFreeNameInput {
                kept_folder,
                original_path,
                branch: kept.branch.as_str(),
                canonical_root,
                common_folder,
                choice: &choice,
                copy: &copy,
            },
            &marks,
        )
        .await
        .map_err(RemovedWorktreeStoreError::failed)?;
        let recorded = match self.record_put_back(&kept, &mount, &placed).await {
            Ok(recorded) => recorded,
            Err(failure) => {
                let undo_failures = placed.undo(tools, &marks).await.err().into_iter().collect();
                return Err(RemovedWorktreeStoreError::failed(CleanupFailures::new(
                    failure,
                    undo_failures,
                    "recording the put-back tree",
                )));
            }
        };
        self.delete_restored_copy_later(removed_worktree_id, recorded.fs_root.clone());
        Ok(WorktreeRestoreResponse::Restored {
            worktree_id: recorded.worktree_id,
            path: recorded.fs_root,
            branch: recorded.branch,
            on_new_branch: placed.new_branch.is_some(),
        })
    }

    // Records the tree put back, in the write that links the kept copy to it and clears its mark.
    async fn record_put_back(
        &self,
        kept: &RemovedWorktreeRow,
        mount: &KeptCopyMount,
        placed: &PlacedPutBack,
    ) -> Result<RecordedPutBack, RemovedWorktreeStoreError> {
        let branch = match &placed.new_branch {
            Some(new_branch) => GitRefName::new(new_branch.name.clone())
                .map_err(RemovedWorktreeStoreError::failed)?,
            None => kept.branch.clone(),
        };
        let fs_root = FilesystemPath::new(placed.target_folder.to_string_lossy().into_owned())
            .map_err(RemovedWorktreeStoreError::failed)?;
        let worktree_id = self
            .deps
            .worktrees
            .record_restored_worktree(
                RestoredWorktree {
                    repo_mount_id: mount.id,
                    session_id: kept.created_by_session_id,
                    branch_name: branch.clone(),
                    base_ref: kept.base_ref.clone(),
                    fs_root: fs_root.clone(),
                    restored_from: kept.removed_worktree_id,
                },
                |worktree_id| {
                    vec![mark_restored_statement(
                        &kept.removed_worktree_id,
                        worktree_id,
                        kept.restored_worktree_id.as_ref(),
                    )]
                },
            )
            .await
            .map_err(RemovedWorktreeStoreError::failed)?;
        Ok(RecordedPutBack {
            worktree_id,
            fs_root,
            branch,
        })
    }

    // Deletes what is left of the kept copy of a tree put back once the put-back has answered,
    // tracked so shutdown waits for it; it waits for the copy's lock the put-back still holds. A
    // failure leaves the copy for the next cleanup to try again, and goes to the service log.
    fn delete_restored_copy_later(
        self: &Arc<Self>,
        removed_worktree_id: RemovedWorktreeId,
        restored_folder: FilesystemPath,
    ) {
        let store = Arc::clone(self);
        self.background.spawn(async move {
            if let Err(failure) = store.delete_restored_copy(removed_worktree_id).await {
                tracing::warn!(
                    removed_worktree_id = %removed_worktree_id,
                    restored_folder = restored_folder.as_str(),
                    error = &failure as &(dyn Error + 'static),
                    "a kept worktree was put back, but removing what is left of its kept copy \
                     failed; the next cleanup tries again"
                );
            }
        });
    }
}

/// The kept copy's row as a put-back reads and marks it.
pub(super) struct KeptCopyPutBackMarks<'a> {
    /// The store whose writer marks the row.
    pub(super) store: &'a RemovedWorktreeStore,
    /// The row as the put-back read it.
    pub(super) kept: &'a RemovedWorktreeRow,
}

impl PutBackMarks for KeptCopyPutBackMarks<'_> {
    // A folder on disk, or one a retired tree's cleanup still owns, which would take a tree put
    // back there for its own.
    async fn is_folder_taken(&self, folder: &Path) -> Result<bool, Box<dyn Error + Send + Sync>> {
        let stored_folder = folder.to_string_lossy().into_owned();
        if self
            .store
            .read(move |connection| query_is_uncleaned_retired_at(connection, &stored_folder))
            .await?
        {
            return Ok(true);
        }
        Ok(tokio::fs::try_exists(folder).await?)
    }

    async fn write(&self, mark: &PutBackMark) -> Result<(), RowWriteError> {
        Ok(self
            .store
            .write(vec![mark_put_back_statement(
                &self.kept.removed_worktree_id,
                self.kept.restored_worktree_id.as_ref(),
                mark,
            )])
            .await?)
    }

    async fn clear(&self) -> Result<(), RowWriteError> {
        Ok(self
            .store
            .write(vec![clear_put_back_mark_statement(
                &self.kept.removed_worktree_id,
            )])
            .await?)
    }
}

fn refused(refusal: WorktreeRestoreRefusal) -> WorktreeRestoreResponse {
    WorktreeRestoreResponse::Refused { refusal }
}
