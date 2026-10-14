//! Where a folder sits on a Windows computer with WSL, read from its path's form. The service runs
//! on Windows itself or inside one WSL distribution. Seen from either side, the other side's disk
//! is reachable but slower: a Windows drive mounted into the distribution, or a distribution's
//! folder reached from Windows over `\\wsl$\<distro>\` or `\\wsl.localhost\<distro>\`. A folder
//! inside another distribution than the service's own is out of reach. Everywhere else every
//! folder is on the service's own disk.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

// `\\wsl$\Ubuntu\home\…` or `\\wsl.localhost\Ubuntu\home\…`, either slash, the host in any ASCII
// case; the capture is the distribution's name.
static WSL_DISTRIBUTION_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\\\\|//)(?i-u:wsl(?:\$|\.localhost))[\\/]([^\\/]+)")
        .expect("the WSL distribution path pattern is a valid regex")
});

/// Where folders sit for the service on this computer; the daemon's start picks it for the system
/// it runs on and hands it to every part that asks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FolderPlace {
    /// A computer with no WSL on either side of the service: every folder is its own.
    OwnDisk,
    /// Windows itself, where a distribution's folder is on the other side's disk.
    Windows,
    /// Inside a WSL distribution, with the Windows drives mounted into it.
    Wsl {
        /// The distribution the service runs in (`WSL_DISTRO_NAME`), compared without case.
        distribution_name: String,
        /// Where the Windows drives are mounted inside the distribution.
        windows_drive_mounts: Vec<PathBuf>,
    },
}

impl FolderPlace {
    /// Whether `folder_path` is on the other side's disk of a Windows computer with WSL, which is
    /// read more slowly.
    pub(crate) fn is_on_other_side_disk(&self, folder_path: &Path) -> bool {
        match self {
            Self::OwnDisk => false,
            Self::Windows => distribution_of(folder_path).is_some(),
            // By whole path components, so `/mnt/cdrom` is not inside `/mnt/c`.
            Self::Wsl {
                windows_drive_mounts,
                ..
            } => windows_drive_mounts
                .iter()
                .any(|mount| folder_path.starts_with(mount)),
        }
    }

    /// Whether `folder_path` lies inside another WSL distribution than the one the service runs
    /// in, which the service cannot reach.
    pub(crate) fn is_in_another_distribution(&self, folder_path: &Path) -> bool {
        match self {
            Self::OwnDisk | Self::Windows => false,
            Self::Wsl {
                distribution_name, ..
            } => distribution_of(folder_path).is_some_and(|distribution| {
                distribution.to_lowercase() != distribution_name.to_lowercase()
            }),
        }
    }
}

// A path that is not UTF-8 is read lossily: its WSL prefix is ASCII, so it still reads as one.
fn distribution_of(folder_path: &Path) -> Option<String> {
    WSL_DISTRIBUTION_PATH
        .captures(&folder_path.to_string_lossy())
        .map(|captures| captures[1].to_owned())
}
