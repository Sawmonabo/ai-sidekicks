//! A file's facts on macOS and Linux, from one `stat` that follows a link, and when an entry last
//! changed by any write.

use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::entry_identity::EntryIdentity;
use crate::file_facts::FileFacts;

/// The facts of the file at `path`, from one `stat` that follows a link: its device and inode, its
/// size, and its modification and change times. Opens nothing, so no lock the process holds on the
/// file is dropped. Fails with the stat's error, `NotFound` when nothing is there.
pub fn file_facts(path: &Path) -> io::Result<FileFacts> {
    let metadata = fs::metadata(path)?;
    Ok(FileFacts {
        identity: EntryIdentity {
            volume: metadata.dev(),
            file: u128::from(metadata.ino()),
        },
        size: metadata.size(),
        modified: nanoseconds(metadata.mtime(), metadata.mtime_nsec()),
        changed: nanoseconds(metadata.ctime(), metadata.ctime_nsec()),
    })
}

/// When the entry `metadata` was read from last changed: the newer of its modified time and its
/// status-change time (`st_ctime`), which every write, rename and time change sets to now and no
/// process can set, so an entry whose modified time was kept or set back still reads as changed.
/// Fails with the error reading the modified time gives.
pub fn entry_changed_at(metadata: &Metadata) -> io::Result<SystemTime> {
    let modified = metadata.modified()?;
    let status_changed = system_time(metadata.ctime(), metadata.ctime_nsec());
    Ok(modified.max(status_changed))
}

// A stat time's seconds and nanoseconds as a system time, before the Unix epoch included.
fn system_time(seconds: i64, nanoseconds: i64) -> SystemTime {
    let whole = Duration::from_secs(seconds.unsigned_abs());
    let fraction = Duration::from_nanos(nanoseconds.unsigned_abs());
    if seconds >= 0 {
        UNIX_EPOCH + whole + fraction
    } else {
        UNIX_EPOCH - whole + fraction
    }
}

// A stat time's seconds and nanoseconds as nanoseconds since the Unix epoch.
fn nanoseconds(seconds: i64, nanoseconds: i64) -> i128 {
    i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds)
}
