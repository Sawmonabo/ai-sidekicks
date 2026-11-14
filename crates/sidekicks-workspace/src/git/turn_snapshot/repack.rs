//! Packing the capture folders: after each capture, what it borrows from the repository beyond its
//! base's tree is packed into its capture folder, so a gc in the repository never takes a captured
//! file away; once a folder holds more packs than the last fold left, and at each sweep, its packs
//! are folded. The sweep also packs the trees of captures whose base no ref of the repository
//! reaches any more, packs again a capture whose own pack failed once its loose objects are an hour
//! old, reclaims the objects of a run whose refs were deleted from the folder, and skips a folder
//! whose refs, packs and loose objects are as its last pass left them and that has no reclaim due.
//! Every pass, a skipped one too, first removes what a git cut at its bound or a daemon stopped
//! mid-write left once it is an hour old: git's temporaries, scratch indexes and their locks, and
//! the owner's capture folders still being made.
//!
//! - Every packing call against a capture folder runs with `--git-dir` alone; of the packing's own
//!   calls only the packs of captures' objects attach the repository, since `prune-packed`, the
//!   fold and the pack of listed loose objects with it attached would take or leave out an object
//!   only the repository's packs hold.
//! - One lock per capture folder orders its packs, folds and sweep passes; a purge holds every
//!   capture folder of its owner on it while they go, so each finds its folder gone after, and a
//!   backup holds one folder on it while it copies that folder's objects.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::{MissingEntry as _, is_gone};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::run_blocking;
use tokio::time::Instant;

use crate::git::process::version::GitFeature;
use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::{CORE_FSYNC_PIN, GitFloorReports};
use crate::git::turn_snapshot::capture_folder::{
    CAPTURES_SEGMENT, CaptureFolder, OBJECTS_SEGMENT, in_git_folder, is_partial_capture_folder_name,
};
use crate::git::turn_snapshot::capture_steps::joined;
use crate::git::turn_snapshot::diagnostics::CaptureDiagnostic;
use crate::git::turn_snapshot::refs::SNAPSHOT_REFS_PREFIX;
use answers::{ObjectCounts, read_object_counts, read_points};
use leftovers::{
    clear_capture_folder_leftovers, clear_partial_capture_folders, remove_stale_temporary_packs,
};
use object_folders::{ObjectFolderState, read_object_folder_state};
use reclaim::ReclaimKept;
use ref_state::{RefState, read_ref_state};
use stale_captures::FailedPacks;

mod answers;
mod leftovers;
mod object_folders;
mod reclaim;
mod ref_state;
mod stale_captures;

/// The packs a capture folder may hold before a fold is due, when no fold has run there yet.
const FOLD_PACK_THRESHOLD: u64 = 10;

/// Keeps one pack per call whatever the host's `pack.packSizeLimit` says, which would split one
/// capture's pack into several.
const PACK_SIZE_LIMIT_PIN: [&str; 2] = ["-c", "pack.packSizeLimit=0"];

/// Keeps `pack-objects` off its path walk, which a `feature.experimental` or `feature.manyFiles`
/// setting turns on and which loses objects in a capture folder's packs; a git without the
/// setting takes it silently.
const PATH_WALK_PIN: [&str; 2] = ["-c", "pack.usePathWalk=false"];

/// How long one fold may run, past the runner's bound for other calls, since its work grows with
/// every pack the folder holds.
const FOLD_TIMEOUT: Duration = Duration::from_mins(10);

/// How long a folder whose fold failed waits before a fold is due there again, so a failing fold
/// is not run again at every capture.
const FOLD_RETRY_WAIT: Duration = Duration::from_hours(1);

/// The folder of an object folder that holds its packs.
const PACK_SEGMENT: &str = "pack";

/// The extension of a pack's data file.
const PACK_EXTENSION: &str = "pack";

/// The extension of a pack's index, which lists its objects.
const PACK_INDEX_EXTENSION: &str = "idx";

/// The extension of a pack's reverse index, which a pack may have beside its index.
const PACK_REVERSE_INDEX_EXTENSION: &str = "rev";

/// One capture's commit in its capture folder and the base it stands on, for its pack.
#[derive(Clone, Debug)]
pub struct CapturedCommit {
    /// The capture folder the commit was written into.
    capture_folder: CaptureFolder,
    /// The capture's commit.
    commit: GitObjectId,
    /// The capture's tree.
    tree: GitObjectId,
    /// The repository's commit the capture stood on; `None` in a repository with no commit yet.
    base: Option<GitObjectId>,
}

