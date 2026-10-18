//! A file's facts as one read of it tells them, following a link: which entry it is, its size and
//! its two times. Each platform's module reads them from one stat or one handle, which leaves any
//! lock a process holds on the file alone.

use crate::entry_identity::EntryIdentity;

/// A file's facts from one read: which entry it is, its size, and when its contents and its
/// metadata last changed, each time in nanoseconds since the Unix epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileFacts {
    /// Which entry the file is, the link's target when the path names a link.
    pub identity: EntryIdentity,
    /// Its size in bytes.
    pub size: u64,
    /// When its contents last changed.
    pub modified: i128,
    /// When its contents or its metadata last changed: `st_ctime`, or Windows' `ChangeTime`.
    pub changed: i128,
}
