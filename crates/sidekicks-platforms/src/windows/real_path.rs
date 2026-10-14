//! A path with every link resolved on Windows, in the form Node's `realpath` answers: without the
//! verbatim prefix std's resolution adds.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE;

// The verbatim prefix of a share's path, and of any other path.
const VERBATIM_SHARE_PREFIX: &str = r"\\?\UNC\";
const VERBATIM_PREFIX: &str = r"\\?\";

// The UTF-16 unit of `\`.
const BACKSLASH: u16 = 0x5C;

/// The absolute path `path` names with every link resolved, its verbatim prefix stripped as libuv
/// strips it: `\\?\UNC\server\share` reads `\\server\share` and `\\?\C:\x` reads `C:\x`; std
/// re-adds the prefix itself for a long path, so the stripped form still opens. Fails with the
/// system's error, `NotFound` when the path is missing, and `ERROR_INVALID_HANDLE` when the
/// resolved path carries neither prefix.
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
        return Err(io::Error::from_raw_os_error(
            ERROR_INVALID_HANDLE.cast_signed(),
        ));
    };
    Ok(PathBuf::from(OsString::from_wide(&stripped)))
}

// Whether `units` begins with the ASCII `prefix`, compared exactly as libuv does.
fn has_prefix(units: &[u16], prefix: &str) -> bool {
    units
        .get(..prefix.len())
        .is_some_and(|head| head.iter().copied().eq(prefix.encode_utf16()))
}
