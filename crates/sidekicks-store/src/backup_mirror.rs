//! The mirror: one copy, in the backups folder, of the files a backup holds beside the database,
//! each named root under a folder of its name, owner-only. Each root is a place under the home
//! folder, kept relative to it, so a restore on a computer whose home differs puts it back under
//! its own. A run copies only a file whose size differs from its copy's or whose modification time
//! is apart from it by the precision the copies' folder keeps or more, which each run measures
//! there, since file systems keep a time to a nanosecond (APFS, ext4), 100 ns (NTFS), 10 ms
//! (exFAT) or two seconds (FAT); it keeps the source's modification time on the copy so the next
//! run passes it over, and deletes each copy whose source is gone, so a session `Delete old data`
//! removed leaves the mirror at the next run. A file is copied under a temporary name starting with
//! `.`, which git never reads as a ref, flushed and renamed over its copy, so a copy whose size and
//! time reached the disk holds its bytes too; a leveling never copies such a name and removes every
//! one it finds on the side it writes. Links
//! are not followed and not copied. A run may take a root's copy from a folder other than its place,
//! or keep the copy as the last run left it, while a restore always writes the copy to the place;
//! a folder other than the place that is gone while its root is copied, a drive unplugged, never
//! empties the copy.
//! Each git folder under a root is copied whole by one routine in both directions: the files that
//! name its objects read first, its objects copied next, under the hold its writer gives it, the
//! files that name them placed last, so a copy cut short holds refs over a superset of their
//! objects.

mod git_folder;

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sidekicks_platforms::{
    create_missing_private_folders, flush_file, remove_tree, rename_replacing,
};
use sidekicks_std::file::removal_after_failure::remove_file_after_failure;
use sidekicks_std::file::time_precision::probe_time_precision;
use sidekicks_std::missing_entry::{MissingEntry as _, is_missing_entry};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::backup_mirror::git_folder::is_git_folder;

/// The mirror's folder inside the backups folder; it holds no manifest, so no reader takes it
/// for a backup.
pub const MIRROR_FOLDER_NAME: &str = "mirror";

/// The file inside the mirror naming where each root's files came from, which a restore reads.
pub const MIRROR_ROOTS_FILE_NAME: &str = "roots.json";

// The suffix of a copy on its way to its place, written after a leading `.` and the copy's name,
// so git, which reads no ref whose name starts with `.`, never reads one a cut-short run left.
const COPY_IN_PROGRESS_SUFFIX: &str = ".mirror-copy";

// What starts the name of a copy on its way to its place.
const COPY_IN_PROGRESS_PREFIX: &str = ".";

// The separator of a root's path in the mirror's list, whatever system wrote it.
const LISTED_PATH_SEPARATOR: char = '/';

/// One file or folder the mirror keeps a copy of: the name of its folder in the mirror, one plain
/// path component, and its place under the home folder, plain components joined by `/`. The
/// mirror's list is read from the backups folder, so a root that reads is checked as [`new`]
/// checks one.
///
/// [`new`]: MirrorRoot::new
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "ListedMirrorRoot")]
pub struct MirrorRoot {
    name: String,
    source: String,
    #[serde(skip_serializing)]
    copy_source: MirrorCopySource,
}

/// Where a run takes a root's copy from. The mirror's list never holds it, so a root read back for
/// a restore takes [`MirrorCopySource::Place`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MirrorCopySource {
    /// The root's own place under the home folder.
    Place,
    /// Another folder, absolute, which may lie outside the home folder.
    Folder(PathBuf),
    /// Nowhere: the copy stays as the last run left it.
    KeptAsIs,
}

// A root as the mirror's list holds it, before its check.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListedMirrorRoot {
    name: String,
    source: String,
}

/// Why a root was refused.
#[derive(Debug, thiserror::Error)]
pub enum MirrorRootError {
    /// The name is not one plain path component.
    #[error("a kept place's name is not one plain folder name")]
    Name,
    /// The place is not a path of plain components under the home folder.
    #[error("a kept place is not a path under the home folder")]
    Source,
}

impl TryFrom<ListedMirrorRoot> for MirrorRoot {
    type Error = MirrorRootError;

