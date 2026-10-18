//! The daemon's run folder on Windows, which has none: the service is reached through its per-user
//! named pipe.

use std::io::{self, ErrorKind};
use std::path::Path;

use crate::run_folder::{DaemonRunFolder, RunFolderRefused};

/// No run folder: Windows reaches the service through its per-user named pipe. Always fails with
/// `Unsupported`.
pub fn daemon_run_folder() -> io::Result<DaemonRunFolder> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        RunFolderRefused::Unsupported,
    ))
}

/// No run folder to check on Windows. Always fails with [`RunFolderRefused::Unsupported`].
pub fn check_private_run_folder(_folder: &Path) -> Result<(), RunFolderRefused> {
    Err(RunFolderRefused::Unsupported)
}
