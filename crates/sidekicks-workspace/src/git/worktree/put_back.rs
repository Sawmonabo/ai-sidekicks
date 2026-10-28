//! Putting a kept copy back where its tree lived. A put-back takes its folder's name by making that
//! folder empty, and git's record by git's own name rule and counter, locking the record at once so
//! no prune takes it half written; then it has the caller mark the kept copy's row with what it is
//! doing, so one a crash cut short is undone from that mark. A new branch is made next, git
//! refusing a name another branch took; a folder or branch name taken this way moves to the next
//! number. Its steps then run side by side and all settle: the tree by one rename (across volumes a
//! copy, which leaves the kept tree whole) and its `.git` file; the record copied from the kept
//! one, its `commondir`, the refs a repository keeps apart, its `gitdir` and, on a new branch, its
//! HEAD put on that branch through git; and the pack and the LFS objects back into the repository.
//! After a copy the index is refreshed, the record's lock goes unless the tree was locked, and
//! everything written is flushed to disk before the caller records the tree. Nothing here runs
//! `git worktree add`, `unlock`, `prune` or `repair`.

pub(crate) mod branch;
mod flush;
mod objects;
mod record;
pub(crate) mod undo;

use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_platforms::CAN_RENAME_REPLACE_EMPTY_FOLDER;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use tokio::task::JoinError;

use self::flush::{PutBackFlushError, PutBackWrites, flush_put_back_writes};
use self::objects::{RestoredObjects, remove_restored_objects, restore_objects};
use self::record::{
    LinkingFiles, LinkingFilesError, LinkingSettings, TakenRecord, prepare_linking_files,
    read_linking_settings, take_record_folder, write_record,
};
use self::undo::{PutBackUndoError, undo_put_back};
use crate::git::process::{GitCall, GitError, GitRunner, background_read, in_folder};
use crate::git::worktree::claims::{KeptCopyClaims, KeptCopyClaimsReadError};
use crate::git::worktree::copy::TreeCopyError;
use crate::git::worktree::kept_copy::folder_move::{
    FolderMoveError, FolderPlacement, rename_or_copy_folder,
};
use crate::git::worktree::kept_copy::saved_state::{
    RefStorePayload, RepositoryStoreSettings, SavedStateError,
};
use crate::git::worktree::kept_copy::{
    KEPT_RECORD_ENTRY, KEPT_TREE_ENTRY, KeptCopyTools, RowWriteError,
};
use crate::git::worktree::naming::read_taken_branch_line;
use crate::git::worktree::reads::{has_branch, read_record_named_by};
use crate::git::worktree::stale_record::StaleRecordTools;

const PUTTING_THE_WORKTREE_BACK: &str = "putting the worktree back";

// The record's lock, written first and removed last unless the tree was locked.
const RECORD_LOCK_FILE_NAME: &str = "locked";
// What git writes in a lock it holds while it makes a record, its own line end included.
const INITIALIZING_LOCK: &[u8] = b"initializing\n";
// A tree's own `.git` file, naming its record.
const GIT_FILE_NAME: &str = ".git";

/// The name a put-back gives a folder or a branch whose own is taken: `<name>-restored` first,
/// then `<name>-restored-2`, `<name>-restored-3` and on.
pub(crate) fn restored_name(name: &str, ordinal: u32) -> String {
    if ordinal == 1 {
        format!("{name}-restored")
    } else {
        format!("{name}-restored-{ordinal}")
    }
}

// `folder` with its last name numbered as `restored_name` numbers it.
fn restored_folder(folder: &Path, ordinal: u32) -> PathBuf {
    let mut numbered = OsString::from(folder.as_os_str());
    numbered.push(if ordinal == 1 {
        "-restored".to_owned()
    } else {
        format!("-restored-{ordinal}")
    });
    PathBuf::from(numbered)
}

