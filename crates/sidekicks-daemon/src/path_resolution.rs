//! A path made absolute against the daemon's own working folder, or against a base folder, and
//! folded, as Node's `path.resolve` gives it: `.` dropped, `..` taking its parent away, never past
//! the root.

use std::io::{self, ErrorKind};
use std::{env, path};

use typed_path::{Utf8NativePath, Utf8NativePathBuf, Utf8WindowsPath, Utf8WindowsPrefix};

/// `path` made absolute against the daemon's working folder, with `.` and `..` folded away and no
/// trailing separator; an empty path is the working folder, as Node reads it. Fails when the
/// working folder cannot be read, or with `InvalidData` when it is not UTF-8, never a lossy path.
pub(crate) fn resolve_path(path: &str) -> io::Result<String> {
    // `std::path::absolute` refuses an empty path, which Node resolves to the working folder.
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

/// `path` resolved against `base` as Node's `path.resolve(base, path)` gives it: an absolute `path`
/// replaces `base`, a Windows drive-relative one on another drive (`D:foo`) resolves against that
/// drive's folder, and a relative `base` is made absolute against the daemon's working folder.
/// Fails as [`resolve_path`] does.
pub(crate) fn resolve_path_against(base: &str, path: &str) -> io::Result<String> {
    let joined = if cfg!(windows) {
        join_windows_path(base, path, read_drive_folder)?
    } else {
        Utf8NativePath::new(base).join(path).into_string()
    };
    resolve_path(&joined)
}

// `path` joined onto `base` as Node's `path.win32.resolve` joins them. A drive-relative `path`
// (`C:foo`) joins onto `base` on the same drive, else onto the folder `read_drive_folder` gives for
// its drive as written (`C:`), and keeps that spelling of the drive.
fn join_windows_path(
    base: &str,
    path: &str,
    read_drive_folder: impl FnOnce(&str) -> io::Result<String>,
) -> io::Result<String> {
    let components = Utf8WindowsPath::new(path).components();
    let Some(Utf8WindowsPrefix::Disk(drive)) = components
        .prefix_kind()
        .filter(|_| !components.has_physical_root())
    else {
        return Ok(Utf8WindowsPath::new(base).join(path).into_string());
    };
    // A disk prefix is an ASCII letter and a colon, two bytes.
    let (device, rest) = path.split_at(2);
    let base_components = Utf8WindowsPath::new(base).components();
    let base_prefix = base_components.prefix_kind();
    let anchor = if let Some(Utf8WindowsPrefix::Disk(base_drive)) = base_prefix
        && base_drive == drive
    {
        format!("{device}{}", &base[2..])
    } else {
        let folder = read_drive_folder(device)?;
        let drive_folder = if folder
            .get(..2)
            .is_some_and(|start| start.eq_ignore_ascii_case(device))
        {
            format!("{device}{}", &folder[2..])
        } else if folder.as_bytes().get(2) == Some(&b'\\') {
            // The folder names another drive, so the drive's root stands in for it.
            format!("{device}\\")
        } else {
            // A folder on no drive (a network share) leaves the path drive-relative.
            return Ok(path.to_owned());
        };
        // A `base` with no drive of its own sits on the path's drive.
        if base_prefix.is_none() {
            Utf8WindowsPath::new(&drive_folder).join(base).into_string()
        } else {
            drive_folder
        }
    };
    Ok(Utf8WindowsPath::new(&anchor).join(rest).into_string())
}

// The folder Windows keeps for `device` (`C:`): its `=C:` variable, else the daemon's working
// folder, as Node reads it.
fn read_drive_folder(device: &str) -> io::Result<String> {
    let folder = match env::var_os(format!("={device}")).filter(|folder| !folder.is_empty()) {
        Some(folder) => folder,
        None => env::current_dir()?.into_os_string(),
    };
    let Ok(folder) = folder.into_string() else {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "the daemon's folder for a drive is not UTF-8",
        ));
    };
    Ok(folder)
}

#[cfg(test)]
mod tests {
    use std::io;

    use rstest::rstest;

    use super::join_windows_path;

    #[rstest]
    #[case::same_drive(r"C:\proj", "C:foo", r"D:\work", r"C:\proj\foo")]
    #[case::same_drive_in_another_case(r"c:\proj", "C:foo", r"D:\work", r"C:\proj\foo")]
    #[case::drive_alone(r"C:\proj", "C:", r"D:\work", r"C:\proj")]
    #[case::another_drive(r"C:\proj", "D:foo", r"d:\Work", r"D:\Work\foo")]
    #[case::another_drive_whose_folder_is_elsewhere(
        r"C:\proj",
        "D:foo",
        r"C:\elsewhere",
        r"D:\foo"
    )]
    #[case::base_on_no_drive(r"\proj", "D:foo", r"D:\work", r"D:\proj\foo")]
    #[case::folder_on_no_drive(r"C:\proj", "D:foo", r"\\server\share\x", "D:foo")]
    #[case::rooted(r"C:\proj", r"\foo", r"D:\work", r"C:\foo")]
    #[case::absolute(r"C:\proj", r"D:\foo", r"C:\work", r"D:\foo")]
    fn a_drive_relative_path_joins_as_node_joins_it(
        #[case] base: &str,
        #[case] path: &str,
        #[case] drive_folder: &str,
        #[case] expected: &str,
    ) {
        let joined = join_windows_path(base, path, |_| Ok::<_, io::Error>(drive_folder.to_owned()));

        assert_eq!(joined.unwrap(), expected);
    }
}