    fn try_from(listed: ListedMirrorRoot) -> Result<Self, Self::Error> {
        if !is_plain_component(&listed.name) {
            return Err(MirrorRootError::Name);
        }
        if listed.source.is_empty()
            || !listed
                .source
                .split(LISTED_PATH_SEPARATOR)
                .all(is_plain_component)
        {
            return Err(MirrorRootError::Source);
        }
        Ok(Self {
            name: listed.name,
            source: listed.source,
            copy_source: MirrorCopySource::Place,
        })
    }
}

impl MirrorRoot {
    /// The root named `name` keeping `source`, a path relative to the home folder. Fails when the
    /// name is not one plain path component, or the path is empty, absolute, not UTF-8 or holds a
    /// component other than a plain name, such as `..`.
    pub fn new(name: String, source: &Path) -> Result<Self, MirrorRootError> {
        let components = source
            .components()
            .map(|component| match component {
                Component::Normal(part) => part.to_str().ok_or(MirrorRootError::Source),
                Component::Prefix(_)
                | Component::RootDir
                | Component::CurDir
                | Component::ParentDir => Err(MirrorRootError::Source),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Self::try_from(ListedMirrorRoot {
            name,
            source: components.join(&LISTED_PATH_SEPARATOR.to_string()),
        })
    }

    /// The root named `name` keeping `place`, a path under `home` as `home` is spelled. Fails as
    /// [`new`] does, and when `place` is not under `home`.
    ///
    /// [`new`]: MirrorRoot::new
    pub fn under_home(name: String, home: &Path, place: &Path) -> Result<Self, MirrorRootError> {
        let source = place
            .strip_prefix(home)
            .map_err(|_outside| MirrorRootError::Source)?;
        Self::new(name, source)
    }

    /// This root with its copy taken from `folder`, an absolute path that may lie outside the home
    /// folder, while a restore still writes the copy to the root's place.
    #[must_use]
    pub fn copied_from(self, folder: PathBuf) -> Self {
        Self {
            copy_source: MirrorCopySource::Folder(folder),
            ..self
        }
    }

    /// This root with its copy kept as the last run left it, for a source that cannot be read
    /// today; a root with no copy yet keeps none.
    #[must_use]
    pub fn kept_as_is(self) -> Self {
        Self {
            copy_source: MirrorCopySource::KeptAsIs,
            ..self
        }
    }

    /// The copy's name in the mirror.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The place this root keeps on the computer whose home folder is `home`.
    pub fn place(&self, home: &Path) -> PathBuf {
        self.source
            .split(LISTED_PATH_SEPARATOR)
            .fold(home.to_path_buf(), |place, part| place.join(part))
    }
}

// Whether `part` is one plain path component on this system and on every other: not empty, not
// `.` or `..`, and holding neither separator.
fn is_plain_component(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.contains(['/', '\\'])
        && matches!(
            Path::new(part).components().collect::<Vec<_>>().as_slice(),
            [Component::Normal(_)]
        )
}

/// What one run of the mirror did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MirrorReport {
    /// The files copied.
    pub copied_files: u64,
    /// Their bytes.
    pub copied_bytes: u64,
    /// The copies deleted because their source is gone.
    pub removed_entries: u64,
    /// The folders whose copy was kept as the last run left it, since they could not be copied
    /// whole this run.
    pub skipped_folders: Vec<PathBuf>,
}

/// Why the mirror did not finish.
#[derive(Debug, thiserror::Error)]
pub enum MirrorError {
    /// The run's stop came first.
    #[error("the mirror's copy was stopped")]
    Stopped,
    /// The file system refused a read, a copy or a removal.
    #[error("the mirror could not copy {}", path.display())]
    Io {
        /// The file or folder it was at.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
}

/// An index git reads in a git folder being copied, and the file holding what the copy read of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CopiedIndex {
    /// The index file in the live folder.
    pub live: PathBuf,
    /// The file holding the copy's read of it: the one staged beside the copy's index, or the
    /// copy's own where the index did not change.
    pub copied: PathBuf,
}

/// What a check of a git folder's copied indexes against its copy found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopiedIndexCheck {
    /// Every object they name is in the copy, or is one the live folder itself does without.
    Whole,
    /// One left the copy's reach while it was copied, so the folder's copy runs again.
    Moved,
    /// git could not read one of them, so the folder keeps its last copy this run.
    Unread,
}

