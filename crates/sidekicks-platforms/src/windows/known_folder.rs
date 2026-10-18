//! The path of a Windows known folder, as the system reports it for this account.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{KF_FLAG_DEFAULT, SHGetKnownFolderPath};
use windows_sys::core::{GUID, PWSTR};

/// The path of the known folder `folder` names (a `FOLDERID_*` constant), read through
/// `SHGetKnownFolderPath`. Fails with the system's error when the folder cannot be read.
pub(crate) fn known_folder(folder: &GUID) -> io::Result<PathBuf> {
    let mut path: PWSTR = std::ptr::null_mut();
    // SAFETY: `folder` is a live GUID, a null token names the calling account, and the call writes
    // one string pointer into the live local `path`.
    let result = unsafe {
        SHGetKnownFolderPath(
            folder,
            KF_FLAG_DEFAULT.cast_unsigned(),
            std::ptr::null_mut(),
            &raw mut path,
        )
    };
    let read = if result < 0 {
        Err(io::Error::from_raw_os_error(result))
    } else {
        // SAFETY: on success `path` holds a NUL-terminated wide string the system allocated.
        Ok(PathBuf::from(unsafe { read_wide_string(path) }))
    };
    // SAFETY: the string is freed on success and on failure alike, as the call's contract asks;
    // a null pointer, which a failure may leave, is no work for `CoTaskMemFree`.
    unsafe { CoTaskMemFree(path.cast_const().cast()) };
    read
}

// The NUL-terminated wide string at `text`, copied without its NUL.
//
// Safety: `text` points at a live NUL-terminated wide string.
unsafe fn read_wide_string(text: PWSTR) -> OsString {
    let mut length = 0;
    // SAFETY: every unit up to and including the NUL lies inside the string.
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: the `length` units before the NUL are the string's, initialized and live.
    OsString::from_wide(unsafe { std::slice::from_raw_parts(text, length) })
}
