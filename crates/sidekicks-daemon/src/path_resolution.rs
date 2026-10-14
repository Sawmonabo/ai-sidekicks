//! A typed path made absolute against the daemon's own working folder, or against a base folder,
//! and folded lexically so it keeps the address as typed: `.` dropped, `..` taking its parent away,
//! never past the root, and no link followed.

use std::io::{self, ErrorKind};
use std::path;

use typed_path::{Utf8NativePath, Utf8NativePathBuf, Utf8WindowsPath, Utf8WindowsPrefix};

/// `path` made absolute against the daemon's working folder, with `.` and `..` folded away and no
/// trailing separator; an empty path is the working folder. Fails when the working folder cannot
/// be read, or with `InvalidData` when it is not UTF-8, never a lossy path.
pub(crate) fn resolve_path(path: &str) -> io::Result<String> {
    // `std::path::absolute` refuses an empty path, which stands for the working folder.
    let absolute = path::absolute(if path.is_empty() { "." } else { path })?;
    // The text was UTF-8, so only the working folder joined before it can fail this.
    let Ok(absolute) = absolute.into_os_string().into_string() else {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "the daemon's working folder is not UTF-8",
        ));
    };
    Ok(Utf8NativePathBuf::from(absolute).normalize().into_string())
}

/// `path` joined onto `base` and folded as [`resolve_path`] folds it: an absolute `path` replaces
/// `base`, and a Windows drive-relative one (`D:foo`) resolves as Codex resolves it, reading no
/// environment variable and no working folder. Only a relative `base` reads the daemon's working
/// folder. Fails as [`resolve_path`] does.
pub(crate) fn resolve_path_against(base: &str, path: &str) -> io::Result<String> {
    let joined = if cfg!(windows) {
        join_windows_path(base, path)
    } else {
        Utf8NativePath::new(base).join(path).into_string()
    };
    resolve_path(&joined)
}

// `path` joined onto `base` by Windows rules. A drive-relative `path` (`D:foo`) takes its own
// drive, then `base` without its drive, then the rest of itself, so on the same drive it joins
// onto `base`; a bare drive (`D:`) is that drive's root.
fn join_windows_path(base: &str, path: &str) -> String {
    let components = Utf8WindowsPath::new(path).components();
    let Some(Utf8WindowsPrefix::Disk(_)) = components
        .prefix_kind()
        .filter(|_| !components.has_physical_root())
    else {
        return Utf8WindowsPath::new(base).join(path).into_string();
    };
    // A disk prefix is an ASCII letter and a colon, two bytes.
    let (drive, rest) = path.split_at(2);
    if rest.is_empty() {
        return format!("{drive}\\");
    }
    let base_prefix_len = Utf8WindowsPath::new(base)
        .components()
        .prefix()
        .map_or(0, |prefix| prefix.len());
    let anchor = format!("{drive}{}", &base[base_prefix_len..]);
    Utf8WindowsPath::new(&anchor).join(rest).into_string()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::join_windows_path;

    #[rstest]
    #[case::same_drive(r"C:\proj", "C:foo", r"C:\proj\foo")]
    #[case::same_drive_in_another_case(r"c:\proj", "C:foo", r"C:\proj\foo")]
    #[case::another_drive(r"C:\base\cwd", r"D:path\to\file", r"D:\base\cwd\path\to\file")]
    #[case::bare_drive(r"C:\proj", "D:", r"D:\")]
    #[case::base_on_no_drive(r"\proj", "D:foo", r"D:\proj\foo")]
    #[case::rooted(r"C:\base\cwd", r"\path\to\file", r"C:\path\to\file")]
    #[case::absolute(r"C:\proj", r"D:\foo", r"D:\foo")]
    fn a_drive_relative_path_joins_as_codex_joins_it(
        #[case] base: &str,
        #[case] path: &str,
        #[case] expected: &str,
    ) {
        assert_eq!(join_windows_path(base, path), expected);
    }
}
