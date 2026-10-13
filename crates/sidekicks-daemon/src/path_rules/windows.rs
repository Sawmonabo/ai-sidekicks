//! How Windows spells paths: `\` between components, a drive or share as the root, names compared
//! without case as NTFS compares them, and a program's line ended by `\r\n`.

use typed_path::Utf8WindowsPath;

/// The separator between a Windows path's components.
pub(super) const SEPARATOR: char = '\\';

/// Whether `path` is rooted, by Windows' own reading: `\repos`, `C:\repos` and `\\server\share`
/// are, `C:repos` is not.
pub(super) fn is_absolute(path: &str) -> bool {
    Utf8WindowsPath::new(path).has_root()
}

/// Whether `path` names one location with no help from the daemon's current drive: it has a
/// volume (a drive, a share or a device) and a root under it.
pub(super) fn names_complete_location(path: &str) -> bool {
    let path = Utf8WindowsPath::new(path);
    path.components().has_prefix() && path.has_root()
}
