//! Which entry a path names on Windows: its volume serial and 128-bit file id with its kind and
//! facts, read from one handle opened on the entry itself, never on a link's target.

use std::fs::OpenOptions;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo, FileIdInfo,
};

use crate::entry_identity::{EntryIdentity, IdentifiedEntry};
use crate::windows::file_information::read_information;

// The reparse-tag bit that marks a name surrogate: a link or a junction, which names another
// entry. A reparse point without it (a cloud-file placeholder) is the entry itself.
const NAME_SURROGATE_TAG_BIT: u32 = 0x2000_0000;

/// The identity, kind and facts of the entry at `path`, all read from one handle opened on the
/// entry itself, so a link or a junction reads as not a folder, as std's `symlink_metadata` reads
/// it. The file id is the 128-bit one, since the 64-bit index is not unique on `ReFS`. Fails with
/// the system's error from the open or a read, `NotFound` when nothing is there.
pub fn entry_identity(path: &Path) -> io::Result<IdentifiedEntry> {
    // Opened as std opens a path, so the entry is the one std made there; the shares let a rename
    // of the entry go on while the handle is open, and a folder opens only with backup semantics.
    let opened = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let identity: FILE_ID_INFO = read_information(&opened, FileIdInfo)?;
    let attributes: FILE_ATTRIBUTE_TAG_INFO = read_information(&opened, FileAttributeTagInfo)?;
    let metadata = opened.metadata()?;
    let is_link = attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && attributes.ReparseTag & NAME_SURROGATE_TAG_BIT != 0;
    Ok(IdentifiedEntry {
        is_folder: attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 && !is_link,
        identity: EntryIdentity {
            volume: identity.VolumeSerialNumber,
            file: u128::from_le_bytes(identity.FileId.Identifier),
        },
        metadata,
    })
}
