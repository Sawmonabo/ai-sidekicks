//! Removing a worktree the daemon made. A plain removal is refused while an agent runs in the tree
//! or while the tree holds anything to lose, ignored files included; it records the retirement and
//! leaves the folder to the cleanup's sweep. A discard keeps the tree whole: it ends the processes
//! working in it and git's file-watch daemon for it, writes the kept copy's row, moves the tree
//! aside with everything git needs to put it back, records the retirement and the finished kept
//! copy in one write, then removes the tree's own record from the repository. Either way every
//! session in the tree is moved back to the repository's own checkout. A retired tree the sweep
//! finds holding something new is kept aside the same way.
//!
//! Every path that moves or deletes a tree's folder first ends the processes the daemon started
//! in it, the owners of those processes all together. One tree's removals and keepings aside take
//! turns, each run in a task of its own that holds the tree's turn and the owners' holds until it
//! ends, so a caller that stops waiting never leaves half of one done, lets no second removal in
//! and lets no process start in the folder before its move lands; the second of two pressed
//! together finds the tree retired. A discard's move and its record run on the kept copy's lock,
//! the one the removed list's put-back and deletion take. A tree's sessions are swept once that
//! lock is let go, since the sweep takes the workspace locks, which come before it, and while the
//! folder's opens are still held. The discards a crash cut short are put right first, by the
//! repair.

mod repair;

use std::error::Error;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_contracts::worktree::lifecycle::{
    KeptWorktree, RemovedWorktreeId, RetiredWorktreeState, WorktreeId,
    WorktreeRetireConflictDetails, WorktreeRetireIncompleteDetails, WorktreeRetireRequest,
    WorktreeRetireResponse, WorktreeState,
};
use sidekicks_platforms::DOES_WATCH_OUTLIVE_TREE_MOVE;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::settle_all::settle_all;
use tokio::task::JoinError;

pub use self::repair::{InterruptedKeptCopyFailure, InterruptedKeptCopyRepair};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::branch_name_pattern::last_fatal_line;
use crate::git::process::{GitError, GitRunner};
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::kept_copy::folder_move::FolderMoveError;
use crate::git::worktree::kept_copy::held_work::{
    HeldWorkEnd, HeldWorkSubject, held_answer, log_landed_late,
};
use crate::git::worktree::kept_copy::{
    KEPT_TREE_ENTRY, KeepFailure, KeptCopyTools, MoveAsideError, MovedAsideWorktree, WorktreeAside,
    move_worktree_aside,
};
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::reads::tree_name_of;
use crate::git::worktree::removed_store::rows::{KeptWorktreeRecord, finish_statement};
use crate::git::worktree::removed_store::{
    RemovedWorktreeStore, RemovedWorktreeStoreError, kept_folder_for,
};
use crate::git::worktree::risks::{has_something_to_lose, read_removal_risks};
use crate::git::worktree::rows::{AttachedMountRow, WorktreeRow};
use crate::git::worktree::service::cleanup::{RetiredWorktreeKeeper, stop_file_watch};
use crate::git::worktree::service::{
    RecordRetirementOptions, WorktreeService, WorktreeServiceError, remove_folder,
};

/// What an owner keeps holding once its processes in a folder have ended, so none starts there
/// again until it drops; its caller drops it once the folder's move or deletion has landed.
pub type FolderProcessHold = Box<dyn Send + Sync>;

/// An owner of processes the daemon started, which ends those working in a folder about to be
/// moved or deleted: the setup card's commands, the Terminal pane's shells.
pub trait FolderProcessOwner: Send + Sync {
    /// Ends every process this owner started whose working folder is `folder` or inside it,
    /// answering once each has exited, with the hold that keeps new ones out of the folder. Fails
    /// with the owner's failure, naming what was not ended.
    fn end_processes_in_folder<'a>(
        &'a self,
        folder: &'a Path,
    ) -> BoxFuture<'a, Result<FolderProcessHold, Box<dyn Error + Send + Sync>>>;
}

