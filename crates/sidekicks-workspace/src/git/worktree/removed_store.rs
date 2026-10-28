//! The kept worktrees `Discard and remove` leaves: their rows in `removed_worktrees`, listing them,
//! putting one back and deleting one when the person presses `Delete now`. Nothing else deletes a
//! kept worktree: no age, no sweep and no data cleanup reaches its folder or its pins.
//!
//! A discard writes its row before it makes anything the row lists, with no `removed_at`, fills in
//! what the copy records before the tree moves, and the retirement's write sets `removed_at`; a row
//! still without one names a discard a crash cut short, which the daemon's start finishes or
//! undoes, so no kept folder or pin is ever left that nothing lists. A put-back marks the row with
//! what it is doing before the tree moves, and the put-back's own write clears the mark; a row
//! still marked names a put-back a crash cut short, which is undone so the kept copy is whole
//! again.
//!
//! What is left of a copy put back (its pins, its folder and its row) goes after the answer, under
//! the copy's lock, once the tree put back stands sound or has gone through its own removal; a
//! failure goes to the service log and the next cleanup tries again. Until then it is listed only
//! while it is the one source to rebuild a live tree put back that git cannot read.
//!
//! One lock per kept copy, shared with the removal, runs its discard, its repair, its put-back, its
//! size read and its deletion one at a time, so each reads the row as the one before left it. The size reads and
//! the restored copies' deletions run in the background after their call answered, one size read
//! at a time, and [`RemovedWorktreeStore::settle`] waits for them.

mod restore;
pub(crate) mod rows;

use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};
use sidekicks_contracts::worktree::removed::{
    RemovedWorktree, WorktreeRemovedListRequest, WorktreeRemovedListResponse,
};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::processor_bound::map_with_processor_bound;
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::DatabaseWriter;
use tokio::sync::Semaphore;
use tokio::task::JoinError;
use tokio_util::task::TaskTracker;

use self::rows::{
    KeptCopyMount, KeptWorktreeRecord, RemovedWorktreeRow, SELECT_INTERRUPTED_PUT_BACK_IDS_SQL,
    SELECT_LISTED_IDS_SQL, SELECT_RESTORED_IDS_SQL, clear_put_back_mark_statement,
    delete_row_statement, finish_statement, forget_pending_statement, insert_pending_statement,
    query_ids, query_listed, query_listed_one, query_live_tree, query_mount,
    query_mount_of_kept_copy, query_project_mount, record_kept_state_statement,
    record_size_statement,
};
use crate::git::process::GitRunner;
use crate::git::worktree::claims::KeptCopyClaims;
use crate::git::worktree::copy::progress::WorktreeCopiesUnderWay;
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::kept_copy::folder_move::{FolderMoveTools, NamesInUse};
use crate::git::worktree::kept_copy::held_work::{HeldWorkEnd, held_answer, log_landed_late};
use crate::git::worktree::kept_copy::{
    KeptCopyRowWrites, KeptCopyTools, KeptWorktreeState, RowWriteError, delete_kept_copy,
    measure_kept_copy,
};
use crate::git::worktree::naming::REMOVED_WORKTREES_FOLDER_NAME;
use crate::git::worktree::put_back::undo::undo_put_back;
use crate::git::worktree::put_back::unmarked_names::remove_unmarked_names;
use crate::git::worktree::put_back::{PutBackTools, UnsoundTreeError, require_sound_restored_tree};
use crate::git::worktree::rows::WorktreeRow;
use crate::git::worktree::service::{WorktreeRowsReadError, WorktreeService};
use crate::git::worktree::stale_record::{StaleRecordTools, remove_stale_record_and_refs};
use crate::git::worktree::unfinished_discards::{UnfinishedKeptWorktree, read_unfinished_discards};
use crate::trust_envelope::components_equal;

/// The statements the kept worktrees' store prepares on a read connection: its listings, its id
/// reads, its mount reads, the live tree read and the retired folder read.
pub const REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY: usize = 11;

