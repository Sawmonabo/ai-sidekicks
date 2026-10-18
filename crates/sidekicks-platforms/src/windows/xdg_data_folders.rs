//! The XDG Base Directory specification's default data folders, which Windows does not follow.

/// The default `XDG_DATA_DIRS`: none, since Windows keeps no XDG data folders.
pub const XDG_DEFAULT_DATA_FOLDERS: &[&str] = &[];
