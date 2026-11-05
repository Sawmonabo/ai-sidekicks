//! Packing the capture folders: after each capture, what it borrows from the repository beyond its
//! base's tree is packed into its capture folder, so a gc in the repository never takes a captured
//! file away; once a folder holds more packs than the last fold left, and at each sweep, its packs
//! are folded. The sweep also packs the trees of captures whose base no ref of the repository
//! reaches any more, and skips a folder whose refs, packs and loose objects are as its last pass
//! left them.
//!
//! - Every call against a capture folder runs with `--git-dir` alone; only the pack of a capture's
//!   objects attaches the repository, since `prune-packed` and the fold with it attached would
//!   take a loose object only the repository's packs hold.
//! - One lock per capture folder orders its packs, folds and sweep passes.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use crate::git::cat_file::object_lines;
use crate::git::process::version::GitFeature;
use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::{CORE_FSYNC_PIN, GitFloorReports};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, OBJECTS_SEGMENT, in_git_folder};
use crate::git::turn_snapshot::capture_steps::{UNRESOLVED_NAME_EXIT_CODE, joined};
use crate::git::turn_snapshot::diagnostics::CaptureDiagnostic;
use crate::git::turn_snapshot::refs::SNAPSHOT_REFS_PREFIX;
use answers::{
    BasePresence, ObjectCounts, read_bases_present, read_object_counts, read_points, read_reach,
};
use ref_state::{RefState, read_ref_state};

mod answers;
mod ref_state;

/// The packs a capture folder may hold before a fold is due, when no fold has run there yet.
const FOLD_PACK_THRESHOLD: u64 = 10;

/// Keeps one pack per call whatever the host's `pack.packSizeLimit` says, which would split one
/// capture's pack into several.
const PACK_SIZE_LIMIT_PIN: [&str; 2] = ["-c", "pack.packSizeLimit=0"];

/// How long one fold may run, past the runner's bound for other calls, since its work grows with
/// every pack the folder holds; a temporary pack older than this was left by a git cut short.
const FOLD_TIMEOUT: Duration = Duration::from_mins(10);

/// How long a folder whose fold failed waits before a fold is due there again, so a failing fold
/// is not run again at every capture.
const FOLD_RETRY_WAIT: Duration = Duration::from_hours(1);

/// The folder of an object folder that holds its packs.
const PACK_SEGMENT: &str = "pack";

/// The name prefixes of the temporary files a pack write keeps in the pack folder until it
/// finishes: `pack-objects`' and `index-pack`'s `tmp_`, and `repack`'s `.tmp-`.
const TEMPORARY_PACK_PREFIXES: [&str; 2] = ["tmp_", ".tmp-"];

/// One capture's commit in its capture folder and the base it stands on, for its pack.
#[derive(Clone, Debug)]
pub struct CapturedCommit {
    /// The capture folder the commit was written into.
    capture_folder: CaptureFolder,
    /// The capture's commit.
    commit: GitObjectId,
    /// The repository's commit the capture stood on; `None` in a repository with no commit yet.
    base: Option<GitObjectId>,
}

impl CapturedCommit {
    /// The capture `commit` written into `capture_folder` on `base`, `None` when the repository
    /// had no commit.
    pub(crate) fn new(
        capture_folder: CaptureFolder,
        commit: GitObjectId,
        base: Option<GitObjectId>,
    ) -> Self {
        Self {
            capture_folder,
            commit,
            base,
        }
    }

    /// The capture's commit.
    pub fn commit(&self) -> &GitObjectId {
        &self.commit
    }
}

/// One capture a sweep keeps alive: its tree and the repository's commit it stands on, `None` for
/// a capture taken before the repository had a commit, which has nothing to reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotPoint {
    /// The capture's tree.
    pub tree: GitObjectId,
    /// The repository's commit the capture stood on.
    pub base: Option<GitObjectId>,
}