/// What the kept worktrees' store runs with.
pub struct RemovedWorktreeStoreDeps {
    /// The daemon's git entry point.
    pub git: GitRunner,
    /// The daemon's read pool.
    pub reads: Arc<DatabaseReadPool>,
    /// The writer every row write goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The worktree service, which records the tree a put-back makes.
    pub worktrees: Arc<WorktreeService>,
    /// Where a put-back's copy across volumes, and its undo's, reports its progress.
    pub copies: WorktreeCopiesUnderWay,
    /// The names in use, shared with everything that makes or sweeps one.
    pub names_in_use: Arc<NamesInUse>,
    /// The lock per kept copy, by its id, which the removal holds for its discards and repairs.
    pub kept_copy_lock: Arc<KeyedLock<RemovedWorktreeId>>,
    /// The daemon's worktrees folder; a kept folder is deleted only from inside it.
    pub worktrees_folder: PathBuf,
}

/// Why a kept worktree's call failed.
#[derive(Debug, thiserror::Error)]
pub enum RemovedWorktreeStoreError {
    /// The call was refused: no listed kept copy has the id (`worktree.removed.notFound`).
    #[error(transparent)]
    Refused(#[from] WorktreeRefusal),
    /// A read, a write, a git call or a file step failed; a put-back undid every step first.
    #[error(transparent)]
    Failed(Box<dyn Error + Send + Sync>),
    /// The task that ran the call under the kept copy's lock ended before it finished.
    #[error("the kept worktree's call ended before it finished")]
    Interrupted(#[source] JoinError),
    /// The call under the kept copy's lock ended without an answer.
    #[error("the kept worktree's call ended without an answer")]
    Unanswered,
}

impl RemovedWorktreeStoreError {
    fn failed(failure: impl Error + Send + Sync + 'static) -> Self {
        Self::Failed(Box::new(failure))
    }

    // One failure as it came; several kept together.
    fn settled(failures: SettleFailures<Self>) -> Self {
        match failures {
            SettleFailures::One(failure) => failure,
            many @ SettleFailures::Many { .. } => Self::failed(many),
        }
    }
}

// A kept folder whose stored path is no `<project>/.removed/<name>` folder under the worktrees
// folder, which nothing deletes.
#[derive(Debug, thiserror::Error)]
#[error("cannot delete kept worktree {removed_worktree_id}: its stored folder is not a kept one")]
struct NotAKeptFolder {
    removed_worktree_id: RemovedWorktreeId,
}

// A kept copy's size past what the wire carries.
#[derive(Debug, thiserror::Error)]
#[error("the kept worktree's size of {size_bytes} bytes is past what the list can carry")]
struct SizeOutOfRange {
    size_bytes: u64,
}

/// Lists, puts back and deletes the worktrees a discard kept.
pub struct RemovedWorktreeStore {
    deps: RemovedWorktreeStoreDeps,
    claims: KeptCopyClaims,
    // The size reads and the deletions of kept copies put back, which run after their call
    // answered.
    background: TaskTracker,
    // The one permit a size read holds, so the reads walk one tree at a time.
    size_read_permit: Semaphore,
    // Kept copies whose stale record this process already looked for: a record is left behind only
    // by a crash or a failed removal before the copy's first look, so each copy is read once a run.
    // A copy's id goes once its row does.
    stale_record_checked_ids: Mutex<HashSet<RemovedWorktreeId>>,
}

/// Where a tree's kept copy goes: `<project folder>/.removed/<name>-<removed id>/`.
pub(crate) fn kept_folder_for(
    worktree: &WorktreeRow,
    removed_worktree_id: &RemovedWorktreeId,
) -> PathBuf {
    let fs_root = Path::new(worktree.fs_root.as_str());
    let project_folder = fs_root
        .parent()
        .expect("a tree's folder sits inside its project's folder");
    let name = fs_root
        .file_name()
        .expect("a tree's folder ends in its name");
    project_folder
        .join(REMOVED_WORKTREES_FOLDER_NAME)
        .join(format!("{}-{removed_worktree_id}", name.to_string_lossy()))
}

impl RemovedWorktreeStore {
    /// A store over `deps`; it reads what live trees and put-backs claim through `deps.reads`.
    pub fn new(deps: RemovedWorktreeStoreDeps) -> Self {
        Self {
            claims: KeptCopyClaims::new(Arc::clone(&deps.reads)),
            deps,
            background: TaskTracker::new(),
            size_read_permit: Semaphore::new(1),
            stale_record_checked_ids: Mutex::default(),
        }
    }

    /// What live trees and put-backs under way hold, which no kept copy's removal takes.
    pub(crate) fn claims(&self) -> &KeptCopyClaims {
        &self.claims
    }

    /// The lock per kept copy, by its id, which every discard, repair, put-back and deletion of
    /// one copy runs under.
    pub(crate) fn kept_copy_lock(&self) -> &Arc<KeyedLock<RemovedWorktreeId>> {
        &self.deps.kept_copy_lock
    }

    /// The copies under way and the names in use, which every folder move of a kept copy runs
    /// with.
    pub(crate) fn folder_move_tools(&self) -> FolderMoveTools<'_> {
        FolderMoveTools {
            copies: &self.deps.copies,
            names_in_use: &self.deps.names_in_use,
        }
    }

    /// The row writes of one discard, for its move aside.
    pub(crate) fn pending_kept_copy(&self, record: KeptWorktreeRecord) -> PendingKeptCopy<'_> {
        PendingKeptCopy {
            store: self,
            record,
        }
    }

