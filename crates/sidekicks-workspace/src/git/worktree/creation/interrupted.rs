//! Settling the trees a stop cut off between their row and `ready`. Such a `creating` row holds
//! its branch under the active-branch index and no sweep reads it. A tree still on disk is undone
//! as a failed creation is: the row marked `failed`, the folder and its own record removed and the
//! branch its creation made deleted. A row whose tree is gone, or whose mount is no longer
//! attached, is retired, so the sweep settles it; for a tree gone from an attached mount, git's
//! records naming its folder are removed first, since no sweep reads a record of a missing folder,
//! and the row stays `creating` for the next start when they cannot be.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use notify::Watcher;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::text_column;

use super::{WorktreeCreationError, WorktreeCreator, remove_tree_without_git};
use crate::git::worktree::service::{RecordRetirementOptions, WorktreeServiceError};

static SELECT_CREATING_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id FROM worktrees WHERE state = '{}'",
        <&'static str>::from(WorktreeState::Creating)
    )
});

/// What one pass over the creations a stop cut off did; its failures stay for the next start.
#[derive(Debug, Default)]
pub struct InterruptedCreationRepair {
    /// The trees whose `creating` row was settled.
    pub settled_worktree_ids: Vec<WorktreeId>,
    /// Each step that failed, in the pass's order.
    pub failures: Vec<InterruptedCreationFailure>,
}

/// One step of settling the creations a stop cut off that failed.
#[derive(Debug, thiserror::Error)]
pub enum InterruptedCreationFailure {
    /// The `creating` rows could not be listed.
    #[error("the worktrees a stop left mid-creation could not be listed")]
    Listing(#[source] WorktreeCreationError),
    /// A step of settling one tree failed; the steps after it still ran.
    #[error("the worktree {worktree_id} a stop left mid-creation could not be settled")]
    Worktree {
        /// The tree.
        worktree_id: WorktreeId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
}

impl<W: Watcher + Send + 'static> WorktreeCreator<W> {
    /// Settles every `creating` row, as the module describes. Runs once at the daemon's start,
    /// before any creation, since a creation under way holds a `creating` row too. Each tree's
    /// failure is kept and stops no other.
    pub async fn finish_interrupted_creations(&self) -> InterruptedCreationRepair {
        let mut repair = InterruptedCreationRepair::default();
        let listed = self
            .deps
            .reads
            .read(ReadLength::Short, |connection| {
                Ok::<_, WorktreeCreationError>(
                    connection
                        .prepare_cached(SELECT_CREATING_WORKTREES_SQL.as_str())?
                        .query_map([], |row| text_column(row, 0, |text| WorktreeId::new(&text)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                )
            })
            .await;
        let worktree_ids = match listed {
            Ok(worktree_ids) => worktree_ids,
            Err(failure) => {
                repair
                    .failures
                    .push(InterruptedCreationFailure::Listing(failure));
                return repair;
            }
        };
        for worktree_id in worktree_ids {
            let failures = self.settle_interrupted_creation(&worktree_id).await;
            if failures.is_empty() {
                repair.settled_worktree_ids.push(worktree_id);
            }
            repair.failures.extend(
                failures
                    .into_iter()
                    .map(|cause| InterruptedCreationFailure::Worktree { worktree_id, cause }),
            );
        }
        repair
    }

    // Undoes the tree of one `creating` row while it stands on an attached mount, and otherwise
    // retires the row, once the records of a tree gone from an attached mount are removed; answers
    // each step's failure.
    async fn settle_interrupted_creation(
        &self,
        worktree_id: &WorktreeId,
    ) -> Vec<Box<dyn Error + Send + Sync>> {
        let worktrees = &self.deps.worktrees;
        let row = match worktrees.require_worktree_at_place(worktree_id).await {
            Ok((row, _place)) => row,
            Err(failure) => return vec![failure.into()],
        };
        let folder = PathBuf::from(row.fs_root.as_str());
        let is_present = match tokio::fs::try_exists(&folder).await {
            Ok(is_present) => is_present,
            Err(failure) => return vec![failure.into()],
        };
        let mount = match worktrees.require_attached_mount(&row.repo_mount_id).await {
            Ok(mount) => Some(mount),
            Err(WorktreeServiceError::MountRefused(_)) => None,
            Err(failure) => return vec![failure.into()],
        };
        if is_present && let Some(mount) = &mount {
            return self
                .record_create_failure(mount, &folder, row.branch_name.as_str(), worktree_id)
                .await;
        }
        // The records go first: a row retired before them would leave no `creating` row for the
        // next start to retry a failed removal from.
        if let Some(mount) = &mount {
            let repository = Path::new(mount.canonical_root.as_str());
            if let Err(record_failures) =
                remove_tree_without_git(&self.deps.git, mount.place.as_ref(), repository, &folder)
                    .await
            {
                return record_failures;
            }
        }
        worktrees
            .record_retirement(&row, RecordRetirementOptions::default())
            .await
            .err()
            .into_iter()
            .map(Into::into)
            .collect()
    }
}
