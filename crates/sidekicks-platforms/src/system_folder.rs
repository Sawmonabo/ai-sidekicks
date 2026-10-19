//! The computer-wide base folders a program's administrator-managed settings sit under, one set
//! per operating system so no system is asked for another's folder and no caller holds a system
//! path, and one value per operating system for a fact that differs between them.

use std::path::PathBuf;

#[cfg(windows)]
use crate::windows::known_folder::{program_data_folder, program_files_folder};

/// A computer-wide folder on macOS a program keeps its administrator-managed settings under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MacosSystemFolder {
    /// `/etc`.
    Etc,
    /// The computer-wide `/Library/Application Support`.
    ApplicationSupport,
}

/// A computer-wide folder on Linux a program keeps its administrator-managed settings under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxSystemFolder {
    /// `/etc`.
    Etc,
}

/// A computer-wide folder on Windows a program keeps its administrator-managed settings under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowsSystemFolder {
    /// The `Program Files` folder.
    ProgramFiles,
    /// The `ProgramData` folder.
    ProgramData,
}

/// A folder below a computer-wide base folder of one operating system: `Base` is that system's
/// set of base folders, so a base another system has cannot be named.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SystemFolder<Base> {
    /// The computer-wide folder the components are under.
    pub base: Base,
    /// The components below `base`, outermost first.
    pub components: &'static [&'static str],
}

/// One folder per operating system below its own computer-wide folders; `None` where a program
/// keeps none on that system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SystemFolders {
    /// On macOS.
    pub macos: Option<SystemFolder<MacosSystemFolder>>,
    /// On Linux.
    pub linux: Option<SystemFolder<LinuxSystemFolder>>,
    /// On Windows.
    pub windows: Option<SystemFolder<WindowsSystemFolder>>,
}

impl SystemFolders {
    /// The running system's folder, its base's path joined with its components, `None` where it
    /// has none; the WSL server, a Linux build, answers Linux's. On Windows the base is read from
    /// the system's known folders, its usual path where that read fails (logged). Never fails.
    pub fn native_path(&self) -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        let (base_path, components) = {
            let folder = self.macos?;
            let base_path = match folder.base {
                MacosSystemFolder::Etc => PathBuf::from("/etc"),
                MacosSystemFolder::ApplicationSupport => {
                    PathBuf::from("/Library/Application Support")
                }
            };
            (base_path, folder.components)
        };
        #[cfg(windows)]
        let (base_path, components) = {
            let folder = self.windows?;
            let base_path = match folder.base {
                WindowsSystemFolder::ProgramFiles => program_files_folder(),
                WindowsSystemFolder::ProgramData => program_data_folder(),
            };
            (base_path, folder.components)
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let (base_path, components) = {
            let folder = self.linux?;
            let base_path = match folder.base {
                LinuxSystemFolder::Etc => PathBuf::from("/etc"),
            };
            (base_path, folder.components)
        };
        Some(
            components
                .iter()
                .fold(base_path, |path, component| path.join(component)),
        )
    }
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
