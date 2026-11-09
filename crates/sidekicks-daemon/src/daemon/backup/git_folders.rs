//! The git folders the backup copies, as the daemon sees their writers: each capture folder is
//! copied under its packing lock, so no pack, fold or sweep pass moves its objects meanwhile, and
//! every other git folder, which no lock the daemon holds covers, by a second read of its refs and
//! a check of its copied indexes against the copy, read through this machine's git so it never
//! fetches an object.

use std::collections::{BTreeSet, HashSet};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::backup_mirror::{CopiedIndex, CopiedIndexCheck, LiveGitFolders, MirrorError};
use sidekicks_workspace::git::index_objects::{
    IndexObjectsError, read_absent_objects, read_index_objects,
};
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::turn_snapshot::capture_folder::is_capture_folder;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use tempfile::TempDir;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

// A git folder's objects folder.
const OBJECTS_FOLDER_NAME: &str = "objects";

/// The holds and checks the backup's mirror asks of the git folders it copies.
pub(crate) struct BackupGitFolders {
    /// The capture folders' packing, whose per-folder lock a copy holds.
    packing: Arc<CapturePacking>,
    /// The daemon's git.
    git: GitRunner,
    /// An owner-only folder for the index checks' scratch repositories and work tree, made on the
    /// first check and kept for the daemon's life.
    scratch: Mutex<Option<TempDir>>,
    /// The daemon's runtime, which the mirror's blocking thread runs each wait on.
    runtime: Handle,
}

impl BackupGitFolders {
    /// The git folders over `packing` and `git`, their waits run on `runtime`.
    pub(crate) fn new(packing: Arc<CapturePacking>, git: GitRunner, runtime: Handle) -> Self {
        Self {
            packing,
            git,
            scratch: Mutex::new(None),
            runtime,
        }
    }

    // The scratch folder, made on its first need.
    fn scratch_folder(&self) -> io::Result<PathBuf> {
        let mut scratch = lock(&self.scratch);
        if let Some(folder) = scratch.as_ref() {
            return Ok(folder.path().to_path_buf());
        }
        let folder = TempDir::new()?;
        let path = folder.path().to_path_buf();
        *scratch = Some(folder);
        Ok(path)
    }

    // Whether every object `indexes` name is in `copy_objects` or is one the live folder
    // `git_folder` does without: one the copy lacks counts as moved when the live folder holds it
    // or no live index names it any more, since a prune may then have taken it.
    async fn check_indexes(
        &self,
        git_folder: &Path,
        copy_objects: &Path,
        indexes: &[CopiedIndex],
        scratch: &Path,
    ) -> Result<CopiedIndexCheck, IndexObjectsError> {
        let mut named = BTreeSet::new();
        for index in indexes {
            named.extend(
                read_index_objects(&self.git, index_folder(index), &index.copied, scratch).await?,
            );
        }
        let named: Vec<&GitObjectId> = named.iter().collect();
        let absent = read_absent_objects(&self.git, scratch, copy_objects, &named).await?;
        if absent.is_empty() {
            return Ok(CopiedIndexCheck::Whole);
        }
        let absent_objects: Vec<&GitObjectId> = absent.iter().collect();
        let live_objects = git_folder.join(OBJECTS_FOLDER_NAME);
        let absent_live: HashSet<GitObjectId> =
            read_absent_objects(&self.git, scratch, &live_objects, &absent_objects)
                .await?
                .into_iter()
                .collect();
        // A live index gone since reads as an empty one.
        let mut named_live = BTreeSet::new();
        for index in indexes {
            named_live.extend(
                read_index_objects(&self.git, index_folder(index), &index.live, scratch).await?,
            );
        }
        let is_moved = absent
            .iter()
            .any(|object| !absent_live.contains(object) || !named_live.contains(object));
        Ok(if is_moved {
            CopiedIndexCheck::Moved
        } else {
            CopiedIndexCheck::Whole
        })
    }
}

impl LiveGitFolders for BackupGitFolders {
    fn hold(
        &self,
        git_folder: &Path,
        stop: &CancellationToken,
    ) -> Result<Option<Box<dyn Send + '_>>, MirrorError> {
        if !is_capture_folder(git_folder) {
            return Ok(None);
        }
        self.runtime.block_on(async {
            tokio::select! {
                biased;
                () = stop.cancelled() => Err(MirrorError::Stopped),
                hold = self.packing.hold_capture_folder(git_folder) => {
                    Ok(Some(Box::new(hold) as Box<dyn Send + '_>))
                }
            }
        })
    }

    fn check_copied_indexes(
        &self,
        git_folder: &Path,
        copy_objects: &Path,
        indexes: &[CopiedIndex],
        stop: &CancellationToken,
    ) -> Result<CopiedIndexCheck, MirrorError> {
        if indexes.is_empty() {
            return Ok(CopiedIndexCheck::Whole);
        }
        let scratch = match self.scratch_folder() {
            Ok(scratch) => scratch,
            Err(error) => {
                tracing::warn!(
                    folder = %git_folder.display(),
                    error = &error as &(dyn Error + 'static),
                    "the backup's scratch folder could not be made, so a git folder's last copy is kept"
                );
                return Ok(CopiedIndexCheck::Unread);
            }
        };
        // Dropping git's future at the stop ends its process tree.
        let checked = self.runtime.block_on(async {
            tokio::select! {
                biased;
                () = stop.cancelled() => None,
                checked = self.check_indexes(git_folder, copy_objects, indexes, &scratch) => {
                    Some(checked)
                }
            }
        });
        match checked {
            None => Err(MirrorError::Stopped),
            Some(Ok(check)) => Ok(check),
            Some(Err(error)) => {
                tracing::warn!(
                    folder = %git_folder.display(),
                    error = &error as &(dyn Error + 'static),
                    "a git folder's index could not be read against its copy, so its last copy is kept"
                );
                Ok(CopiedIndexCheck::Unread)
            }
        }
    }
}

// The folder holding `index`'s live file, the git folder or a linked worktree's folder in it,
// where git finds a split index's shared file.
fn index_folder(index: &CopiedIndex) -> &Path {
    index
        .live
        .parent()
        .expect("an index file lies in a git folder")
}

#[cfg(test)]
mod tests;
