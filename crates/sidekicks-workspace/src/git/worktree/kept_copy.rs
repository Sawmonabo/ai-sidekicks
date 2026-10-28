//! The kept copy of a discarded worktree, on disk and in the repository: moving the tree aside
//! whole with git's record of it, the objects its index needs and the commits its state names, then
//! deleting and measuring what it keeps. The kept folder holds the tree under `worktree/`, git's
//! per-worktree record under `record/`, the index's objects HEAD's tree lacks as one pack under
//! `objects/`, the LFS objects its staged pointers name under `lfs-objects/` and, for a repository
//! that keeps its refs apart, the tree's refs under `ref-store/`. The commits are pinned as refs
//! under `refs/sidekicks/removed/<removed id>/`, which `git gc` keeps. The record keeps its lock:
//! nothing here unlocks a record or prunes the repository's records.
//!
//! A move aside writes the kept copy's row first, so a crash leaves nothing the row does not list.
//! Beside that write it reads git's record of the tree, HEAD and `ORIG_HEAD`, the index's objects
//! HEAD's tree lacks and where the repository keeps its LFS objects and its refs; then it copies
//! the record (its location files and git's file-watch socket and cookies left out), packs the
//! objects and keeps the LFS objects and the payload refs; then it pins the commits the copied
//! record's state names and reads its branch. Every step of a stage settles before a failure cleans
//! up, and the row goes only once that cleanup succeeded, so one that fails leaves the row for the
//! repair. The row is then filled in with what the copy records, and the folder moves by one
//! rename, or across volumes by a copy that keeps both when the original cannot be removed
//! completely. The caller removes git's record, and the payload refs with it, once the move is
//! recorded.

pub mod folder_move;
pub(crate) mod held_work;
pub(crate) mod pins;
pub(crate) mod saved_state;

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_contracts::worktree::lifecycle::RemovedWorktreeId;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use tokio::task::JoinError;

use crate::git::process::{GitError, GitRunner};
use crate::git::worktree::copy::{TreeCopyError, TreeCopyPolicy, copy_tree};
use crate::git::worktree::kept_copy::folder_move::{
    FileSizeWalkError, FolderMoveError, FolderMoveTools, HardLinkCount, move_folder, rename_folder,
    rename_or_copy_folder, sum_file_sizes,
};
use crate::git::worktree::kept_copy::pins::{delete_pins, write_pins};
use crate::git::worktree::kept_copy::saved_state::{
    RepositoryStoreSettings, SavedStateError, keep_lfs_objects, keep_ref_store,
    list_index_objects_missing_from_head, pack_objects, read_head_refs, read_kept_branch,
    read_state_pins,
};
use crate::git::worktree::reads::{
    LinkedTreeRecordError, RECORD_COMMONDIR_FILE_NAME, RECORD_GITDIR_FILE_NAME,
    common_folder_of_record, read_linked_tree_record,
};
use crate::git::worktree::service::remove_folder;

/// The entry of a kept folder that holds the tree itself.
pub(crate) const KEPT_TREE_ENTRY: &str = "worktree";
// Where a deletion moves the kept tree first, a name nothing else reads; a rename within one
// folder is atomic, so the tree is either whole under its own name or no longer under it.
const KEPT_TREE_DELETING_ENTRY: &str = "worktree.deleting";
/// The entry of a kept folder that holds git's per-worktree record of the tree.
pub(crate) const KEPT_RECORD_ENTRY: &str = "record";
/// The entry of a kept folder that holds the pack of the index's objects HEAD's tree lacks.
pub(crate) const KEPT_OBJECTS_ENTRY: &str = "objects";
/// The entry of a kept folder that holds the LFS objects the tree's staged pointers name.
pub(crate) const KEPT_LFS_ENTRY: &str = "lfs-objects";
/// The entry of a kept folder that holds the tree's refs, for a repository that keeps its refs
/// apart from its git folder.
pub(crate) const KEPT_REF_STORE_ENTRY: &str = "ref-store";