/// The git runner and folder moves a put-back runs through, and what live trees and put-backs
/// claim, which it never takes.
#[derive(Clone, Copy)]
pub(crate) struct PutBackTools<'a> {
    /// The kept copy's git runner, the project's place and its folder moves.
    pub(crate) kept: KeptCopyTools<'a>,
    /// What live trees and put-backs under way claim.
    pub(crate) claims: &'a KeptCopyClaims,
}

impl<'a> PutBackTools<'a> {
    fn git(&self) -> &'a GitRunner {
        self.kept.git
    }

    fn place(&self) -> Option<&'a Place> {
        self.kept.place
    }

    fn stale_record(&self) -> StaleRecordTools<'a> {
        StaleRecordTools {
            claims: self.claims,
            leftover_names: self.kept.folder_moves.leftover_names,
        }
    }
}

/// A branch a put-back makes, and the commit it makes it at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PutBackBranch {
    /// The branch's name, without `refs/heads/`.
    pub(crate) name: String,
    /// The commit it is made at.
    pub(crate) commit: GitObjectId,
}

/// What a put-back is doing, written on the kept copy's row before the tree moves, so a crash
/// after is undone from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PutBackMark {
    /// The kept copy's folder.
    pub(crate) kept_folder: PathBuf,
    /// The folder the tree goes to.
    pub(crate) target_folder: PathBuf,
    /// Git's record of the tree, which the put-back made under `<common folder>/worktrees/`.
    pub(crate) record_folder: PathBuf,
    /// The branch the put-back makes; `None` keeps the recorded HEAD.
    pub(crate) new_branch: Option<PutBackBranch>,
}

/// The kept copy's row as a put-back reads and marks it.
pub(crate) trait PutBackMarks: Sync {
    /// Whether `folder` is taken: on disk, or still owned by a retired tree's cleanup. Fails with
    /// the read's failure.
    fn is_folder_taken(
        &self,
        folder: &Path,
    ) -> impl Future<Output = Result<bool, Box<dyn Error + Send + Sync>>> + Send;

    /// Writes `mark`; runs before the tree moves. Fails with the write's failure.
    fn write(&self, mark: &PutBackMark) -> impl Future<Output = Result<(), RowWriteError>> + Send;

    /// Clears the mark once the put-back is undone whole. Fails with the write's failure.
    fn clear(&self) -> impl Future<Output = Result<(), RowWriteError>> + Send;
}

/// The branch a kept tree goes back on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PutBackBranchChoice {
    /// Its own branch; a detached tree keeps its recorded HEAD.
    OwnBranch,
    /// A new numbered `<branch>-restored` made at the recorded commit.
    NewBranchAt(GitObjectId),
}

/// A kept copy to put back at its own folder and branch, or at the first numbered names free.
#[derive(Clone, Copy)]
pub(crate) struct PutBackAtFreeNameInput<'a> {
    /// The kept copy's folder.
    pub(crate) kept_folder: &'a Path,
    /// Where the tree lived, the folder it goes back to when free.
    pub(crate) original_path: &'a Path,
    /// The kept tree's branch, which a new branch's name is numbered from.
    pub(crate) branch: &'a str,
    /// The repository's main checkout.
    pub(crate) canonical_root: &'a Path,
    /// The repository's git common folder.
    pub(crate) common_folder: &'a Path,
    /// The branch the tree goes back on.
    pub(crate) choice: &'a PutBackBranchChoice,
    /// The put-back as a copy across volumes and its undo report it.
    pub(crate) copy: &'a WorktreeCopy,
}

/// Which of a put-back's names was taken as it made it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TakenName {
    /// The folder the tree goes to.
    Folder,
    /// The new branch.
    Branch,
}

impl fmt::Display for TakenName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Folder => "folder",
            Self::Branch => "branch",
        })
    }
}