impl CapturedCommit {
    /// The capture `commit` of `tree` written into `capture_folder` on `base`, `None` when the
    /// repository had no commit.
    pub(crate) fn new(
        capture_folder: CaptureFolder,
        commit: GitObjectId,
        tree: GitObjectId,
        base: Option<GitObjectId>,
    ) -> Self {
        Self {
            capture_folder,
            commit,
            tree,
            base,
        }
    }

    /// The capture's commit.
    pub fn commit(&self) -> &GitObjectId {
        &self.commit
    }

    /// The capture folder the commit was written into.
    pub(crate) fn capture_folder(&self) -> &CaptureFolder {
        &self.capture_folder
    }
}

/// One capture a sweep keeps alive: its commit, its tree and the repository's commit it stands
/// on, `None` for a capture taken before the repository had a commit, which has nothing to reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotPoint {
    /// The capture's commit in its capture folder.
    pub commit: GitObjectId,
    /// The capture's tree.
    pub tree: GitObjectId,
    /// The repository's commit the capture stood on.
    pub base: Option<GitObjectId>,
}

/// What one sweep pass found of one capture folder's repository: its refs' stat data, the stat
/// data of the capture folder's object folders, the packs git counted there once a count found
/// nothing loose, and when the stat data was read. Kept by the caller between passes and handed
/// back to the next one.
#[derive(Clone, Debug)]
pub struct CaptureFolderPass {
    /// The stat data of the repository's refs.
    ref_state: RefState,
    /// The stat data of the capture folder's object folders, read under its hold.
    object_folders: ObjectFolderState,
    /// The packs the folder held as `object_folders` read, once git counted no loose object and
    /// no leftover there; `None` otherwise.
    counted_packs: Option<u64>,
    /// When the stat data was read.
    read_at: SystemTime,
}

impl CaptureFolderPass {
    // Whether `current` reads the refs as this pass left them: the same entries with the same
    // facts, and none written so near this pass's read that a later write could keep its time.
    fn is_unchanged_by(&self, current: &RefState) -> bool {
        self.ref_state == *current && !self.ref_state.has_entry_near(self.read_at)
    }

    // The packs this pass counted, when `current` reads the object folders as this pass left
    // them, so no object was written or removed since that count; `None` when they changed or no
    // count found the folder clean.
    fn unchanged_packs(&self, current: &ObjectFolderState) -> Option<u64> {
        self.counted_packs.filter(|_| {
            self.object_folders == *current && !self.object_folders.has_entry_near(self.read_at)
        })
    }
}

/// The bases of a sweep's points by whether a ref of the repository reaches each; a base gone or
/// naming no commit counts as unreached, since what its captures borrow can be lost alike.
#[derive(Debug, Default)]
struct BaseReach {
    /// The bases no ref reaches, whose trees gc may take, and those gone or naming no commit.
    unreached: HashSet<GitObjectId>,
    /// The bases a ref reaches.
    reached: HashSet<GitObjectId>,
}

/// What a sweep did with one capture folder.
#[derive(Clone, Debug)]
pub enum CaptureFolderSweep {
    /// The owner has no capture folder for the repository.
    Absent,
    /// The repository's common git folder no longer resolves, so the pass did nothing beyond its
    /// owner's partial folders; the capture folder is kept, since the repository can come back.
    RepositoryGone,
    /// Nothing changed since the last pass, so nothing ran.
    Skipped(CaptureFolderPass),
    /// The folder was swept: its unreached captures packed and its packs folded when due.
    Swept(CaptureFolderPass),
}

/// A hold on every capture folder of one owner, taken while a purge removes them: a pack, a fold
/// or a sweep pass of one waits until it drops and then finds the folder gone.
pub struct OwnerFoldersHold<'a> {
    /// The lock's hold on each folder, released when this drops.
    _holds: Vec<KeyHold<'a, PathBuf>>,
}