// What a record holds that a kept copy leaves out: the files naming where its tree lives, which a
// put-back writes afresh, and git's file-watch socket and cookie folder, which a copy cannot take
// and a running watch churns. A `locked` file is kept, so a locked tree comes back locked.
const RECORD_ENTRIES_LEFT_OUT: [&str; 4] = [
    RECORD_GITDIR_FILE_NAME,
    RECORD_COMMONDIR_FILE_NAME,
    "fsmonitor--daemon.ipc",
    "fsmonitor--daemon",
];

const KEEPING_THE_WORKTREE: &str = "keeping the worktree";

/// A row write's own failure, kept whole.
pub(crate) type RowWriteError = Box<dyn Error + Send + Sync>;

/// The writes a move aside makes to the kept copy's row, each before what it names is made.
pub(crate) trait KeptCopyRowWrites: Sync {
    /// Writes the row naming the kept folder and the pins; runs before either is made. Fails with
    /// the write's failure.
    fn record_pending(&self) -> impl Future<Output = Result<(), RowWriteError>> + Send;

    /// Fills in what the copy records; runs before the tree moves. Fails with the write's failure.
    fn record_state(
        &self,
        state: &KeptWorktreeState,
    ) -> impl Future<Output = Result<(), RowWriteError>> + Send;

    /// Deletes the row of a move that failed, once everything the row lists is gone. Fails with
    /// the write's failure.
    fn forget_pending(&self) -> impl Future<Output = Result<(), RowWriteError>> + Send;
}

/// The git runner a kept copy's reads and pins run through, at the project's place, and where its
/// folder moves report.
#[derive(Clone, Copy)]
pub(crate) struct KeptCopyTools<'a> {
    /// The one git runner.
    pub(crate) git: &'a GitRunner,
    /// Where the project lives, which every git call runs at.
    pub(crate) place: Option<&'a Place>,
    /// Where a copy across volumes reports, and the leftover names it holds.
    pub(crate) folder_moves: FolderMoveTools<'a>,
}

/// A tree to move aside and where its kept copy goes.
#[derive(Clone, Copy)]
pub(crate) struct WorktreeAside<'a> {
    /// The tree's folder.
    pub(crate) tree_folder: &'a Path,
    /// The kept copy's folder, made by the move.
    pub(crate) kept_folder: &'a Path,
    /// The kept copy, whose id names its pins.
    pub(crate) removed_worktree_id: &'a RemovedWorktreeId,
    /// The removal as a copy across volumes reports it, its figures left for the copy to fill.
    pub(crate) copy: &'a WorktreeCopy,
}

/// What a tree's kept copy records about it, known before the folder moves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeptWorktreeState {
    /// The commit HEAD named.
    pub(crate) head_commit: GitObjectId,
    /// The branch HEAD named, or in a rebase the branch being rebased; `None` while detached.
    pub(crate) branch: Option<String>,
    /// Git's record of the tree in the repository, as git named it from inside the live tree.
    pub(crate) record_folder: PathBuf,
}

/// A tree moved aside, whose record and payload refs the caller removes once the move is kept,
/// with its undo.
#[derive(Debug)]
pub(crate) struct MovedAsideWorktree {
    /// What the kept copy records.
    pub(crate) state: KeptWorktreeState,
    /// The tree's refs folder in the repository's refs payload, which goes with the record; `None`
    /// for refs kept in the git folder.
    pub(crate) ref_store_folder: Option<PathBuf>,
    tree_folder: PathBuf,
    kept_folder: PathBuf,
    common_folder: PathBuf,
    removed_worktree_id: RemovedWorktreeId,
    copy: WorktreeCopy,
}

