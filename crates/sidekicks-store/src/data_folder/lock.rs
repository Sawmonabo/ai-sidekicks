//! The data folder's hold: one daemon per data folder, through an exclusive lock on its lock file
//! held for the daemon's whole life and freed the moment the daemon dies. The holder writes its
//! process id beside the lock, so a refused start names it.

use std::fmt::{self, Display};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

/// The lock file, in the data folder.
const LOCK_FILE_NAME: &str = "daemon.lock";

/// The file the holder writes its process id to, beside the lock file: a locked file cannot be
/// read on every system.
const PROCESS_ID_FILE_NAME: &str = "daemon.pid";

/// How long a held lock is tried again before the start is refused: a child the holder started is
/// briefly between fork and exec sharing the lock file, until its exec closes it.
const HELD_RETRY_BOUND: Duration = Duration::from_secs(1);

/// How long between two tries of a held lock.
const HELD_RETRY_INTERVAL: Duration = Duration::from_millis(50);

/// Another daemon holds the data folder; its `Display` is the refusal a person reads.
#[derive(Debug, thiserror::Error)]
pub struct HeldDataFolder {
    /// The data folder.
    pub path: PathBuf,
    /// The holder's process id as it recorded it, when the record could be read.
    pub process_id: Option<u32>,
    /// The lock's answer that showed the folder is held.
    #[source]
    pub source: io::Error,
}

impl Display for HeldDataFolder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_data_folder_held(formatter, self.process_id)
    }
}

/// Writes the refusal a person reads when another daemon holds the data folder, naming the
/// holder's `process_id` when it is known.
pub fn write_data_folder_held(
    formatter: &mut fmt::Formatter<'_>,
    process_id: Option<u32>,
) -> fmt::Result {
    match process_id {
        Some(process_id) => write!(
            formatter,
            "The background service is already running (process {process_id})."
        ),
        None => write!(formatter, "The background service is already running."),
    }
}

/// Why the data folder could not be held.
#[derive(Debug, thiserror::Error)]
pub enum DataFolderLockError {
    /// Another daemon holds it.
    #[error(transparent)]
    Held(#[from] HeldDataFolder),
    /// The lock file could not be opened or locked.
    #[error("the data folder's lock file {} could not be locked", path.display())]
    Lock {
        /// The lock file.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
    /// The process id could not be written beside the lock.
    #[error("the daemon's process id could not be written to {}", path.display())]
    RecordProcessId {
        /// The process id file.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
}

/// The daemon's hold on its data folder, kept for its whole life; dropping it frees the folder.
/// The system opens the lock file close-on-exec and not inheritable, so no child holds it.
pub struct DataFolderLock {
    _file: File,
}

impl DataFolderLock {
    /// Takes the data folder at `data_folder` for this process and records its process id beside
    /// the lock; a held lock is tried again for up to a second. Fails with `Held` naming the
    /// holder's process id once it stays held, and with the system's error when the lock file
    /// cannot be opened or locked or the id cannot be written. Blocking, so it runs through
    /// `spawn_blocking`.
    pub fn take(data_folder: &Path) -> Result<Self, DataFolderLockError> {
        let lock_path = data_folder.join(LOCK_FILE_NAME);
        let lock_error = |source| DataFolderLockError::Lock {
            path: lock_path.clone(),
            source,
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(lock_error)?;
        let retry_until = Instant::now() + HELD_RETRY_BOUND;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(TryLockError::Error(source)) => return Err(lock_error(source)),
                Err(TryLockError::WouldBlock) if Instant::now() < retry_until => {
                    thread::sleep(HELD_RETRY_INTERVAL);
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(HeldDataFolder {
                        path: data_folder.to_path_buf(),
                        process_id: read_holder_process_id(data_folder),
                        source: io::Error::from(io::ErrorKind::WouldBlock),
                    }
                    .into());
                }
            }
        }
        let process_id_path = data_folder.join(PROCESS_ID_FILE_NAME);
        fs::write(&process_id_path, std::process::id().to_string()).map_err(|source| {
            DataFolderLockError::RecordProcessId {
                path: process_id_path,
                source,
            }
        })?;
        Ok(Self { _file: file })
    }
}

/// The process id the holder recorded beside the lock, or `None` when the record is missing or
/// unreadable, as when the holder has not written it yet.
fn read_holder_process_id(data_folder: &Path) -> Option<u32> {
    let path = data_folder.join(PROCESS_ID_FILE_NAME);
    match fs::read_to_string(&path) {
        Ok(text) => text.trim().parse().ok(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(
                path = %path.display(),
                "the data folder's holder left no process id"
            );
            None
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                path = %path.display(),
                "the data folder's holder's process id could not be read"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::{DataFolderLock, DataFolderLockError};

    #[test]
    fn a_second_take_is_refused_naming_the_holder_without_waiting_for_it() {
        let data_folder = tempfile::tempdir().expect("a scratch folder");
        let _holder = DataFolderLock::take(data_folder.path()).expect("the first take holds");

        // On a thread of its own, so a take that waits on the holder fails the test, not hangs it.
        let (answer, answered) = mpsc::channel();
        let path = data_folder.path().to_path_buf();
        thread::spawn(move || answer.send(DataFolderLock::take(&path)).map_err(drop));
        let second = answered
            .recv_timeout(Duration::from_secs(5))
            .expect("the second take answers without waiting on the holder");
        let Err(DataFolderLockError::Held(refused)) = second else {
            panic!("the second take was not refused as held");
        };
        assert_eq!(refused.path, data_folder.path());
        assert_eq!(refused.process_id, Some(std::process::id()));
        assert_eq!(
            refused.to_string(),
            format!(
                "The background service is already running (process {}).",
                std::process::id()
            )
        );
    }
}
