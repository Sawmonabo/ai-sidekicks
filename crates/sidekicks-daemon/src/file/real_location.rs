//! Where a file is reached once every link in its existing folders is resolved, so two spellings
//! of one file, through a link or a relative path, name it once.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::real_path;

/// `path` with its deepest existing folder (the file itself where it exists) resolved through
/// `real_path` and the names below it kept as written. Fails with a resolve's failure other than
/// a missing entry, or where no part of the path exists.
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
                Err(failure) if failure.kind() == io::ErrorKind::NotFound => {
                    let (Some(parent), Some(name)) = (existing.parent(), existing.file_name())
                    else {
                        return Err(failure);
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
