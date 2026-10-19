//! Which entry a path names on macOS and Linux: its device and inode with its kind and facts, from
//! one `lstat`.

use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use crate::entry_identity::{EntryIdentity, IdentifiedEntry};

/// The identity, kind and facts of the entry at `path`, from one stat that follows no link, so a
/// link to a folder reads as not a folder. Fails with the stat's error, `NotFound` when nothing is
/// there.
pub fn entry_identity(path: &Path) -> io::Result<IdentifiedEntry> {
    let metadata = fs::symlink_metadata(path)?;
    Ok(IdentifiedEntry {
        is_folder: metadata.is_dir(),
        identity: EntryIdentity {
            volume: metadata.dev(),
            file: u128::from(metadata.ino()),
        },
        metadata,
    })
}
