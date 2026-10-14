//! A path made absolute against the daemon's own working folder and folded, as Node's
//! `path.resolve` gives it: `.` dropped, `..` taking its parent away, never past the root.

use std::io::{self, ErrorKind};
use std::path::{self, PathBuf};

use typed_path::Utf8NativePathBuf;

/// `path` made absolute against the daemon's working folder, with `.` and `..` folded away and no
/// trailing separator; an empty path is the working folder, as Node reads it. Fails when the
/// working folder cannot be read, or with `InvalidData` when it is not UTF-8, never a lossy path.
pub(crate) fn resolve_path(path: &str) -> io::Result<String> {
    // `std::path::absolute` refuses an empty path, which Node resolves to the working folder.
    let absolute = path::absolute(if path.is_empty() { "." } else { path })?;
    // The text was UTF-8, so only the working folder joined before it can fail this.
    let absolute = absolute.into_os_string().into_string().map_err(|joined| {
        io::Error::new(
            ErrorKind::InvalidData,
            format!(
                "{} is not UTF-8: the daemon's working folder is not",
                PathBuf::from(joined).display()
            ),
        )
    })?;
    Ok(Utf8NativePathBuf::from(absolute).normalize().into_string())
}
