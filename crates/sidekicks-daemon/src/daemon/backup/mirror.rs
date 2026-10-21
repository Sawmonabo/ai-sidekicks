//! The mirror: one copy, in the backups folder, of the files a backup holds beside the database,
//! each named root under a folder of its name. A run copies only a file whose size or modification
//! time differs from its copy's, keeping the source's modification time on the copy so the next
//! run passes it over, and deletes each copy whose source is gone, so a session `Delete old data`
//! removed leaves the mirror at the next run. A file is copied under a temporary name and renamed
//! over its copy; the copies are not flushed one by one, since a copy a crash loses differs from
//! its source and the next run copies it again. Links are not followed and not copied.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_platforms::{remove_tree, rename_replacing};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::missing_entry::{MissingEntry as _, is_missing_entry};

/// The mirror's folder inside the backups folder; it holds no manifest, so no reader takes it
/// for a backup.
pub(crate) const MIRROR_FOLDER_NAME: &str = "mirror";

/// The file inside the mirror naming where each root's files came from, which a restore reads.
pub(crate) const MIRROR_ROOTS_FILE_NAME: &str = "roots.json";

// The suffix of a copy on its way to its place.
const COPY_IN_PROGRESS_SUFFIX: &str = ".mirror-copy";

/// One file or folder the mirror keeps a copy of: the name of its folder in the mirror, one plain
/// path component, and where it lives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MirrorRoot {
    /// The copy's name in the mirror.
    pub(crate) name: String,
    /// The file or folder copied.
    pub(crate) source: PathBuf,
}

/// What one run of the mirror did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MirrorReport {
    /// The files copied.
    pub(crate) copied_files: u64,
    /// Their bytes.
    pub(crate) copied_bytes: u64,
    /// The copies deleted because their source is gone.
    pub(crate) removed_entries: u64,
}

/// Why the mirror did not finish.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MirrorError {
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

/// Brings the mirror at `mirror_folder` level with `roots`: each changed file copied, each copy
/// whose source is gone deleted, and every folder of a root no longer listed deleted. Checks
/// `stop` before each entry. Blocking, so it runs through `spawn_blocking`. Fails with
/// [`MirrorError::Stopped`] once `stop` fires, and with the first refused read, copy or removal.
pub(crate) fn mirror_roots(
    mirror_folder: &Path,
    roots: &[MirrorRoot],
    stop: &CancellationToken,
) -> Result<MirrorReport, MirrorError> {
    let at = |path: &Path| {
        let path = path.to_path_buf();
        move |source| MirrorError::Io { path, source }
    };
    fs::create_dir_all(mirror_folder).map_err(at(mirror_folder))?;
    let mut report = MirrorReport::default();
    for root in roots {
        let leveled = bring_level(&root.source, &mirror_folder.join(&root.name), stop)?;
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
/// restore's for one place: each file whose copy differs in size or modification time copied, and
/// each copy whose source is gone deleted; a source that is gone leaves no copy. Checks `stop`
/// before each entry. Blocking. Fails as [`mirror_roots`] does.
pub(crate) fn bring_level(
    source: &Path,
    copy: &Path,
    stop: &CancellationToken,
) -> Result<MirrorReport, MirrorError> {
    let mut report = MirrorReport::default();
    copy_changed(source, copy, stop, &mut report)?;
    remove_gone(source, copy, stop, &mut report)?;
    Ok(report)
}

// Copies each file under `source` whose copy under `copy_root` differs in size or modification
// time; a source that is gone copies nothing.
fn copy_changed(
    source: &Path,
    copy_root: &Path,
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
                && copy_metadata.modified().ok() == Some(modified)
            {
                continue;
            }
            if copy_metadata.is_dir() {
                remove_tree(&copy).map_err(at(&copy))?;
            }
        }
        copy_file(entry.path(), &copy, modified).map_err(at(&copy))?;
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

// Copies `source` beside `copy` and renames it over it, with `modified` as its modification time.
fn copy_file(source: &Path, copy: &Path, modified: std::time::SystemTime) -> io::Result<()> {
    let mut in_progress = copy.as_os_str().to_owned();
    in_progress.push(COPY_IN_PROGRESS_SUFFIX);
    let in_progress = PathBuf::from(in_progress);
    fs::remove_file(&in_progress).none_if_missing()?;
    fs::copy(source, &in_progress)?;
    File::options()
        .write(true)
        .open(&in_progress)?
        .set_modified(modified)?;
    rename_replacing(&in_progress, copy)
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
    use std::path::Path;

    use tokio_util::sync::CancellationToken;

    use super::{MirrorReport, MirrorRoot, mirror_roots};

    fn modified(path: &Path) -> std::time::SystemTime {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .expect("the test reads a modification time")
    }

    // A changed file is copied with its modification time; an unchanged one is passed over, which
    // a copy whose bytes alone differ shows; a file whose source is gone, and a root no longer
    // listed, are deleted; a second run copies nothing. Killed by the size-and-time compare
    // dropped, by the modification time not kept, and by the removal of gone copies dropped.
    #[test]
    fn a_run_copies_what_changed_and_deletes_what_is_gone() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let workspace = scratch.path().join("workspace");
        fs::create_dir_all(workspace.join("notes")).expect("the source folder is made");
        fs::write(workspace.join("notes/kept.md"), b"kept").expect("written");
        fs::write(workspace.join("notes/changed.md"), b"first").expect("written");
        fs::write(workspace.join("gone.md"), b"gone").expect("written");
        let settings = scratch.path().join("machine-settings.json");
        fs::write(&settings, b"{}").expect("written");
        let mirror = scratch.path().join("backups/mirror");
        let roots = [
            MirrorRoot {
                name: "workspace".to_owned(),
                source: workspace.clone(),
            },
            MirrorRoot {
                name: "settings".to_owned(),
                source: settings,
            },
        ];
        let stop = CancellationToken::new();
        let first = mirror_roots(&mirror, &roots, &stop).expect("the first run copies");
        assert_eq!(first.copied_files, 4);
        assert_eq!(fs::read(mirror.join("settings")).expect("read"), b"{}");

        // The kept file's copy differs only in its bytes, so a run that copies it shows.
        let kept_copy = mirror.join("workspace/notes/kept.md");
        let kept_time = modified(&kept_copy);
        fs::write(&kept_copy, b"KEPT").expect("written");
        File::options()
            .write(true)
            .open(&kept_copy)
            .and_then(|file| file.set_modified(kept_time))
            .expect("the copy's time is put back");
        fs::write(workspace.join("notes/changed.md"), b"second, longer").expect("written");
        fs::remove_file(workspace.join("gone.md")).expect("removed");
        let listed = [roots[0].clone()];

        let second = mirror_roots(&mirror, &listed, &stop).expect("the second run copies");

        assert_eq!(
            second,
            MirrorReport {
                copied_files: 1,
                copied_bytes: 14,
                removed_entries: 2,
            }
        );
        assert_eq!(fs::read(&kept_copy).expect("read"), b"KEPT");
        let changed_copy = mirror.join("workspace/notes/changed.md");
        assert_eq!(fs::read(&changed_copy).expect("read"), b"second, longer");
        assert_eq!(
            modified(&changed_copy),
            modified(&workspace.join("notes/changed.md"))
        );
        assert!(!mirror.join("workspace/gone.md").exists());
        assert!(!mirror.join("settings").exists());
        assert_eq!(
            mirror_roots(&mirror, &listed, &stop).expect("the third run reads"),
            MirrorReport::default()
        );
    }
}
