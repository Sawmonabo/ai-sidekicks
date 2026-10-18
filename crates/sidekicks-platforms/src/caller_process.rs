//! A pinned process's parent: what a walk up from the caller of a local connection reads.

use crate::PinnedProcess;

/// How many times a parent read starts over when the parent it pinned was no longer the process's
/// parent by the time it checked; a process re-parented that often during one read is refused.
#[cfg(unix)]
pub(crate) const PARENT_READ_ATTEMPTS: usize = 16;

/// A pinned process's parent, or why a walk up from it ends there.
#[derive(Clone, Debug)]
pub enum ParentProcess {
    /// The parent, pinned, so a later read names that same process.
    Pinned(PinnedProcess),
    /// The process has no parent the system names: the first process, or one whose parent lies
    /// outside this process's view.
    Root,
    /// The process has ended, so it has no parent to read.
    Ended,
}
