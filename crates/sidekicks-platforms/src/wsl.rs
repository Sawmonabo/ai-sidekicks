//! WSL facts every system reads the same way: the WSL 2 distribution a Windows path names and the
//! path inside it, and the Windows drive path a `/mnt/<drive>` path names. A distribution's folders
//! are reached from Windows at `\\wsl.localhost\<distro>\` or `\\wsl$\<distro>\`, so the path's
//! form says which distribution holds it and where.
//!
//! Windows shows a Linux name holding a character NTFS forbids with that character moved into the
//! private-use range from U+F000, and WSL moves it back when it turns such a path into a Linux one.
//! `unescape_name` does the same, read from WSL 3.0.5's `src/linux/init/escape.cpp`: the
//! character table at lines 27 to 156 and `UnescapePathInplace` at lines 298 to 340, which
//! `UtilWinPathTranslateInternal` in `src/linux/init/util.cpp` runs on a `\\wsl.localhost\` or
//! `\\wsl$\` path. `DistributionPath::windows_path` writes the inverse, as `EscapePathForNt` at
//! line 196 of the same file does. `drive_path_of` is the other way, read from the same release:
//! `CollapsePath` in `src/linux/init/wslpath.cpp`, the drive folders `config.cpp` mounts, and
//! `EscapePathForNt` in `escape.cpp`.

use std::path::{Path, PathBuf};

use typed_path::{WindowsComponent, WindowsPath, WindowsPrefix};

use crate::path::rules::PathRules;

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

