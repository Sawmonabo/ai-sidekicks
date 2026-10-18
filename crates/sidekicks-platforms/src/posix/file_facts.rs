//! A file's facts on macOS and Linux, from one `stat` that follows a link.

use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

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

// A stat time's seconds and nanoseconds as nanoseconds since the Unix epoch.
fn nanoseconds(seconds: i64, nanoseconds: i64) -> i128 {
    i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds)
}
