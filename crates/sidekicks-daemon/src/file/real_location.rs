//! Where a file is reached once every link in its existing folders is resolved, so two spellings
//! of one file, through a link or a relative path, name it once.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::real_path;

use crate::missing_entry::is_missing_entry;

/// `path` with every link resolved through `real_path`, read off the async workers. Fails with the
/// system's error, `NotFound` when the path is missing, and with the blocking task's failure.
pub(crate) async fn resolve_real_path(path: &Path) -> io::Result<PathBuf> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || real_path(&path))
        .await
        .map_err(io::Error::other)?
}

/// `path` with its deepest existing folder (the file itself where it exists) resolved through
/// `real_path` and the names below it kept as written; `path` as given where not even its root
/// exists (a drive unplugged), so its folders still compare. A part that names nothing, a file
/// standing where a folder would be among them, is passed over as missing. Fails with any other
/// resolve's failure.
pub(crate) async fn resolve_real_location(path: &Path) -> io::Result<PathBuf> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut missing_names = Vec::new();
        let mut existing = path.as_path();
        loop {
            match real_path(existing) {
                Ok(resolved) => {
                    return Ok(missing_names
                        .into_iter()
                        .rev()
                        .fold(resolved, |resolved, name| resolved.join(name)));
                }
                Err(failure) if is_missing_entry(&failure) => {
                    let (Some(parent), Some(name)) = (existing.parent(), existing.file_name())
                    else {
                        return Ok(path);
                    };
                    missing_names.push(name.to_os_string());
                    existing = parent;
                }
                Err(failure) => return Err(failure),
            }
        }
    })
    .await
    .map_err(io::Error::other)?
}