    /// Lists the kept copy on its own, for a move that left both folders and retires nothing.
    /// Fails with the write's failure.
    pub(crate) async fn finish(
        &self,
        removed_worktree_id: &RemovedWorktreeId,
    ) -> Result<(), RemovedWorktreeStoreError> {
        self.write(vec![finish_statement(removed_worktree_id)])
            .await
    }

    /// Lists a kept copy a crash cut short whose tree is neither in its kept folder nor where it
    /// lived, and writes its id to the service log, for the person to delete: `Put back` refuses
    /// it, and `Delete now` deletes what is left and its pins. Fails with the write's failure.
    pub(crate) async fn finish_without_tree(
        &self,
        removed_worktree_id: &RemovedWorktreeId,
    ) -> Result<(), RemovedWorktreeStoreError> {
        self.finish(removed_worktree_id).await?;
        tracing::warn!(
            removed_worktree_id = %removed_worktree_id,
            "a crash cut a kept worktree's discard short and its tree is neither in its kept \
             folder nor where it lived; it is listed for Delete now, and Put back refuses it"
        );
        Ok(())
    }

    /// Deletes the row of a kept copy whose tree never moved, once its folder and pins are gone.
    /// Fails with the write's failure.
    pub(crate) async fn forget_pending(
        &self,
        removed_worktree_id: &RemovedWorktreeId,
    ) -> Result<(), RemovedWorktreeStoreError> {
        self.write(vec![forget_pending_statement(removed_worktree_id)])
            .await
    }

    /// Every discard a crash cut short, with the live tree it was moving. Fails with the read's
    /// failure.
    pub(crate) async fn list_unfinished(
        &self,
    ) -> Result<Vec<UnfinishedKeptWorktree>, RemovedWorktreeStoreError> {
        self.read(read_unfinished_discards).await
    }

    /// Undoes a discard a crash cut short before its tree was moved or copied whole: deletes the
    /// kept folder, which holds no whole tree, and the pins, then the row. Fails as each step does.
    pub(crate) async fn discard_unfinished(
        &self,
        unfinished: &UnfinishedKeptWorktree,
    ) -> Result<(), RemovedWorktreeStoreError> {
        let removed_worktree_id = unfinished.removed_worktree_id;
        let mount = self
            .read(move |connection| query_mount_of_kept_copy(connection, &removed_worktree_id))
            .await?;
        let mut pins = None;
        if let Some(KeptCopyMount {
            common_folder: Some(common_folder),
            place,
            ..
        }) = mount
            && tokio::fs::try_exists(&common_folder)
                .await
                .map_err(RemovedWorktreeStoreError::failed)?
        {
            pins = Some((common_folder, place));
        }
        self.delete_kept_folder(
            &removed_worktree_id,
            Path::new(unfinished.kept_folder.as_str()),
            pins,
        )
        .await?;
        self.forget_pending(&removed_worktree_id).await
    }

    /// The ids of the kept copies whose put-back a crash cut short. Fails with the read's failure.
    pub(crate) async fn list_interrupted_put_backs(
        &self,
    ) -> Result<Vec<RemovedWorktreeId>, RemovedWorktreeStoreError> {
        self.read(|connection| query_ids(connection, SELECT_INTERRUPTED_PUT_BACK_IDS_SQL))
            .await
    }