/// What one sweep pass found of one capture folder's repository: its refs' stat data and when it
/// was read. Kept by the caller between passes and handed back to the next one.
#[derive(Clone, Debug)]
pub struct CaptureFolderPass {
    /// The stat data of the repository's refs.
    ref_state: RefState,
    /// When the stat data was read.
    read_at: SystemTime,
}

impl CaptureFolderPass {
    // Whether `current` reads the refs as this pass left them: the same entries with the same
    // facts, and none written so near this pass's read that a later write could keep its time.
    fn is_unchanged_by(&self, current: &RefState) -> bool {
        self.ref_state == *current && !self.ref_state.has_entry_near(self.read_at)
    }
}

/// What a sweep did with one capture folder.
#[derive(Clone, Debug)]
pub enum CaptureFolderSweep {
    /// The owner has no capture folder for the repository.
    Absent,
    /// Nothing changed since the last pass, so nothing ran.
    Skipped(CaptureFolderPass),
    /// The folder was swept: its unreached captures packed and its packs folded when due.
    Swept(CaptureFolderPass),
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
/// keeps, for this daemon run, how many packs each folder's last fold left and when its last fold
/// failed.
pub struct CapturePacking {
    /// The daemon's git.
    git: GitRunner,
    /// One lock per capture folder, by its path.
    folder_lock: KeyedLock<PathBuf>,
    /// The packs each folder's last fold left in this daemon run.
    packs_left_by_fold: Mutex<HashMap<PathBuf, u64>>,
    /// When each folder's last fold failed, until a fold there succeeds.
    failed_folds: Mutex<HashMap<PathBuf, Instant>>,
    /// The places whose git was reported too old to fold.
    floor_reports: GitFloorReports,
}

impl CapturePacking {
    /// Packing that runs `git`.
    pub fn new(git: GitRunner) -> Self {
        Self {
            git,
            folder_lock: KeyedLock::new(),
            packs_left_by_fold: Mutex::new(HashMap::new()),
            failed_folds: Mutex::new(HashMap::new()),
            floor_reports: GitFloorReports::new(),
        }
    }

    /// Forgets what this daemon run keeps of the capture folders under the owner folder
    /// `owner_folder`, for an owner whose folder was removed: how many packs each folder's last
    /// fold left and when a fold there failed.
    pub fn forget_owner(&self, owner_folder: &Path) {
        lock(&self.packs_left_by_fold).retain(|folder, _| !folder.starts_with(owner_folder));
        lock(&self.failed_folds).retain(|folder, _| !folder.starts_with(owner_folder));
    }

