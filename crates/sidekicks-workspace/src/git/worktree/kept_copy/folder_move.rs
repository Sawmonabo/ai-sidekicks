//! The folder moves a kept copy and its put-back share: one rename on one volume, and across
//! volumes a copy with its progress that takes the real name only once whole, the original removed
//! after it only by a move. A copy in flight sits beside its destination under a leftover's name,
//! `<name>.copying-<32 hex>`, so a crash partway never leaves a partial copy under the real name;
//! the names this daemon is using now are held in one [`LeftoverNamesInUse`], so the leftover
//! sweep never takes a copy in flight for one a crash cut short.

use std::collections::HashSet;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ignore::WalkBuilder;
use sidekicks_contracts::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_platforms::{entry_identity, is_held_file_error, rename_replacing};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::random_hex::random_hex;
use tokio::task::JoinError;

use crate::git::worktree::copy::progress::{WorktreeCopiesUnderWay, WorktreeCopyReport};
use crate::git::worktree::copy::{TreeCopyError, TreeCopyFollower, TreeCopyPolicy, copy_tree};
use crate::git::worktree::folder_names::read_folder_names;
use crate::git::worktree::naming::REMOVED_WORKTREES_FOLDER_NAME;
use crate::git::worktree::service::remove_folder;

// The random bytes a leftover's name ends in, written as twice as many hex digits.
const LEFTOVER_SUFFIX_BYTES: usize = 16;

/// The names of the leftover folders this daemon is making or removing now: copies in flight and
/// records set aside. Made once and shared by `Arc` with everything that makes or sweeps one.
#[derive(Debug, Default)]
pub struct LeftoverNamesInUse {
    names: Mutex<HashSet<PathBuf>>,
}

/// A leftover's name held in use; dropping it lets the name go, so a canceled move frees it too.
pub(crate) struct LeftoverNameHold {
    names: Arc<LeftoverNamesInUse>,
    folder: PathBuf,
}

impl LeftoverNamesInUse {
    /// Holds `folder` in use until the answer is dropped.
    pub(crate) fn hold(self: &Arc<Self>, folder: &Path) -> LeftoverNameHold {
        lock(&self.names).insert(folder.to_path_buf());
        LeftoverNameHold {
            names: Arc::clone(self),
            folder: folder.to_path_buf(),
        }
    }

    /// Whether `folder` is held in use now.
    pub(crate) fn is_in_use(&self, folder: &Path) -> bool {
        lock(&self.names).contains(folder)
    }
}

impl Drop for LeftoverNameHold {
    fn drop(&mut self) {
        lock(&self.names.names).remove(&self.folder);
    }
}

/// What a leftover folder is, by the word its name carries before its random suffix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LeftoverKind {
    /// A folder's copy in flight, or a folder renamed aside to be removed.
    Copying,
    /// Git's record of a kept tree renamed aside to be removed.
    Removing,
}

impl LeftoverKind {
    fn infix(self) -> &'static str {
        match self {
            Self::Copying => ".copying-",
            Self::Removing => ".removing-",
        }
    }
}

/// The leftover name beside `folder` for `kind`: its name with the kind's word and 32 random hex
/// digits added. Fails when the system gives no random bytes.
pub(crate) fn leftover_name(
    folder: &Path,
    kind: LeftoverKind,
) -> Result<PathBuf, getrandom::Error> {
    let mut name = OsString::from(folder.as_os_str());
    name.push(kind.infix());
    name.push(random_hex(LEFTOVER_SUFFIX_BYTES)?);
    Ok(PathBuf::from(name))
}

