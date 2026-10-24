//! The database file's check, repair and copies: the start's check of the file, the damage found
//! while the daemon has it open and the record of it the next start repairs from, the repair
//! itself and the readying of the fresh file it recovers into, the record of how the last run on
//! it ended, the newest backup a repair reads from, the daemon's SQLite shell that recovers a
//! damaged file, the copies aside made before any repair, the copy every copy of a file runs in,
//! the watch that stops a recovery whose shells have stalled, and the offline restore from a
//! backup. Every child it starts is the daemon's own program in a mode, ended at once by a stop.

pub mod aside_copy;
pub mod check;
pub mod copy;
pub(crate) mod damage;
pub mod fresh;
pub mod last_run;
pub(crate) mod newest_backup;
pub mod repair;
pub mod restore;
pub mod sqlite_shell;
pub(crate) mod stall_watch;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The suffix of the write-ahead log SQLite keeps beside a database.
pub(crate) const WRITE_AHEAD_LOG_SUFFIX: &str = "-wal";

/// The suffix of the shared-memory index SQLite keeps beside a database in write-ahead-log mode.
pub(crate) const SHARED_MEMORY_SUFFIX: &str = "-shm";

/// How long a read of the database file, the check's or a shell's, waits out another connection's
/// lock before it fails busy.
pub(crate) const READ_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// How many bytes at the end of a child's error output are kept for its failure's message.
pub(crate) const ERROR_OUTPUT_KEPT_BYTES: usize = 4_096;

/// `database_path` with `suffix` added to its file name: `daemon.db` becomes `daemon.db-wal`.
pub(crate) fn sibling_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = OsString::from(database_path.as_os_str());
    path.push(suffix);
    PathBuf::from(path)
}

/// The folder the database file at `database_path` sits in; the daemon's path to it always names
/// one.
pub(crate) fn store_folder(database_path: &Path) -> &Path {
    database_path
        .parent()
        .expect("the database file's path names its folder")
}
