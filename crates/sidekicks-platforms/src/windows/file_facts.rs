//! A file's facts on Windows, read from one handle opened through any link, which asks only to
//! read attributes, so it leaves SQLite's locks on the file alone, and when an entry last changed
//! by any write.

use std::fs::{Metadata, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::time::SystemTime;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO, FileBasicInfo, FileStandardInfo,
};

use crate::file_facts::FileFacts;
use crate::windows::entry_identity::open_file_identity;
use crate::windows::file_information::read_information;

// The 100-nanosecond intervals between 1601-01-01, where a `FILETIME` counts from, and the Unix
// epoch.
const UNIX_EPOCH_INTERVALS: i128 = 116_444_736_000_000_000;

/// The facts of the file at `path`, read from one handle opened through any link: its volume
/// serial and 128-bit file id, its size, and its last write and change times. Fails with the
/// system's error from the open or a read, `NotFound` when nothing is there.
pub fn file_facts(path: &Path) -> io::Result<FileFacts> {
    // Opened as `entry_identity` opens an entry, but through a link to its target.
    let opened = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let identity = open_file_identity(&opened)?;
    let times: FILE_BASIC_INFO = read_information(&opened, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = read_information(&opened, FileStandardInfo)?;
    Ok(FileFacts {
        identity,
        size: u64::try_from(standard.EndOfFile).map_err(io::Error::other)?,
        modified: nanoseconds(times.LastWriteTime),
        changed: nanoseconds(times.ChangeTime),
    })
}

/// When the entry `metadata` was read from last changed: the newer of its last write time and its
/// creation time, which a copy or a move from another volume sets to now while keeping the write
/// time it carried. Fails with the error reading the write time gives.
pub fn entry_changed_at(metadata: &Metadata) -> io::Result<SystemTime> {
    let modified = metadata.modified()?;
    // A volume that keeps no creation time leaves the write time alone to tell it.
    Ok(metadata
        .created()
        .map_or(modified, |created| created.max(modified)))
}

// A `FILETIME`'s 100-nanosecond intervals since 1601 as nanoseconds since the Unix epoch.
fn nanoseconds(intervals: i64) -> i128 {
    (i128::from(intervals) - UNIX_EPOCH_INTERVALS) * 100
}
