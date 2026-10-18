//! The computer-wide base folders a program's administrator-managed settings sit under, named so
//! no caller holds a system path, with the path each has on the system it belongs to, and one
//! value per operating system for a fact that differs between them.

use std::path::PathBuf;

#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, FOLDERID_ProgramFiles};
#[cfg(windows)]
use windows_sys::core::GUID;

#[cfg(windows)]
use crate::windows::known_folder::known_folder;

// Where the two Windows folders usually are, used when the system cannot report them.
const PROGRAM_FILES_USUAL_PATH: &str = r"C:\Program Files";
const PROGRAM_DATA_USUAL_PATH: &str = r"C:\ProgramData";

/// A computer-wide folder a program keeps its administrator-managed settings under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemFolderBase {
    /// `/etc` on macOS and Linux.
    Etc,
    /// The computer-wide `/Library/Application Support` on macOS.
    ApplicationSupport,
    /// The `Program Files` folder on Windows.
    ProgramFiles,
    /// The `ProgramData` folder on Windows.
    ProgramData,
}

/// The path of `base` as the system it belongs to spells it: the two Windows folders read from the
/// system's known folders, their usual path where that read fails (logged) or on another system,
/// which no descriptor asks for them on. Never fails.
pub fn system_folder_path(base: SystemFolderBase) -> PathBuf {
    match base {
        SystemFolderBase::Etc => PathBuf::from("/etc"),
        SystemFolderBase::ApplicationSupport => PathBuf::from("/Library/Application Support"),
        SystemFolderBase::ProgramFiles => {
            #[cfg(windows)]
            {
                read_known_folder(&FOLDERID_ProgramFiles, PROGRAM_FILES_USUAL_PATH)
            }
            #[cfg(not(windows))]
            {
                PathBuf::from(PROGRAM_FILES_USUAL_PATH)
            }
        }
        SystemFolderBase::ProgramData => {
            #[cfg(windows)]
            {
                read_known_folder(&FOLDERID_ProgramData, PROGRAM_DATA_USUAL_PATH)
            }
            #[cfg(not(windows))]
            {
                PathBuf::from(PROGRAM_DATA_USUAL_PATH)
            }
        }
    }
}

// The known folder `folder`, or `usual_path` when the system cannot report it.
#[cfg(windows)]
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

/// One value per operating system, for a fact that differs between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerSystem<T> {
    /// On macOS.
    pub macos: T,
    /// On Linux.
    pub linux: T,
    /// On Windows.
    pub windows: T,
}

impl<T> PerSystem<T> {
    /// The running system's value; the WSL server is a Linux build, so it answers Linux's.
    pub const fn native(&self) -> &T {
        if cfg!(target_os = "macos") {
            &self.macos
        } else if cfg!(windows) {
            &self.windows
        } else {
            &self.linux
        }
    }
}
