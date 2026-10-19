//! What a failed file or process call on macOS and Linux means, read from its system error code:
//! out of open files, a busy entry, a volume with no hard links, a rename a held file stops, a
//! link that loops, a signal that found no process.

use std::io::{self, ErrorKind};

/// Whether `error` says the process or the system is out of open files (`EMFILE`, `ENFILE`).
pub fn is_out_of_open_files(error: &io::Error) -> bool {
    error
        .raw_os_error()
        .is_some_and(|code| code == libc::EMFILE || code == libc::ENFILE)
}

/// Whether `error` says a path ran through more links than the system follows, a loop among
/// them (`ELOOP`), which std reads as a kind that is not yet stable.
pub fn is_link_loop(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

/// Whether `error` says the entry is busy (`EBUSY`).
pub fn is_resource_busy(error: &io::Error) -> bool {
    error.kind() == ErrorKind::ResourceBusy
}

/// Whether `error`, from hard-linking a regular file the caller made, says the volume makes no hard
/// links: macOS's exFAT answers `ENOTSUP`, which std leaves unmapped, and Linux's FAT and exFAT
/// answer `EPERM`, which for a file its owner links means the file system has no links at all.
pub fn is_hard_link_unsupported(error: &io::Error) -> bool {
    // Linux gives both names one value; each is compared, never matched, so neither goes unread.
    error.raw_os_error().is_some_and(|code| {
        code == libc::ENOTSUP
            || code == libc::EOPNOTSUPP
            || (cfg!(target_os = "linux") && code == libc::EPERM)
    })
}

/// Whether `error` says a rename was refused because a program holds a file under it open; a
/// permission refusal is itself on macOS and Linux, so only a busy entry counts.
pub fn is_held_file_error(error: &io::Error) -> bool {
    is_resource_busy(error)
}

/// Whether `error`, from a signal to a process or a group, says nothing was left to signal
/// (`ESRCH`).
pub fn is_no_such_process(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH)
}