/// One step of keeping a tree's saved state that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeepStepError {
    /// The kept copy's row could not be written.
    #[error("the kept copy's row could not be written")]
    Row(#[source] RowWriteError),
    /// The kept folder could not be made.
    #[error("the kept folder could not be made")]
    KeptFolder(#[source] io::Error),
    /// git's record of the tree could not be read.
    #[error("git's record of the worktree could not be read")]
    Record(#[source] LinkedTreeRecordError),
    /// The tree has no record of its own in the repository.
    #[error("the worktree has no record of its own in the repository")]
    NoOwnRecord,
    /// A read or a keep of the saved state failed.
    #[error(transparent)]
    State(SavedStateError),
    /// The commits the saved state names could not be pinned.
    #[error("the kept copy's commits could not be pinned")]
    Pins(#[source] GitError),
    /// git's record of the tree could not be listed for its copy.
    #[error("git's record of the worktree could not be listed")]
    RecordListing(#[source] io::Error),
    /// git's record of the tree could not be copied.
    #[error("git's record of the worktree could not be copied")]
    RecordCopy(#[source] TreeCopyError),
    /// The blocking task that copied the record ended before it finished.
    #[error("the copy of git's record ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// Why a move aside failed before the tree moved, or the move refused.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeepFailure {
    /// A step of keeping the saved state failed.
    #[error(transparent)]
    Steps(#[from] SettleFailures<KeepStepError>),
    /// The kept copy's state could not be recorded on its row.
    #[error("the kept copy's state could not be recorded")]
    RecordState(#[source] RowWriteError),
    /// The tree did not move; [`FolderMoveError::Held`] is a program holding a file in it open.
    #[error(transparent)]
    Move(#[from] FolderMoveError),
}

/// Why cleaning up after a failed move aside failed; the row stays for the repair.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeptCopyCleanupError {
    /// The kept copy could not be deleted.
    #[error(transparent)]
    Delete(#[from] KeptCopyDeleteError),
    /// The pending row could not be deleted.
    #[error("the kept copy's pending row could not be deleted")]
    ForgetPending(#[source] RowWriteError),
}

/// Why a tree was not moved aside.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MoveAsideError {
    /// It failed before the tree moved, or the move refused: what it made is removed and its row
    /// deleted, unless that cleanup failed too, whose failures it carries.
    #[error(transparent)]
    Failed(#[from] CleanupFailures<KeepFailure, KeptCopyCleanupError>),
    /// The tree was copied whole into the kept folder across volumes, but the original could not
    /// be removed completely: both are kept, and nothing was deleted to undo it.
    #[error(
        "the worktree was copied whole to its kept place, but the original could not be removed \
         completely; both are kept"
    )]
    Incomplete(#[source] io::Error),
}

/// One part of a kept copy's deletion that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeptCopyPartError {
    /// The pins could not be deleted.
    #[error("the kept copy's pins could not be deleted")]
    Pins(#[source] GitError),
    /// The kept folder could not be removed.
    #[error("the kept folder could not be removed")]
    Folder(#[source] io::Error),
}

/// Why a kept copy was not deleted; a second call finishes one that failed part way.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeptCopyDeleteError {
    /// The kept tree could not be taken off its name; nothing was deleted.
    #[error("the kept tree could not be taken off its name")]
    TreeRename(#[source] io::Error),
    /// The pins or the folder could not be deleted.
    #[error(transparent)]
    Parts(#[from] SettleFailures<KeptCopyPartError>),
}

/// Why a moved-aside tree was not put back where it was.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeptCopyUndoError {
    /// The tree did not move back.
    #[error("the worktree could not be moved back")]
    Move(#[source] FolderMoveError),
    /// The tree is back, but its kept copy could not be deleted.
    #[error(transparent)]
    Delete(#[from] KeptCopyDeleteError),
}

/// Moves a tree aside whole into its kept folder, as the module describes. Fails with
/// [`MoveAsideError::Incomplete`] with both kept, and otherwise with [`MoveAsideError::Failed`],
/// having removed what it made and then its row, which stays when that cleanup fails; a move a
/// program's open file refused is [`KeepFailure::Move`] of [`FolderMoveError::Held`].
pub(crate) async fn move_worktree_aside(
    tools: KeptCopyTools<'_>,
    aside: WorktreeAside<'_>,
    row_writes: &impl KeptCopyRowWrites,
) -> Result<MovedAsideWorktree, MoveAsideError> {
    let mut is_pending_written = false;
    let mut known_common_folder = None;
    let kept = keep_saved_state(
        tools,
        aside,
        row_writes,
        &mut is_pending_written,
        &mut known_common_folder,
    )
    .await;
    let failure = match kept {
        Err(failures) => KeepFailure::Steps(failures),
        Ok(kept) => match row_writes.record_state(&kept.state).await {
            Err(failure) => KeepFailure::RecordState(failure),
            Ok(()) => {
                let kept_tree = aside.kept_folder.join(KEPT_TREE_ENTRY);
                match move_folder(
                    tools.folder_moves,
                    aside.tree_folder,
                    &kept_tree,
                    aside.copy.clone(),
                )
                .await
                {
                    Ok(()) => {
                        return Ok(MovedAsideWorktree {
                            state: kept.state,
                            ref_store_folder: kept.ref_store_folder,
                            tree_folder: aside.tree_folder.to_path_buf(),
                            kept_folder: aside.kept_folder.to_path_buf(),
                            common_folder: kept.common_folder,
                            removed_worktree_id: *aside.removed_worktree_id,
                            copy: aside.copy.clone(),
                        });
                    }
                    // Both copies stand, so nothing of either is deleted.
                    Err(FolderMoveError::Incomplete(source)) => {
                        return Err(MoveAsideError::Incomplete(source));
                    }
                    Err(failure) => KeepFailure::Move(failure),
                }
            }
        },
    };
    let mut cleanup_failures = Vec::new();
    match delete_kept_copy(
        tools.git,
        tools.place,
        aside.kept_folder,
        known_common_folder.as_deref(),
        aside.removed_worktree_id,
    )
    .await
    {
        Err(failure) => cleanup_failures.push(KeptCopyCleanupError::Delete(failure)),
        // Only once nothing it lists is left: a row kept after a failed cleanup lets the repair
        // delete what is left.
        Ok(()) if is_pending_written => {
            if let Err(failure) = row_writes.forget_pending().await {
                cleanup_failures.push(KeptCopyCleanupError::ForgetPending(failure));
            }
        }
        Ok(()) => {}
    }
    Err(CleanupFailures::new(failure, cleanup_failures, "moving the worktree aside").into())
}

impl MovedAsideWorktree {
    /// Moves the tree back where it was, then deletes the pins and the kept folder, leaving git's
    /// record as it was. Fails as the move back or the deletion does; a failed deletion leaves the
    /// tree back and the row unfinished for the repair.
    pub(crate) async fn undo(&self, tools: KeptCopyTools<'_>) -> Result<(), KeptCopyUndoError> {
        // Its copy back still reads as the removal: the removal is under way until it ends or
        // fails. The tree is whole once back, so the kept tree goes by the deletion's rename aside,
        // never removed in place under its own name.
        rename_or_copy_folder(
            tools.folder_moves,
            &self.kept_folder.join(KEPT_TREE_ENTRY),
            &self.tree_folder,
            self.copy.clone(),
        )
        .await
        .map_err(KeptCopyUndoError::Move)?;
        delete_kept_copy(
            tools.git,
            tools.place,
            &self.kept_folder,
            Some(&self.common_folder),
            &self.removed_worktree_id,
        )
        .await?;
        Ok(())
    }
}

/// Deletes a kept copy for good: first takes its tree off the kept tree's name, so a deletion that
/// fails part way never leaves a partial tree that reads as whole, then deletes its pins, in the
/// repository whose git common folder is `common_folder` when one is known, and its folder at
/// once. Any part already gone is no failure, so a second call finishes one that failed part way.
/// Fails with the rename's failure, deleting nothing, or with the parts' failures.
pub(crate) async fn delete_kept_copy(
    git: &GitRunner,
    place: Option<&Place>,
    kept_folder: &Path,
    common_folder: Option<&Path>,
    removed_worktree_id: &RemovedWorktreeId,
) -> Result<(), KeptCopyDeleteError> {
    match rename_folder(
        &kept_folder.join(KEPT_TREE_ENTRY),
        &kept_folder.join(KEPT_TREE_DELETING_ENTRY),
    )
    .await
    {
        // A copy put back by a move, a discard undone or cut short, or a deletion tried before, has
        // no tree there.
        Err(failure) if failure.kind() != io::ErrorKind::NotFound => {
            return Err(KeptCopyDeleteError::TreeRename(failure));
        }
        Ok(()) | Err(_) => {}
    }
    let pins_deleted = async {
        match common_folder {
            Some(common_folder) => delete_pins(git, place, common_folder, removed_worktree_id)
                .await
                .map_err(KeptCopyPartError::Pins),
            None => Ok(()),
        }
    };
    let folder_removed = async {
        remove_folder(kept_folder)
            .await
            .map_err(KeptCopyPartError::Folder)
    };
    settle_all(
        tokio::join!(pins_deleted, folder_removed),
        "deleting the kept copy",
    )?;
    Ok(())
}

/// The kept copy's size on disk: every file under `kept_folder`, a file hard-linked twice counted
/// once. Fails with the walk's failure.
pub(crate) async fn measure_kept_copy(kept_folder: &Path) -> Result<u64, FileSizeWalkError> {
    let kept_folder = kept_folder.to_path_buf();
    tokio::task::spawn_blocking(move || sum_file_sizes(&kept_folder, HardLinkCount::OncePerFile))
        .await
        .map_err(FileSizeWalkError::Interrupted)?
}

// What the saved-state steps kept, for the row and the move.
struct KeptSavedState {
    state: KeptWorktreeState,
    ref_store_folder: Option<PathBuf>,
    common_folder: PathBuf,
}

// The settled steps of a move aside, in three stages, each waiting only for the reads before it;
// every step of a stage settles before a failure is answered. Sets `is_pending_written` once the
// row is written and `known_common_folder` once git's record is read, for the cleanup.
async fn keep_saved_state(
    tools: KeptCopyTools<'_>,
    aside: WorktreeAside<'_>,
    row_writes: &impl KeptCopyRowWrites,
    is_pending_written: &mut bool,
    known_common_folder: &mut Option<PathBuf>,
) -> Result<KeptSavedState, SettleFailures<KeepStepError>> {
    let KeptCopyTools { git, place, .. } = tools;
    let WorktreeAside {
        tree_folder,
        kept_folder,
        removed_worktree_id,
        ..
    } = aside;

    let kept_folder_made = async {
        row_writes
            .record_pending()
            .await
            .map_err(KeepStepError::Row)?;
        *is_pending_written = true;
        tokio::fs::create_dir_all(kept_folder)
            .await
            .map_err(KeepStepError::KeptFolder)
    };
    let record_read = async {
        read_linked_tree_record(git, place, tree_folder)
            .await
            .map_err(KeepStepError::Record)?
            .ok_or(KeepStepError::NoOwnRecord)
    };
    let head_read = async {
        read_head_refs(git, place, tree_folder)
            .await
            .map_err(KeepStepError::State)
    };
    let missing_read = async {
        list_index_objects_missing_from_head(git, place, tree_folder)
            .await
            .map_err(KeepStepError::State)
    };
    let settings_read = async {
        RepositoryStoreSettings::read(git, place, tree_folder)
            .await
            .map_err(KeepStepError::State)
    };
    let (record_folder, head, missing_from_head, settings) = match tokio::join!(
        kept_folder_made,
        record_read,
        head_read,
        missing_read,
        settings_read
    ) {
        (Ok(()), Ok(record), Ok(head), Ok(missing), Ok(settings)) => {
            (record, head, missing, settings)
        }
        (made, record, head, missing, settings) => {
            return Err(failures_of([
                made.err(),
                record.err(),
                head.err(),
                missing.err(),
                settings.err(),
            ]));
        }
    };
    let common_folder = common_folder_of_record(&record_folder)
        .expect("a linked tree's record sits two folders below its common folder")
        .to_path_buf();
    *known_common_folder = Some(common_folder.clone());

    let kept_record = kept_folder.join(KEPT_RECORD_ENTRY);
    let record_copied = copy_record(&record_folder, &kept_record);
    let objects_packed = async {
        let objects_folder = kept_folder.join(KEPT_OBJECTS_ENTRY);
        pack_objects(git, place, tree_folder, &objects_folder, &missing_from_head)
            .await
            .map_err(KeepStepError::State)
    };
    let lfs_objects_kept = async {
        let lfs_store = settings.lfs_store(&common_folder);
        keep_lfs_objects(
            git,
            place,
            tree_folder,
            &lfs_store,
            kept_folder,
            &missing_from_head,
        )
        .await
        .map_err(KeepStepError::State)
    };
    let ref_store_kept = async {
        match settings.ref_store_payload(&common_folder) {
            Some(payload) => keep_ref_store(&payload, &record_folder, kept_folder)
                .await
                .map_err(KeepStepError::State),
            None => Ok::<_, KeepStepError>(None),
        }
    };
    let ref_store_folder = match tokio::join!(
        record_copied,
        objects_packed,
        lfs_objects_kept,
        ref_store_kept
    ) {
        (Ok(()), Ok(()), Ok(()), Ok(ref_store_folder)) => ref_store_folder,
        (copied, packed, lfs, ref_store) => {
            return Err(failures_of([
                copied.err(),
                packed.err(),
                lfs.err(),
                ref_store.err(),
            ]));
        }
    };

    // The state files are read from the copy, so the pins match what is kept.
    let pins_written = async {
        let pins = read_state_pins(&kept_record, &head)
            .await
            .map_err(KeepStepError::State)?;
        write_pins(git, place, &common_folder, removed_worktree_id, &pins)
            .await
            .map_err(KeepStepError::Pins)
    };
    let branch_read = async {
        read_kept_branch(&kept_record, head.branch.clone())
            .await
            .map_err(KeepStepError::State)
    };
    let branch = match tokio::join!(pins_written, branch_read) {
        (Ok(()), Ok(branch)) => branch,
        (pinned, branch) => return Err(failures_of([pinned.err(), branch.err()])),
    };
    Ok(KeptSavedState {
        state: KeptWorktreeState {
            head_commit: head.commit,
            branch,
            record_folder,
        },
        ref_store_folder,
        common_folder,
    })
}

// The failures of a stage whose steps have all settled, at least one of them failed.
fn failures_of<const STEPS: usize>(
    failures: [Option<KeepStepError>; STEPS],
) -> SettleFailures<KeepStepError> {
    let outcomes: Vec<Result<(), KeepStepError>> =
        failures.into_iter().flatten().map(Err).collect();
    settle_all(outcomes, KEEPING_THE_WORKTREE)
        .expect_err("a stage answers its failures only when a step failed")
}

// Copies each entry of git's record of the tree into `kept_record`, but those it leaves out, cloned
// where the volume can.
async fn copy_record(record_folder: &Path, kept_record: &Path) -> Result<(), KeepStepError> {
    let (record_folder, kept_record) = (record_folder.to_path_buf(), kept_record.to_path_buf());
    tokio::task::spawn_blocking(move || {
        fs::create_dir(&kept_record).map_err(KeepStepError::RecordListing)?;
        for entry in fs::read_dir(&record_folder).map_err(KeepStepError::RecordListing)? {
            let name = entry.map_err(KeepStepError::RecordListing)?.file_name();
            if RECORD_ENTRIES_LEFT_OUT
                .iter()
                .any(|left_out| name == *left_out)
            {
                continue;
            }
            copy_tree(
                &record_folder.join(&name),
                &kept_record.join(&name),
                TreeCopyPolicy::IntoEmpty,
                None,
            )
            .map_err(KeepStepError::RecordCopy)?;
        }
        Ok(())
    })
    .await
    .map_err(KeepStepError::Interrupted)?
}
