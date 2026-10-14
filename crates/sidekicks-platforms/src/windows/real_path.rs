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

// The prefix of a device path, which the system already takes as it is.
const DEVICE_PREFIX: &str = r"\\.\";

// The start of a share's path, `\\server\share`.
const SHARE_PREFIX: &str = r"\\";

// The UTF-16 unit of `\`.
const BACKSLASH: u16 = 0x5C;

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
    let stripped: Vec<u16> = if has_prefix(&resolved, VERBATIM_SHARE_PREFIX) {
        // `\\?\UNC\server` keeps the separator before `server` and gains one: `\\server`.
        let after_unc = VERBATIM_SHARE_PREFIX.len() - 1;
        std::iter::once(BACKSLASH)
            .chain(resolved[after_unc..].iter().copied())
            .collect()
    } else if has_prefix(&resolved, VERBATIM_PREFIX) {
        resolved[VERBATIM_PREFIX.len()..].to_vec()
    } else {
        // Anything else is a form no path the system resolved should take.
        return Err(io::Error::from_raw_os_error(
            ERROR_INVALID_HANDLE.cast_signed(),
        ));
    };
    Ok(PathBuf::from(OsString::from_wide(&stripped)))
}

/// `path` made absolute in its verbatim form, `\\?\C:\x` or `\\?\UNC\server\share\x`, as UTF-16
/// units with no NUL, so a system call takes it past 260 units without a long-path manifest; a
/// verbatim or device path stays as it is. Fails with `InvalidInput` for a NUL in the path, and
/// with the system's error when it cannot be made absolute.
pub(crate) fn verbatim_path(path: &Path) -> io::Result<Vec<u16>> {
    let absolute: Vec<u16> = std::path::absolute(path)?
        .as_os_str()
        .encode_wide()
        .collect();
    if has_prefix(&absolute, VERBATIM_PREFIX) || has_prefix(&absolute, DEVICE_PREFIX) {
        return Ok(absolute);
    }
    if has_prefix(&absolute, SHARE_PREFIX) {
        return Ok(VERBATIM_SHARE_PREFIX
            .encode_utf16()
            .chain(absolute[SHARE_PREFIX.len()..].iter().copied())
            .collect());
    }
    Ok(VERBATIM_PREFIX.encode_utf16().chain(absolute).collect())
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
    use std::path::{Component, Path, PathBuf, Prefix};

    use rstest::rstest;

    use super::real_path;

    enum PathForm {
        Drive,
        Share,
        NameEndingInDot,
        PastMaxPath,
    }

    // `C:\x` as the machine's own administrative share sees it, `\\localhost\C$\x`.
    fn share_path(drive_path: &Path) -> PathBuf {
        let mut components = drive_path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            panic!("a drive path starts with its drive");
        };
        let Prefix::Disk(letter) = prefix.kind() else {
            panic!("a drive path's prefix is a disk");
        };
        let rest: PathBuf = components.skip(1).collect();
        PathBuf::from(format!(r"\\localhost\{}$", char::from(letter))).join(rest)
    }

    #[rstest]
    #[case::drive(PathForm::Drive)]
    #[case::share(PathForm::Share)]
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
            PathForm::Share => {
                let folder = base.join("shared");
                fs::create_dir(&folder).expect("the folder is made");
                let shared = share_path(&folder);
                (shared.clone(), shared)
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
}
