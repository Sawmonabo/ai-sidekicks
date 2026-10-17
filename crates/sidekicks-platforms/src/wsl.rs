//! WSL facts every system reads the same way: the WSL 2 distribution a Windows path names. A
//! distribution's folders are reached from Windows at `\\wsl.localhost\<distro>\` or
//! `\\wsl$\<distro>\`, so the path's form says which distribution holds it.

use std::path::Path;

use typed_path::{WindowsPath, WindowsPrefix};

/// The distribution a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` path names, either
/// slash, the host in any ASCII case; `None` for any other path. A name that is not UTF-8 reads
/// lossily.
pub fn distribution_of(folder_path: &Path) -> Option<String> {
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