/// One step of a put-back's side-by-side steps that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PutBackStepError {
    /// A file or folder could not be read, written or removed.
    #[error("{} could not be read, written or removed", path.display())]
    File {
        /// The entry.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// The tree did not reach its folder.
    #[error("the kept tree could not be put back")]
    Move(#[source] FolderMoveError),
    /// An entry of the kept record could not be copied into the new record.
    #[error("git's kept record could not be copied")]
    RecordCopy(#[source] TreeCopyError),
    /// The refs kept apart could not be written back, or the record's rebase could not be read.
    #[error(transparent)]
    SavedState(SavedStateError),
    /// git could not put the record's HEAD on the new branch.
    #[error("git could not put the restored tree's HEAD on its new branch")]
    Head(#[source] GitError),
    /// A blocking task ended before it finished.
    #[error("a put-back step ended before it finished")]
    Interrupted(#[source] JoinError),
}

fn at(path: &Path) -> impl FnOnce(io::Error) -> PutBackStepError {
    let path = path.to_path_buf();
    move |source| PutBackStepError::File { path, source }
}

/// Why a put-back failed; [`PutBackError`] carries its undo's failures beside it.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PutBackFailure {
    /// A name was taken as the put-back made it; the next name is tried.
    #[error("the put-back's {0} name was taken as it was made")]
    NameTaken(TakenName),
    /// Whether a folder is taken could not be read.
    #[error("whether the put-back's folder is taken could not be read")]
    FolderTakenRead(#[source] Box<dyn Error + Send + Sync>),
    /// Whether a new branch name is taken could not be read.
    #[error("whether the put-back's branch name is taken could not be read")]
    BranchRead(#[source] GitError),
    /// What live trees and put-backs claim could not be read.
    #[error(transparent)]
    Claims(KeptCopyClaimsReadError),
    /// Where the repository keeps its LFS objects and refs could not be read.
    #[error(transparent)]
    StoreSettings(SavedStateError),
    /// The linking files could not be prepared.
    #[error(transparent)]
    LinkingFiles(#[from] LinkingFilesError),
    /// The target folder could not be made.
    #[error("the put-back's folder could not be made")]
    TargetFolder(#[source] io::Error),
    /// git's record of the tree could not be made or locked.
    #[error("{} could not be made", path.display())]
    Record {
        /// The record's folder or its lock.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// The mark could not be written.
    #[error("the put-back's mark could not be written")]
    Mark(#[source] RowWriteError),
    /// The new branch could not be made.
    #[error("the put-back's branch could not be made")]
    Branch(#[source] GitError),
    /// A side-by-side step failed.
    #[error(transparent)]
    Steps(SettleFailures<PutBackStepError>),
    /// The copied tree's index could not be refreshed.
    #[error("the copied tree's index could not be refreshed")]
    Refresh(#[source] GitError),
    /// The record's lock could not be removed.
    #[error("the put-back record's lock could not be removed")]
    Unlock(#[source] io::Error),
    /// What the put-back wrote could not be flushed to disk.
    #[error(transparent)]
    Flush(SettleFailures<PutBackFlushError>),
}

/// A failed put-back, undone, with the failures of undoing it beside it.
pub(crate) type PutBackError = CleanupFailures<PutBackFailure, PutBackUndoError>;

fn failed(failure: PutBackFailure) -> PutBackError {
    CleanupFailures::new(failure, Vec::new(), PUTTING_THE_WORKTREE_BACK)
}

/// A tree put back, with the way to undo the put-back before anything records it.
#[derive(Debug)]
pub(crate) struct PlacedPutBack {
    /// The folder the tree is in.
    pub(crate) target_folder: PathBuf,
    /// The branch the put-back made, if any.
    pub(crate) new_branch: Option<PutBackBranch>,
    progress: PutBackProgress,
    copy: WorktreeCopy,
}

impl PlacedPutBack {
    /// Undoes every step, the objects copied into the repository too, then clears the mark. Fails
    /// with every step's failure, the mark kept for the next try.
    pub(crate) async fn undo(
        mut self,
        tools: PutBackTools<'_>,
        marks: &impl PutBackMarks,
    ) -> Result<(), SettleFailures<PutBackUndoError>> {
        let failures = self.progress.undo(tools, marks, &self.copy).await;
        settle_all(
            failures
                .into_iter()
                .map(Err)
                .collect::<Vec<Result<(), _>>>(),
            "undoing the put-back",
        )
        .map(drop)
    }
}

/// Puts a kept copy back at its own folder, or the first numbered `-restored` folder free, on its
/// own branch or the new branch of the same number, the lowest number free for both. A name taken
/// as the put-back makes it moves to the next number. Fails as one put-back does, undone, with its
/// undo's failures beside it.
pub(crate) async fn put_worktree_back_at_free_name(
    tools: PutBackTools<'_>,
    input: PutBackAtFreeNameInput<'_>,
    marks: &impl PutBackMarks,
) -> Result<PlacedPutBack, PutBackError> {
    let mut is_folder_renamed = marks
        .is_folder_taken(input.original_path)
        .await
        .map_err(|failure| failed(PutBackFailure::FolderTakenRead(failure)))?;
    let mut ordinal = 1_u32;
    // Each number is a new name and only finitely many are taken, so the walk ends.
    loop {
        let target_folder = if is_folder_renamed {
            restored_folder(input.original_path, ordinal)
        } else {
            input.original_path.to_path_buf()
        };
        let new_branch = match input.choice {
            PutBackBranchChoice::NewBranchAt(commit) => Some(PutBackBranch {
                name: restored_name(input.branch, ordinal),
                commit: commit.clone(),
            }),
            PutBackBranchChoice::OwnBranch => None,
        };
        if (is_folder_renamed && is_folder_taken(marks, &target_folder).await?)
            || is_branch_taken(tools, input, new_branch.as_ref()).await?
        {
            ordinal += 1;
            continue;
        }
        let put_back = put_worktree_back(
            tools,
            PutBackInput {
                kept_folder: input.kept_folder,
                target_folder: &target_folder,
                canonical_root: input.canonical_root,
                common_folder: input.common_folder,
                new_branch,
                copy: input.copy,
            },
            marks,
        )
        .await;
        let failure = match put_back {
            Ok(placed) => return Ok(placed),
            Err(failure) => failure,
        };
        // A put-back whose undo failed is not tried again.
        let PutBackFailure::NameTaken(taken_name) = failure.original() else {
            return Err(failure);
        };
        if !failure.cleanup_failures().is_empty() {
            return Err(failure);
        }
        // The own folder, taken since it was read, is renamed at the same number; any other name
        // taken moves to the next.
        if *taken_name == TakenName::Folder && !is_folder_renamed {
            is_folder_renamed = true;
        } else {
            ordinal += 1;
        }
    }
}

async fn is_folder_taken(marks: &impl PutBackMarks, folder: &Path) -> Result<bool, PutBackError> {
    marks
        .is_folder_taken(folder)
        .await
        .map_err(|failure| failed(PutBackFailure::FolderTakenRead(failure)))
}

// Whether the new branch, when there is one, exists or another put-back makes it.
async fn is_branch_taken(
    tools: PutBackTools<'_>,
    input: PutBackAtFreeNameInput<'_>,
    new_branch: Option<&PutBackBranch>,
) -> Result<bool, PutBackError> {
    let Some(new_branch) = new_branch else {
        return Ok(false);
    };
    if has_branch(
        tools.git(),
        tools.place(),
        input.canonical_root,
        &new_branch.name,
    )
    .await
    .map_err(|failure| failed(PutBackFailure::BranchRead(failure)))?
    {
        return Ok(true);
    }
    // The put-back has no record yet, so every other put-back's mark on the branch claims it.
    tools
        .claims
        .is_branch_claimed(&new_branch.name, input.common_folder, Path::new(""))
        .await
        .map_err(|failure| failed(PutBackFailure::Claims(failure)))
}

// One put-back at one folder and branch name.
struct PutBackInput<'a> {
    kept_folder: &'a Path,
    target_folder: &'a Path,
    canonical_root: &'a Path,
    common_folder: &'a Path,
    new_branch: Option<PutBackBranch>,
    copy: &'a WorktreeCopy,
}

// How far a put-back got, which its undo works from.
#[derive(Debug)]
struct PutBackProgress {
    mark: PutBackMark,
    is_marked: bool,
    is_branch_made: bool,
    restored: RestoredObjects,
}

impl PutBackProgress {
    // Undoes what this put-back did, every step settled, then clears the mark once all of it is
    // undone; answers each failure, the mark kept when any came.
    async fn undo(
        &mut self,
        tools: PutBackTools<'_>,
        marks: &impl PutBackMarks,
        copy: &WorktreeCopy,
    ) -> Vec<PutBackUndoError> {
        // A branch of that name this put-back did not make is someone's, whatever it points at.
        let mut mark = self.mark.clone();
        if !self.is_branch_made {
            mark.new_branch = None;
        }
        let restored_files = std::mem::take(&mut self.restored.files);
        let (placement, objects) = tokio::join!(
            undo_put_back(tools, &mark, copy),
            remove_restored_objects(restored_files)
        );
        let mut failures: Vec<PutBackUndoError> = match placement {
            Ok(()) => Vec::new(),
            Err(SettleFailures::One(failure)) => vec![failure],
            Err(SettleFailures::Many { failures, .. }) => failures,
        };
        failures.extend(objects);
        if !failures.is_empty() {
            return failures;
        }
        self.is_branch_made = false;
        if self.is_marked {
            match marks.clear().await {
                Ok(()) => self.is_marked = false,
                Err(failure) => failures.push(PutBackUndoError::ClearMark(failure)),
            }
        }
        failures
    }
}

// Puts a kept copy back at `input.target_folder`, as the module describes. A failure undoes every
// step taken, so the kept copy stands whole, and is answered with its undo's failures,
// `NameTaken` when the folder or the new branch was taken as the put-back made it.
async fn put_worktree_back(
    tools: PutBackTools<'_>,
    input: PutBackInput<'_>,
    marks: &impl PutBackMarks,
) -> Result<PlacedPutBack, PutBackError> {
    let (store_settings, linking_settings) = tokio::join!(
        RepositoryStoreSettings::read(tools.git(), tools.place(), input.canonical_root),
        read_linking_settings(tools.git(), tools.place(), input.canonical_root)
    );
    let store_settings =
        store_settings.map_err(|failure| failed(PutBackFailure::StoreSettings(failure)))?;
    let linking_settings = linking_settings.map_err(|failure| failed(failure.into()))?;
    let payload = store_settings.ref_store_payload(input.common_folder);
    let lfs_store = store_settings.lfs_store(input.common_folder);
    // A tree's folder is its stored path or that path numbered, so it always ends in a name.
    let tree_name = input
        .target_folder
        .file_name()
        .expect("a tree's folder ends in its name")
        .to_string_lossy();
    // The names are taken before the mark names them, so two put-backs never take one name. A
    // crash between leaves an empty folder, which git does not list; the next put-back takes the
    // next number.
    match tokio::fs::create_dir(input.target_folder).await {
        Ok(()) => {}
        Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {
            return Err(failed(PutBackFailure::NameTaken(TakenName::Folder)));
        }
        Err(failure) => return Err(failed(PutBackFailure::TargetFolder(failure))),
    }
    let record = match take_record_folder(input.common_folder, &tree_name, payload.as_ref()).await {
        Ok(record) => record,
        Err(failure) => {
            let cleanup_failures = tokio::fs::remove_dir(input.target_folder)
                .await
                .err()
                .map(|source| PutBackUndoError::File {
                    path: input.target_folder.to_path_buf(),
                    source,
                })
                .into_iter()
                .collect();
            return Err(CleanupFailures::new(
                failure,
                cleanup_failures,
                PUTTING_THE_WORKTREE_BACK,
            ));
        }
    };
    let mut progress = PutBackProgress {
        mark: PutBackMark {
            kept_folder: input.kept_folder.to_path_buf(),
            target_folder: input.target_folder.to_path_buf(),
            record_folder: record.record_folder.clone(),
            new_branch: input.new_branch.clone(),
        },
        is_marked: false,
        is_branch_made: false,
        restored: RestoredObjects::default(),
    };
    let placed = place_tree_back(
        tools,
        &input,
        marks,
        PutBackStores {
            record: &record,
            linking_settings,
            payload: payload.as_ref(),
            lfs_store: &lfs_store,
        },
        &mut progress,
    )
    .await;
    match placed {
        Ok(()) => Ok(PlacedPutBack {
            target_folder: input.target_folder.to_path_buf(),
            new_branch: input.new_branch,
            progress,
            copy: input.copy.clone(),
        }),
        Err(failure) => {
            let undo_failures = progress.undo(tools, marks, input.copy).await;
            Err(CleanupFailures::new(
                failure,
                undo_failures,
                PUTTING_THE_WORKTREE_BACK,
            ))
        }
    }
}

// Where a put-back writes beside the tree: the record it took, how its linking files are written,
// the refs payload and the LFS store.
struct PutBackStores<'a> {
    record: &'a TakenRecord,
    linking_settings: LinkingSettings,
    payload: Option<&'a RefStorePayload>,
    lfs_store: &'a Path,
}

// The put-back's steps once its names are taken, each recorded in `progress` as it lands.
async fn place_tree_back(
    tools: PutBackTools<'_>,
    input: &PutBackInput<'_>,
    marks: &impl PutBackMarks,
    stores: PutBackStores<'_>,
    progress: &mut PutBackProgress,
) -> Result<(), PutBackFailure> {
    let record_folder = &stores.record.record_folder;
    // Locked first, so no prune takes the record while it is half written: with the kept lock's
    // text when the tree was locked, else git's own while it makes a record.
    let kept_lock_path = input
        .kept_folder
        .join(KEPT_RECORD_ENTRY)
        .join(RECORD_LOCK_FILE_NAME);
    let kept_lock = tokio::fs::read(&kept_lock_path)
        .await
        .none_if_missing()
        .map_err(|source| PutBackFailure::Record {
            path: kept_lock_path,
            source,
        })?;
    let lock_path = record_folder.join(RECORD_LOCK_FILE_NAME);
    tokio::fs::write(
        &lock_path,
        kept_lock.as_deref().unwrap_or(INITIALIZING_LOCK),
    )
    .await
    .map_err(|source| PutBackFailure::Record {
        path: lock_path.clone(),
        source,
    })?;

    marks
        .write(&progress.mark)
        .await
        .map_err(PutBackFailure::Mark)?;
    progress.is_marked = true;
    // Before anything moves: git refuses a name another branch has taken since it was chosen.
    if let Some(new_branch) = &input.new_branch {
        make_branch(tools, input.canonical_root, new_branch).await?;
        progress.is_branch_made = true;
    }
    let linking = prepare_linking_files(
        tools,
        input.canonical_root,
        stores.linking_settings,
        input.target_folder,
        record_folder,
    )
    .await?;

    let (placement, record_written, (restored, objects_restored)) = tokio::join!(
        place_tree(tools, input, &linking),
        write_record(
            tools,
            input.kept_folder,
            record_folder,
            &linking,
            stores.payload,
            input.new_branch.as_ref()
        ),
        restore_objects(input.kept_folder, input.common_folder, stores.lfs_store)
    );
    progress.restored = restored;
    let (placement, (), ()) = settle_all(
        (placement, record_written, objects_restored),
        PUTTING_THE_WORKTREE_BACK,
    )
    .map_err(PutBackFailure::Steps)?;
    // A copy gives every file a new inode and change time, so the index is refreshed to save the
    // next read a rehash; a rename keeps both, and the index it carried is still fresh.
    if placement == FolderPlacement::Copied {
        tools
            .git()
            .run(
                tools.place(),
                GitCall::write(in_folder(
                    input.target_folder,
                    &["update-index", "-q", "--refresh"],
                )),
            )
            .await
            .map_err(PutBackFailure::Refresh)?;
    }
    if kept_lock.is_none() {
        tokio::fs::remove_file(&lock_path)
            .await
            .map_err(PutBackFailure::Unlock)?;
    }
    flush_put_back_writes(PutBackWrites {
        target_folder: input.target_folder,
        record: stores.record,
        placement,
        restored: &progress.restored,
        common_folder: input.common_folder,
        new_branch: input.new_branch.as_ref().map(|branch| branch.name.as_str()),
    })
    .await
    .map_err(PutBackFailure::Flush)
}

// Makes `branch` at its commit in the repository; git's taken line is `NameTaken`.
async fn make_branch(
    tools: PutBackTools<'_>,
    canonical_root: &Path,
    branch: &PutBackBranch,
) -> Result<(), PutBackFailure> {
    let made = tools
        .git()
        .run(
            tools.place(),
            GitCall::write(in_folder(
                canonical_root,
                &["branch", &branch.name, branch.commit.as_str()],
            )),
        )
        .await;
    match made {
        Ok(_) => Ok(()),
        Err(GitError::Exited { stderr, .. }) if read_taken_branch_line(&stderr).is_some() => {
            Err(PutBackFailure::NameTaken(TakenName::Branch))
        }
        Err(failure) => Err(PutBackFailure::Branch(failure)),
    }
}

// Moves the kept tree into the target folder, then writes its `.git` file.
async fn place_tree(
    tools: PutBackTools<'_>,
    input: &PutBackInput<'_>,
    linking: &LinkingFiles,
) -> Result<FolderPlacement, PutBackStepError> {
    // Where the system refuses to rename a folder onto one that exists, the empty folder that took
    // the name goes just before the move.
    if !CAN_RENAME_REPLACE_EMPTY_FOLDER {
        tokio::fs::remove_dir(input.target_folder)
            .await
            .map_err(at(input.target_folder))?;
    }
    let placement = rename_or_copy_folder(
        tools.kept.folder_moves,
        &input.kept_folder.join(KEPT_TREE_ENTRY),
        input.target_folder,
        input.copy.clone(),
    )
    .await
    .map_err(PutBackStepError::Move)?;
    let git_file = input.target_folder.join(GIT_FILE_NAME);
    tokio::fs::write(&git_file, &linking.tree_git_file)
        .await
        .map_err(at(&git_file))?;
    Ok(placement)
}

/// Why a tree put back does not stand sound.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UnsoundTreeError {
    /// The tree's `.git` file could not be read.
    #[error("the tree put back at {} could not be read", folder.display())]
    Read {
        /// The tree's folder.
        folder: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// The tree's `.git` names no record git keeps.
    #[error("the tree put back at {} names no record git keeps", folder.display())]
    NoRecord {
        /// The tree's folder.
        folder: PathBuf,
    },
    /// git cannot read the tree's HEAD.
    #[error("git cannot read HEAD in the tree put back at {}", folder.display())]
    HeadUnreadable {
        /// The tree's folder.
        folder: PathBuf,
        /// git's failure.
        #[source]
        source: GitError,
    },
}

/// Checks that the tree put back at `tree_folder` stands sound: its `.git` names a record that
/// exists and git reads its HEAD there. Its kept copy is deleted only once this passes. Fails with
/// what is unsound.
pub(crate) async fn require_sound_restored_tree(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
) -> Result<(), UnsoundTreeError> {
    let read_failure = |source| UnsoundTreeError::Read {
        folder: tree_folder.to_path_buf(),
        source,
    };
    let named_record = read_record_named_by(&tree_folder.join(GIT_FILE_NAME))
        .await
        .map_err(read_failure)?;
    let has_record = match &named_record {
        Some(record) => tokio::fs::try_exists(record).await.map_err(read_failure)?,
        None => false,
    };
    if !has_record {
        return Err(UnsoundTreeError::NoRecord {
            folder: tree_folder.to_path_buf(),
        });
    }
    git.run(
        place,
        GitCall::read(background_read(
            tree_folder,
            &["rev-parse", "--verify", "-q", "HEAD"],
        )),
    )
    .await
    .map_err(|source| UnsoundTreeError::HeadUnreadable {
        folder: tree_folder.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests;