/// Why a pack, a fold or a sweep pass failed.
#[derive(Debug, thiserror::Error)]
pub enum PackingError {
    /// A git call failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// git answered in a form this code does not read.
    #[error("git's {command} answer does not read: {reason}")]
    UnreadableAnswer {
        /// The command that answered.
        command: &'static str,
        /// What was wrong with the answer.
        reason: &'static str,
    },
    /// The capture folder, or the repository's refs, could not be read.
    #[error("the capture folder or the repository's refs could not be read")]
    Folder(#[source] io::Error),
}

/// Packs every capture folder after each capture and at each sweep, one at a time per folder, and
/// keeps, for this daemon run, how many packs each folder's last fold left, when its last fold
/// failed and the captures whose own pack failed; an old git it meets goes in the daemon run's
/// shared record.
pub struct CapturePacking {
    /// The daemon's git.
    git: GitRunner,
    /// One lock per capture folder, by its path.
    folder_lock: KeyedLock<PathBuf>,
    /// The packs each folder's last fold left in this daemon run.
    packs_left_by_fold: Mutex<HashMap<PathBuf, u64>>,
    /// When each folder's last fold failed, until a fold there succeeds.
    failed_folds: Mutex<HashMap<PathBuf, Instant>>,
    /// Each folder's captures whose own pack failed, until a pack of them succeeds: a fold packs
    /// a loose tree without what it borrows, which a sweep then no longer finds loose.
    failed_packs: Mutex<HashMap<PathBuf, FailedPacks>>,
    /// The daemon run's record of the old gits already reported.
    floor_reports: Arc<GitFloorReports>,
    /// When this daemon run's packing began; a scratch index last written before it is an earlier
    /// run's leftover at any age.
    began_at: SystemTime,
}

impl CapturePacking {
    /// Packing that runs `git` and reports a git too old to fold once through `floor_reports`, the
    /// daemon run's.
    pub fn new(git: GitRunner, floor_reports: Arc<GitFloorReports>) -> Self {
        Self {
            git,
            folder_lock: KeyedLock::new(),
            packs_left_by_fold: Mutex::new(HashMap::new()),
            failed_folds: Mutex::new(HashMap::new()),
            failed_packs: Mutex::new(HashMap::new()),
            floor_reports,
            began_at: SystemTime::now(),
        }
    }

    /// The lock each capture folder's packs, folds and sweep passes take, keyed by its path, for a
    /// test that waits for a caller to queue on one.
    #[cfg(any(test, feature = "test-support"))]
    pub fn folder_lock(&self) -> &KeyedLock<PathBuf> {
        &self.folder_lock
    }

    /// Forgets what this daemon run keeps of the capture folders under the owner folder
    /// `owner_folder`, for an owner whose folder was removed: how many packs each folder's last
    /// fold left, when a fold there failed and the captures whose own pack failed.
    pub fn forget_owner(&self, owner_folder: &Path) {
        lock(&self.packs_left_by_fold).retain(|folder, _| !folder.starts_with(owner_folder));
        lock(&self.failed_folds).retain(|folder, _| !folder.starts_with(owner_folder));
        lock(&self.failed_packs).retain(|folder, _| !folder.starts_with(owner_folder));
    }

    /// Holds every capture folder under the owner folder `owner_folder`, a folder still being made
    /// aside, once each one's pack, fold or sweep pass under way ends; the hold lasts until the
    /// answer drops. An owner with no captures folder answers an empty hold. Fails as listing the
    /// captures folder does.
    pub async fn hold_owner_folders(
        &self,
        owner_folder: &Path,
    ) -> io::Result<OwnerFoldersHold<'_>> {
        let captures = owner_folder.join(CAPTURES_SEGMENT);
        let mut folders = Vec::new();
        if let Some(mut entries) = tokio::fs::read_dir(&captures).await.none_if_missing()? {
            while let Some(entry) = entries.next_entry().await? {
                let name = entry.file_name();
                if !is_partial_capture_folder_name(&name) {
                    folders.push(captures.join(name));
                }
            }
        }
        Ok(OwnerFoldersHold {
            _holds: self.folder_lock.acquire_all(folders).await,
        })
    }

