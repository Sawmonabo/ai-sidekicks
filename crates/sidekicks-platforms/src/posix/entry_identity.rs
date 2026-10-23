//! Which entry a path names on macOS and Linux: its device and inode with its kind and facts, from
//! one `lstat`; and the same identity of an open file, from one `fstat`.

use std::fs::{self, File};
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
        identity: identity_of(&metadata),
        metadata,
    })
}

/// The identity of the open file `file`, equal to [`entry_identity`]'s of any name that still
/// names it. Fails with the stat's error.
pub fn open_file_identity(file: &File) -> io::Result<EntryIdentity> {
    Ok(identity_of(&file.metadata()?))
}

/// Whether the open file `file` is marked for deletion once its last handle closes: never here,
/// where a removed name is gone at once and the open file keeps no such mark.
#[expect(
    clippy::unnecessary_wraps,
    reason = "Windows reads the mark from the file and can fail; both answer alike"
)]
pub(crate) fn is_marked_for_deletion(_file: &File) -> io::Result<bool> {
    Ok(false)
}

fn identity_of(metadata: &fs::Metadata) -> EntryIdentity {
    EntryIdentity {
        volume: metadata.dev(),
        file: u128::from(metadata.ino()),
    }
}
