//! The git folders the backup copies, as the daemon sees their writers: each capture folder is
//! copied under its packing lock, so no pack, fold or sweep pass moves its objects meanwhile.

use std::path::Path;
use std::sync::Arc;

use sidekicks_store::backup_mirror::{LiveGitFolders, MirrorError};
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::turn_snapshot::capture_folder::is_capture_folder;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

/// The holds and checks the backup's mirror asks of the git folders it copies.
pub(crate) struct BackupGitFolders {
    /// The capture folders' packing, whose per-folder lock a copy holds.
    packing: Arc<CapturePacking>,
    /// The daemon's git.
    git: GitRunner,
    /// The daemon's runtime, which the mirror's blocking thread runs each wait on.
    runtime: Handle,
}

impl BackupGitFolders {
    /// The git folders over `packing` and `git`, their waits run on `runtime`.
    pub(crate) fn new(packing: Arc<CapturePacking>, git: GitRunner, runtime: Handle) -> Self {
        Self {
            packing,
            git,
            runtime,
        }
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
}

#[cfg(test)]
mod tests;
