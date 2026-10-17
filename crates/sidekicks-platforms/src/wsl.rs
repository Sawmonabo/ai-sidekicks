//! WSL facts every system reads the same way: the WSL 2 distribution a Windows path names, and the
//! path inside it. A distribution's folders are reached from Windows at `\\wsl.localhost\<distro>\`
//! or `\\wsl$\<distro>\`, so the path's form says which distribution holds it and where.
//!
//! Windows shows a Linux name holding a character NTFS forbids with that character moved into the
//! private-use range from U+F000, and WSL moves it back when it turns such a path into a Linux one.
//! `unescape_name` does the same, read from WSL 3.0.3's `src/linux/init/escape.cpp`: the
//! character table at lines 27 to 156 and `UnescapePathInplace` at lines 298 to 340, which
//! `UtilWinPathTranslateInternal` in `src/linux/init/util.cpp` runs on a `\\wsl.localhost\` or
//! `\\wsl$\` path.

use std::path::Path;

use typed_path::{WindowsComponent, WindowsPath, WindowsPrefix};

/// A folder inside a WSL distribution, read from its Windows form: the distribution's name and
/// the folder's Linux path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DistributionPath {
    /// The distribution's name, as the path spells it. A share matches without regard to case, so
    /// the caller matches it against `wsl -l` the same way and keeps the list's spelling.
    pub distro: String,
    /// The folder's absolute Linux path, `/` for the distribution's root.
    pub linux_path: String,
}

/// The distribution and Linux path a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` path
/// names, either slash, the host in any ASCII case, or its verbatim `\\?\UNC\…` form; `None` for
/// any other path. Names that are not UTF-8 read lossily.
pub fn distribution_of(folder_path: &Path) -> Option<DistributionPath> {
    let components = WindowsPath::new(folder_path.as_os_str().as_encoded_bytes()).components();
    let Some(WindowsPrefix::UNC(server, share) | WindowsPrefix::VerbatimUNC(server, share)) =
        components.prefix_kind()
    else {
        return None;
    };
    let is_wsl_server =
        server.eq_ignore_ascii_case(b"wsl$") || server.eq_ignore_ascii_case(b"wsl.localhost");
    if !is_wsl_server || share.is_empty() {
        return None;
    }
    let distro = String::from_utf8_lossy(share).into_owned();
    let mut linux_path = String::new();
    for component in components {
        let name: &[u8] = match component {
            WindowsComponent::Normal(name) => name,
            WindowsComponent::ParentDir => b"..",
            WindowsComponent::Prefix(_) | WindowsComponent::RootDir | WindowsComponent::CurDir => {
                continue;
            }
        };
        linux_path.push('/');
        linux_path.push_str(&String::from_utf8_lossy(&unescape_name(name)));
    }
    if linux_path.is_empty() {
        linux_path.push('/');
    }
    Some(DistributionPath { distro, linux_path })
}

/// Whether WSL moves `byte` into the private-use range on Windows: a control character other than
/// NUL, which a Linux name cannot hold, or one of `"*:<>?\|`.
const fn is_escaped_by_wsl(byte: u8) -> bool {
    matches!(
        byte,
        0x01..=0x1F | b'"' | b'*' | b':' | b'<' | b'>' | b'?' | b'\\' | b'|'
    )
}

/// `name` with each three-byte sequence WSL reads as an escaped character put back, matching as
/// loosely as WSL does: a lead byte of `0xEF` and two bytes with their top bit set, whose low bits
/// spell a character WSL escapes.
fn unescape_name(name: &[u8]) -> Vec<u8> {
    let mut unescaped = Vec::with_capacity(name.len());
    let mut index = 0;
    while index < name.len() {
        if let [0xEF, second, third, ..] = name[index..] {
            let character = ((second & 0x03) << 6) | (third & 0x3F);
            if second & 0x80 != 0 && third & 0x80 != 0 && is_escaped_by_wsl(character) {
                unescaped.push(character);
                index += 3;
                continue;
            }
        }
        unescaped.push(name[index]);
        index += 1;
    }
    unescaped
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::{DistributionPath, distribution_of};

    #[rstest]
    #[case::wsl_localhost(r"\\wsl.localhost\Ubuntu\home\me\x", Some(("Ubuntu", "/home/me/x")))]
    #[case::wsl_dollar(r"\\wsl$\Ubuntu\home\ana", Some(("Ubuntu", "/home/ana")))]
    #[case::forward_slashes("//WSL.localhost/Debian/home", Some(("Debian", "/home")))]
    #[case::dollar_forward_slashes("//wsl$/Ubuntu/home", Some(("Ubuntu", "/home")))]
    #[case::dollar_upper_case(r"\\WSL$\Ubuntu\x", Some(("Ubuntu", "/x")))]
    #[case::escaped_colon("\\\\wsl.localhost\\Ubuntu\\a\u{F03A}b", Some(("Ubuntu", "/a:b")))]
    #[case::private_use_f000("\\\\wsl$\\Ubuntu\\a\u{F000}b", Some(("Ubuntu", "/a\u{F000}b")))]
    #[case::verbatim(r"\\?\UNC\wsl.localhost\Ubuntu\x", Some(("Ubuntu", "/x")))]
    #[case::share_alone(r"\\wsl$\Ubuntu", Some(("Ubuntu", "/")))]
    #[case::share_with_slash(r"\\wsl$\Ubuntu\", Some(("Ubuntu", "/")))]
    #[case::no_share(r"\\wsl$\", None)]
    #[case::another_server(r"\\server\Ubuntu\home", None)]
    #[case::drive(r"C:\wsl$\Ubuntu", None)]
    fn reads_the_distribution_and_linux_path_a_wsl_path_names(
        #[case] path: &str,
        #[case] expected: Option<(&str, &str)>,
    ) {
        let expected = expected.map(|(distro, linux_path)| DistributionPath {
            distro: distro.to_owned(),
            linux_path: linux_path.to_owned(),
        });
        assert_eq!(distribution_of(Path::new(path)), expected);
    }
}