/// What the mirror asks of whoever writes a git folder while it is copied. Each method blocks,
/// and answers [`MirrorError::Stopped`] once `stop` fires while it waits.
pub trait LiveGitFolders: Send + Sync {
    /// The hold that keeps the objects of `git_folder` from moving until it drops; `None` for a
    /// folder the caller holds nothing over.
    fn hold(
        &self,
        git_folder: &Path,
        stop: &CancellationToken,
    ) -> Result<Option<Box<dyn Send + '_>>, MirrorError>;

    /// Whether every object `indexes`, the copied indexes of `git_folder`, name is in
    /// `copy_objects`, the copy's objects folder, or is one the live folder does without, asked of
    /// a folder no hold covers once its refs read as they did before its objects were copied.
    fn check_copied_indexes(
        &self,
        git_folder: &Path,
        copy_objects: &Path,
        indexes: &[CopiedIndex],
        stop: &CancellationToken,
    ) -> Result<CopiedIndexCheck, MirrorError>;
}

// The git folders of a copy no one writes while it is read, a restore's from the mirror, whose
// indexes the backup checked when it wrote them.
struct UnwrittenGitFolders;

impl LiveGitFolders for UnwrittenGitFolders {
    fn hold(
        &self,
        _git_folder: &Path,
        _stop: &CancellationToken,
    ) -> Result<Option<Box<dyn Send + '_>>, MirrorError> {
        Ok(None)
    }

    fn check_copied_indexes(
        &self,
        _git_folder: &Path,
        _copy_objects: &Path,
        _indexes: &[CopiedIndex],
        _stop: &CancellationToken,
    ) -> Result<CopiedIndexCheck, MirrorError> {
        Ok(CopiedIndexCheck::Whole)
    }
}

/// Brings the mirror at `mirror_folder` level with `roots`, each a place under `home`: the folder
/// made owner-only where it is missing and the precision of its times probed, then each changed
/// file copied, each copy whose source is gone deleted, and every folder of a root no longer
/// listed deleted. Each git folder under a root is copied whole by one routine: its refs and the
/// other files that name objects read first and staged beside their copies, then its objects
/// copied under the hold `git_folders` gives it, then the staged files placed, and only then the
/// copies its source no longer lists removed, so a run cut short anywhere leaves refs over a
/// superset of their objects. A git folder no hold covers has its refs read again after its
/// objects' copy and its copied indexes checked against the copy through `git_folders`, and is
/// copied again, three times at most, while a ref moved or an object an index names left the
/// copy's reach; one still changing then, or whose index git cannot read, keeps its last copy and
/// is named in the report's skipped folders. Each root's copy is taken from its
/// [`MirrorCopySource`]; a root kept as it is is still listed, so its copy is neither leveled nor
/// deleted, and a root copied from another folder that is gone when its copy starts, before a copy
/// is removed or after a read fails keeps its copy as it stands and is named skipped. Checks `stop`
/// before each entry. Blocking, so it runs through `spawn_blocking`. Fails
/// with [`MirrorError::Stopped`] once `stop` fires, and with the first refused read, copy or
/// removal.
pub fn mirror_roots(
    mirror_folder: &Path,
    home: &Path,
    roots: &[MirrorRoot],
    git_folders: &dyn LiveGitFolders,
    stop: &CancellationToken,
) -> Result<MirrorReport, MirrorError> {
    let at = |path: &Path| {
        let path = path.to_path_buf();
        move |source| MirrorError::Io { path, source }
    };
    create_missing_private_folders(mirror_folder).map_err(at(mirror_folder))?;
    let precision = probe_time_precision(mirror_folder).map_err(at(mirror_folder))?;
    let mut report = MirrorReport::default();
    for root in roots {
        let place;
        let (source, is_other_folder) = match &root.copy_source {
            MirrorCopySource::Place => {
                place = root.place(home);
                (&place, false)
            }
            MirrorCopySource::Folder(folder) => (folder, true),
            MirrorCopySource::KeptAsIs => continue,
        };
        level_with_git_folders(
            source,
            &mirror_folder.join(&root.name),
            precision,
            git_folders,
            is_other_folder,
            stop,
            &mut report,
        )?;
    }
    for entry in fs::read_dir(mirror_folder).map_err(at(mirror_folder))? {
        let entry = entry.map_err(at(mirror_folder))?;
        let name = entry.file_name();
        if name == MIRROR_ROOTS_FILE_NAME || roots.iter().any(|root| *root.name == *name) {
            continue;
        }
        remove_tree(&entry.path()).map_err(at(&entry.path()))?;
        report.removed_entries += 1;
    }
    Ok(report)
}