/// Why the processes in a folder were not all ended: each owner's failure, in the owners' order.
#[derive(Debug)]
pub struct FolderProcessesEndError {
    /// Each failing owner's failure, kept whole.
    pub failures: Vec<Box<dyn Error + Send + Sync>>,
}

impl fmt::Display for FolderProcessesEndError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the processes started in the folder could not all be ended")?;
        for failure in &self.failures {
            write!(formatter, "; {}", describe_error(failure.as_ref()))?;
        }
        Ok(())
    }
}

impl Error for FolderProcessesEndError {}

/// Ends the processes every one of `owners` started in `folder` or inside it, the owners running
/// together and all settling before this answers, so nothing still runs there once it fails.
/// Answers every owner's hold, which the caller keeps until the folder's move or deletion lands.
/// Fails with every owner's failure.
pub(crate) async fn end_processes_in_folder(
    owners: &[Arc<dyn FolderProcessOwner>],
    folder: &Path,
) -> Result<Vec<FolderProcessHold>, FolderProcessesEndError> {
    let mut holds = Vec::new();
    let mut failures = Vec::new();
    for ended in join_all(
        owners
            .iter()
            .map(|owner| owner.end_processes_in_folder(folder)),
    )
    .await
    {
        match ended {
            Ok(hold) => holds.push(hold),
            Err(failure) => failures.push(failure),
        }
    }
    if failures.is_empty() {
        Ok(holds)
    } else {
        Err(FolderProcessesEndError { failures })
    }
}

/// The removed tree whose sessions a sweep moves out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeSweep {
    /// The mount the tree was on.
    pub repo_mount_id: RepoMountId,
    /// The tree.
    pub worktree_id: WorktreeId,
    /// The tree's folder, as its row stores it.
    pub folder: FilesystemPath,
}

