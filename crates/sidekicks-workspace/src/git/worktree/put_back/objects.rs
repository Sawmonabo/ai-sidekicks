//! The pack and LFS objects a put-back copies from the kept copy back into the repository, and
//! their removal when the put-back is undone.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_std::file::clone_or_copy::clone_or_copy;
use sidekicks_std::missing_entry::MissingEntry;

use super::undo::PutBackUndoError;
use super::{PutBackStepError, at};
use crate::git::worktree::kept_copy::saved_state::lfs_object_path;
use crate::git::worktree::kept_copy::{KEPT_LFS_ENTRY, KEPT_OBJECTS_ENTRY};

/// What a put-back copied into the repository, each file named before it is written, so a failure
/// part way still names it for the undo, and the folders it made on the way.
#[derive(Debug, Default)]
pub(super) struct RestoredObjects {
    /// The pack and LFS object files written.
    pub(super) files: Vec<PathBuf>,
    /// The folders made to hold them, each before the ones inside it.
    pub(super) made_folders: Vec<PathBuf>,
}

// Removes each object a put-back copied into the repository; one already gone is no failure.
pub(super) async fn remove_restored_objects(files: Vec<PathBuf>) -> Vec<PutBackUndoError> {
    let mut failures = Vec::new();
    for file in files {
        if let Err(source) = tokio::fs::remove_file(&file).await.none_if_missing() {
            failures.push(PutBackUndoError::File { path: file, source });
        }
    }
    failures
}

// Copies the kept pack and LFS objects into the repository, the LFS ones into `lfs_store`, naming
// each file before it is written, so a failure part way still names it for the undo. A copy works
// across volumes, and git objects never change, so the kept ones stay whole for an undo and go
// with the kept copy once the put-back is recorded. An object the repository already has is left.
pub(super) async fn restore_objects(
    kept_folder: &Path,
    common_folder: &Path,
    lfs_store: &Path,
) -> (RestoredObjects, Result<(), PutBackStepError>) {
    let kept_objects = kept_folder.join(KEPT_OBJECTS_ENTRY);
    let kept_lfs = kept_folder.join(KEPT_LFS_ENTRY);
    let pack_folder = common_folder.join("objects").join("pack");
    let lfs_store = lfs_store.to_path_buf();
    let restoring = tokio::task::spawn_blocking(move || {
        let mut restored = RestoredObjects::default();
        let outcome = copy_kept_objects(
            &kept_objects,
            &pack_folder,
            &kept_lfs,
            &lfs_store,
            &mut restored,
        );
        (restored, outcome)
    })
    .await;
    match restoring {
        Ok(restored) => restored,
        Err(failure) => (
            RestoredObjects::default(),
            Err(PutBackStepError::Interrupted(failure)),
        ),
    }
}

// Copies each kept pack file into `pack_folder` and each kept LFS object into `lfs_store`, naming
// each in `restored` before it is written.
fn copy_kept_objects(
    kept_objects: &Path,
    pack_folder: &Path,
    kept_lfs: &Path,
    lfs_store: &Path,
    restored: &mut RestoredObjects,
) -> Result<(), PutBackStepError> {
    for name in read_entry_names(kept_objects)? {
        restore_object(
            &kept_objects.join(&name),
            &pack_folder.join(&name),
            restored,
        )?;
    }
    for lfs_object_id in read_entry_names(kept_lfs)? {
        restore_object(
            &kept_lfs.join(&lfs_object_id),
            &lfs_object_path(lfs_store, &lfs_object_id.to_string_lossy()),
            restored,
        )?;
    }
    Ok(())
}

// The names in `folder`, none when it is missing.
fn read_entry_names(folder: &Path) -> Result<Vec<OsString>, PutBackStepError> {
    let Some(entries) = fs::read_dir(folder).none_if_missing().map_err(at(folder))? else {
        return Ok(Vec::new());
    };
    entries
        .map(|entry| entry.map(|entry| entry.file_name()).map_err(at(folder)))
        .collect()
}

// Copies one kept object to `target` unless something is there, making its missing folders first.
fn restore_object(
    source: &Path,
    target: &Path,
    restored: &mut RestoredObjects,
) -> Result<(), PutBackStepError> {
    if target.try_exists().map_err(at(target))? {
        return Ok(());
    }
    if let Some(folder) = target.parent() {
        let mut missing = Vec::new();
        for ancestor in folder.ancestors() {
            if ancestor.try_exists().map_err(at(ancestor))? {
                break;
            }
            missing.push(ancestor.to_path_buf());
        }
        for made in missing.into_iter().rev() {
            match fs::create_dir(&made) {
                Ok(()) => restored.made_folders.push(made),
                Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {}
                Err(failure) => return Err(at(&made)(failure)),
            }
        }
    }
    restored.files.push(target.to_path_buf());
    clone_or_copy(source, target).map_err(at(target))
}
