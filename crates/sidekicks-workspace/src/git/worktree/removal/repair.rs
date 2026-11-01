//! Putting right what a crash cut short. A discard whose kept copy's row has no `removed_at` is
//! undone when its tree never moved, and otherwise finished: the copy is listed, and a tree whose
//! row is still live is retired with it. Then, at every cleanup, interrupted put-backs are undone,
//! restored copies deleted, listed copies' stale records removed with the empty folder and the
//! record holding only git's `initializing` lock that a put-back cut short before its mark left,
//! and leftover copies a crash left in the worktrees folder removed. Each step's failure is kept
//! for the next pass and stops no other.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::worktree::lifecycle::RemovedWorktreeId;
use tokio_util::sync::CancellationToken;

use super::{
    RecordRemovalFailure, RemovalShared, WorktreeRemoval, WorktreeRemovalError,
    file_watch_stop_failed,
};
use crate::git::worktree::kept_copy::KEPT_TREE_ENTRY;
use crate::git::worktree::kept_copy::folder_move::list_leftover_copies;
use crate::git::worktree::kept_copy::held_work::{HeldWorkSubject, log_landed_late};
use crate::git::worktree::reads::common_folder_of_record;
use crate::git::worktree::removed_store::RemovedWorktreeStoreError;
use crate::git::worktree::removed_store::rows::finish_statement;
use crate::git::worktree::rows::WorktreeRow;
use crate::git::worktree::service::{RecordRetirementOptions, remove_folder};
use crate::git::worktree::stale_record::{StaleRecordTools, at, remove_stale_record_and_refs};
use crate::git::worktree::tree_records::hold_records;
use crate::git::worktree::unfinished_discards::UnfinishedKeptWorktree;

/// What one pass over the work a crash cut short did; its failures stay for the next pass.
#[derive(Debug, Default)]
pub struct InterruptedKeptCopyRepair {
    /// The kept copies whose discard, keeping aside or put-back was put right.
    pub repaired_removed_worktree_ids: Vec<RemovedWorktreeId>,
    /// Each step that failed, in the pass's order.
    pub failures: Vec<InterruptedKeptCopyFailure>,
}