/// Whether `name` is a leftover of `kind` made beside a folder named `base`; with no `base`, beside
/// any folder. A name that is not UTF-8 is none.
pub(crate) fn is_leftover_name(name: &OsStr, base: Option<&str>, kind: LeftoverKind) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some((before, suffix)) = name.rsplit_once(kind.infix()) else {
        return false;
    };
    base.is_none_or(|base| before == base)
        && suffix.len() == LEFTOVER_SUFFIX_BYTES * 2
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Where a copy across volumes reports, and the leftover names it holds while it runs.
#[derive(Clone, Copy)]
pub(crate) struct FolderMoveTools<'a> {
    /// The copies under way, which a copy across volumes joins while it runs.
    pub(crate) copies: &'a WorktreeCopiesUnderWay,
    /// The leftover names in use, which a copy in flight holds.
    pub(crate) leftover_names: &'a Arc<LeftoverNamesInUse>,
}

/// How a folder reached its new place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FolderPlacement {
    /// One rename on one volume; nothing is left at the old place.
    Renamed,
    /// A copy across volumes; the original is still where it was.
    Copied,
}

/// Why a copy across volumes failed; whatever it copied is removed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderCopyError {
    /// The copy itself failed.
    #[error(transparent)]
    Copy(#[from] TreeCopyError),
    /// The blocking task that copied ended before it finished.
    #[error("the folder's copy ended before it finished")]
    Interrupted(#[source] JoinError),
    /// The whole copy could not take its destination's name.
    #[error("the folder's copy could not take its place")]
    Place(#[source] io::Error),
}

/// Why a folder did not move.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderMoveError {
    /// The system refused the rename while a program holds a file in the folder open; nothing
    /// moved.
    #[error("a program holds a file in the folder open, so it could not be moved")]
    Held(#[source] io::Error),
    /// The rename failed for another reason; nothing moved.
    #[error("the folder could not be renamed")]
    Rename(#[source] io::Error),
    /// The system gave no random bytes for the copy's leftover name; nothing moved.
    #[error("the folder's copy could not be named")]
    LeftoverName(#[source] getrandom::Error),
    /// The copy across volumes failed and was removed, or its removal failed too.
    #[error(transparent)]
    Copy(#[from] CleanupFailures<FolderCopyError, io::Error>),
    /// The folder was copied whole to its new place, but the original could not be removed
    /// completely: both are kept, and nothing was deleted to undo it.
    #[error(
        "the folder was copied whole to its new place, but the original could not be removed \
         completely; both are kept"
    )]
    Incomplete(#[source] io::Error),
}

/// Why a folder renamed aside as a leftover was not removed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LeftoverRemovalError {
    /// The system gave no random bytes for the leftover's name; nothing moved.
    #[error("the folder's leftover name could not be made")]
    Name(#[source] getrandom::Error),
    /// The folder could not be renamed aside; nothing moved.
    #[error("the folder could not be renamed aside")]
    Rename(#[source] io::Error),
    /// The folder renamed aside could not be removed; the sweep finishes it.
    #[error("the folder renamed aside could not be removed")]
    Remove(#[source] io::Error),
}

/// Why a folder's file sizes could not be summed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FileSizeWalkError {
    /// The walk of the folder failed.
    #[error("the folder could not be walked")]
    Walk(#[source] ignore::Error),
    /// One entry's size could not be read.
    #[error("{} could not be read", path.display())]
    Entry {
        /// The entry.
        path: PathBuf,
        /// The read's failure.
        #[source]
        source: io::Error,
    },
    /// The blocking task that walked ended before it finished.
    #[error("the walk of the folder ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// How a sum of file sizes counts a file hard-linked under several paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HardLinkCount {
    /// Once for each path, as a copy copies it once per path.
    OncePerPath,
    /// Once, as the disk holds it once.
    OncePerFile,
}

/// Renames `from` to `to` in one step on a blocking thread, a folder replacing an empty one where
/// the system does so. Fails with the rename's error, `CrossesDevices` across volumes.
pub(crate) async fn rename_folder(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (from.to_path_buf(), to.to_path_buf());
    tokio::task::spawn_blocking(move || rename_replacing(&from, &to))
        .await
        .map_err(io::Error::other)?
}

/// Sums the sizes of the regular files under `folder`, no link followed and nothing ignored, a file
/// gone since the listing counting nothing. Blocks on the file system, so it runs on a blocking
/// thread. Fails with the walk's failure or an entry's read other than its absence.
pub(crate) fn sum_file_sizes(
    folder: &Path,
    hard_links: HardLinkCount,
) -> Result<u64, FileSizeWalkError> {
    let mut counted = HashSet::new();
    let mut total: u64 = 0;
    let walk = WalkBuilder::new(folder)
        .standard_filters(false)
        .follow_links(false)
        .build();
    for entry in walk {
        let entry = entry.map_err(FileSizeWalkError::Walk)?;
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let identified = match entry_identity(entry.path()) {
            Ok(identified) => identified,
            Err(failure) if failure.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(FileSizeWalkError::Entry {
                    path: entry.path().to_path_buf(),
                    source,
                });
            }
        };
        let is_counted_already =
            hard_links == HardLinkCount::OncePerFile && !counted.insert(identified.identity);
        if !is_counted_already {
            total = total.saturating_add(identified.metadata.len());
        }
    }
    Ok(total)
}

/// Moves `from` to `to` as [`rename_or_copy_folder`] does, then, after a copy, removes the original;
/// the complete copy is never deleted. Fails as that does, and with
/// [`FolderMoveError::Incomplete`] when the original could not be removed completely.
pub(crate) async fn move_folder(
    tools: FolderMoveTools<'_>,
    from: &Path,
    to: &Path,
    copy: WorktreeCopy,
) -> Result<(), FolderMoveError> {
    match rename_or_copy_folder(tools, from, to, copy).await? {
        FolderPlacement::Renamed => Ok(()),
        FolderPlacement::Copied => remove_folder(from)
            .await
            .map_err(FolderMoveError::Incomplete),
    }
}

/// Moves `from` to `to` by one rename on one volume; across volumes, copies it, cloned where the
/// volume can, reporting its progress as `copy` (its figures filled in here), and leaves the
/// original in place. The copy takes `to` only once whole; one that fails partway is removed.
/// Answers which it did. Fails with [`FolderMoveError::Held`] when a program holds a file in the
/// folder open, and otherwise as each step does.
pub(crate) async fn rename_or_copy_folder(
    tools: FolderMoveTools<'_>,
    from: &Path,
    to: &Path,
    copy: WorktreeCopy,
) -> Result<FolderPlacement, FolderMoveError> {
    match rename_folder(from, to).await {
        Ok(()) => return Ok(FolderPlacement::Renamed),
        Err(failure) if is_held_file_error(&failure) => {
            return Err(FolderMoveError::Held(failure));
        }
        Err(failure) if failure.kind() == io::ErrorKind::CrossesDevices => {}
        Err(failure) => return Err(FolderMoveError::Rename(failure)),
    }
    let copy_folder =
        leftover_name(to, LeftoverKind::Copying).map_err(FolderMoveError::LeftoverName)?;
    let _copy_name = tools.leftover_names.hold(&copy_folder);
    let copied = copy_whole(tools.copies, from, &copy_folder, copy).await;
    let placed = match copied {
        Ok(()) => rename_folder(&copy_folder, to)
            .await
            .map_err(FolderCopyError::Place),
        Err(failure) => Err(failure),
    };
    if let Err(failure) = placed {
        let cleanup_failures = remove_folder(&copy_folder)
            .await
            .err()
            .into_iter()
            .collect();
        return Err(CleanupFailures::new(failure, cleanup_failures, "copying the folder").into());
    }
    Ok(FolderPlacement::Copied)
}

/// Removes `folder` after renaming it to a copy's leftover name beside it, so a removal cut short
/// leaves a leftover the sweep removes, never part of the folder under its own name. Fails as each
/// step does.
pub(crate) async fn remove_folder_as_leftover(
    leftover_names: &Arc<LeftoverNamesInUse>,
    folder: &Path,
) -> Result<(), LeftoverRemovalError> {
    let leftover =
        leftover_name(folder, LeftoverKind::Copying).map_err(LeftoverRemovalError::Name)?;
    let _leftover_name = leftover_names.hold(&leftover);
    rename_folder(folder, &leftover)
        .await
        .map_err(LeftoverRemovalError::Rename)?;
    remove_folder(&leftover)
        .await
        .map_err(LeftoverRemovalError::Remove)
}

/// The copies a crash cut short: those in each project folder of `worktrees_folder`, where a
/// put-back or an undone discard copies a tree, and those in each kept folder under the project's
/// removed-worktrees folder, where a discard or an undone put-back copies one. A copy this daemon
/// is making now is left out. Fails with a folder's read.
pub(crate) async fn list_leftover_copies(
    leftover_names: &LeftoverNamesInUse,
    worktrees_folder: &Path,
) -> io::Result<Vec<PathBuf>> {
    let mut leftovers = Vec::new();
    for project in read_folder_names(worktrees_folder).await? {
        // A project's slug never starts with a dot, so such a folder is no project's.
        if project.to_str().is_none_or(|name| name.starts_with('.')) {
            continue;
        }
        let project_folder = worktrees_folder.join(&project);
        leftovers.extend(list_leftover_copies_in(leftover_names, &project_folder).await?);
        let removed_folder = project_folder.join(REMOVED_WORKTREES_FOLDER_NAME);
        for kept in read_folder_names(&removed_folder).await? {
            leftovers
                .extend(list_leftover_copies_in(leftover_names, &removed_folder.join(kept)).await?);
        }
    }
    Ok(leftovers)
}

async fn list_leftover_copies_in(
    leftover_names: &LeftoverNamesInUse,
    folder: &Path,
) -> io::Result<Vec<PathBuf>> {
    Ok(read_folder_names(folder)
        .await?
        .into_iter()
        .filter(|name| is_leftover_name(name, None, LeftoverKind::Copying))
        .map(|name| folder.join(name))
        .filter(|leftover| !leftover_names.is_in_use(leftover))
        .collect())
}

// Copies `from` whole into `copy_folder` on a blocking thread, reporting its progress as `copy`
// when the source's size could be read.
async fn copy_whole(
    copies: &WorktreeCopiesUnderWay,
    from: &Path,
    copy_folder: &Path,
    copy: WorktreeCopy,
) -> Result<(), FolderCopyError> {
    let in_flight: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    let report = begin_report(copies, from, copy, Arc::clone(&in_flight)).await;
    let follower = CopyProgress { report, in_flight };
    let (from, copy_folder) = (from.to_path_buf(), copy_folder.to_path_buf());
    // The follower, and with it the report, ends with the task, on every path.
    tokio::task::spawn_blocking(move || {
        copy_tree(
            &from,
            &copy_folder,
            TreeCopyPolicy::IntoEmpty,
            Some(&follower),
        )
    })
    .await
    .map_err(FolderCopyError::Interrupted)?
    .map_err(FolderCopyError::Copy)
}

// Lists the copy with its total from one walk of the source; a walk that fails leaves the copy
// unreported, since its progress never costs the move.
async fn begin_report(
    copies: &WorktreeCopiesUnderWay,
    from: &Path,
    copy: WorktreeCopy,
    in_flight: Arc<Mutex<Option<PathBuf>>>,
) -> Option<WorktreeCopyReport> {
    let source = from.to_path_buf();
    let total =
        tokio::task::spawn_blocking(move || sum_file_sizes(&source, HardLinkCount::OncePerPath))
            .await
            .map_err(FileSizeWalkError::Interrupted)
            .and_then(|walked| walked);
    let total = match total {
        Ok(total) => total,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                folder = %from.display(),
                "A folder's copy across volumes runs without its progress, since its size could not \
                 be read"
            );
            return None;
        }
    };
    // No disk holds 2^53 bytes, so a total past it is reported at the bound.
    let total =
        SafeInt::new(total.min(MAX_SAFE_INTEGER)).expect("a figure capped at the bound is safe");
    Some(copies.begin(with_total(copy, total), move || {
        let in_flight = lock(&in_flight).clone();
        async move { read_bytes_in_flight(in_flight.as_deref()).await }
    }))
}

// `copy` with its total set and nothing copied yet.
fn with_total(mut copy: WorktreeCopy, total: SafeInt<0>) -> WorktreeCopy {
    match &mut copy {
        WorktreeCopy::Removing {
            copied_bytes,
            total_bytes,
            ..
        }
        | WorktreeCopy::PuttingBack {
            copied_bytes,
            total_bytes,
            ..
        } => {
            *copied_bytes = SafeInt::ZERO;
            *total_bytes = total;
        }
    }
    copy
}

// What has reached the destination of the file the copy is on; nothing before it is made.
async fn read_bytes_in_flight(destination: Option<&Path>) -> io::Result<u64> {
    let Some(destination) = destination else {
        return Ok(0);
    };
    match tokio::fs::symlink_metadata(destination).await {
        Ok(metadata) => Ok(metadata.len()),
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(failure) => Err(failure),
    }
}

// The copy's follower: the file it is on, for the progress ticks, and each file done, for the
// report.
struct CopyProgress {
    report: Option<WorktreeCopyReport>,
    in_flight: Arc<Mutex<Option<PathBuf>>>,
}

impl TreeCopyFollower for CopyProgress {
    fn file_began(&self, destination: &Path) {
        *lock(&self.in_flight) = Some(destination.to_path_buf());
    }

    fn file_copied(&self, bytes: u64) {
        *lock(&self.in_flight) = None;
        if let Some(report) = &self.report {
            report.add_copied(bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use super::{LeftoverKind, LeftoverNamesInUse, leftover_name, list_leftover_copies};
    use crate::git::worktree::naming::REMOVED_WORKTREES_FOLDER_NAME;

    // Kills dropping `LeftoverNamesInUse` from the listing, which lets the sweep remove a copy in
    // flight; and a listing that misses the kept folders or matches a name of another form.
    #[tokio::test]
    async fn a_leftover_listing_keeps_out_copies_in_flight_and_names_of_other_forms() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let worktrees = scratch.path();
        let project = worktrees.join("app");
        let kept = project.join(REMOVED_WORKTREES_FOLDER_NAME).join("fix-1");
        fs::create_dir_all(&kept).expect("the kept folder is made");
        let in_flight =
            leftover_name(&project.join("fix"), LeftoverKind::Copying).expect("a leftover name");
        let cut_short =
            leftover_name(&kept.join("worktree"), LeftoverKind::Copying).expect("a leftover name");
        let record_aside =
            leftover_name(&project.join("other"), LeftoverKind::Removing).expect("a leftover name");
        for folder in [
            &in_flight,
            &cut_short,
            &record_aside,
            &project.join("fix.copying-not-hex"),
        ] {
            fs::create_dir(folder).expect("the folder is made");
        }
        let names = Arc::new(LeftoverNamesInUse::default());
        let copy_in_flight = names.hold(&in_flight);

        let leftovers = list_leftover_copies(&names, worktrees)
            .await
            .expect("the folders read");

        assert_eq!(leftovers, [cut_short.clone()]);
        drop(copy_in_flight);
        let mut leftovers = list_leftover_copies(&names, worktrees)
            .await
            .expect("the folders read");
        leftovers.sort();
        let mut expected = vec![in_flight, cut_short];
        expected.sort();
        assert_eq!(
            leftovers, expected,
            "a copy no longer in flight is a leftover"
        );
    }
}
