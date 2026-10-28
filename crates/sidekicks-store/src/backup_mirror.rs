//! The mirror: one copy, in the backups folder, of the files a backup holds beside the database,
//! each named root under a folder of its name, owner-only. Each root is a place under the home
//! folder, kept relative to it, so a restore on a computer whose home differs puts it back under
//! its own. A run copies only a file whose size differs from its copy's or whose modification time
//! is apart from it by the precision the copies' folder keeps or more, which each run measures
//! there, since file systems keep a time to a nanosecond (APFS, ext4), 100 ns (NTFS), 10 ms
//! (exFAT) or two seconds (FAT); it keeps the source's modification time on the copy so the next
//! run passes it over, and deletes each copy whose source is gone, so a session `Delete old data`
//! removed leaves the mirror at the next run. A file is copied under a temporary name, flushed and
//! renamed over its copy, so a copy whose size and time reached the disk holds its bytes too. Links
//! are not followed and not copied.

use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sidekicks_platforms::{
    create_missing_private_folders, flush_file, remove_tree, rename_replacing,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::missing_entry::{MissingEntry as _, is_missing_entry};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

/// The mirror's folder inside the backups folder; it holds no manifest, so no reader takes it
/// for a backup.
pub const MIRROR_FOLDER_NAME: &str = "mirror";

/// The file inside the mirror naming where each root's files came from, which a restore reads.
pub const MIRROR_ROOTS_FILE_NAME: &str = "roots.json";

// The suffix of a copy on its way to its place.
const COPY_IN_PROGRESS_SUFFIX: &str = ".mirror-copy";

// The file a precision probe sets times on, removed once it has read them back.
const TIME_PROBE_FILE_NAME: &str = ".sidekicks-time-probe";

// An even second well inside every file system's range, FAT's from 1980 among them, that a probe
// adds each fraction to.
const TIME_PROBE_BASE: Duration = Duration::from_secs(1_700_000_000);

// The precision of a folder that keeps no time a probe set to the second: FAT's two seconds.
const COARSEST_TIME_PRECISION: Duration = Duration::from_secs(2);

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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MirrorReport {
    /// The files copied.
    pub copied_files: u64,
    /// Their bytes.
    pub copied_bytes: u64,
    /// The copies deleted because their source is gone.
    pub removed_entries: u64,
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

/// Brings the mirror at `mirror_folder` level with `roots`, each a place under `home`: the folder
/// made owner-only where it is missing and the precision of its times probed, then each changed
/// file copied, each copy whose source is gone deleted, and every folder of a root no longer
/// listed deleted. Checks `stop` before each entry. Blocking, so it runs through `spawn_blocking`.
/// Fails with [`MirrorError::Stopped`] once `stop` fires, and with the first refused read, copy or
/// removal.
pub fn mirror_roots(
    mirror_folder: &Path,
    home: &Path,
    roots: &[MirrorRoot],
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
        let leveled = bring_level(
            &root.place(home),
            &mirror_folder.join(&root.name),
            precision,
            stop,
        )?;
        report.copied_files += leveled.copied_files;
        report.copied_bytes += leveled.copied_bytes;
        report.removed_entries += leveled.removed_entries;
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

/// Brings the file or folder at `copy` level with `source`, the mirror's run for one root and a
/// restore's for one place: each file whose copy differs in size, or in modification time by
/// `precision`, the one [`probe_time_precision`] measured where the copy is, or more, copied, and
/// each copy whose source is gone deleted; a source that is gone leaves no copy. Checks `stop`
/// before each entry. Blocking. Fails as [`mirror_roots`] does.
pub fn bring_level(
    source: &Path,
    copy: &Path,
    precision: Duration,
    stop: &CancellationToken,
) -> Result<MirrorReport, MirrorError> {
    let mut report = MirrorReport::default();
    copy_changed(source, copy, precision, stop, &mut report)?;
    remove_gone(source, copy, stop, &mut report)?;
    Ok(report)
}

// Copies each file under `source` whose copy under `copy_root` differs in size or in modification
// time by `precision` or more; a source that is gone copies nothing.
fn copy_changed(
    source: &Path,
    copy_root: &Path,
    precision: Duration,
    stop: &CancellationToken,
    report: &mut MirrorReport,
) -> Result<(), MirrorError> {
    let at = |path: &Path| {
        let path = path.to_path_buf();
        move |source| MirrorError::Io { path, source }
    };
    if fs::symlink_metadata(source)
        .none_if_missing()
        .map_err(at(source))?
        .is_none()
    {
        return Ok(());
    }
    for entry in WalkDir::new(source) {
        if stop.is_cancelled() {
            return Err(MirrorError::Stopped);
        }
        let entry = entry.map_err(|failure| MirrorError::Io {
            path: failure.path().unwrap_or(source).to_path_buf(),
            source: failure.into(),
        })?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .expect("the walk stays under its root");
        let copy = path_under(copy_root, relative);
        let file_type = entry.file_type();
        let copy_metadata = fs::symlink_metadata(&copy)
            .none_if_missing()
            .map_err(at(&copy))?;
        if file_type.is_dir() {
            if copy_metadata
                .as_ref()
                .is_some_and(|metadata| !metadata.is_dir())
            {
                fs::remove_file(&copy).map_err(at(&copy))?;
            }
            fs::create_dir_all(&copy).map_err(at(&copy))?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|failure| MirrorError::Io {
            path: entry.path().to_path_buf(),
            source: failure.into(),
        })?;
        let modified = metadata.modified().map_err(at(entry.path()))?;
        if let Some(copy_metadata) = &copy_metadata {
            if copy_metadata.is_file()
                && copy_metadata.len() == metadata.len()
                && copy_metadata
                    .modified()
                    .is_ok_and(|copied| is_same_modified_time(copied, modified, precision))
            {
                continue;
            }
            if copy_metadata.is_dir() {
                remove_tree(&copy).map_err(at(&copy))?;
            }
        }
        copy_file(entry.path(), &copy, modified, |from, to| fs::copy(from, to))
            .map_err(at(&copy))?;
        report.copied_files += 1;
        report.copied_bytes += metadata.len();
    }
    Ok(())
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

/// The precision of the modification times `folder` keeps: a file there is given a time 1 ns past
/// an even second, then 10 ns, 100 ns and so on up to 1 s, and the first that reads back whole is
/// it; two seconds when none does. The file is removed after. Blocking. Fails when the file cannot
/// be made, timed, read or removed.
pub fn probe_time_precision(folder: &Path) -> io::Result<Duration> {
    let probe = folder.join(TIME_PROBE_FILE_NAME);
    let file = File::create(&probe)?;
    let base = UNIX_EPOCH + TIME_PROBE_BASE;
    let mut fraction = Duration::from_nanos(1);
    let precision = loop {
        let set = base + fraction;
        file.set_modified(set)?;
        if fs::metadata(&probe)?.modified()? == set {
            break fraction;
        }
        if fraction >= Duration::from_secs(1) {
            break COARSEST_TIME_PRECISION;
        }
        fraction *= 10;
    };
    drop(file);
    fs::remove_file(&probe)?;
    Ok(precision)
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
    let mut in_progress = copy.as_os_str().to_owned();
    in_progress.push(COPY_IN_PROGRESS_SUFFIX);
    let in_progress = PathBuf::from(in_progress);
    fs::remove_file(&in_progress).none_if_missing()?;
    let placed = copy_bytes(source, &in_progress)
        .and_then(|_bytes| {
            File::options()
                .write(true)
                .open(&in_progress)?
                .set_modified(modified)
        })
        .and_then(|()| flush_file(&in_progress))
        .and_then(|()| rename_replacing(&in_progress, copy));
    let Err(failure) = placed else {
        return Ok(());
    };
    match fs::remove_file(&in_progress).none_if_missing() {
        Ok(_removed) => Err(failure),
        Err(removal) => Err(io::Error::new(
            failure.kind(),
            CleanupFailures::new(failure, vec![removal], "the mirror's copy"),
        )),
    }
}

// Deletes each copy under `copy_root` whose source under `source` is gone or is no longer of its
// kind, a copy on its way that a cut-short run left among them.
fn remove_gone(
    source: &Path,
    copy_root: &Path,
    stop: &CancellationToken,
    report: &mut MirrorReport,
) -> Result<(), MirrorError> {
    let at = |path: &Path| {
        let path = path.to_path_buf();
        move |source| MirrorError::Io { path, source }
    };
    if fs::symlink_metadata(copy_root)
        .none_if_missing()
        .map_err(at(copy_root))?
        .is_none()
    {
        return Ok(());
    }
    let mut walk = WalkDir::new(copy_root).into_iter();
    while let Some(entry) = walk.next() {
        if stop.is_cancelled() {
            return Err(MirrorError::Stopped);
        }
        let entry = entry.map_err(|failure| MirrorError::Io {
            path: failure.path().unwrap_or(copy_root).to_path_buf(),
            source: failure.into(),
        })?;
        let relative = entry
            .path()
            .strip_prefix(copy_root)
            .expect("the walk stays under its root");
        let original = path_under(source, relative);
        // A source whose folder became a file names nothing, as a missing one does.
        let original_metadata = match fs::symlink_metadata(&original) {
            Ok(metadata) => Some(metadata),
            Err(failure) if is_missing_entry(&failure) => None,
            Err(failure) => return Err(at(&original)(failure)),
        };
        let is_kept = original_metadata.is_some_and(|metadata| {
            metadata.is_dir() == entry.file_type().is_dir() && !metadata.is_symlink()
        });
        if is_kept {
            continue;
        }
        if entry.file_type().is_dir() {
            walk.skip_current_dir();
            remove_tree(entry.path()).map_err(at(entry.path()))?;
        } else {
            fs::remove_file(entry.path()).map_err(at(entry.path()))?;
        }
        report.removed_entries += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io;
    use std::path::Path;
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::{COPY_IN_PROGRESS_SUFFIX, MirrorReport, MirrorRoot, copy_file, mirror_roots};

    fn modified(path: &Path) -> std::time::SystemTime {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .expect("the test reads a modification time")
    }

    // A changed file is copied with its modification time, a same-size rewrite a second later
    // among them, since this folder keeps finer times than a second; a file whose source is gone,
    // and a root no longer listed, are deleted; a third run copies nothing. Each root is found
    // under the home it is given. Killed by the size-and-time compare dropped, by a blanket
    // tolerance of two seconds, by the modification time not kept, and by the removal of gone
    // copies dropped.
    #[test]
    fn a_run_copies_what_changed_and_deletes_what_is_gone() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let home = scratch.path();
        let workspace = scratch.path().join("workspace");
        fs::create_dir_all(workspace.join("notes")).expect("the source folder is made");
        fs::write(workspace.join("notes/kept.md"), b"kept").expect("written");
        fs::write(workspace.join("notes/changed.md"), b"first").expect("written");
        fs::write(workspace.join("gone.md"), b"gone").expect("written");
        let settings = scratch.path().join("machine-settings.json");
        fs::write(&settings, b"{}").expect("written");
        let mirror = scratch.path().join("backups/mirror");
        let roots = [
            MirrorRoot::new("workspace".to_owned(), Path::new("workspace")).expect("a root"),
            MirrorRoot::new("settings".to_owned(), Path::new("machine-settings.json"))
                .expect("a root"),
        ];
        let stop = CancellationToken::new();
        let first = mirror_roots(&mirror, home, &roots, &stop).expect("the first run copies");
        assert_eq!(first.copied_files, 4);
        assert_eq!(fs::read(mirror.join("settings")).expect("read"), b"{}");

        // The rewritten file keeps its size and is written a second after its copy's time.
        let rewritten = workspace.join("notes/kept.md");
        let rewritten_time = modified(&rewritten) + Duration::from_secs(1);
        fs::write(&rewritten, b"KEPT").expect("written");
        File::options()
            .write(true)
            .open(&rewritten)
            .and_then(|file| file.set_modified(rewritten_time))
            .expect("the source's time is set");
        fs::write(workspace.join("notes/changed.md"), b"second, longer").expect("written");
        fs::remove_file(workspace.join("gone.md")).expect("removed");
        let listed = [roots[0].clone()];

        let second = mirror_roots(&mirror, home, &listed, &stop).expect("the second run copies");

        assert_eq!(
            second,
            MirrorReport {
                copied_files: 2,
                copied_bytes: 18,
                removed_entries: 2,
            }
        );
        assert_eq!(
            fs::read(mirror.join("workspace/notes/kept.md")).expect("read"),
            b"KEPT"
        );
        let changed_copy = mirror.join("workspace/notes/changed.md");
        assert_eq!(fs::read(&changed_copy).expect("read"), b"second, longer");
        assert_eq!(
            modified(&changed_copy),
            modified(&workspace.join("notes/changed.md"))
        );
        assert!(!mirror.join("workspace/gone.md").exists());
        assert!(!mirror.join("settings").exists());
        assert_eq!(
            mirror_roots(&mirror, home, &listed, &stop).expect("the third run reads"),
            MirrorReport::default()
        );
    }

    // A list read from the backups folder that names a place outside the home folder, or a copy
    // outside the mirror, is refused, so a restore never writes there; a plain one reads and is
    // put under the home it is given. Killed by the read's check dropped.
    #[rstest]
    #[case::parent(json!({ "name": "notes", "source": "../outside" }))]
    #[case::absolute(json!({ "name": "notes", "source": "/etc/hosts" }))]
    #[case::inner_parent(json!({ "name": "notes", "source": "notes/../../outside" }))]
    #[case::empty_source(json!({ "name": "notes", "source": "" }))]
    #[case::name_path(json!({ "name": "../notes", "source": "notes" }))]
    #[case::name_parent(json!({ "name": "..", "source": "notes" }))]
    fn a_listed_root_outside_the_home_is_refused(#[case] listed: serde_json::Value) {
        assert!(serde_json::from_value::<MirrorRoot>(listed).is_err());
        let root: MirrorRoot =
            serde_json::from_value(json!({ "name": "notes", "source": ".agent/notes.md" }))
                .expect("a plain root reads");
        assert_eq!(
            root.place(Path::new("/home/other")),
            Path::new("/home/other/.agent/notes.md")
        );
    }

    // A copy the disk refuses partway leaves neither the file beside the copy nor the copy, so a
    // full disk is not kept full until the next run. Killed by a failed copy that keeps its file.
    #[test]
    fn a_copy_that_fails_partway_leaves_no_file_beside_the_copy() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let source = scratch.path().join("source.md");
        fs::write(&source, b"the source's bytes").expect("written");
        let copy = scratch.path().join("copy.md");
        let copy_half_then_fail = |from: &Path, to: &Path| -> io::Result<u64> {
            let bytes = fs::read(from)?;
            fs::write(to, &bytes[..bytes.len() / 2])?;
            Err(io::Error::from(io::ErrorKind::StorageFull))
        };

        let failure = copy_file(&source, &copy, modified(&source), copy_half_then_fail)
            .expect_err("the copy fails");

        assert_eq!(failure.kind(), io::ErrorKind::StorageFull);
        let mut in_progress = copy.as_os_str().to_owned();
        in_progress.push(COPY_IN_PROGRESS_SUFFIX);
        assert!(!Path::new(&in_progress).exists());
        assert!(!copy.exists());
    }
}
