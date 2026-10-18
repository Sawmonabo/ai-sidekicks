//! The data folders the XDG Base Directory specification sets when `XDG_DATA_DIRS` is unset or
//! empty.

/// The default `XDG_DATA_DIRS`, in the order a program reads them, which every system that follows
/// the specification shares.
pub const XDG_DEFAULT_DATA_FOLDERS: &[&str] = &["/usr/local/share", "/usr/share"];
