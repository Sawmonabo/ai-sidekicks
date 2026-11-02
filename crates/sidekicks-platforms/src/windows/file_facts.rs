//! A file's facts on Windows, read from one handle opened through any link, which asks only to
//! read attributes, so it leaves SQLite's locks on the file alone, or from a handle already open,
//! and when an entry last changed by any write.

use std::fs::{File, Metadata, OpenOptions};
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
/// serial and 128-bit file id, its size, its link count, and its last write and change times.
/// Fails with the system's error from the open or a read, `NotFound` when nothing is there.
pub fn file_facts(path: &Path) -> io::Result<FileFacts> {
    file_facts_of(&open_for_attributes(path)?)
}

/// Opens the file or folder at `path` through any link only to read its attributes, as
/// `entry_identity` opens an entry but through a link to its target: every share mode, so it leaves
/// other handles' locks alone, and backup semantics, without which a folder does not open. Fails
/// with the system's error from the open.
pub(crate) fn open_for_attributes(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

/// The facts of the open file `file`, read through its handle, never its path, so they are the very
/// file's the handle holds even once another file takes its name; the handle needs the right to
/// read attributes, which any read open has. Fails with the system's error from a read.
pub fn file_facts_of(file: &File) -> io::Result<FileFacts> {
    let identity = open_file_identity(file)?;
    let times: FILE_BASIC_INFO = read_information(file, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = read_information(file, FileStandardInfo)?;
    Ok(FileFacts {
        identity,
        size: u64::try_from(standard.EndOfFile).map_err(io::Error::other)?,
        link_count: u64::from(standard.NumberOfLinks),
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
