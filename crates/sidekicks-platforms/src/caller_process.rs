//! A pinned process's parent and its responsible process: what the daemon reads of the caller of a
//! local connection to tell its own descendants from everyone else's.

#[cfg(not(target_os = "macos"))]
use std::io;

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

/// The process the system holds responsible for a pinned process: on macOS the one it charges with
/// the privacy prompts of everything that process started, inherited by each process started from
/// it unless the start disclaims it.
#[derive(Clone, Debug)]
pub enum ResponsibleProcess {
    /// This process: the pinned process is one it started, or a descendant of one.
    ThisProcess,
    /// The pinned process is responsible for itself.
    Itself,
    /// Another process, pinned.
    Another(PinnedProcess),
    /// The system keeps no responsible process, as every system but macOS.
    Untracked,
    /// The pinned process has ended, so nothing vouches for it.
    Ended,
}

/// The process the system holds responsible for `process`: always
/// [`ResponsibleProcess::Untracked`], since this system keeps none. Never fails.
#[cfg(not(target_os = "macos"))]
pub fn read_responsible_process(_process: &PinnedProcess) -> io::Result<ResponsibleProcess> {
    Ok(ResponsibleProcess::Untracked)
}