/// One step of putting right the work a crash cut short that failed.
#[derive(Debug, thiserror::Error)]
pub enum InterruptedKeptCopyFailure {
    /// The kept copies a step works through could not be listed.
    #[error("the kept worktrees to put right could not be listed")]
    Listing(#[source] RemovedWorktreeStoreError),
    /// One kept copy could not be put right.
    #[error("the kept worktree {removed_worktree_id} could not be put right")]
    KeptCopy {
        /// The kept copy.
        removed_worktree_id: RemovedWorktreeId,
        /// Why.
        #[source]
        cause: WorktreeRemovalError,
    },
    /// The worktrees folder could not be read for the copies a crash left.
    #[error("the worktrees folder could not be read for the copies a crash left")]
    LeftoverListing(#[source] std::io::Error),
    /// A copy a crash left could not be removed.
    #[error("{} could not be removed", folder.display())]
    LeftoverCopy {
        /// The copy's folder.
        folder: PathBuf,
        /// Why.
        #[source]
        cause: WorktreeRemovalError,
    },
}

impl InterruptedKeptCopyRepair {
    // The ids a step lists, or none with the listing's failure kept.
    fn listed(
        &mut self,
        listing: Result<Vec<RemovedWorktreeId>, RemovedWorktreeStoreError>,
    ) -> Vec<RemovedWorktreeId> {
        listing.unwrap_or_else(|failure| {
            self.failures
                .push(InterruptedKeptCopyFailure::Listing(failure));
            Vec::new()
        })
    }

    // Keeps one kept copy's outcome: put right, left alone, or failed.
    fn record(
        &mut self,
        removed_worktree_id: RemovedWorktreeId,
        outcome: Result<bool, WorktreeRemovalError>,
    ) {
        match outcome {
            Ok(true) => self.repaired_removed_worktree_ids.push(removed_worktree_id),
            Ok(false) => {}
            Err(cause) => self.failures.push(InterruptedKeptCopyFailure::KeptCopy {
                removed_worktree_id,
                cause,
            }),
        }
    }
}

// What one repair of a discard did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiscardRepairOutcome {
    // The row was finished or gone by the time the lock was held.
    Nothing,
    // The tree never moved, so the discard was undone.
    Undone,
    // The kept copy was listed.
    Listed,
}

// A tree whose sessions a repair leaves to sweep once the kept copy's lock is let go.
struct PendingSweep {
    row: WorktreeRow,
    record_removal: Option<RecordRemovalFailure>,
}

// What one repair of a discard did, and the sweep it leaves.
struct InterruptedDiscardRepair {
    outcome: DiscardRepairOutcome,
    sweep: Option<PendingSweep>,
}

impl InterruptedDiscardRepair {
    const NOTHING: Self = Self {
        outcome: DiscardRepairOutcome::Nothing,
        sweep: None,
    };
}

impl WorktreeRemoval {
    /// Puts right the work a crash cut short, as the module describes, each step on its own so a
    /// failure stops no other; answers what was put right and the failures, which stay for the
    /// next pass. Stops between steps once `cancel` fires.
    pub async fn finish_interrupted_kept_copies(
        &self,
        cancel: &CancellationToken,
    ) -> InterruptedKeptCopyRepair {
        let shared = &self.shared;
        let store = &shared.deps.removed_worktrees;
        let mut repair = InterruptedKeptCopyRepair::default();
        let unfinished = store.list_unfinished().await.map(|unfinished| {
            unfinished
                .into_iter()
                .map(|kept| kept.removed_worktree_id)
                .collect()
        });
        for removed_worktree_id in repair.listed(unfinished) {
            if cancel.is_cancelled() {
                return repair;
            }
            let outcome = shared
                .finish_interrupted_discard_of(removed_worktree_id)
                .await
                .map(|outcome| outcome != DiscardRepairOutcome::Nothing);
            repair.record(removed_worktree_id, outcome);
        }
        for removed_worktree_id in repair.listed(store.list_interrupted_put_backs().await) {
            if cancel.is_cancelled() {
                return repair;
            }
            let outcome = store
                .finish_interrupted_put_back(removed_worktree_id)
                .await
                .map_err(WorktreeRemovalError::from);
            repair.record(removed_worktree_id, outcome);
        }
        for removed_worktree_id in repair.listed(store.list_restored().await) {
            if cancel.is_cancelled() {
                return repair;
            }
            let outcome = store
                .delete_restored_copy(removed_worktree_id)
                .await
                .map(|()| false)
                .map_err(WorktreeRemovalError::from);
            repair.record(removed_worktree_id, outcome);
        }
        for removed_worktree_id in repair.listed(store.list_kept().await) {
            if cancel.is_cancelled() {
                return repair;
            }
            let outcome = store
                .remove_stale_record_of(removed_worktree_id)
                .await
                .map(|()| false)
                .map_err(WorktreeRemovalError::from);
            repair.record(removed_worktree_id, outcome);
        }
        // A folder that cannot be read blocks only this step.
        let leftovers = list_leftover_copies(
            shared
                .deps
                .removed_worktrees
                .folder_move_tools()
                .names_in_use,
            &shared.deps.worktrees_folder,
        )
        .await
        .unwrap_or_else(|failure| {
            repair
                .failures
                .push(InterruptedKeptCopyFailure::LeftoverListing(failure));
            Vec::new()
        });
        for folder in leftovers {
            if cancel.is_cancelled() {
                return repair;
            }
            if let Err(cause) = shared.remove_leftover_copy(&folder).await {
                repair
                    .failures
                    .push(InterruptedKeptCopyFailure::LeftoverCopy { folder, cause });
            }
        }
        repair
    }
}

impl RemovalShared {
    // Puts right each discard of the tree at `folder` a crash cut short, failing with the first
    // failure; answers whether any of them listed a kept copy.
    pub(super) async fn finish_interrupted_discards_in(
        self: &Arc<Self>,
        folder: &FilesystemPath,
    ) -> Result<bool, WorktreeRemovalError> {
        let mut is_any_listed = false;
        for unfinished in self.deps.removed_worktrees.list_unfinished().await? {
            if unfinished.original_path == *folder {
                let outcome = self
                    .finish_interrupted_discard_of(unfinished.removed_worktree_id)
                    .await?;
                is_any_listed |= outcome == DiscardRepairOutcome::Listed;
            }
        }
        Ok(is_any_listed)
    }

