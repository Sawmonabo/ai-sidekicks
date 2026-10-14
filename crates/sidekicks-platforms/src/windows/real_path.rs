//! A path with every link resolved on Windows, in the form the desktop's `realpath` answers:
//! without the verbatim prefix std's resolution adds; and the verbatim form a system call takes a
//! long path in.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE;

// The verbatim prefix of a share's path, and of any other path.
const VERBATIM_SHARE_PREFIX: &str = r"\\?\UNC\";
const VERBATIM_PREFIX: &str = r"\\?\";

// The UTF-16 units of `\`, `/`, `:`, `.` and `?`.
const BACKSLASH: u16 = 0x5C;
const SLASH: u16 = 0x2F;
const COLON: u16 = 0x3A;
const DOT: u16 = 0x2E;
const QUESTION_MARK: u16 = 0x3F;

/// The absolute path `path` names with every link resolved, its verbatim prefix stripped:
/// `\\?\UNC\server\share` reads `\\server\share` and `\\?\C:\x` reads `C:\x`, as the desktop's
/// `realpath` answers; std re-adds the prefix itself for a long path, so the stripped form still
/// opens. Fails with the system's error, `NotFound` when the path is missing, and
/// `ERROR_INVALID_HANDLE` when the resolved path carries neither prefix.
pub fn real_path(path: &Path) -> io::Result<PathBuf> {
    // Compared and cut on UTF-16 units, so a name holding an unpaired surrogate survives.
    let resolved: Vec<u16> = std::fs::canonicalize(path)?
        .as_os_str()
        .encode_wide()
        .collect();
    Ok(PathBuf::from(OsString::from_wide(&strip_verbatim_prefix(
        &resolved,
    )?)))
}

// `\\?\UNC\server\share\x` becomes `\\server\share\x` and `\\?\C:\x` becomes `C:\x`; a resolved
// path with neither prefix is a form no path the system resolved should take.
fn strip_verbatim_prefix(resolved: &[u16]) -> io::Result<Vec<u16>> {
    if has_prefix(resolved, VERBATIM_SHARE_PREFIX) {
        // `\\?\UNC\server` keeps the separator before `server` and gains one: `\\server`.
        let after_unc = VERBATIM_SHARE_PREFIX.len() - 1;
        return Ok(std::iter::once(BACKSLASH)
            .chain(resolved[after_unc..].iter().copied())
            .collect());
    }
    if has_prefix(resolved, VERBATIM_PREFIX) {
        return Ok(resolved[VERBATIM_PREFIX.len()..].to_vec());
    }
    Err(io::Error::from_raw_os_error(
        ERROR_INVALID_HANDLE.cast_signed(),
    ))
}

/// `path` made absolute in its verbatim form, `\\?\C:\x` or `\\?\UNC\server\share\x`, as UTF-16
/// units with no NUL, so a system call takes it past 260 units without a long-path manifest. An
/// absolute path is normalized by its text alone (`/` read as `\`, `.` and `..` collapsed), so a
/// name ending in a dot or a space keeps it; a relative one is made absolute by the system first;
/// a device or verbatim path is passed on as written, for the system to read. Fails with
/// `InvalidInput` for a NUL in the path or a share's path naming no share, and with the system's
/// error when a relative path cannot be made absolute.
pub(crate) fn verbatim_path(path: &Path) -> io::Result<Vec<u16>> {
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    if units.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path holds a NUL",
        ));
    }
    if let Some(verbatim) = absolute_verbatim(&units) {
        return Ok(verbatim);
    }
    let absolute: Vec<u16> = std::path::absolute(path)?
        .as_os_str()
        .encode_wide()
        .collect();
    absolute_verbatim(&absolute).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path names no drive folder or share",
        )
    })
}

