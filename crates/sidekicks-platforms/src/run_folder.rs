//! The daemon's run folder: the person's own folder holding the session token the daemon writes at
//! each start and every client presents, the status file that records why a start failed, and on
//! macOS and Linux the local socket the daemon binds and every client connects to; on Windows that
//! socket is the person's own named pipe. Each platform resolves the folder and checks it is
//! private before any bind or byte.

use std::io;
use std::path::PathBuf;

/// The run folder's name, and the start of the names derived from it: the folder in the session's
/// runtime folder on Linux, the application's folder on Windows, and its named pipe.
pub(crate) const RUN_FOLDER_NAME: &str = "ai-sidekicks";

/// The session token file's name in the run folder.
pub(crate) const SESSION_TOKEN_FILE_NAME: &str = "daemon.token";

/// The service status file's name in the run folder.
pub(crate) const SERVICE_STATUS_FILE_NAME: &str = "service-status.json";

/// The run folder, the daemon's local socket, its token file and its status file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonRunFolder {
    /// The folder itself.
    pub folder_path: PathBuf,
    /// The local socket the daemon binds: a socket file in the folder on macOS and Linux, the
    /// person's own named pipe (`\\.\pipe\ai-sidekicks-<user SID>`) on Windows.
    pub socket_path: PathBuf,
    /// The session token file, rewritten with a new token at every daemon start.
    pub token_path: PathBuf,
    /// The service status file, which records why the daemon's last start failed, for the clients
    /// to read with no daemon to ask; a start that succeeds removes it.
    pub status_path: PathBuf,
}

/// Why the run folder is not private to this account.
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
    /// The path names a link, a file, or a folder owned by an account that may not hold it.
    #[error(
        "the run folder {} is a link, a file or a folder owned by an account that may not hold it",
        folder.display()
    )]
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
    /// The folder's access list lets in an account other than this one, SYSTEM and the
    /// Administrators: Windows.
    #[error("the run folder {} lets {account} in", folder.display())]
    OpenToAccount {
        /// The folder checked.
        folder: PathBuf,
        /// The account let in, as SDDL text, or the kind of entry that names none.
        account: String,
    },
}