    /// Undoes a put-back of this kept copy a crash cut short, under the copy's lock, so the copy
    /// stands whole again, and clears its mark; answers whether there was one. A failure keeps the
    /// mark for the next try.
    pub(crate) async fn finish_interrupted_put_back(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<bool, RemovedWorktreeStoreError> {
        let _hold = self.deps.kept_copy_lock.acquire(removed_worktree_id).await;
        match self.find_row(removed_worktree_id).await? {
            Some(kept) => self.undo_interrupted_put_back(&kept).await,
            None => Ok(false),
        }
    }

    /// The ids of every kept copy whose discard finished. Fails with the read's failure.
    pub(crate) async fn list_kept(
        &self,
    ) -> Result<Vec<RemovedWorktreeId>, RemovedWorktreeStoreError> {
        self.read(|connection| query_ids(connection, SELECT_LISTED_IDS_SQL))
            .await
    }

    /// Removes a kept copy's old tree record when it is still the copy's own, under the copy's
    /// lock, so git never counts it a duplicate of a tree put back, then the names a put-back cut
    /// short before its mark left; once a run per copy. Fails as
    /// the removal does, the copy looked at again next time.
    pub(crate) async fn remove_stale_record_of(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<(), RemovedWorktreeStoreError> {
        if lock(&self.stale_record_checked_ids).contains(&removed_worktree_id) {
            return Ok(());
        }
        let _hold = self.deps.kept_copy_lock.acquire(removed_worktree_id).await;
        if let Some(kept) = self.find_row(removed_worktree_id).await? {
            self.remove_stale_record(&kept).await?;
            lock(&self.stale_record_checked_ids).insert(removed_worktree_id);
        }
        Ok(())
    }

    /// The ids of the kept copies of trees put back, whose deletion is left undone. Fails with the
    /// read's failure.
    pub(crate) async fn list_restored(
        &self,
    ) -> Result<Vec<RemovedWorktreeId>, RemovedWorktreeStoreError> {
        self.read(|connection| query_ids(connection, SELECT_RESTORED_IDS_SQL))
            .await
    }

    /// Deletes what is left of the kept copy of a tree put back, its pins, its folder and its row,
    /// under the copy's lock, once the tree put back stands sound or has gone through its own
    /// removal. A failure, or a live tree that is not sound, keeps the copy for the next cleanup.
    pub(crate) async fn delete_restored_copy(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<(), RemovedWorktreeStoreError> {
        let _hold = self.deps.kept_copy_lock.acquire(removed_worktree_id).await;
        let Some(kept) = self.find_row(removed_worktree_id).await? else {
            return Ok(());
        };
        let Some(restored_worktree_id) = kept.restored_worktree_id else {
            return Ok(());
        };
        if let Some((_, unsound)) = self
            .find_unsound_restored_tree(restored_worktree_id)
            .await?
        {
            return Err(RemovedWorktreeStoreError::failed(unsound));
        }
        self.delete_kept(&kept).await
    }

    /// Reads the kept copy's size once, after the discard has answered, so the press waits on no
    /// walk of the tree; one read runs at a time, under the copy's lock, so no put-back or deletion
    /// moves the copy mid-walk, and none runs once the copy is no longer listed. A failed read
    /// leaves the size unknown and is written to the service log.
    pub(crate) fn measure_later(
        self: &Arc<Self>,
        removed_worktree_id: RemovedWorktreeId,
        kept_folder: PathBuf,
    ) {
        let store = Arc::clone(self);
        self.background.spawn(async move {
            let _permit = store
                .size_read_permit
                .acquire()
                .await
                .expect("the size reads' permit is never closed");
            if let Err(failure) = store.record_size(&removed_worktree_id, &kept_folder).await {
                tracing::warn!(
                    removed_worktree_id = %removed_worktree_id,
                    error = &failure as &(dyn Error + 'static),
                    "reading a kept worktree's size failed; its size stays unknown"
                );
            }
        });
    }

    /// Waits until no size read and no deletion of a kept copy put back runs, those started while
    /// it waits included, for shutdown.
    pub async fn settle(&self) {
        self.background.close();
        self.background.wait().await;
    }

    /// One project's kept worktrees, or every project's, newest first. What is left of a copy put
    /// back is listed only while it is the one source to rebuild a live tree put back that git
    /// cannot read, with that tree's folder. Fails with a read's failure.
    pub async fn list(
        &self,
        request: &WorktreeRemovedListRequest,
    ) -> Result<WorktreeRemovedListResponse, RemovedWorktreeStoreError> {
        let project_id = request.project_id;
        let rows = self
            .read(move |connection| query_listed(connection, project_id.as_ref()))
            .await?;
        // One git read per copy put back, as many at once as the machine has processors.
        let listed = map_with_processor_bound(rows, "listing the kept worktrees", |row| {
            self.listed_worktree(row)
        })
        .await
        .map_err(RemovedWorktreeStoreError::settled)?;
        Ok(WorktreeRemovedListResponse {
            removed_worktrees: listed.into_iter().flatten().collect(),
        })
    }

    /// Deletes a kept worktree for good, under its lock: a put-back of it a crash cut short is
    /// undone first, then the tree's old record when it is still the copy's own, its folder, its
    /// pins and its row; the row goes last, so a failure leaves a row a second `Delete now`
    /// finishes. Fails with `worktree.removed.notFound` when no listed kept copy has the id.
    pub async fn delete(
        self: &Arc<Self>,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<(), RemovedWorktreeStoreError> {
        let store = Arc::clone(self);
        let landed = self
            .deps
            .kept_copy_lock
            .run_held(
                removed_worktree_id,
                async move {
                    let kept = store.require_row(removed_worktree_id).await?;
                    store.undo_interrupted_put_back(&kept).await?;
                    let kept = store.require_row(removed_worktree_id).await?;
                    store.delete_kept(&kept).await
                },
                log_landed_late("deleting the kept worktree", removed_worktree_id),
            )
            .await;
        held_answer(landed)
    }

    // The row as the list shows it, `None` for a copy put back whose tree stands sound or is gone.
    async fn listed_worktree(
        &self,
        row: RemovedWorktreeRow,
    ) -> Result<Option<RemovedWorktree>, RemovedWorktreeStoreError> {
        let unreadable_put_back_folder = match row.restored_worktree_id {
            Some(restored_worktree_id) => {
                match self
                    .find_unsound_restored_tree(restored_worktree_id)
                    .await?
                {
                    Some((folder, _)) => Some(folder),
                    None => return Ok(None),
                }
            }
            None => None,
        };
        Ok(Some(RemovedWorktree {
            removed_worktree_id: row.removed_worktree_id,
            project_id: row.project_id,
            name: row.worktree_name,
            branch: row.branch,
            head_commit: row.head_commit,
            removed_at: row.removed_at,
            size_bytes: row.size_bytes,
            size_read_at: row.size_read_at,
            unreadable_put_back_folder,
        }))
    }

    // Measures the kept copy and records its size under the copy's lock, while it is listed.
    async fn record_size(
        &self,
        removed_worktree_id: &RemovedWorktreeId,
        kept_folder: &Path,
    ) -> Result<(), RemovedWorktreeStoreError> {
        let _hold = self.deps.kept_copy_lock.acquire(*removed_worktree_id).await;
        if self.find_row(*removed_worktree_id).await?.is_none() {
            return Ok(());
        }
        let size_bytes = measure_kept_copy(kept_folder)
            .await
            .map_err(RemovedWorktreeStoreError::failed)?;
        let size = SafeInt::new(size_bytes)
            .ok_or_else(|| RemovedWorktreeStoreError::failed(SizeOutOfRange { size_bytes }))?;
        self.write(vec![record_size_statement(removed_worktree_id, size)])
            .await
    }

    // Undoes the put-back the row's mark names and clears the mark; answers whether it had one.
    // Runs under the kept copy's lock.
    async fn undo_interrupted_put_back(
        &self,
        kept: &RemovedWorktreeRow,
    ) -> Result<bool, RemovedWorktreeStoreError> {
        let Some(mark) = &kept.put_back_mark else {
            return Ok(false);
        };
        undo_put_back(
            self.put_back_tools(kept.place.as_ref()),
            mark,
            &put_back_copy(kept),
        )
        .await
        .map_err(RemovedWorktreeStoreError::failed)?;
        self.write(vec![clear_put_back_mark_statement(
            &kept.removed_worktree_id,
        )])
        .await?;
        Ok(true)
    }

    // The live tree put back when it is not sound, with why; no git runs once that tree went
    // through its own removal, which kept what it held.
    async fn find_unsound_restored_tree(
        &self,
        restored_worktree_id: WorktreeId,
    ) -> Result<Option<(FilesystemPath, UnsoundTreeError)>, RemovedWorktreeStoreError> {
        let Some((folder, place)) = self
            .read(move |connection| query_live_tree(connection, &restored_worktree_id))
            .await?
        else {
            return Ok(None);
        };
        Ok(
            require_sound_restored_tree(&self.deps.git, place.as_ref(), Path::new(folder.as_str()))
                .await
                .err()
                .map(|unsound| (folder, unsound)),
        )
    }

    // The same mount, or one whose repository is the one the tree was kept from.
    async fn is_same_repository(
        &self,
        kept: &RemovedWorktreeRow,
        mount: &KeptCopyMount,
    ) -> Result<bool, RemovedWorktreeStoreError> {
        if kept.mount_id == mount.id {
            return Ok(true);
        }
        let kept_mount_id = kept.mount_id;
        let kept_mount = self
            .read(move |connection| query_mount(connection, &kept_mount_id))
            .await?;
        Ok(kept_mount
            .and_then(|kept_mount| kept_mount.common_folder)
            .zip(mount.common_folder.as_ref())
            .is_some_and(|(kept_common, common)| components_equal(&kept_common, common)))
    }

    // The repository the pins are in, by its git common folder, with its place: the mount the
    // tree was kept from, or the project's mount now when it holds the same repository; `None`
    // when neither is on disk, which leaves no pin.
    async fn find_pin_repository(
        &self,
        kept: &RemovedWorktreeRow,
    ) -> Result<Option<(PathBuf, Option<Place>)>, RemovedWorktreeStoreError> {
        let (kept_mount_id, project_id) = (kept.mount_id, kept.project_id);
        let mounts = self
            .read(move |connection| {
                Ok([
                    query_mount(connection, &kept_mount_id)?,
                    query_project_mount(connection, &project_id)?,
                ])
            })
            .await?;
        for mount in mounts.into_iter().flatten() {
            if !self.is_same_repository(kept, &mount).await? {
                continue;
            }
            let Some(common_folder) = mount.common_folder else {
                continue;
            };
            if tokio::fs::try_exists(&common_folder)
                .await
                .map_err(RemovedWorktreeStoreError::failed)?
            {
                return Ok(Some((common_folder, mount.place)));
            }
        }
        Ok(None)
    }

    // Deletes a kept copy for good, under its lock: the tree's old record when it is still the
    // copy's own, its folder and pins, then its row last, so a failure leaves a row a second
    // `Delete now` finishes.
    async fn delete_kept(
        &self,
        kept: &RemovedWorktreeRow,
    ) -> Result<(), RemovedWorktreeStoreError> {
        self.remove_stale_record(kept).await?;
        let pins = self.find_pin_repository(kept).await?;
        self.delete_kept_folder(
            &kept.removed_worktree_id,
            Path::new(kept.kept_path.as_str()),
            pins,
        )
        .await?;
        self.write(vec![delete_row_statement(&kept.removed_worktree_id)])
            .await?;
        lock(&self.stale_record_checked_ids).remove(&kept.removed_worktree_id);
        Ok(())
    }

    // The stored folder comes from the database, so a recursive delete must reach nothing but a
    // `<worktrees>/<project slug>/.removed/<name>` folder. The pins go in the repository `pins`
    // names, when one is.
    async fn delete_kept_folder(
        &self,
        removed_worktree_id: &RemovedWorktreeId,
        kept_folder: &Path,
        pins: Option<(PathBuf, Option<Place>)>,
    ) -> Result<(), RemovedWorktreeStoreError> {
        let is_kept_folder = kept_folder
            .strip_prefix(&self.deps.worktrees_folder)
            .is_ok_and(|relative| {
                let parts = relative.components().collect::<Vec<_>>();
                parts.len() == 3
                    && parts
                        .iter()
                        .all(|part| matches!(part, Component::Normal(_)))
                    && parts[1] == Component::Normal(OsStr::new(REMOVED_WORKTREES_FOLDER_NAME))
            });
        if !is_kept_folder {
            return Err(RemovedWorktreeStoreError::failed(NotAKeptFolder {
                removed_worktree_id: *removed_worktree_id,
            }));
        }
        let (common_folder, place) = pins.unzip();
        delete_kept_copy(
            &self.deps.git,
            place.flatten().as_ref(),
            kept_folder,
            common_folder.as_deref(),
            removed_worktree_id,
        )
        .await
        .map_err(RemovedWorktreeStoreError::failed)
    }

    // Removes the tree's old record when it is still the copy's own, and its refs in a refs payload,
    // then the names a put-back of a copy of that tree took before a crash cut it short, under the
    // copy's lock.
    async fn remove_stale_record(
        &self,
        kept: &RemovedWorktreeRow,
    ) -> Result<(), RemovedWorktreeStoreError> {
        let tools = StaleRecordTools {
            claims: &self.claims,
            names_in_use: &self.deps.names_in_use,
        };
        let record_folder = Path::new(kept.record_folder.as_str());
        let original_path = Path::new(kept.original_path.as_str());
        remove_stale_record_and_refs(
            tools,
            &self.deps.git,
            kept.place.as_ref(),
            Path::new(kept.kept_path.as_str()),
            record_folder,
            original_path,
        )
        .await
        .map_err(RemovedWorktreeStoreError::failed)?;
        // A record's folder always sits in its repository's records folder.
        let records_folder = record_folder
            .parent()
            .expect("a record's folder sits in the records folder");
        remove_unmarked_names(tools, original_path, records_folder)
            .await
            .map_err(RemovedWorktreeStoreError::failed)
    }

    // The listed kept copy, or `worktree.removed.notFound`.
    async fn require_row(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<RemovedWorktreeRow, RemovedWorktreeStoreError> {
        self.find_row(removed_worktree_id)
            .await?
            .ok_or(RemovedWorktreeStoreError::Refused(
                WorktreeRefusal::RemovedNotFound {
                    removed_worktree_id,
                },
            ))
    }

    async fn find_row(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<Option<RemovedWorktreeRow>, RemovedWorktreeStoreError> {
        self.read(move |connection| query_listed_one(connection, &removed_worktree_id))
            .await
    }

    // The tools a put-back or its undo runs through, at `place`.
    fn put_back_tools<'a>(&'a self, place: Option<&'a Place>) -> PutBackTools<'a> {
        PutBackTools {
            kept: KeptCopyTools {
                git: &self.deps.git,
                place,
                folder_moves: self.folder_move_tools(),
            },
            claims: &self.claims,
        }
    }

    async fn read<Output: Send + 'static>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<Output> + Send + 'static,
    ) -> Result<Output, RemovedWorktreeStoreError> {
        self.deps
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorktreeRowsReadError>(read(connection)?)
            })
            .await
            .map_err(RemovedWorktreeStoreError::failed)
    }

    async fn write(
        &self,
        statements: Vec<WriteStatement>,
    ) -> Result<(), RemovedWorktreeStoreError> {
        self.deps
            .writer
            .write(statements)
            .await
            .map(drop)
            .map_err(RemovedWorktreeStoreError::failed)
    }
}

/// One discard's writes to its kept copy's row, each before what it names is made.
pub(crate) struct PendingKeptCopy<'a> {
    store: &'a RemovedWorktreeStore,
    record: KeptWorktreeRecord,
}

impl KeptCopyRowWrites for PendingKeptCopy<'_> {
    async fn record_pending(&self) -> Result<(), RowWriteError> {
        Ok(self
            .store
            .write(vec![insert_pending_statement(&self.record)])
            .await?)
    }

    async fn record_state(&self, state: &KeptWorktreeState) -> Result<(), RowWriteError> {
        Ok(self
            .store
            .write(vec![record_kept_state_statement(
                &self.record.removed_worktree_id,
                state,
            )])
            .await?)
    }

    async fn forget_pending(&self) -> Result<(), RowWriteError> {
        Ok(self
            .store
            .forget_pending(&self.record.removed_worktree_id)
            .await?)
    }
}

// The kept copy as a put-back's copy and its undo report it, its figures left for the copy.
fn put_back_copy(kept: &RemovedWorktreeRow) -> WorktreeCopy {
    WorktreeCopy::PuttingBack {
        removed_worktree_id: kept.removed_worktree_id,
        project_id: kept.project_id,
        name: kept.worktree_name.clone(),
        copied_bytes: SafeInt::ZERO,
        total_bytes: SafeInt::ZERO,
    }
}

impl From<HeldWorkEnd> for RemovedWorktreeStoreError {
    fn from(end: HeldWorkEnd) -> Self {
        match end {
            HeldWorkEnd::Unanswered => Self::Unanswered,
            HeldWorkEnd::Interrupted(interrupted) => Self::Interrupted(interrupted),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_fixture;
#[cfg(test)]
mod tests;