/// Brings the file or folder at `copy` level with `source`, a restore's run for one place: each
/// file whose copy differs in size, or in modification time by `precision`, the one
/// [`probe_time_precision`] measured where the copy is, or more, copied, and each copy whose source
/// is gone deleted, each git folder by the routine [`mirror_roots`] copies one with, its objects
/// before the files that name them; a source that is gone leaves no copy. Checks `stop` before
/// each entry. Blocking. Fails as [`mirror_roots`] does.
pub fn bring_level(
    source: &Path,
    copy: &Path,
    precision: Duration,
    stop: &CancellationToken,
) -> Result<MirrorReport, MirrorError> {
    let mut report = MirrorReport::default();
    level_with_git_folders(
        source,
        copy,
        precision,
        &UnwrittenGitFolders,
        false,
        stop,
        &mut report,
    )?;
    Ok(report)
}

// Brings `copy` level with `source`, each git folder under it held through `git_folders`, adding
// what it did to `report`. A source that `is_other_folder`, a root's copy taken from a folder
// other than its place, that is gone when the leveling starts, before a copy is removed, or after
// a read fails, as when its drive was unplugged, keeps the copy with what was copied so far,
// removes nothing more and is named in the report's skipped folders.
fn level_with_git_folders(
    source: &Path,
    copy: &Path,
    precision: Duration,
    git_folders: &dyn LiveGitFolders,
    is_other_folder: bool,
    stop: &CancellationToken,
    report: &mut MirrorReport,
) -> Result<(), MirrorError> {
    let mut leveling = Leveling {
        precision,
        git_folders,
        away_folder: is_other_folder.then_some(source),
        stop,
        report: &mut *report,
    };
    match leveling.level(source, copy) {
        Ok(()) => Ok(()),
        Err(LevelStop::Failed(failure)) => Err(failure),
        Err(LevelStop::Away) => {
            report.skipped_folders.push(source.to_path_buf());
            Ok(())
        }
    }
}

// Why a leveling ended before its end.
enum LevelStop {
    // The run's stop, or a step the file system refused.
    Failed(MirrorError),
    // The folder a root's copy is taken from is gone, so the copy is kept as it stands.
    Away,
}

impl From<MirrorError> for LevelStop {
    fn from(failure: MirrorError) -> Self {
        Self::Failed(failure)
    }
}

// One leveling's settings and the report it adds to.
struct Leveling<'run> {
    precision: Duration,
    git_folders: &'run dyn LiveGitFolders,
    // The folder a root's copy is taken from when it is not the root's place, whose absence keeps
    // the copy as it stands.
    away_folder: Option<&'run Path>,
    stop: &'run CancellationToken,
    report: &'run mut MirrorReport,
}