    /// Holds the capture folder `folder`, on the lock its packs, folds and sweep passes take, once
    /// the one under way ends; the hold lasts until the answer drops. A backup holds it while it
    /// copies the folder's objects, so nothing moves them during the copy.
    pub async fn hold_capture_folder(&self, folder: &Path) -> KeyHold<'_, PathBuf> {
        self.folder_lock.acquire(folder.to_path_buf()).await
    }

    /// Packs what `captured` borrows from the repository beyond its base's tree into its capture
    /// folder, removes the loose copies, and starts a fold on a task of its own when one is due,
    /// running git for the project at `place`; a folder a purge removed before its turn is left
    /// alone. Never fails: a failure is logged, the capture kept for the folder's next fold or
    /// sweep to pack again, and the remaining steps skipped.
    pub async fn pack(self: &Arc<Self>, place: Option<&Place>, captured: &CapturedCommit) {
        let capture_folder = &captured.capture_folder;
        let folder = capture_folder.folder().to_path_buf();
        // The commit with its objects, less everything the base's tree holds.
        let mut revisions = format!("{}\n", captured.commit.as_str());
        if let Some(base) = &captured.base {
            revisions.push_str("--not\n");
            revisions.push_str(base.as_str());
            revisions.push('\n');
        }
        let hold = self.folder_lock.acquire(folder.clone()).await;
        if is_folder_removed(&folder).await {
            return;
        }
        let packed = self
            .pack_revisions(place, capture_folder, revisions.into_bytes(), &hold)
            .await;
        drop(hold);
        let counts = match packed {
            Ok(counts) => counts,
            Err(failure) => {
                CaptureDiagnostic::PackFailed {
                    capture_folder: folder.clone(),
                    detail: Box::new(failure),
                }
                .warn();
                self.keep_failed_pack(folder, captured);
                return;
            }
        };
        if self.is_fold_due(&folder, counts.packs) {
            let packing = Arc::clone(self);
            let place = place.cloned();
            // Off the caller's path; a stop that cuts it short loses nothing.
            tokio::spawn(async move {
                packing.fold_when_due(place.as_ref(), folder).await;
            });
        }
    }

    /// One sweep pass over the capture folder of the owner whose folder is `owner_folder`, for the
    /// repository whose common git folder is `common_folder`, running git for the project at
    /// `place`, its blocking work charged to the meter of the metered run whose task calls, if any.
    /// A repository whose common git folder is gone
    /// answers `RepositoryGone` and keeps its capture folder; a capture folder a purge removed
    /// before the pass's turn answers `Absent`. Every pass first removes the owner's capture
    /// folders still being made and, once git has counted the folder's objects, git's temporaries
    /// and the scratch indexes left in it, each once it is an hour old, a scratch index also once
    /// it predates this daemon run. Skipped when the repository's refs read as `last_pass` left
    /// them, read at `read_at`, and the folder holds no loose object, no capture whose own pack
    /// failed and no fold is due, with no git process run once its object folders also read as
    /// the last count left them; else the trees of the folder's captures and of `extra_points`
    /// whose base no ref reaches are packed,
    /// the captures whose tree is a loose object an hour old are packed again on their own base,
    /// those loose objects are packed, a folder a prune marked once its run's refs are gone is
    /// reclaimed from its refs, `extra_points` and its kept indexes, and the packs folded; a
    /// folder holding a reclaim due is never skipped. The reclaim also keeps what each of
    /// `kept_commits` reaches, a commit the folder lacks skipped, so a capture an owner's window
    /// recorded under another spelling of the repository stays whole. Fails with the step's
    /// failure, so no pass is kept and the next sweep runs it all.
    #[expect(
        clippy::too_many_arguments,
        reason = "each is one fact of the pass the caller holds"
    )]
    pub async fn sweep_capture_folder(
        &self,
        place: Option<&Place>,
        owner_folder: &Path,
        common_folder: &Path,
        last_pass: Option<&CaptureFolderPass>,
        extra_points: &[SnapshotPoint],
        kept_commits: &[GitObjectId],
        read_at: SystemTime,
    ) -> Result<CaptureFolderSweep, PackingError> {
        // Owner-wide and before the repository is resolved, so a half-made folder of a repository
        // since deleted is cleared too.
        let owner = owner_folder.to_path_buf();
        joined(run_blocking(move || clear_partial_capture_folders(&owner)).await)
            .map_err(PackingError::Folder)?;
        let Some(capture_folder) = CaptureFolder::open_existing(owner_folder, common_folder)
            .await
            .map_err(PackingError::Folder)?
        else {
            return Ok(CaptureFolderSweep::Absent);
        };
        // A deleted folder still resolves through its nearest parent, so the capture folder is
        // found; only the common folder itself says the repository is gone.
        match tokio::fs::metadata(common_folder).await {
            Ok(_) => {}
            Err(gone) if is_gone(&gone) => return Ok(CaptureFolderSweep::RepositoryGone),
            Err(failure) => return Err(PackingError::Folder(failure)),
        }
        // Read before any work, so a change made during the pass is seen by the next one.
        let common = common_folder.to_path_buf();
        let ref_state = joined(run_blocking(move || read_ref_state(&common)).await)
            .map_err(PackingError::Folder)?;
        let folder = capture_folder.folder().to_path_buf();
        let hold = self.folder_lock.acquire(folder.clone()).await;
        if is_folder_removed(&folder).await {
            return Ok(CaptureFolderSweep::Absent);
        }
        let objects = folder.join(OBJECTS_SEGMENT);
        let object_folders = joined(run_blocking(move || read_object_folder_state(&objects)).await)
            .map_err(PackingError::Folder)?;
        let due_marks = self.read_due_marks(place, &folder, &hold).await?;
        let is_unchanged = last_pass.is_some_and(|last| last.is_unchanged_by(&ref_state));
        let is_held_back = !due_marks.is_empty() || lock(&self.failed_packs).contains_key(&folder);
        // An idle folder starts no git process: its refs and its object folders read as the last
        // count left them, so that count still holds.
        if let Some(packs) = last_pass.and_then(|last| last.unchanged_packs(&object_folders))
            && is_unchanged
            && !is_held_back
            && !self.is_fold_due(&folder, packs)
        {
            self.clear_leftovers(&folder, false).await?;
            return Ok(CaptureFolderSweep::Skipped(CaptureFolderPass {
                ref_state,
                object_folders,
                counted_packs: Some(packs),
                read_at,
            }));
        }
        let counts = self.count_objects(place, &folder, &hold).await?;
        // A temporary loose object counts as garbage and a stale one as loose, so the fan-out
        // folders are listed only then.
        let is_object_folder_walked = counts.garbage > 0 || counts.loose > 0;
        let stale_objects = self
            .clear_leftovers(&folder, is_object_folder_walked)
            .await?;
        let mut pass = CaptureFolderPass {
            ref_state,
            object_folders,
            counted_packs: None,
            read_at,
        };
        if is_unchanged
            && counts.loose == 0
            && !is_held_back
            && !self.is_fold_due(&folder, counts.packs)
        {
            pass.counted_packs = (counts.garbage == 0).then_some(counts.packs);
            return Ok(CaptureFolderSweep::Skipped(pass));
        }
        let mut points = self.read_capture_points(place, &folder, &hold).await?;
        points.extend_from_slice(extra_points);
        let reach = self
            .read_base_reach(place, &folder, common_folder, &points, &hold)
            .await?;
        let unreached_trees: Vec<&GitObjectId> = points
            .iter()
            .filter(|point| {
                point
                    .base
                    .as_ref()
                    .is_some_and(|base| reach.unreached.contains(base))
            })
            .map(|point| &point.tree)
            .collect();
        if !unreached_trees.is_empty() {
            self.pack_unreached_trees(
                place,
                &capture_folder,
                common_folder,
                &unreached_trees,
                &hold,
            )
            .await?;
        }
        if !stale_objects.is_empty() {
            // A capture whose own pack failed left its tree loose; one whose base no ref reaches
            // was packed above.
            let stale: HashSet<&GitObjectId> = stale_objects.iter().collect();
            let failed_points: Vec<&SnapshotPoint> = points
                .iter()
                .filter(|point| stale.contains(&point.tree))
                .filter(|point| {
                    point
                        .base
                        .as_ref()
                        .is_none_or(|base| reach.reached.contains(base))
                })
                .collect();
            self.pack_stale_points(place, &capture_folder, &failed_points, &hold)
                .await?;
            self.pack_listed_objects(place, &folder, &stale_objects, &hold)
                .await?;
        }
        if !due_marks.is_empty() {
            let reclaim = ReclaimKept {
                points: extra_points,
                commits: kept_commits,
            };
            self.reclaim(place, &folder, &reclaim, &due_marks, &hold)
                .await?;
        }
        self.fold_held(place, &folder, &hold).await?;
        Ok(CaptureFolderSweep::Swept(pass))
    }

    // Clears the capture folder `folder`'s stale leftovers, its fan-out folders walked when
    // `is_object_folder_walked`, and answers the loose objects the walk found an hour old.
    async fn clear_leftovers(
        &self,
        folder: &Path,
        is_object_folder_walked: bool,
    ) -> Result<Vec<GitObjectId>, PackingError> {
        let (cleared, run_began_at) = (folder.to_path_buf(), self.began_at);
        joined(
            run_blocking(move || {
                clear_capture_folder_leftovers(&cleared, is_object_folder_walked, run_began_at)
            })
            .await,
        )
        .map_err(PackingError::Folder)
    }

    // Packs the objects `revisions` name on standard input into the capture folder, the repository
    // attached so what the captures borrow is copied, removes the loose copies, and counts what is
    // left.
    async fn pack_revisions(
        &self,
        place: Option<&Place>,
        capture_folder: &CaptureFolder,
        revisions: Vec<u8>,
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<ObjectCounts, PackingError> {
        let folder = capture_folder.folder();
        // `--revs` on standard input, never a `rev-list` pipe, whose line buffer a long path
        // passes; `--non-empty` writes no pack when nothing is new; never `--local`,
        // `--incremental` or `--thin`, which leave borrowed objects out.
        let mut arguments = in_git_folder(
            folder,
            &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN, &PATH_WALK_PIN],
            &["pack-objects", "-q", "--revs", "--non-empty"],
        );
        arguments.push(pack_name_base(folder));
        let mut call = GitCall::read(arguments).with_input(revisions);
        for (name, value) in capture_folder.write_environment() {
            call = call.with_environment(name, value);
        }
        self.git.run(place, call).await?;
        self.prune_packed(place, folder).await?;
        self.count_objects(place, folder, hold).await
    }

    // Removes the folder's loose objects its packs hold. No alternate attached, so only what the
    // folder's own packs hold is removed.
    async fn prune_packed(&self, place: Option<&Place>, folder: &Path) -> Result<(), GitError> {
        let arguments = in_git_folder(folder, &[], &["prune-packed", "-q"]);
        self.git.run(place, GitCall::read(arguments)).await?;
        Ok(())
    }

    // The capture folder's loose objects and packs.
    async fn count_objects(
        &self,
        place: Option<&Place>,
        folder: &Path,
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<ObjectCounts, PackingError> {
        let arguments = in_git_folder(folder, &[], &["count-objects", "-v"]);
        let output = self.git.run(place, GitCall::read(arguments)).await?;
        read_object_counts(&output.stdout)
    }

    // Whether a fold of `folder` holding `packs` packs is due: more than the threshold and more
    // than the last fold left, since packs already in geometric order would otherwise be folded
    // again, with nothing merged, after every capture, and not while a failed fold there waits.
    fn is_fold_due(&self, folder: &Path, packs: u64) -> bool {
        let left = lock(&self.packs_left_by_fold).get(folder).copied();
        let since_failure = lock(&self.failed_folds).get(folder).map(Instant::elapsed);
        is_fold_due(packs, left, since_failure)
    }

    // Whether the git for `place` can fold; a git that cannot is reported once and the fold
    // skipped. Fails when the version cannot be read.
    async fn can_fold(&self, place: Option<&Place>) -> Result<bool, PackingError> {
        let version = self.git.version(place, GitFeature::RepackGeometric).await?;
        if version.has(GitFeature::RepackGeometric) {
            return Ok(true);
        }
        self.floor_reports
            .report_once(place, version, GitFeature::RepackGeometric);
        Ok(false)
    }

    // A fold a capture's pack found due, run when the folder's lock comes free and only when it is
    // still due and still there then. Never fails: a failure is logged.
    async fn fold_when_due(&self, place: Option<&Place>, folder: PathBuf) {
        let hold = self.folder_lock.acquire(folder.clone()).await;
        if is_folder_removed(&folder).await {
            return;
        }
        let folded = self.fold_held(place, &folder, &hold).await;
        drop(hold);
        if let Err(failure) = folded {
            CaptureDiagnostic::FoldFailed {
                capture_folder: folder,
                detail: Box::new(failure),
            }
            .warn();
        }
    }

    // Packs again the captures of `folder` whose own pack failed, then folds its packs into
    // geometric order when a fold is due and the git for `place` can fold, and keeps how many
    // packs it left, or when it failed, a failed read of git's version included, so the next fold
    // there waits; a fold that finds its folder gone keeps nothing.
    async fn fold_held(
        &self,
        place: Option<&Place>,
        folder: &Path,
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        self.pack_failed_captures(place, folder, hold).await;
        let counts = self.count_objects(place, folder, hold).await?;
        if !self.is_fold_due(folder, counts.packs) {
            return Ok(());
        }
        let folded = match self.can_fold(place).await {
            Ok(true) => self.fold(place, folder, hold).await,
            Ok(false) => return Ok(()),
            Err(failure) => Err(failure),
        };
        // A folder removed while its fold ran, as a purge removes its owner's, has its entries
        // forgotten, so none is kept for it here. The check is made under the lock the purge's
        // forgetting takes, so a purge that removes the folder after it forgets what this keeps.
        let mut failed_folds = lock(&self.failed_folds);
        match &folded {
            Ok(()) => {
                failed_folds.remove(folder);
            }
            Err(_) if matches!(folder.try_exists(), Ok(false)) => {}
            Err(_) => {
                failed_folds.insert(folder.to_path_buf(), Instant::now());
            }
        }
        folded
    }

    // Removes the stale temporary packs a git cut short left, folds `folder`'s packs under the
    // fold's own bound, and keeps how many packs it left.
    async fn fold(
        &self,
        place: Option<&Place>,
        folder: &Path,
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        let pack_folder = folder.join(OBJECTS_SEGMENT).join(PACK_SEGMENT);
        joined(
            tokio::task::spawn_blocking(move || remove_stale_temporary_packs(&pack_folder)).await,
        )
        .map_err(PackingError::Folder)?;
        // No alternate attached, and never `-l`, which with a store attached would leave out every
        // object that store holds; `-n` writes neither `info/refs` nor `objects/info/packs`, and no
        // bitmap is written, which a `pack.writeBitmaps` setting would otherwise fail on. Never
        // `-a`, `-A` or `-m`, which fail on a folder whose objects are borrowed.
        let arguments = in_git_folder(
            folder,
            &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN, &PATH_WALK_PIN],
            &[
                "repack",
                "--geometric=2",
                "-d",
                "-n",
                "-q",
                "--no-write-bitmap-index",
            ],
        );
        self.git
            .run_within(place, GitCall::read(arguments), FOLD_TIMEOUT)
            .await?;
        let left = self.count_objects(place, folder, hold).await?;
        lock(&self.packs_left_by_fold).insert(folder.to_path_buf(), left.packs);
        Ok(())
    }

    // The captures the folder's refs under `refs/sidekicks/runs/` name; a ref that does not read
    // as one capture over at most one base is logged and left out.
    async fn read_capture_points(
        &self,
        place: Option<&Place>,
        folder: &Path,
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<Vec<SnapshotPoint>, PackingError> {
        let arguments = in_git_folder(
            folder,
            &[],
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname) %(tree) %(parent)",
                SNAPSHOT_REFS_PREFIX,
            ],
        );
        let output = self.git.run(place, GitCall::read(arguments)).await?;
        let (points, unreadable) = read_points(&output.stdout);
        for line in unreadable {
            CaptureDiagnostic::UnreadableRef {
                capture_folder: folder.to_path_buf(),
                line,
            }
            .warn();
        }
        Ok(points)
    }
}

