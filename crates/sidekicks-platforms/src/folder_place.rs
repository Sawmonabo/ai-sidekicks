//! Where a folder sits on a Windows computer with WSL, read from its path's form. The service runs
//! on Windows itself or inside one WSL distribution. Seen from either side, the other side's disk
//! is reachable but slower: a Windows drive mounted into the distribution, or a distribution's
//! folder reached from Windows over `\\wsl$\<distro>\` or `\\wsl.localhost\<distro>\`. A folder
//! inside another distribution than the service's own is out of reach. Everywhere else every
//! folder is on the service's own disk.

use std::path::{Path, PathBuf};

use typed_path::{WindowsPath, WindowsPrefix};

/// Where folders sit for the service on this computer; each system's module supplies the running
/// system's through `folder_place`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FolderPlace {
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
    pub fn is_on_other_side_disk(&self, folder_path: &Path) -> bool {
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
    pub fn is_in_another_distribution(&self, folder_path: &Path) -> bool {
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

// The distribution a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` path names, either slash,
// the host in any ASCII case. A name that is not UTF-8 reads lossily.
fn distribution_of(folder_path: &Path) -> Option<String> {
    let components = WindowsPath::new(folder_path.as_os_str().as_encoded_bytes()).components();
    let Some(WindowsPrefix::UNC(server, share)) = components.prefix_kind() else {
        return None;
    };
    let is_wsl_server =
        server.eq_ignore_ascii_case(b"wsl$") || server.eq_ignore_ascii_case(b"wsl.localhost");
    (is_wsl_server && !share.is_empty()).then(|| String::from_utf8_lossy(share).into_owned())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::distribution_of;

    #[rstest]
    #[case::wsl_dollar(r"\\wsl$\Ubuntu\home\ana", Some("Ubuntu"))]
    #[case::wsl_localhost_forward_slashes("//WSL.localhost/Debian/home", Some("Debian"))]
    #[case::share_alone(r"\\wsl$\Ubuntu", Some("Ubuntu"))]
    #[case::no_share(r"\\wsl$\", None)]
    #[case::another_server(r"\\server\Ubuntu\home", None)]
    #[case::drive(r"C:\wsl$\Ubuntu", None)]
    fn reads_the_distribution_a_wsl_path_names(
        #[case] path: &str,
        #[case] distribution: Option<&str>,
    ) {
        assert_eq!(distribution_of(Path::new(path)).as_deref(), distribution);
    }
}
