//! The database file's check, repair and copies: the start's check of the file, the record of how
//! the last run on it ended, the newest backup a repair reads from, the daemon's SQLite shell that
//! recovers a damaged file, the copies aside made before any repair, the copy every copy of a file
//! runs in, and the watch that stops a recovery whose shells have stalled. Every child it starts is
//! the daemon's own program in a mode, ended at once by a stop.

pub mod aside_copy;
pub mod check;
pub mod copy;
pub(crate) mod last_run;
pub(crate) mod newest_backup;
pub mod sqlite_shell;
pub(crate) mod stall_watch;

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

/// The suffix of the write-ahead log SQLite keeps beside a database.
pub(crate) const WRITE_AHEAD_LOG_SUFFIX: &str = "-wal";

/// The suffix of the shared-memory index SQLite keeps beside a database in write-ahead-log mode.
pub(crate) const SHARED_MEMORY_SUFFIX: &str = "-shm";

/// How long a read of the database file, the check's or a shell's, waits out another connection's
/// lock before it fails busy.
pub(crate) const READ_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// How many bytes at the end of a child's error output are kept for its failure's message.
pub(crate) const ERROR_OUTPUT_KEPT_BYTES: usize = 4_096;

// How many bytes one read of a child's error output takes.
const ERROR_OUTPUT_READ_BYTES: usize = 4_096;

/// The last [`ERROR_OUTPUT_KEPT_BYTES`] of `stream`, read to its end, decoded lossily once and
/// starting on a whole character. Fails with the read's error.
pub(crate) async fn read_error_tail(mut stream: impl AsyncRead + Unpin) -> io::Result<String> {
    let mut kept = Vec::new();
    let mut chunk = [0_u8; ERROR_OUTPUT_READ_BYTES];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..read]);
        // Trimmed only past twice the bound, so a long stream is not shifted on every read.
        if kept.len() > 2 * ERROR_OUTPUT_KEPT_BYTES {
            kept.drain(..kept.len() - ERROR_OUTPUT_KEPT_BYTES);
        }
    }
    let mut start = kept.len().saturating_sub(ERROR_OUTPUT_KEPT_BYTES);
    // A cut inside a character moves on to the next character's first byte.
    while kept.get(start).is_some_and(|byte| byte & 0xC0 == 0x80) {
        start += 1;
    }
    Ok(String::from_utf8_lossy(&kept[start..]).trim().to_owned())
}

/// `database_path` with `suffix` added to its file name: `daemon.db` becomes `daemon.db-wal`.
pub(crate) fn sibling_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = OsString::from(database_path.as_os_str());
    path.push(suffix);
    PathBuf::from(path)
}
