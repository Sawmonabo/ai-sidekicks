//! A typed path made absolute against the program's working folder, or against a base folder, and
//! folded lexically so it keeps the address as typed: `.` dropped, `..` taking its parent away,
//! never past the root, and no link followed.

use std::io::{self, ErrorKind};
use std::path::absolute;

use typed_path::Utf8NativePathBuf;

use crate::path::rules::PathRules;

/// `path` made absolute against the program's working folder, with `.` and `..` folded away and no
/// trailing separator; an empty path is the working folder. Fails when the working folder cannot
/// be read, or with `InvalidData` when it is not UTF-8, never a lossy path.
pub fn resolve_path(path: &str) -> io::Result<String> {
    // `std::path::absolute` refuses an empty path, which stands for the working folder.
    let absolute_path = absolute(if path.is_empty() { "." } else { path })?;
    // The text was UTF-8, so only the working folder joined before it can fail this.
    let Ok(absolute_path) = absolute_path.into_os_string().into_string() else {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "the working folder is not UTF-8",
        ));
    };
    Ok(Utf8NativePathBuf::from(absolute_path)
        .normalize()
        .into_string())
}

/// `path` joined onto `base` by the running system's rules and folded as [`resolve_path`] folds
/// it: an absolute `path` replaces `base`, and on Windows a drive-relative one (`D:foo`) takes its
/// own drive, then `base` without its drive, and a bare drive (`D:`) is that drive's root. A
/// relative `base` first resolves against the working folder. Fails as [`resolve_path`] does.
pub fn resolve_path_against(base: &str, path: &str) -> io::Result<String> {
    let base = resolve_path(base)?;
    resolve_path(&PathRules::NATIVE.join(&base, path))
}
