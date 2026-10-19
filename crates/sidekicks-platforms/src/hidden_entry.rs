//! Whether a folder listing leaves an entry out as hidden: a name starting with a dot on every
//! system, and the system's own hidden mark, which its file browser honors, where it keeps one.

use std::ffi::OsStr;
use std::fs::Metadata;

/// Whether the entry `name`, whose facts are `metadata`, is hidden: its name starts with a dot, or
/// the system marks it hidden (macOS's `hidden` flag, which Finder honors, so `~/Library` is
/// hidden; Windows' hidden attribute). Linux keeps no mark beyond the dot.
pub fn is_hidden_entry(name: &OsStr, metadata: &Metadata) -> bool {
    name.as_encoded_bytes().first() == Some(&b'.') || has_hidden_mark(metadata)
}

#[cfg(target_os = "macos")]
fn has_hidden_mark(metadata: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;

    metadata.st_flags() & libc::UF_HIDDEN != 0
}

#[cfg(target_os = "linux")]
fn has_hidden_mark(_metadata: &Metadata) -> bool {
    false
}

#[cfg(windows)]
fn has_hidden_mark(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;

    metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}
