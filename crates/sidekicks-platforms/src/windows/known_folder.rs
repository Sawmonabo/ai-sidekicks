//! The path of a Windows known folder, as the system reports it for this account, and the system
//! folder and the computer-wide program folders read through it.

use std::io;
use std::path::PathBuf;

use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_System, KF_FLAG_DEFAULT,
    SHGetKnownFolderPath,
};
use windows_sys::core::{GUID, PWSTR};

use crate::windows::wide_text::read_wide_string;

// Where each folder read here usually is, used when the system cannot report it.
const SYSTEM_FOLDER_USUAL_PATH: &str = r"C:\Windows\System32";
const PROGRAM_FILES_USUAL_PATH: &str = r"C:\Program Files";
const PROGRAM_DATA_USUAL_PATH: &str = r"C:\ProgramData";

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

/// The system folder (`System32`) as the system reports it, its usual path where that read fails
/// (logged); never fails.
pub(crate) fn system_folder() -> PathBuf {
    read_known_folder(&FOLDERID_System, SYSTEM_FOLDER_USUAL_PATH)
}

/// The computer-wide `Program Files` folder as the system reports it, its usual path where that
/// read fails (logged); never fails.
pub(crate) fn program_files_folder() -> PathBuf {
    read_known_folder(&FOLDERID_ProgramFiles, PROGRAM_FILES_USUAL_PATH)
}

/// The computer-wide `ProgramData` folder as the system reports it, its usual path where that read
/// fails (logged); never fails.
pub(crate) fn program_data_folder() -> PathBuf {
    read_known_folder(&FOLDERID_ProgramData, PROGRAM_DATA_USUAL_PATH)
}

// The known folder `folder`, or `usual_path` when the system cannot report it, which is logged.
fn read_known_folder(folder: &GUID, usual_path: &str) -> PathBuf {
    known_folder(folder).unwrap_or_else(|error| {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            usual_path,
            "a computer-wide folder could not be read; its usual path is used"
        );
        PathBuf::from(usual_path)
    })
}
