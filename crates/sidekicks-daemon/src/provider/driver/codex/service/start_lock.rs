//! Codex's own start lock on the person's Codex folder, `app-server-daemon/daemon.lock`, which
//! Codex's managed daemon and its updater hold while they start or restart a service there. The
//! daemon takes the same whole-file lock, so a terminal's plain `codex` waits while the daemon
//! starts the terminal service, and the daemon waits while Codex restarts its own; it holds the
//! lock only for the seconds a start takes.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How often a wait for the lock tries again, as Codex's own wait does.
const START_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(50);

/// The folder under a Codex home where Codex keeps its managed daemon's lock, pid files and logs.
pub(crate) const CODEX_DAEMON_STATE_FOLDER: &str = "app-server-daemon";

/// The lock file's name in that folder.
const START_LOCK_FILE_NAME: &str = "daemon.lock";

/// Codex's start lock, held until this drops.
#[derive(Debug)]
pub(crate) struct CodexStartLock {
    // Held open, since closing the file lets go of the lock.
    _file: File,
}

/// The folder Codex keeps its managed daemon's state in on `codex_home`.
pub(crate) fn codex_daemon_state_folder(codex_home: &Path) -> PathBuf {
    codex_home.join(CODEX_DAEMON_STATE_FOLDER)
}

/// Takes Codex's start lock on `codex_home`, trying again every 50 ms until `deadline` passes.
/// Fails with `TimedOut` past the deadline, and with the folder's, the file's or the lock's other
/// errors.
pub(crate) async fn take_codex_start_lock(
    codex_home: &Path,
    deadline: Duration,
) -> io::Result<CodexStartLock> {
    let folder = codex_daemon_state_folder(codex_home);
    std::fs::create_dir_all(&folder)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(folder.join(START_LOCK_FILE_NAME))?;
    let wait = async {
        loop {
            match file.try_lock() {
                Ok(()) => return Ok::<(), io::Error>(()),
                Err(TryLockError::WouldBlock) => {
                    tokio::time::sleep(START_LOCK_RETRY_INTERVAL).await;
                }
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
    };
    tokio::time::timeout(deadline, wait)
        .await
        .map_err(|_elapsed| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "Codex's start lock was not free within the start's deadline",
            )
        })??;
    Ok(CodexStartLock { _file: file })
}
