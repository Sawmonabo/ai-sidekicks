//! The names of the folders directly inside a folder that may be missing.

use std::ffi::OsString;
use std::io;
use std::path::Path;

use sidekicks_std::missing_entry::MissingEntry;

/// The names of the entries directly in `folder` that are folders themselves, a link to a folder
/// left out; none when `folder` is missing. Fails with the listing's or an entry's read error.
pub(crate) async fn read_folder_names(folder: &Path) -> io::Result<Vec<OsString>> {
    let Some(mut entries) = tokio::fs::read_dir(folder).await.none_if_missing()? else {
        return Ok(Vec::new());
    };
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        // The entry's own type, so a link is never followed.
        if entry.file_type().await?.is_dir() {
            names.push(entry.file_name());
        }
    }
    Ok(names)
}
