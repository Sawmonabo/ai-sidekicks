//! A path made absolute against the daemon's own working folder, or against a base folder, and
//! folded, as Node's `path.resolve` gives it: `.` dropped, `..` taking its parent away, never past
//! the root.

use std::io::{self, ErrorKind};
use std::path;

use typed_path::{Utf8NativePath, Utf8NativePathBuf};

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
/// replaces `base`, and a relative `base` is itself made absolute against the daemon's working
/// folder. Fails as [`resolve_path`] does.
pub(crate) fn resolve_path_against(base: &str, path: &str) -> io::Result<String> {
    resolve_path(Utf8NativePath::new(base).join(path).as_str())
}