    // Puts right one discard under its kept copy's lock, then sweeps the tree it finished once the
    // lock is let go.
    async fn finish_interrupted_discard_of(
        self: &Arc<Self>,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<DiscardRepairOutcome, WorktreeRemovalError> {
        let held = Arc::clone(self);
        let repair = self
            .deps
            .removed_worktrees
            .kept_copy_lock()
            .run_held(
                removed_worktree_id,
                async move {
                    held.finish_interrupted_discard_held(removed_worktree_id)
                        .await
                },
                log_landed_late(
                    "finishing an interrupted discard",
                    HeldWorkSubject::KeptCopy(removed_worktree_id),
                ),
            )
            .await??;
        if let Some(PendingSweep {
            row,
            record_removal,
        }) = repair.sweep
        {
            self.sweep_after_record(&row, record_removal).await?;
        }
        Ok(repair.outcome)
    }

    // Under the kept copy's lock the row is read again, so one a discard or another repair finished
    // while this one waited is left alone.
    async fn finish_interrupted_discard_held(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<InterruptedDiscardRepair, WorktreeRemovalError> {
        let unfinished = self
            .deps
            .removed_worktrees
            .list_unfinished()
            .await?
            .into_iter()
            .find(|candidate| candidate.removed_worktree_id == removed_worktree_id);
        match unfinished {
            Some(unfinished) => self.finish_interrupted_discard(&unfinished).await,
            None => Ok(InterruptedDiscardRepair::NOTHING),
        }
    }

    async fn finish_interrupted_discard(
        &self,
        unfinished: &UnfinishedKeptWorktree,
    ) -> Result<InterruptedDiscardRepair, WorktreeRemovalError> {
        let store = &self.deps.removed_worktrees;
        let removed_worktree_id = unfinished.removed_worktree_id;
        let kept_folder = PathBuf::from(unfinished.kept_folder.as_str());
        let original_path = PathBuf::from(unfinished.original_path.as_str());
        let (has_kept_tree, has_tree) = tokio::try_join!(
            tokio::fs::try_exists(kept_folder.join(KEPT_TREE_ENTRY)),
            tokio::fs::try_exists(&original_path)
        )
        .map_err(WorktreeRemovalError::Folder)?;
        // The tree moves only once what the copy records is written, so without it nothing moved.
        // A copy takes the kept tree's name only once whole, and a deletion takes the tree off it
        // first, so with no kept tree the live tree is the whole one, and a partial copy goes with
        // the kept folder.
        let record_folder = match &unfinished.record_folder {
            Some(record_folder) if has_kept_tree || !has_tree => {
                PathBuf::from(record_folder.as_str())
            }
            Some(_) | None => {
                store.discard_unfinished(unfinished).await?;
                return Ok(InterruptedDiscardRepair {
                    outcome: DiscardRepairOutcome::Undone,
                    sweep: None,
                });
            }
        };
        // With neither there, nothing is known to be whole, so the person decides.
        if !has_kept_tree && !has_tree {
            store.finish_without_tree(&removed_worktree_id).await?;
            return Ok(InterruptedDiscardRepair {
                outcome: DiscardRepairOutcome::Listed,
                sweep: None,
            });
        }
        let mut sweep = None;
        if has_kept_tree && !has_tree {
            // The moved tree's record goes now, so a file-watch daemon the move left running is
            // stopped through it first.
            self.stop_file_watch_after_move(unfinished.place.as_ref(), &kept_folder)
                .await
                .map_err(file_watch_stop_failed)?;
            if let Some(row) = &unfinished.worktree {
                self.deps
                    .worktrees
                    .record_retirement(
                        row,
                        RecordRetirementOptions {
                            removed_worktree_id: Some(removed_worktree_id),
                            transactional_prelude: vec![finish_statement(&removed_worktree_id)],
                            ..RecordRetirementOptions::default()
                        },
                    )
                    .await?;
                let record_removal = self
                    .remove_own_record(unfinished, &record_folder, &original_path)
                    .await
                    .err();
                sweep = Some(PendingSweep {
                    row: row.clone(),
                    record_removal,
                });
            } else {
                // A retired tree the sweep was keeping aside: listing the copy finishes it, and
                // the sweep stamps the row once it finds the folder gone.
                store.finish(&removed_worktree_id).await?;
                self.remove_own_record(unfinished, &record_folder, &original_path)
                    .await
                    .map_err(|record| WorktreeRemovalError::RecordRemoval {
                        record,
                        sweep: None,
                    })?;
            }
        } else {
            // With both there, either a move across volumes copied the tree whole and the crash
            // came before or while the original was removed, or an undo across volumes was cut
            // short while removing the kept tree, which may then be partial. The copy is listed
            // either way, so nothing that may be whole is deleted, and the person decides.
            store.finish(&removed_worktree_id).await?;
        }
        store.measure_later(removed_worktree_id, kept_folder);
        Ok(InterruptedDiscardRepair {
            outcome: DiscardRepairOutcome::Listed,
            sweep,
        })
    }

    // Removes the moved tree's record once no live row stands at its folder, and only while it is
    // the copy's own, since a later tree of that folder name may have taken the record's name; with
    // it goes the tree's refs folder a repository keeping its refs apart holds, when the copy kept
    // it.
    async fn remove_own_record(
        &self,
        unfinished: &UnfinishedKeptWorktree,
        record_folder: &Path,
        original_path: &Path,
    ) -> Result<(), RecordRemovalFailure> {
        let store = &self.deps.removed_worktrees;
        let common_folder = common_folder_of_record(record_folder)
            .expect("a kept copy's record sits two folders below its git common folder");
        let records_hold = hold_records(common_folder)
            .await
            .map_err(at(common_folder))?;
        remove_stale_record_and_refs(
            StaleRecordTools {
                claims: store.claims(),
                names_in_use: store.folder_move_tools().names_in_use,
            },
            &self.deps.git,
            unfinished.place.as_ref(),
            Path::new(unfinished.kept_folder.as_str()),
            record_folder,
            original_path,
            &records_hold,
        )
        .await?;
        Ok(())
    }

    // Removes a copy a crash left in the worktrees folder, unless a worktree's row names it.
    async fn remove_leftover_copy(&self, folder: &Path) -> Result<(), WorktreeRemovalError> {
        if self.deps.worktrees.is_worktree_folder(folder).await? {
            return Ok(());
        }
        remove_folder(folder)
            .await
            .map_err(WorktreeRemovalError::Folder)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sidekicks_contracts::worktree::lifecycle::WorktreeState;
    use tokio_util::sync::CancellationToken;

    use crate::git::worktree::kept_copy::KEPT_TREE_ENTRY;
    use crate::git::worktree::removal::tests::RemovalFixture;
    use crate::git::worktree::removed_store::kept_folder_for;

    // Kills inverting the kept-tree test of the repair: a discard cut before its move is undone,
    // and one cut after its move, with the tree's row still live, is finished.
    #[tokio::test]
    async fn a_discard_cut_short_is_undone_before_its_move_and_finished_after_it() {
        let fixture = RemovalFixture::new().await;
        let unmoved = fixture.kept.add_tree("unmoved", "unmoved").await;
        let unmoved_id = fixture.cut_before_move(&unmoved).await;
        let moved = fixture.kept.add_tree("moved", "moved").await;
        let (moved_id, record_folder) = fixture.cut_after_move(&moved).await;

        let repair = fixture
            .removal
            .finish_interrupted_kept_copies(&CancellationToken::default())
            .await;

        assert!(repair.failures.is_empty(), "{:?}", repair.failures);
        assert_eq!(
            repair.repaired_removed_worktree_ids,
            vec![unmoved_id, moved_id],
            "both discards were put right, in kept-copy id order"
        );
        let unmoved_folder = PathBuf::from(unmoved.fs_root.as_str());
        assert!(
            unmoved_folder.join(".git").exists(),
            "the unmoved tree stays live"
        );
        assert_eq!(
            fixture.worktree_state(&unmoved),
            <&str>::from(WorktreeState::Ready)
        );
        assert_eq!(
            fixture.kept_copy_rows(&unmoved_id),
            None,
            "the undone discard's row is gone"
        );
        assert!(
            !kept_folder_for(&unmoved, &unmoved_id).exists(),
            "the undone discard's kept folder is gone"
        );

        assert_eq!(
            fixture.worktree_state(&moved),
            <&str>::from(WorktreeState::Retired)
        );
        assert_eq!(
            fixture.kept_copy_rows(&moved_id),
            Some(true),
            "the finished discard's copy is listed"
        );
        assert!(
            fixture
                .kept
                .kept_folder(&moved_id)
                .join(KEPT_TREE_ENTRY)
                .join(".git")
                .exists(),
            "the moved tree stays kept"
        );
        assert!(
            !record_folder.exists(),
            "the moved tree's stale record is gone"
        );
        assert_eq!(
            fixture.swept(),
            vec![moved.id],
            "the finished tree's sessions are swept"
        );
    }
}
