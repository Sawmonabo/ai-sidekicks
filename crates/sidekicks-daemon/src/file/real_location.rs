//! Where a file is reached once every link in its existing folders is resolved, so two spellings
//! of one file, through a link or a relative path, name it once.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::real_path;

use crate::file::bounded_read::read_within_ceiling;
use crate::missing_entry::is_missing_entry;

/// `path` with every link resolved through `real_path`, read within the bounded read's ceiling.
/// Fails with the system's error, `NotFound` when the path is missing, and `TimedOut` when the file
/// system gives no answer in time.
pub(crate) async fn resolve_real_path(path: &Path) -> io::Result<PathBuf> {
    read_within_ceiling(path, real_path).await
}

/// `path` with its deepest existing folder (the file itself where it exists) resolved through
/// `real_path` and the names below it kept as written; `path` as given where not even its root
/// exists (a drive unplugged), so its folders still compare. A part that names nothing, a file
/// standing where a folder would be among them, is passed over as missing. The walk is read within
/// the bounded read's ceiling. Fails with any other resolve's failure, and `TimedOut` when the file
/// system gives no answer in time.
pub(crate) async fn resolve_real_location(path: &Path) -> io::Result<PathBuf> {
    read_within_ceiling(path, |path| {
        let mut missing_names = Vec::new();
        let mut existing = path;
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
                        return Ok(path.to_path_buf());
                    };
                    missing_names.push(name.to_os_string());
                    existing = parent;
                }
                Err(failure) => return Err(failure),
            }
        }
    })
    .await
}