// Whether `folder` is known to be gone, as a purge leaves it; a failed check reads as present, so
// the work goes on and reports its own failure.
async fn is_folder_removed(folder: &Path) -> bool {
    matches!(tokio::fs::try_exists(folder).await, Ok(false))
}

// The name prefix of `folder`'s packs: git names each `pack-<hash>` in the folder's pack folder.
fn pack_name_base(folder: &Path) -> OsString {
    folder
        .join(OBJECTS_SEGMENT)
        .join(PACK_SEGMENT)
        .join(PACK_SEGMENT)
        .into_os_string()
}

// Whether a fold of a folder holding `packs` packs is due, when the last fold there left `left`
// and its last fold failed `since_failure` ago.
fn is_fold_due(packs: u64, left: Option<u64>, since_failure: Option<Duration>) -> bool {
    since_failure.is_none_or(|since_failure| since_failure >= FOLD_RETRY_WAIT)
        && packs > left.unwrap_or(0).max(FOLD_PACK_THRESHOLD)
}

// Logs that `base`, under the captures of `folder`, is gone or names a `found_type` object.
fn log_base_lost(folder: &Path, base: &GitObjectId, found_type: Option<String>) {
    CaptureDiagnostic::BaseLost {
        capture_folder: folder.to_path_buf(),
        base: base.clone(),
        found_type,
    }
    .warn();
}

#[cfg(test)]
mod tests;
