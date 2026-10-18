//! The daemon's run folder: the person's own folder holding the local socket the daemon binds and
//! every client connects to, and the session token the daemon writes at each start and every
//! client presents. macOS and Linux resolve it and check it is private before any bind or byte;
//! Windows has none, since its service is reached through a per-user named pipe.

use std::io;
use std::path::PathBuf;

/// The run folder and the two files in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonRunFolder {
    /// The folder itself.
    pub folder_path: PathBuf,
    /// The local socket the daemon binds.
    pub socket_path: PathBuf,
    /// The session token file, rewritten with a new token at every daemon start.
    pub token_path: PathBuf,
}

/// Why the run folder is not one only this account can reach.
#[derive(Debug, thiserror::Error)]
pub enum RunFolderRefused {
    /// The folder could not be read, `NotFound` among the reasons.
    #[error("the run folder {} could not be read", folder.display())]
    Read {
        /// The folder checked.
        folder: PathBuf,
        /// The read's failure.
        #[source]
        source: io::Error,
    },
    /// The path names a link, a file or a folder another account owns.
    #[error("the run folder {} is not a folder this account owns", folder.display())]
    NotOwnFolder {
        /// The folder checked.
        folder: PathBuf,
    },
    /// The folder lets its group or other accounts in.
    #[error(
        "the run folder {} is open to other accounts (mode {mode:o}); it must be 700",
        folder.display()
    )]
    OpenToOthers {
        /// The folder checked.
        folder: PathBuf,
        /// Its permission bits.
        mode: u32,
    },
    /// The system has no run folder: Windows, whose service is reached through a named pipe.
    #[error(
        "on Windows the background service is reached through its per-user named pipe, not a run \
         folder"
    )]
    Unsupported,
}