    /// Packs what `captured` borrows from the repository beyond its base's tree into its capture
    /// folder, removes the loose copies, and starts a fold on a task of its own when one is due,
    /// running git for the project at `place`. Never fails: a failure is logged and the remaining
    /// steps skipped.
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
        let packed = self
            .pack_revisions(place, capture_folder, revisions.into_bytes(), &hold)
            .await;
        drop(hold);
        let counts = match packed {
            Ok(counts) => counts,
            Err(failure) => {
                CaptureDiagnostic::PackFailed {
                    capture_folder: folder,
                    detail: Box::new(failure),
                }
                .warn();
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
    /// `place`. Skipped when the repository's refs read as `last_pass` left them, read at
    /// `read_at`, and the folder holds no loose object and no fold is due; else the trees of the
    /// folder's captures and of `extra_points` whose base no ref reaches are packed and the packs
    /// folded. Fails with the step's failure, so no pass is kept and the next sweep runs it all.
    pub async fn sweep_capture_folder(
        &self,
        place: Option<&Place>,
        owner_folder: &Path,
        common_folder: &Path,
        last_pass: Option<&CaptureFolderPass>,
        extra_points: &[SnapshotPoint],
        read_at: SystemTime,
    ) -> Result<CaptureFolderSweep, PackingError> {
        let Some(capture_folder) = CaptureFolder::open_existing(owner_folder, common_folder)
            .await
            .map_err(PackingError::Folder)?
        else {
            return Ok(CaptureFolderSweep::Absent);
        };
        // Read before any work, so a change made during the pass is seen by the next one.
        let common = common_folder.to_path_buf();
        let ref_state = joined(tokio::task::spawn_blocking(move || read_ref_state(&common)).await)
            .map_err(PackingError::Folder)?;
        let pass = CaptureFolderPass { ref_state, read_at };
        let folder = capture_folder.folder().to_path_buf();
        let hold = self.folder_lock.acquire(folder.clone()).await;
        let counts = self.count_objects(place, &folder, &hold).await?;
        let is_unchanged = last_pass.is_some_and(|last| last.is_unchanged_by(&pass.ref_state));
        if is_unchanged && counts.loose == 0 && !self.is_fold_due(&folder, counts.packs) {
            return Ok(CaptureFolderSweep::Skipped(pass));
        }
        let mut points = self.read_capture_points(place, &folder, &hold).await?;
        points.extend_from_slice(extra_points);
        let unreached = self
            .read_unreached_bases(place, &folder, common_folder, &points, &hold)
            .await?;
        let unreached_trees: Vec<&GitObjectId> = points
            .iter()
            .filter(|point| {
                point
                    .base
                    .as_ref()
                    .is_some_and(|base| unreached.contains(base))
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
        self.fold_held(place, &folder, &hold).await?;
        Ok(CaptureFolderSweep::Swept(pass))
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
        // The packs' name prefix: git names each `pack-<hash>` in the folder's pack folder.
        let pack_base = folder
            .join(OBJECTS_SEGMENT)
            .join(PACK_SEGMENT)
            .join(PACK_SEGMENT);
        // `--revs` on standard input, never a `rev-list` pipe, whose line buffer a long path
        // passes; `--non-empty` writes no pack when nothing is new; never `--local`,
        // `--incremental` or `--thin`, which leave borrowed objects out.
        let mut arguments = in_git_folder(
            folder,
            &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN],
            &["pack-objects", "-q", "--revs", "--non-empty"],
        );
        arguments.push(pack_base.into_os_string());
        let mut call = GitCall::read(arguments).with_input(revisions);
        for (name, value) in capture_folder.write_environment() {
            call = call.with_environment(name, value);
        }
        self.git.run(place, call).await?;
        // No alternate attached, so only what the folder's own packs hold is removed.
        let arguments = in_git_folder(folder, &[], &["prune-packed", "-q"]);
        self.git.run(place, GitCall::read(arguments)).await?;
        self.count_objects(place, folder, hold).await
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
    // still due then. Never fails: a failure is logged.
    async fn fold_when_due(&self, place: Option<&Place>, folder: PathBuf) {
        let hold = self.folder_lock.acquire(folder.clone()).await;
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

    // Folds `folder`'s packs into geometric order when a fold is due and the git for `place` can
    // fold, and keeps how many packs it left, or when it failed, a failed read of git's version
    // included, so the next fold there waits; a fold that finds its folder gone keeps nothing.
    async fn fold_held(
        &self,
        place: Option<&Place>,
        folder: &Path,
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
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

    // Removes the temporary packs a fold cut short left, folds `folder`'s packs under the fold's
    // own bound, and keeps how many packs it left.
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
        // No alternate attached; `-n` writes neither `info/refs` nor `objects/info/packs`, and no
        // bitmap is written, which a `pack.writeBitmaps` setting would otherwise fail on. Never
        // `-a`, `-A` or `-m`, which fail on a folder whose objects are borrowed.
        let arguments = in_git_folder(
            folder,
            &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN],
            &[
                "repack",
                "--geometric=2",
                "-d",
                "-l",
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

    // The distinct bases of `points` that the repository holds as commits and no ref of it
    // reaches; a base gone or naming no commit is logged and left out.
    async fn read_unreached_bases(
        &self,
        place: Option<&Place>,
        folder: &Path,
        common_folder: &Path,
        points: &[SnapshotPoint],
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<HashSet<GitObjectId>, PackingError> {
        let mut bases: Vec<&GitObjectId> = points
            .iter()
            .filter_map(|point| point.base.as_ref())
            .collect();
        bases.sort_unstable();
        bases.dedup();
        if bases.is_empty() {
            return Ok(HashSet::new());
        }
        let input = object_lines(bases.iter().copied());
        let arguments = in_git_folder(common_folder, &[], &["cat-file", "--batch-check"]);
        let output = self
            .git
            .run(place, GitCall::read(arguments).with_input(input))
            .await?;
        let presence = read_bases_present(&output.stdout, &bases)?;
        let mut unreached = HashSet::new();
        for (base, presence) in bases.into_iter().zip(presence) {
            match presence {
                BasePresence::Commit => {}
                BasePresence::Missing => {
                    log_base_lost(folder, base, None);
                    continue;
                }
                BasePresence::NotACommit(found_type) => {
                    log_base_lost(folder, base, Some(found_type));
                    continue;
                }
            }
            let arguments = in_git_folder(
                common_folder,
                &[],
                &["rev-list", "-n1", base.as_str(), "--not", "--all"],
            );
            let output = self.git.run(place, GitCall::read(arguments)).await?;
            if !read_reach(&output.stdout, base)? {
                unreached.insert(base.clone());
            }
        }
        Ok(unreached)
    }

    // Packs `trees` into the capture folder less what the repository's `HEAD` tree holds, the
    // repository attached, then removes the loose copies.
    async fn pack_unreached_trees(
        &self,
        place: Option<&Place>,
        capture_folder: &CaptureFolder,
        common_folder: &Path,
        trees: &[&GitObjectId],
        hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        let mut revisions = String::new();
        for tree in trees {
            revisions.push_str(tree.as_str());
            revisions.push('\n');
        }
        let arguments = in_git_folder(
            common_folder,
            &[],
            &["rev-parse", "--verify", "-q", "HEAD^{tree}"],
        );
        // An unborn `HEAD` has no tree, so nothing is left out.
        match self.git.run(place, GitCall::read(arguments)).await {
            Ok(output) => {
                let head_tree =
                    GitObjectId::new(String::from_utf8_lossy(&output.stdout).trim().to_owned())
                        .ok_or(PackingError::UnreadableAnswer {
                            command: "rev-parse",
                            reason: "the HEAD tree is not an object id",
                        })?;
                revisions.push_str("--not\n");
                revisions.push_str(head_tree.as_str());
                revisions.push('\n');
            }
            Err(unresolved) if unresolved.exit_code() == Some(UNRESOLVED_NAME_EXIT_CODE) => {}
            Err(failure) => return Err(failure.into()),
        }
        self.pack_revisions(place, capture_folder, revisions.into_bytes(), hold)
            .await?;
        Ok(())
    }
}

// Whether a fold of a folder holding `packs` packs is due, when the last fold there left `left`
// and its last fold failed `since_failure` ago.
fn is_fold_due(packs: u64, left: Option<u64>, since_failure: Option<Duration>) -> bool {
    since_failure.is_none_or(|since_failure| since_failure >= FOLD_RETRY_WAIT)
        && packs > left.unwrap_or(0).max(FOLD_PACK_THRESHOLD)
}

// Removes from `pack_folder` each temporary pack file written longer ago than a fold may run, so
// only what a git cut short at its bound, or a crash, left; a live write's file is never that old.
fn remove_stale_temporary_packs(pack_folder: &Path) -> io::Result<()> {
    let Some(entries) = fs::read_dir(pack_folder).none_if_missing()? else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !TEMPORARY_PACK_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let Some(metadata) = entry.metadata().none_if_missing()? else {
            continue;
        };
        // A write time ahead of the clock reads as just written.
        let age = metadata.modified()?.elapsed().unwrap_or(Duration::ZERO);
        if age > FOLD_TIMEOUT {
            fs::remove_file(entry.path()).none_if_missing()?;
        }
    }
    Ok(())
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