/// Moves every session out of a removed tree.
pub trait WorktreeSessionSweep: Send + Sync {
    /// Moves every session standing in the swept folder to the repository's own checkout, clears
    /// every pending move to it, and records one `session.swept_to_repo_root` per session. It runs
    /// while the folder's opens are held, so it never waits on an open in the folder. Fails with
    /// the move's failure; a later sweep of the same tree finishes it.
    fn sweep_to_repo_root<'a>(
        &'a self,
        sweep: &'a WorktreeSweep,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What the removal runs with; the kept copy's lock, the names in use and the copies under way
/// are the store's, so the removal and the store never hold two.
pub struct WorktreeRemovalDeps {
    /// The daemon's git entry point.
    pub git: GitRunner,
    /// The worktree service, which reads and retires the tree's row.
    pub worktrees: Arc<WorktreeService>,
    /// The kept worktrees' store, which writes and lists the kept copy's row.
    pub removed_worktrees: Arc<RemovedWorktreeStore>,
    /// The daemon's one occupancy reader, for the sessions standing in a tree.
    pub occupancy: MountOccupancyReader,
    /// Every owner of processes the daemon starts in a tree, each ended before the tree moves.
    pub process_owners: Vec<Arc<dyn FolderProcessOwner>>,
    /// Moves a removed tree's sessions back to the repository's checkout.
    pub sessions: Arc<dyn WorktreeSessionSweep>,
    /// The daemon's worktrees folder, where the repair looks for copies a crash left.
    pub worktrees_folder: PathBuf,
}

/// Why a removal, a keeping aside or a repair failed.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeRemovalError {
    /// The removal was refused: an unknown tree, an agent running in it, something to lose, a
    /// folder a program holds, or a copy across volumes whose original stayed.
    #[error(transparent)]
    Refused(#[from] WorktreeRefusal),
    /// A process the daemon started in the tree could not be ended; nothing moved.
    #[error(transparent)]
    EndProcesses(#[from] FolderProcessesEndError),
    /// git's file-watch daemon for the tree could not be stopped; nothing moved.
    #[error("{}", file_watch_stop_message(.line.as_deref()))]
    FileWatchStop {
        /// git's last `fatal:` line, when it wrote one.
        line: Option<String>,
        /// git's failure.
        #[source]
        source: GitError,
    },
    /// Whether a folder exists could not be read, or a leftover copy could not be removed.
    #[error("a worktree's folder could not be read or removed")]
    Folder(#[source] io::Error),
    /// The tree's sessions could not be moved to the repository's checkout.
    #[error("the worktree's sessions could not be moved to the repository's checkout")]
    Sweep(#[source] Box<dyn Error + Send + Sync>),
    /// git's record of the moved tree could not be removed, once its retirement was recorded.
    #[error("{}", record_removal_message(.sweep.as_deref()))]
    RecordRemoval {
        /// The removal's failure.
        #[source]
        record: Box<dyn Error + Send + Sync>,
        /// The sweep's failure, when the sweep after it failed too.
        sweep: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A read, a write, a git call or a file step failed.
    #[error(transparent)]
    Failed(Box<dyn Error + Send + Sync>),
    /// The task that ran the removal or the keeping aside ended before it finished.
    #[error("the removal ended before it finished")]
    Interrupted(#[source] JoinError),
    /// The removal or the keeping aside ended without an answer.
    #[error("the removal ended without an answer")]
    Unanswered,
}

impl From<WorktreeServiceError> for WorktreeRemovalError {
    fn from(failure: WorktreeServiceError) -> Self {
        match failure {
            WorktreeServiceError::Refused(refusal) => Self::Refused(refusal),
            failure @ (WorktreeServiceError::MountRefused(_)
            | WorktreeServiceError::AlreadyRetired { .. }
            | WorktreeServiceError::RowVanished { .. }
            | WorktreeServiceError::RowMoved(_)
            | WorktreeServiceError::Pool(_)
            | WorktreeServiceError::Database(_)
            | WorktreeServiceError::Write(_)
            | WorktreeServiceError::Emit(_)
            | WorktreeServiceError::Folder(_)
            | WorktreeServiceError::RiskRead(_)
            | WorktreeServiceError::RiskReadAndRetirement { .. }) => {
                Self::Failed(Box::new(failure))
            }
        }
    }
}

impl From<RemovedWorktreeStoreError> for WorktreeRemovalError {
    fn from(failure: RemovedWorktreeStoreError) -> Self {
        match failure {
            RemovedWorktreeStoreError::Refused(refusal) => Self::Refused(refusal),
            RemovedWorktreeStoreError::Failed(failure) => Self::Failed(failure),
            RemovedWorktreeStoreError::Interrupted(interrupted) => Self::Interrupted(interrupted),
            RemovedWorktreeStoreError::Unanswered => Self::Unanswered,
        }
    }
}

fn file_watch_stop_message(line: Option<&str>) -> String {
    let message = "the worktree's git file-watch daemon could not be stopped";
    match line {
        Some(line) => format!("{message}: {line}"),
        None => message.to_owned(),
    }
}

fn record_removal_message(sweep: Option<&(dyn Error + Send + Sync + 'static)>) -> String {
    let message = "git's record of the moved worktree could not be removed";
    match sweep {
        Some(sweep) => format!(
            "{message}; moving its sessions to the repository's checkout failed too: {}",
            describe_error(sweep)
        ),
        None => message.to_owned(),
    }
}

// The stop's failure, carrying git's line.
fn file_watch_stop_failed(source: GitError) -> WorktreeRemovalError {
    let line = match &source {
        GitError::Exited { stderr, .. } => last_fatal_line(stderr).map(str::to_owned),
        GitError::WslPlace { .. }
        | GitError::NotFound
        | GitError::Start(_)
        | GitError::TimedOut { .. }
        | GitError::OutputTooLarge { .. }
        | GitError::Read(_)
        | GitError::PathText(_)
        | GitError::NotStartable => None,
    };
    WorktreeRemovalError::FileWatchStop { line, source }
}

/// Answers `worktree.retire`, keeps aside a retired tree the sweep must not delete, and puts right
/// the discards a crash cut short.
pub struct WorktreeRemoval {
    shared: Arc<RemovalShared>,
}

// What the removal and the work it runs in its own task share.
struct RemovalShared {
    deps: WorktreeRemovalDeps,
    // Held per tree by the task of a removal or a keeping aside, from its first read to its end.
    retirements: Arc<KeyedLock<WorktreeId>>,
}

// git's record of a moved tree that could not be removed, kept to report once the tree's sessions
// are swept.
type RecordRemovalFailure = Box<dyn Error + Send + Sync>;

impl WorktreeRemoval {
    /// A removal over `deps`.
    pub fn new(deps: WorktreeRemovalDeps) -> Self {
        Self {
            shared: Arc::new(RemovalShared {
                deps,
                retirements: Arc::new(KeyedLock::new()),
            }),
        }
    }

    /// Removes the tree. A discard of this tree a crash cut short is put right first, and its
    /// failure answered. Refuses `worktree.retireConflict` while an agent runs in the tree, or, for
    /// a plain removal, while it holds anything to lose; a discard refuses
    /// `worktree.retireFolderHeld` when the system refuses the move, and every refusal removes
    /// nothing. A discard whose copy across volumes could not remove the original refuses
    /// `worktree.retireIncomplete`, its copy listed and the tree left live. A tree already retired
    /// has its sessions swept again, so the second of two removals of one tree, which take turns,
    /// answers it retired. Runs whole in a task of its own once the tree's turn comes, even after
    /// its caller stops waiting.
    pub async fn retire(
        &self,
        request: &WorktreeRetireRequest,
    ) -> Result<WorktreeRetireResponse, WorktreeRemovalError> {
        let shared = Arc::clone(&self.shared);
        let held_request = request.clone();
        let landed = self
            .shared
            .retirements
            .run_held(
                request.worktree_id,
                async move { shared.retire(&held_request).await },
                log_landed_late(
                    "removing the worktree",
                    HeldWorkSubject::Worktree(request.worktree_id),
                ),
            )
            .await;
        held_answer(landed)
    }
}

impl RetiredWorktreeKeeper for WorktreeRemoval {
    // Runs whole in a task of its own once the tree's turn comes, which holds `process_holds`
    // until it ends, even after its caller stops waiting.
    fn keep_retired_aside<'a>(
        &'a self,
        row: &'a WorktreeRow,
        process_holds: Vec<FolderProcessHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        let shared = Arc::clone(&self.shared);
        let held_row = row.clone();
        Box::pin(async move {
            let landed = self
                .shared
                .retirements
                .run_held(
                    row.id,
                    async move {
                        let _process_holds = process_holds;
                        shared.keep_retired_aside(&held_row).await
                    },
                    log_landed_late(
                        "keeping the retired worktree aside",
                        HeldWorkSubject::Worktree(row.id),
                    ),
                )
                .await;
            Ok(held_answer(landed)?)
        })
    }
}

impl RemovalShared {
    // The removal `WorktreeRemoval::retire` describes, run in the tree's turn.
    async fn retire(
        self: &Arc<Self>,
        request: &WorktreeRetireRequest,
    ) -> Result<WorktreeRetireResponse, WorktreeRemovalError> {
        let worktrees = &self.deps.worktrees;
        let (row, _) = worktrees
            .require_worktree_at_place(&request.worktree_id)
            .await?;
        self.finish_interrupted_discards_in(&row.fs_root).await?;
        // Read again: the repair may have retired it.
        let (row, place) = worktrees
            .require_worktree_at_place(&request.worktree_id)
            .await?;
        if row.state == WorktreeState::Retired {
            self.sweep(&row)
                .await
                .map_err(WorktreeRemovalError::Sweep)?;
            return Ok(retired(row.id, None));
        }
        let folder = PathBuf::from(row.fs_root.as_str());
        let (running, has_folder) = tokio::join!(
            worktrees.read_running_session(&row.id),
            tokio::fs::try_exists(&folder)
        );
        if let Some(running_session_id) = running? {
            return Err(WorktreeRefusal::RetireConflict {
                details: WorktreeRetireConflictDetails::RootBusy {
                    worktree_id: row.id,
                    running_session_id,
                },
            }
            .into());
        }
        let has_folder = has_folder.map_err(WorktreeRemovalError::Folder)?;
        if !request.discard && has_folder {
            let occupying = self.read_occupying(&row, &folder).await?;
            let risks = read_removal_risks(&self.deps.git, place.as_ref(), &folder, occupying)
                .await
                .map_err(|failure| WorktreeRemovalError::Failed(Box::new(failure)))?;
            if has_something_to_lose(&risks) {
                return Err(WorktreeRefusal::RetireConflict {
                    details: WorktreeRetireConflictDetails::HasChanges {
                        worktree_id: row.id,
                        risks,
                    },
                }
                .into());
            }
        }
        // Held until this task ends, past the move or the sweep.
        let _process_holds = if has_folder {
            end_processes_in_folder(&self.deps.process_owners, &folder).await?
        } else {
            Vec::new()
        };
        if !request.discard || !has_folder {
            self.record_plain_retirement(&row).await?;
            self.sweep(&row)
                .await
                .map_err(WorktreeRemovalError::Sweep)?;
            return Ok(retired(row.id, None));
        }

        let mount = worktrees.require_attached_mount(&row.repo_mount_id).await?;
        stop_file_watch(&self.deps.git, mount.place.as_ref(), &folder)
            .await
            .map_err(file_watch_stop_failed)?;
        let removed_worktree_id = new_removed_worktree_id();
        let record_removal = {
            let _kept_copy = self
                .deps
                .removed_worktrees
                .kept_copy_lock()
                .acquire(removed_worktree_id)
                .await;
            self.discard_held(&row, &mount, removed_worktree_id).await?
        };
        self.sweep_after_record(&row, record_removal).await?;
        Ok(retired(
            row.id,
            Some(KeptWorktree {
                removed_worktree_id,
            }),
        ))
    }

    // Keeps a retired tree aside whole, as a discard would, listing it with its row stamped cleaned
    // in one write; the cleanup ended its processes first. A keeping aside of this tree a crash cut
    // short is put right first and its failure answered, so the tree is never kept aside twice. A
    // move that copied the tree whole but left the original lists the copy and stamps the row, so
    // no later sweep copies it again, and answers `worktree.retireIncomplete`.
    async fn keep_retired_aside(
        self: &Arc<Self>,
        row: &WorktreeRow,
    ) -> Result<(), WorktreeRemovalError> {
        let worktrees = &self.deps.worktrees;
        let folder = PathBuf::from(row.fs_root.as_str());
        if self.finish_interrupted_discards_in(&row.fs_root).await? {
            // A folder left beside the listed copy is no longer the sweep's to copy or delete.
            if tokio::fs::try_exists(&folder)
                .await
                .map_err(WorktreeRemovalError::Folder)?
            {
                worktrees.stamp_cleaned(&row.id).await?;
            }
            return Ok(());
        }
        let mount = worktrees.require_attached_mount(&row.repo_mount_id).await?;
        stop_file_watch(&self.deps.git, mount.place.as_ref(), &folder)
            .await
            .map_err(file_watch_stop_failed)?;
        let removed_worktree_id = new_removed_worktree_id();
        let _kept_copy = self
            .deps
            .removed_worktrees
            .kept_copy_lock()
            .acquire(removed_worktree_id)
            .await;
        self.keep_aside_held(row, &mount, removed_worktree_id).await
    }

    // A discard's work under the kept copy's lock: the move, the retirement with the finished
    // copy, the size read and git's record removed; answers the record removal's failure, which
    // is reported once the sessions are swept.
    async fn discard_held(
        &self,
        row: &WorktreeRow,
        mount: &AttachedMountRow,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<Option<RecordRemovalFailure>, WorktreeRemovalError> {
        let kept_folder = kept_folder_for(row, &removed_worktree_id);
        let moved = self
            .move_aside(row, mount, removed_worktree_id, &kept_folder)
            .await?;
        let recorded = self.deps.worktrees.record_retirement(
            row,
            RecordRetirementOptions {
                removed_worktree_id: Some(removed_worktree_id),
                transactional_prelude: vec![finish_statement(&removed_worktree_id)],
                ..RecordRetirementOptions::default()
            },
        );
        self.record_or_undo(&moved, mount.place.as_ref(), removed_worktree_id, recorded)
            .await?;
        self.deps
            .removed_worktrees
            .measure_later(removed_worktree_id, kept_folder.clone());
        // The move has landed, so a daemon left watching the kept tree is logged, not refused.
        if let Err(failure) = self
            .stop_file_watch_after_move(mount.place.as_ref(), &kept_folder)
            .await
        {
            tracing::warn!(
                removed_worktree_id = %removed_worktree_id,
                error = &failure as &(dyn Error + 'static),
                "git's file-watch daemon could not be stopped at a discarded worktree's kept copy"
            );
        }
        Ok(self.remove_moved_record(&moved).await.err())
    }

    // A keeping aside's work under the kept copy's lock, as a discard's but listing the copy with
    // the row stamped cleaned, and answering the record removal's failure at once.
    async fn keep_aside_held(
        &self,
        row: &WorktreeRow,
        mount: &AttachedMountRow,
        removed_worktree_id: RemovedWorktreeId,
    ) -> Result<(), WorktreeRemovalError> {
        let worktrees = &self.deps.worktrees;
        let kept_folder = kept_folder_for(row, &removed_worktree_id);
        let moved = match self
            .move_aside(row, mount, removed_worktree_id, &kept_folder)
            .await
        {
            Ok(moved) => moved,
            Err(failure) => {
                if matches!(
                    failure,
                    WorktreeRemovalError::Refused(WorktreeRefusal::RetireIncomplete { .. })
                ) {
                    worktrees.stamp_cleaned(&row.id).await?;
                }
                return Err(failure);
            }
        };
        let recorded = worktrees.record_kept_aside(&row.id, finish_statement(&removed_worktree_id));
        self.record_or_undo(&moved, mount.place.as_ref(), removed_worktree_id, recorded)
            .await?;
        self.deps
            .removed_worktrees
            .measure_later(removed_worktree_id, kept_folder.clone());
        if let Err(failure) = self
            .stop_file_watch_after_move(mount.place.as_ref(), &kept_folder)
            .await
        {
            tracing::warn!(
                removed_worktree_id = %removed_worktree_id,
                error = &failure as &(dyn Error + 'static),
                "git's file-watch daemon could not be stopped at a kept-aside worktree's copy"
            );
        }
        self.remove_moved_record(&moved).await.map_err(|record| {
            WorktreeRemovalError::RecordRemoval {
                record,
                sweep: None,
            }
        })
    }

    // Moves the tree aside, its kept copy's row written first. A move that copied the tree whole
    // but left the original lists the kept copy and refuses `worktree.retireIncomplete`; a move a
    // program's open file refused, with nothing left to clean up, refuses
    // `worktree.retireFolderHeld`; any other failure is answered as the move left it.
    async fn move_aside(
        &self,
        row: &WorktreeRow,
        mount: &AttachedMountRow,
        removed_worktree_id: RemovedWorktreeId,
        kept_folder: &Path,
    ) -> Result<MovedAsideWorktree, WorktreeRemovalError> {
        let store = &self.deps.removed_worktrees;
        let tree_folder = PathBuf::from(row.fs_root.as_str());
        let name = tree_name_of(&tree_folder)
            .map_err(|failure| WorktreeRemovalError::Failed(Box::new(failure)))?;
        let copy = WorktreeCopy::Removing {
            worktree_id: row.id,
            project_id: mount.project_id,
            name,
            copied_bytes: SafeInt::ZERO,
            total_bytes: SafeInt::ZERO,
        };
        let row_writes = store.pending_kept_copy(KeptWorktreeRecord {
            removed_worktree_id,
            worktree: row.clone(),
            kept_folder: kept_folder.to_path_buf(),
        });
        let moved = move_worktree_aside(
            self.kept_copy_tools(mount.place.as_ref()),
            WorktreeAside {
                tree_folder: &tree_folder,
                kept_folder,
                removed_worktree_id: &removed_worktree_id,
                copy: &copy,
            },
            &row_writes,
        )
        .await;
        match moved {
            Ok(moved) => Ok(moved),
            Err(MoveAsideError::Incomplete(source)) => {
                store.finish(&removed_worktree_id).await?;
                store.measure_later(removed_worktree_id, kept_folder.to_path_buf());
                Err(WorktreeRefusal::RetireIncomplete {
                    details: WorktreeRetireIncompleteDetails {
                        worktree_id: row.id,
                        removed_worktree_id,
                    },
                    source: Box::new(source),
                }
                .into())
            }
            Err(MoveAsideError::Failed(failure)) if failure.cleanup_failures().is_empty() => {
                match failure.into_parts() {
                    (KeepFailure::Move(FolderMoveError::Held(source)), _, _) => {
                        Err(WorktreeRefusal::RetireFolderHeld {
                            worktree_id: row.id,
                            source,
                        }
                        .into())
                    }
                    (original, cleanup_failures, operation) => Err(WorktreeRemovalError::Failed(
                        Box::new(CleanupFailures::new(original, cleanup_failures, operation)),
                    )),
                }
            }
            Err(MoveAsideError::Failed(failure)) => {
                Err(WorktreeRemovalError::Failed(Box::new(failure)))
            }
        }
    }

    // Records a tree moved aside through `record`; a failed record moves the tree back and
    // deletes the kept copy's row, which stays unfinished for the repair when that undo fails.
    async fn record_or_undo(
        &self,
        moved: &MovedAsideWorktree,
        place: Option<&Place>,
        removed_worktree_id: RemovedWorktreeId,
        record: impl Future<Output = Result<(), WorktreeServiceError>>,
    ) -> Result<(), WorktreeRemovalError> {
        let Err(record_failure) = record.await else {
            return Ok(());
        };
        let undone: Result<(), Box<dyn Error + Send + Sync>> = async {
            moved.undo(self.kept_copy_tools(place)).await?;
            self.deps
                .removed_worktrees
                .forget_pending(&removed_worktree_id)
                .await?;
            Ok(())
        }
        .await;
        match undone {
            Ok(()) => Err(record_failure.into()),
            Err(undo_failure) => Err(WorktreeRemovalError::Failed(Box::new(
                CleanupFailures::new(record_failure, vec![undo_failure], "keeping the worktree"),
            ))),
        }
    }

    // Stops git's file-watch daemon at the kept tree once the tree has moved, where the system's
    // watch outlives a moved tree; the kept tree's `.git` still names the record, so git finds the
    // daemon there. Fails with git's failure.
    async fn stop_file_watch_after_move(
        &self,
        place: Option<&Place>,
        kept_folder: &Path,
    ) -> Result<(), GitError> {
        if !DOES_WATCH_OUTLIVE_TREE_MOVE {
            return Ok(());
        }
        stop_file_watch(&self.deps.git, place, &kept_folder.join(KEPT_TREE_ENTRY)).await
    }

    // Removes git's record of the moved tree and its refs folder in a refs payload, both tried.
    async fn remove_moved_record(
        &self,
        moved: &MovedAsideWorktree,
    ) -> Result<(), RecordRemovalFailure> {
        let ref_store_removed = async {
            match &moved.ref_store_folder {
                Some(ref_store_folder) => remove_folder(ref_store_folder).await,
                None => Ok(()),
            }
        };
        settle_all(
            tokio::join!(
                self.deps
                    .worktrees
                    .remove_worktree_record(Some(&moved.state.record_folder)),
                ref_store_removed
            ),
            "removing git's record of the worktree",
        )?;
        Ok(())
    }

    // Records a plain retirement; one another call recorded first is this call's too.
    async fn record_plain_retirement(&self, row: &WorktreeRow) -> Result<(), WorktreeRemovalError> {
        match self
            .deps
            .worktrees
            .record_retirement(row, RecordRetirementOptions::default())
            .await
        {
            Ok(()) | Err(WorktreeServiceError::AlreadyRetired { .. }) => Ok(()),
            Err(failure) => Err(failure.into()),
        }
    }

    // The sessions standing in the tree's folder.
    async fn read_occupying(
        &self,
        row: &WorktreeRow,
        folder: &Path,
    ) -> Result<Vec<SessionId>, WorktreeRemovalError> {
        let occupancy = self
            .deps
            .occupancy
            .read(&row.repo_mount_id)
            .await
            .map_err(|failure| WorktreeRemovalError::Failed(Box::new(failure)))?;
        let folder = canonical_folder_path(folder)
            .await
            .map_err(WorktreeRemovalError::Folder)?;
        Ok(occupancy
            .standing_by_folder
            .get(&folder)
            .map(|standing| standing.iter().map(|session| session.session_id).collect())
            .unwrap_or_default())
    }

    // Sweeps the tree's sessions, then answers a failure removing its record, with a failed
    // sweep's; a later retire of the retired tree sweeps again, but nothing comes back for a
    // record left behind.
    async fn sweep_after_record(
        &self,
        row: &WorktreeRow,
        record_removal: Option<RecordRemovalFailure>,
    ) -> Result<(), WorktreeRemovalError> {
        let swept = self.sweep(row).await;
        match (record_removal, swept) {
            (None, swept) => swept.map_err(WorktreeRemovalError::Sweep),
            (Some(record), swept) => Err(WorktreeRemovalError::RecordRemoval {
                record,
                sweep: swept.err(),
            }),
        }
    }

    async fn sweep(&self, row: &WorktreeRow) -> Result<(), Box<dyn Error + Send + Sync>> {
        self.deps
            .sessions
            .sweep_to_repo_root(&WorktreeSweep {
                repo_mount_id: row.repo_mount_id,
                worktree_id: row.id,
                folder: row.fs_root.clone(),
            })
            .await
    }

    // The tools a move aside and its undo run through, at `place`.
    fn kept_copy_tools<'a>(&'a self, place: Option<&'a Place>) -> KeptCopyTools<'a> {
        KeptCopyTools {
            git: &self.deps.git,
            place,
            folder_moves: self.deps.removed_worktrees.folder_move_tools(),
        }
    }
}

fn retired(worktree_id: WorktreeId, kept: Option<KeptWorktree>) -> WorktreeRetireResponse {
    WorktreeRetireResponse {
        worktree_id,
        state: RetiredWorktreeState::Value,
        kept,
    }
}

/// A new kept copy's id, minted.
pub(crate) fn new_removed_worktree_id() -> RemovedWorktreeId {
    RemovedWorktreeId::try_from(mint_uuid_v7()).expect("a minted UUID is a removed worktree id")
}

impl From<HeldWorkEnd> for WorktreeRemovalError {
    fn from(end: HeldWorkEnd) -> Self {
        match end {
            HeldWorkEnd::Unanswered => Self::Unanswered,
            HeldWorkEnd::Interrupted(interrupted) => Self::Interrupted(interrupted),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_owner;
#[cfg(test)]
pub(crate) mod tests;
