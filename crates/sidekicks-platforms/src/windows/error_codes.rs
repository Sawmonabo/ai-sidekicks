//! What a failed file or process call on Windows means, read from its system error code: out of
//! open files, a busy entry, a volume with no hard links, a rename a held file stops, a link that
//! loops, a name the file system cannot hold, a kill that found no process.

use std::io::{self, ErrorKind};

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_CANT_ACCESS_FILE, ERROR_CANT_RESOLVE_FILENAME,
    ERROR_ELEVATION_REQUIRED, ERROR_INVALID_FUNCTION, ERROR_LOCK_VIOLATION, ERROR_NOT_SUPPORTED,
    ERROR_PIPE_BUSY, ERROR_PRIVILEGE_NOT_HELD, ERROR_SHARING_VIOLATION, ERROR_TOO_MANY_OPEN_FILES,
};
use windows_sys::Win32::Networking::WinSock::{WSAEACCES, WSAEMFILE};

/// Whether `error` says the process is out of open files (`ERROR_TOO_MANY_OPEN_FILES`, or
/// `WSAEMFILE` for sockets).
pub fn is_out_of_open_files(error: &io::Error) -> bool {
    let code = win32_code(error);
    code == Some(ERROR_TOO_MANY_OPEN_FILES) || error.raw_os_error() == Some(WSAEMFILE)
}

/// Whether `error` says a path ran through more links than the system follows, a loop among
/// them (`ERROR_CANT_RESOLVE_FILENAME`), which std reads as a kind that is not yet stable.
pub fn is_link_loop(error: &io::Error) -> bool {
    win32_code(error) == Some(ERROR_CANT_RESOLVE_FILENAME)
}

/// Whether `error` says the system refused a name whose characters it cannot map
/// (`ERROR_NO_UNICODE_TRANSLATION`).
#[cfg(any(test, feature = "test-support"))]
pub fn is_illegal_byte_sequence(error: &io::Error) -> bool {
    use windows_sys::Win32::Foundation::ERROR_NO_UNICODE_TRANSLATION;

    win32_code(error) == Some(ERROR_NO_UNICODE_TRANSLATION)
}

/// Whether `error` says the entry is busy: `ERROR_BUSY`, or a sharing, lock or pipe-busy refusal,
/// each of which says another handle holds the entry for now.
pub fn is_resource_busy(error: &io::Error) -> bool {
    let code = win32_code(error);
    error.kind() == ErrorKind::ResourceBusy
        || code == Some(ERROR_SHARING_VIOLATION)
        || code == Some(ERROR_LOCK_VIOLATION)
        || code == Some(ERROR_PIPE_BUSY)
}

/// Whether `error`, from hard-linking a regular file the caller made, says the volume makes no hard
/// links: `ERROR_NOT_SUPPORTED`, or the `ERROR_INVALID_FUNCTION` that `CreateHardLinkW` answers on
/// exFAT and FAT32.
pub fn is_hard_link_unsupported(error: &io::Error) -> bool {
    let code = win32_code(error);
    code == Some(ERROR_NOT_SUPPORTED) || code == Some(ERROR_INVALID_FUNCTION)
}

/// Whether `error` says a rename was refused because a program holds a file under it open, which
/// Windows answers as a denied access, a sharing or lock violation or a privilege refusal.
pub fn is_held_file_error(error: &io::Error) -> bool {
    let code = win32_code(error);
    code == Some(ERROR_ACCESS_DENIED)
        || code == Some(ERROR_SHARING_VIOLATION)
        || code == Some(ERROR_LOCK_VIOLATION)
        || code == Some(ERROR_PIPE_BUSY)
        || code == Some(ERROR_PRIVILEGE_NOT_HELD)
        || code == Some(ERROR_ELEVATION_REQUIRED)
        || code == Some(ERROR_CANT_ACCESS_FILE)
        || error.raw_os_error() == Some(WSAEACCES)
}

/// Whether `error`, from ending a process's job, says nothing was left to end: never, since ending
/// a job whose processes all ended succeeds.
pub fn is_no_such_process(_error: &io::Error) -> bool {
    false
}

/// The error's system code as Windows types it, which std holds as an `i32`; `None` when the
/// error carries no system code.
pub(crate) fn win32_code(error: &io::Error) -> Option<u32> {
    error
        .raw_os_error()
        .and_then(|code| u32::try_from(code).ok())
}