impl DistributionPath {
    /// The folder's Windows form, `\\wsl.localhost\<distro>\` and each name of the Linux path, a
    /// character WSL escapes moved to U+F000 plus that character; `distribution_of` reads it back.
    pub fn windows_path(&self) -> PathBuf {
        let names: Vec<String> = self
            .linux_path
            .split('/')
            .filter(|name| !name.is_empty())
            .map(escape_name)
            .collect();
        PathBuf::from(format!(
            r"\\wsl.localhost\{}\{}",
            self.distro,
            names.join(r"\")
        ))
    }
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

/// The Windows drive path a `/mnt/<drive>/…` path names, as `wslpath -w` reads it under WSL's
/// default drive mounts, or `None` for any other path. The path is folded first (`..` above the
/// root refused), the drive is one lower-case letter, and each character WSL escapes moves to the
/// private-use range: `/mnt/c/a:b` gives `C:\a\u{F03A}b`.
pub fn drive_path_of(path: &str) -> Option<String> {
    // A `//` start is a UNC share to Windows, never a drive mount.
    let rooted = path
        .strip_prefix('/')
        .filter(|rest| !rest.starts_with('/'))?;
    let mut names = Vec::new();
    for name in rooted.split('/') {
        match name {
            "" | "." => {}
            ".." => {
                names.pop()?;
            }
            name => names.push(name),
        }
    }
    let [mount, drive, rest @ ..] = names.as_slice() else {
        return None;
    };
    let [letter @ b'a'..=b'z'] = drive.as_bytes() else {
        return None;
    };
    if *mount != "mnt" {
        return None;
    }
    let separator = PathRules::Windows.separator();
    let mut drive_path = format!("{}:{separator}", char::from(letter.to_ascii_uppercase()));
    for (index, name) in rest.iter().enumerate() {
        if index > 0 {
            drive_path.push(separator);
        }
        drive_path.extend(name.chars().map(escape_for_windows));
    }
    Some(drive_path)
}

// `character` as WSL writes it into a Windows name: moved to U+F000 plus itself where WSL escapes
// it, else as it is.
fn escape_for_windows(character: char) -> char {
    match u8::try_from(character) {
        Ok(byte) if is_escaped_by_wsl(byte) => char::from_u32(0xF000 | u32::from(byte))
            .expect("U+F001 to U+F07F are Unicode scalar values"),
        _ => character,
    }
}

/// Whether WSL moves `byte` into the private-use range on Windows: a control character other than
/// NUL, which a Linux name cannot hold, or one of `"*:<>?\|`.
const fn is_escaped_by_wsl(byte: u8) -> bool {
    matches!(
        byte,
        0x01..=0x1F | b'"' | b'*' | b':' | b'<' | b'>' | b'?' | b'\\' | b'|'
    )
}

/// `name` with each character WSL escapes moved into the private-use range from U+F000.
fn escape_name(name: &str) -> String {
    name.chars().map(escape_for_windows).collect()
}

/// `name` with each character of the escaped range, U+F000 to U+F07F, put back where its low bits
/// spell a character WSL escapes; every other character, a full-width `：` among them, is kept.
fn unescape_name(name: &[u8]) -> Vec<u8> {
    let mut unescaped = Vec::with_capacity(name.len());
    let mut index = 0;
    while index < name.len() {
        if let [0xEF, second, third, ..] = name[index..] {
            let character = ((second & 0x01) << 6) | (third & 0x3F);
            if second & 0xFE == 0x80 && third & 0xC0 == 0x80 && is_escaped_by_wsl(character) {
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
    use std::path::{Path, PathBuf};

    use rstest::rstest;

    use super::{DistributionPath, distribution_of, drive_path_of};

    #[rstest]
    #[case::wsl_localhost(r"\\wsl.localhost\Ubuntu\home\me\x", Some(("Ubuntu", "/home/me/x")))]
    #[case::wsl_dollar(r"\\wsl$\Ubuntu\home\ana", Some(("Ubuntu", "/home/ana")))]
    #[case::forward_slashes("//WSL.localhost/Debian/home", Some(("Debian", "/home")))]
    #[case::dollar_forward_slashes("//wsl$/Ubuntu/home", Some(("Ubuntu", "/home")))]
    #[case::dollar_upper_case(r"\\WSL$\Ubuntu\x", Some(("Ubuntu", "/x")))]
    #[case::escaped_colon("\\\\wsl.localhost\\Ubuntu\\a\u{F03A}b", Some(("Ubuntu", "/a:b")))]
    #[case::private_use_f000("\\\\wsl$\\Ubuntu\\a\u{F000}b", Some(("Ubuntu", "/a\u{F000}b")))]
    // A full-width colon lies outside the escaped range; the loose match read it as `/a\u{1A}b`.
    #[case::full_width_kept("\\\\wsl$\\Ubuntu\\a\u{FF1A}b", Some(("Ubuntu", "/a\u{FF1A}b")))]
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

    // Kills: the escape skipped (`escaped_colon` writes `a:b`), `/` kept as the separator
    // (`nested`), a `\\wsl$\` host (every literal), and an escape the reader does not invert.
    #[rstest]
    #[case::root("Ubuntu", "/", r"\\wsl.localhost\Ubuntu\")]
    #[case::nested("Ubuntu", "/home/me/x", r"\\wsl.localhost\Ubuntu\home\me\x")]
    #[case::escaped_colon("Ubuntu", "/a:b", "\\\\wsl.localhost\\Ubuntu\\a\u{F03A}b")]
    #[case::escaped_backslash("Ubuntu", "/a\\b", "\\\\wsl.localhost\\Ubuntu\\a\u{F05C}b")]
    #[case::private_use_kept("Ubuntu", "/a\u{F000}b", "\\\\wsl.localhost\\Ubuntu\\a\u{F000}b")]
    fn writes_the_windows_path_of_a_folder_inside_a_distribution(
        #[case] distro: &str,
        #[case] linux_path: &str,
        #[case] expected: &str,
    ) {
        let folder = DistributionPath {
            distro: distro.to_owned(),
            linux_path: linux_path.to_owned(),
        };
        let windows_path = folder.windows_path();
        assert_eq!(windows_path, PathBuf::from(expected));
        assert_eq!(distribution_of(&windows_path), Some(folder));
    }

    // Killed by the `/` to `\` join dropped (the first case), the root's `\` dropped (`/mnt/c`),
    // the fold dropped (the two `..` cases that land, and `/mnt/c/..`), `..` let stop at the root
    // (`/../mnt/c/x`), the escape dropped (`a:b`, `a\b`), any one character or either case taken
    // (`/mnt/1/x`, `/mnt/C/x`), any name taken (`cc`, `wsl`), any first folder taken (`/home/c/x`,
    // `/MNT/c/x`), or `//` read as the form.
    #[rstest]
    #[case::drive_path("/mnt/c/repos/app", Some(r"C:\repos\app"))]
    #[case::drive_alone("/mnt/c", Some("C:\\"))]
    #[case::drive_with_slash("/mnt/d/", Some("D:\\"))]
    #[case::folded("/mnt/c/a/./b//c/../d/", Some(r"C:\a\b\d"))]
    #[case::folded_into_another_drive("/mnt/c/../d/x", Some(r"D:\x"))]
    #[case::escaped_colon("/mnt/c/a:b", Some("C:\\a\u{F03A}b"))]
    #[case::escaped_backslash(r"/mnt/c/a\b", Some("C:\\a\u{F05C}b"))]
    #[case::folded_out_of_the_drive("/mnt/c/..", None)]
    #[case::above_the_root("/../mnt/c/x", None)]
    #[case::mount_folder_alone("/mnt/", None)]
    #[case::upper_case_drive("/mnt/C/x", None)]
    #[case::two_letters("/mnt/cc/x", None)]
    #[case::wsl_folder("/mnt/wsl/x", None)]
    #[case::digit("/mnt/1/x", None)]
    #[case::another_folder("/home/c/x", None)]
    #[case::upper_case_mount("/MNT/c/x", None)]
    #[case::unc_start("//mnt/c/x", None)]
    #[case::relative("mnt/c/x", None)]
    #[case::windows_drive(r"C:\repos", None)]
    #[case::windows_share(r"\\server\share\x", None)]
    fn reads_the_drive_path_a_drive_mount_path_names(
        #[case] path: &str,
        #[case] expected: Option<&str>,
    ) {
        assert_eq!(drive_path_of(path).as_deref(), expected);
    }
}
