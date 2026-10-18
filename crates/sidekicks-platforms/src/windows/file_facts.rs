//! A file's facts on Windows, read from one handle opened through any link, which asks only to
//! read attributes, so it leaves SQLite's locks on the file alone.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
    FileBasicInfo, FileIdInfo, FileStandardInfo, GetFileInformationByHandleEx,
};

use crate::entry_identity::EntryIdentity;
use crate::file_facts::FileFacts;

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
    let identity: FILE_ID_INFO = read_information(&opened, FileIdInfo)?;
    let times: FILE_BASIC_INFO = read_information(&opened, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = read_information(&opened, FileStandardInfo)?;
    Ok(FileFacts {
        identity: EntryIdentity {
            volume: identity.VolumeSerialNumber,
            file: u128::from_le_bytes(identity.FileId.Identifier),
        },
        size: u64::try_from(standard.EndOfFile).map_err(io::Error::other)?,
        modified: nanoseconds(times.LastWriteTime),
        changed: nanoseconds(times.ChangeTime),
    })
}

// One record of `class`, which must be the class whose record `Record` is, read from `file`.
fn read_information<Record: Default>(
    file: &File,
    class: FILE_INFO_BY_HANDLE_CLASS,
) -> io::Result<Record> {
    let mut record = Record::default();
    let length = u32::try_from(size_of::<Record>()).expect("the record's size fits in a u32");
    // SAFETY: the handle is the open file's, alive for the call; the buffer is a live `Record`,
    // the record `class` fills, of the length given.
    let has_record = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            class,
            (&raw mut record).cast(),
            length,
        )
    };
    if has_record == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(record)
}

// A `FILETIME`'s 100-nanosecond intervals since 1601 as nanoseconds since the Unix epoch.
fn nanoseconds(intervals: i64) -> i128 {
    (i128::from(intervals) - UNIX_EPOCH_INTERVALS) * 100
}