// The verbatim form of a drive-rooted path (`C:\x`) or a share's path (`\\server\share\x`), its
// names collapsed by their text; a device or verbatim path (`\\.\x`, `\\?\x`, either written with
// `/`) as written, since only an exact `\\?\` skips the system's own normalization and a `/` in it
// is part of a name; `None` for any other form.
fn absolute_verbatim(units: &[u16]) -> Option<Vec<u16>> {
    let (mut verbatim, names) = match units {
        [first, second, DOT | QUESTION_MARK, fourth, ..]
            if is_separator(*first) && is_separator(*second) && is_separator(*fourth) =>
        {
            return Some(units.to_vec());
        }
        [drive, colon, separator, names @ ..]
            if u8::try_from(*drive).is_ok_and(|drive| drive.is_ascii_alphabetic())
                && *colon == COLON
                && is_separator(*separator) =>
        {
            let root: Vec<u16> = VERBATIM_PREFIX
                .encode_utf16()
                .chain([*drive, COLON])
                .collect();
            (root, names)
        }
        [first, second, rest @ ..] if is_separator(*first) && is_separator(*second) => {
            let mut parts = rest.splitn(3, |unit| is_separator(*unit));
            let server = parts.next().filter(|server| !server.is_empty())?;
            let share = parts.next().filter(|share| !share.is_empty())?;
            let root: Vec<u16> = VERBATIM_SHARE_PREFIX
                .encode_utf16()
                .chain(server.iter().copied())
                .chain([BACKSLASH])
                .chain(share.iter().copied())
                .collect();
            (root, parts.next().unwrap_or_default())
        }
        _ => return None,
    };
    let mut kept: Vec<&[u16]> = Vec::new();
    for name in names.split(|unit| is_separator(*unit)) {
        match name {
            [] | [DOT] => {}
            [DOT, DOT] => {
                kept.pop();
            }
            _ => kept.push(name),
        }
    }
    for name in &kept {
        verbatim.push(BACKSLASH);
        verbatim.extend_from_slice(name);
    }
    // A drive's root is `C:\`, never `C:`.
    if kept.is_empty() && !has_prefix(&verbatim, VERBATIM_SHARE_PREFIX) {
        verbatim.push(BACKSLASH);
    }
    Some(verbatim)
}

fn is_separator(unit: u16) -> bool {
    unit == BACKSLASH || unit == SLASH
}

// Whether `units` begins with the ASCII `prefix`, compared exactly, case and all.
fn has_prefix(units: &[u16], prefix: &str) -> bool {
    units
        .get(..prefix.len())
        .is_some_and(|head| head.iter().copied().eq(prefix.encode_utf16()))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    use rstest::rstest;

    use super::{real_path, strip_verbatim_prefix};

    enum PathForm {
        Drive,
        NameEndingInDot,
        PastMaxPath,
    }

    #[rstest]
    #[case::drive(PathForm::Drive)]
    #[case::name_ending_in_dot(PathForm::NameEndingInDot)]
    #[case::past_max_path(PathForm::PastMaxPath)]
    fn a_resolved_path_round_trips_without_its_verbatim_prefix(#[case] form: PathForm) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        // Resolved first, so a short `8.3` name in the scratch path reads as its long name.
        let base = real_path(scratch.path()).expect("the scratch folder resolves");
        let (asked, expected) = match form {
            PathForm::Drive => {
                let folder = base.join("folder");
                fs::create_dir(&folder).expect("the folder is made");
                (folder.clone(), folder)
            }
            PathForm::NameEndingInDot => {
                let plain = base.join("name.");
                // Only the verbatim form keeps the trailing dot when the folder is made.
                let mut verbatim = OsString::from(r"\\?\");
                verbatim.push(plain.as_os_str());
                let verbatim = PathBuf::from(verbatim);
                fs::create_dir(&verbatim).expect("the folder is made");
                (verbatim, plain)
            }
            PathForm::PastMaxPath => {
                let folder = base
                    .join("a".repeat(100))
                    .join("b".repeat(100))
                    .join("c".repeat(100));
                fs::create_dir_all(&folder).expect("the folders are made");
                (folder.clone(), folder)
            }
        };
        assert_eq!(real_path(&asked).expect("the path resolves"), expected);
    }

    // The share form the system's resolution answers for a path on a share, which needs no share
    // on the machine running the test.
    #[test]
    fn a_resolved_share_path_reads_as_its_share() {
        let resolved: Vec<u16> = r"\\?\UNC\server\share\folder".encode_utf16().collect();
        let stripped = strip_verbatim_prefix(&resolved).expect("the prefix strips");
        assert_eq!(
            String::from_utf16(&stripped).expect("UTF-16 text"),
            r"\\server\share\folder"
        );
    }
}