impl Leveling<'_> {
    // Brings `copy` level with `source`.
    fn level(&mut self, source: &Path, copy: &Path) -> Result<(), LevelStop> {
        self.check_away()?;
        self.copy_changed(source, copy)?;
        self.remove_gone(source, copy)
    }

    // Fails with `Stopped` once the stop fires.
    fn check_stop(&self) -> Result<(), MirrorError> {
        if self.stop.is_cancelled() {
            return Err(MirrorError::Stopped);
        }
        Ok(())
    }

    // Fails with `Away` when the folder the copy is taken from, other than the root's place, is
    // gone.
    fn check_away(&self) -> Result<(), LevelStop> {
        let Some(folder) = self.away_folder else {
            return Ok(());
        };
        match fs::symlink_metadata(folder) {
            Ok(_) => Ok(()),
            Err(error) if is_missing_entry(&error) => Err(LevelStop::Away),
            Err(error) => Err(LevelStop::Failed(MirrorError::Io {
                path: folder.to_path_buf(),
                source: error,
            })),
        }
    }

    // The failure `error` at `path`, or `Away` when the folder the copy is taken from is gone.
    fn failed(&self, path: &Path, error: io::Error) -> LevelStop {
        match self.check_away() {
            Ok(()) => LevelStop::Failed(MirrorError::Io {
                path: path.to_path_buf(),
                source: error,
            }),
            Err(stop) => stop,
        }
    }

    // The failure a walk from `start` met.
    fn walk_failed(&self, start: &Path, failure: walkdir::Error) -> LevelStop {
        let path = failure.path().unwrap_or(start).to_path_buf();
        self.failed(&path, failure.into())
    }

    // Removes the copy at `path`, a folder with all it holds, and counts it; nothing is removed
    // once the folder the copy is taken from is gone.
    fn remove(&mut self, path: &Path, is_folder: bool) -> Result<(), LevelStop> {
        self.check_away()?;
        let removed = if is_folder {
            remove_tree(path)
        } else {
            fs::remove_file(path)
        };
        removed.map_err(|error| self.failed(path, error))?;
        self.report.removed_entries += 1;
        Ok(())
    }

    // Copies each file under `source` whose copy under `copy_root` differs in size or in
    // modification time by the precision or more, each git folder by its own routine; a source
    // that is gone copies nothing.
    fn copy_changed(&mut self, source: &Path, copy_root: &Path) -> Result<(), LevelStop> {
        if fs::symlink_metadata(source)
            .none_if_missing()
            .map_err(|error| self.failed(source, error))?
            .is_none()
        {
            return Ok(());
        }
        let mut walk = WalkDir::new(source).into_iter();
        while let Some(entry) = walk.next() {
            self.check_stop()?;
            let entry = entry.map_err(|failure| self.walk_failed(source, failure))?;
            let relative = entry
                .path()
                .strip_prefix(source)
                .expect("the walk stays under its root");
            let copy = path_under(copy_root, relative);
            let file_type = entry.file_type();
            if is_in_progress_name(entry.file_name()) {
                if file_type.is_dir() {
                    walk.skip_current_dir();
                }
                continue;
            }
            if file_type.is_dir() && is_git_folder(entry.path()) {
                walk.skip_current_dir();
                self.copy_git_folder(entry.path(), &copy)?;
                continue;
            }
            let copy_metadata = fs::symlink_metadata(&copy)
                .none_if_missing()
                .map_err(|error| self.failed(&copy, error))?;
            if file_type.is_dir() {
                if copy_metadata
                    .as_ref()
                    .is_some_and(|metadata| !metadata.is_dir())
                {
                    fs::remove_file(&copy).map_err(|error| self.failed(&copy, error))?;
                }
                fs::create_dir_all(&copy).map_err(|error| self.failed(&copy, error))?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|failure| self.failed(entry.path(), failure.into()))?;
            let is_copied = copy_when_changed(
                entry.path(),
                &metadata,
                &copy,
                copy_metadata.as_ref(),
                self.precision,
            )
            .map_err(|error| self.failed(&copy, error))?;
            if is_copied {
                self.report.copied_files += 1;
                self.report.copied_bytes += metadata.len();
            }
        }
        Ok(())
    }

    // Deletes each copy under `copy_root` whose source under `source` is gone or is no longer of
    // its kind, and each copy on its way that a cut-short run left; a copy whose source is a git
    // folder was leveled whole by its routine.
    fn remove_gone(&mut self, source: &Path, copy_root: &Path) -> Result<(), LevelStop> {
        if fs::symlink_metadata(copy_root)
            .none_if_missing()
            .map_err(|error| self.failed(copy_root, error))?
            .is_none()
        {
            return Ok(());
        }
        let mut walk = WalkDir::new(copy_root).into_iter();
        while let Some(entry) = walk.next() {
            self.check_stop()?;
            let entry = entry.map_err(|failure| self.walk_failed(copy_root, failure))?;
            let relative = entry
                .path()
                .strip_prefix(copy_root)
                .expect("the walk stays under its root");
            if is_in_progress_name(entry.file_name()) {
                if entry.file_type().is_dir() {
                    walk.skip_current_dir();
                }
                self.remove(entry.path(), entry.file_type().is_dir())?;
                continue;
            }
            let original = path_under(source, relative);
            // A source whose folder became a file names nothing, as a missing one does.
            let original_metadata = match fs::symlink_metadata(&original) {
                Ok(metadata) => Some(metadata),
                Err(failure) if is_missing_entry(&failure) => None,
                Err(failure) => return Err(self.failed(&original, failure)),
            };
            let is_kept = original_metadata.is_some_and(|metadata| {
                metadata.is_dir() == entry.file_type().is_dir() && !metadata.is_symlink()
            });
            if is_kept {
                if entry.file_type().is_dir() && is_git_folder(&original) {
                    walk.skip_current_dir();
                }
                continue;
            }
            if entry.file_type().is_dir() {
                walk.skip_current_dir();
            }
            self.remove(entry.path(), entry.file_type().is_dir())?;
        }
        Ok(())
    }
}

