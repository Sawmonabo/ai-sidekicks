//! The run folder the daemon's socket and session token live in: private to the person, cleared of
//! the socket a crashed daemon left behind while a daemon that still answers there keeps it, and
//! given a new session token at every bind.

use std::io;

use sidekicks_platforms::{
    DaemonRunFolder, RUN_FOLDER_FILE_MODE, RunFolderRefused, SocketPathEntry,
    check_private_run_folder, connect_socket, create_private_run_folder, read_socket_path_entry,
};
use tokio::task::JoinError;

use crate::daemon::already_running_error::{DaemonAlreadyRunningError, HeldPlace};
use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::ipc::local_gateway::LocalGateway;
use crate::random_hex::random_hex;

// The session token's size: 256 bits from the system's secure random source.
const SESSION_TOKEN_BYTES: usize = 32;

/// Why the run folder could not be prepared or the socket bound.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunFolderError {
    /// Another daemon answers on the socket, or bound it first.
    #[error(transparent)]
    AlreadyRunning(#[from] DaemonAlreadyRunningError),
    /// The folder could not be made.
    #[error("the run folder could not be made")]
    Folder(#[source] io::Error),
    /// The folder is not private to this account.
    #[error(transparent)]
    Refused(#[from] RunFolderRefused),
    /// The socket left there could not be read, probed or removed.
    #[error("the socket left in the run folder could not be read, probed or removed")]
    LeftSocket(#[source] io::Error),
    /// Something other than a socket stands at the socket's path, which the start never removes.
    #[error("{} is not a socket, so the daemon cannot bind there", path.display())]
    NotASocket {
        /// The socket's path.
        path: std::path::PathBuf,
    },
    /// The blocking task that prepared the folder ended before it finished.
    #[error("the run folder's preparation ended before it finished")]
    Interrupted(#[source] JoinError),
    /// The socket could not be bound.
    #[error("the daemon's socket could not be bound")]
    Bind(#[source] io::Error),
    /// The session token could not be written.
    #[error(transparent)]
    Token(#[from] AtomicWriteError),
}

/// Mints a session token, new at every bind, so an earlier bind's token opens no connection. Fails
/// when the system gives no random bytes.
pub(crate) fn mint_session_token() -> Result<String, getrandom::Error> {
    random_hex(SESSION_TOKEN_BYTES)
}

/// Makes the run folder ready for a bind: creates it readable by the person alone, refuses one
/// another account could reach, and removes a socket nobody answers on. Fails with
/// [`RunFolderError::AlreadyRunning`] when a daemon answers there and with
/// [`RunFolderError::NotASocket`] when anything else stands at the socket's path.
pub(crate) async fn prepare_run_folder(run_folder: &DaemonRunFolder) -> Result<(), RunFolderError> {
    let folder_path = run_folder.folder_path.clone();
    let socket_path = run_folder.socket_path.clone();
    let entry = tokio::task::spawn_blocking(move || {
        create_private_run_folder(&folder_path).map_err(RunFolderError::Folder)?;
        check_private_run_folder(&folder_path)?;
        read_socket_path_entry(&socket_path).map_err(RunFolderError::LeftSocket)
    })
    .await
    .map_err(RunFolderError::Interrupted)??;
    match entry {
        SocketPathEntry::Absent => return Ok(()),
        SocketPathEntry::Other => {
            return Err(RunFolderError::NotASocket {
                path: run_folder.socket_path.clone(),
            });
        }
        SocketPathEntry::Socket => {}
    }
    match connect_socket(&run_folder.socket_path).await {
        Ok(_answering) => Err(DaemonAlreadyRunningError {
            held_place: HeldPlace::Socket(run_folder.socket_path.clone()),
            source: None,
        }
        .into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        // A socket file with no listener behind it is a crashed daemon's.
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            match tokio::fs::remove_file(&run_folder.socket_path).await {
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    Err(RunFolderError::LeftSocket(error))
                }
                _ => Ok(()),
            }
        }
        Err(error) => Err(RunFolderError::LeftSocket(error)),
    }
}

/// Binds the daemon's socket in the prepared run folder through `start_gateway`, then writes
/// `session_token`, which the gateway's handshake checks, readable by the person alone and
/// replacing the previous bind's file all at once. Fails with [`RunFolderError::AlreadyRunning`]
/// when another start bound the socket first; a failed write stops the gateway again.
pub(crate) async fn bind_socket(
    start_gateway: impl FnOnce() -> io::Result<LocalGateway>,
    run_folder: &DaemonRunFolder,
    session_token: String,
) -> Result<LocalGateway, RunFolderError> {
    let gateway = match start_gateway() {
        Ok(gateway) => gateway,
        // Another start bound the socket between this start's check of the folder and its bind.
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            return Err(DaemonAlreadyRunningError {
                held_place: HeldPlace::Socket(run_folder.socket_path.clone()),
                source: Some(Box::new(error)),
            }
            .into());
        }
        Err(error) => return Err(RunFolderError::Bind(error)),
    };
    if let Err(error) =
        write_file_atomically(&run_folder.token_path, session_token, RUN_FOLDER_FILE_MODE).await
    {
        gateway.stop().await;
        return Err(error.into());
    }
    Ok(gateway)
}

#[cfg(test)]
mod tests {
    use sidekicks_platforms::{
        DaemonRunFolder, SocketPathEntry, create_private_folder, read_socket_path_entry,
    };

    use super::{RunFolderError, prepare_run_folder};

    // Fails when anything but a socket at the socket's path is probed, where a connect refused on a
    // regular file would delete it.
    #[tokio::test]
    async fn a_file_at_the_socket_s_path_refuses_the_start_and_is_kept() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder_path = scratch.path().join("run");
        create_private_folder(&folder_path).expect("the run folder is made");
        let socket_path = folder_path.join("daemon.sock");
        std::fs::write(&socket_path, b"").expect("a regular file stands at the socket's path");
        // Where the socket's path is a named pipe, a file never stands there.
        if read_socket_path_entry(&socket_path).expect("the path reads") == SocketPathEntry::Socket
        {
            return;
        }

        let result = prepare_run_folder(&DaemonRunFolder {
            token_path: folder_path.join("daemon.token"),
            folder_path,
            socket_path: socket_path.clone(),
        })
        .await;

        assert!(
            matches!(result, Err(RunFolderError::NotASocket { .. })),
            "{result:?}"
        );
        assert!(
            socket_path.exists(),
            "the file at the socket's path is kept"
        );
    }
}