// `relative` under `root`, `root` itself when `relative` is empty, as for a root that is a file.
fn path_under(root: &Path, relative: &Path) -> PathBuf {
    if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    }
}

// Whether two modification times are one at `precision`.
fn is_same_modified_time(left: SystemTime, right: SystemTime, precision: Duration) -> bool {
    let apart = left
        .duration_since(right)
        .or_else(|_earlier| right.duration_since(left))
        .unwrap_or(Duration::MAX);
    apart < precision
}

// Whether a copy whose metadata is `copy` holds the file whose metadata is `source`: a file of its
// size whose modification time is one with it at `precision`.
fn is_unchanged_copy(copy: &fs::Metadata, source: &fs::Metadata, precision: Duration) -> bool {
    copy.is_file()
        && copy.len() == source.len()
        && match (copy.modified(), source.modified()) {
            (Ok(copied), Ok(modified)) => is_same_modified_time(copied, modified, precision),
            _ => false,
        }
}

// Copies the file `source`, whose metadata is `metadata`, over `copy`, whose metadata is
// `copy_metadata`, unless the copy holds it at `precision`; a folder at the copy is removed first.
// Answers whether it copied.
fn copy_when_changed(
    source: &Path,
    metadata: &fs::Metadata,
    copy: &Path,
    copy_metadata: Option<&fs::Metadata>,
    precision: Duration,
) -> io::Result<bool> {
    if let Some(copy_metadata) = copy_metadata {
        if is_unchanged_copy(copy_metadata, metadata, precision) {
            return Ok(false);
        }
        if copy_metadata.is_dir() {
            remove_tree(copy)?;
        }
    }
    copy_file(source, copy, metadata.modified()?, |from, to| {
        fs::copy(from, to)
    })?;
    Ok(true)
}

// Where a copy on its way to `copy` is written: `.<name>.mirror-copy` beside it.
fn in_progress_path(copy: &Path) -> PathBuf {
    let mut name = OsString::from(COPY_IN_PROGRESS_PREFIX);
    name.push(copy.file_name().expect("a copy is named"));
    name.push(COPY_IN_PROGRESS_SUFFIX);
    copy.with_file_name(name)
}

// Whether `name` is a copy's name on its way to its place, which a leveling never copies and
// always removes from the side it writes.
fn is_in_progress_name(name: &OsStr) -> bool {
    let name = name.as_encoded_bytes();
    name.len() > COPY_IN_PROGRESS_PREFIX.len() + COPY_IN_PROGRESS_SUFFIX.len()
        && name.starts_with(COPY_IN_PROGRESS_PREFIX.as_bytes())
        && name.ends_with(COPY_IN_PROGRESS_SUFFIX.as_bytes())
}

// Copies `source` beside `copy` through `copy_bytes`, with `modified` as its modification time,
// flushes it and renames it over the copy. A failed step removes the file beside the copy, a failed
// removal kept beside the step's failure, so a full disk is not kept full until the next run.
fn copy_file(
    source: &Path,
    copy: &Path,
    modified: SystemTime,
    copy_bytes: impl FnOnce(&Path, &Path) -> io::Result<u64>,
) -> io::Result<()> {
    let in_progress = in_progress_path(copy);
    write_in_progress(source, &in_progress, modified, copy_bytes)?;
    rename_replacing(&in_progress, copy).map_err(|failure| {
        remove_file_after_failure(failure, &in_progress, "the mirror's copy").into_io_error()
    })
}

// Copies `source` to `in_progress` through `copy_bytes`, with `modified` as its modification time,
// and flushes it; a failed step removes it, as `copy_file` does.
fn write_in_progress(
    source: &Path,
    in_progress: &Path,
    modified: SystemTime,
    copy_bytes: impl FnOnce(&Path, &Path) -> io::Result<u64>,
) -> io::Result<()> {
    fs::remove_file(in_progress).none_if_missing()?;
    let written = copy_bytes(source, in_progress)
        .and_then(|_bytes| {
            File::options()
                .write(true)
                .open(in_progress)?
                .set_modified(modified)
        })
        .and_then(|()| flush_file(in_progress));
    written.map_err(|failure| {
        remove_file_after_failure(failure, in_progress, "the mirror's copy").into_io_error()
    })
}

#[cfg(test)]
mod tests;
