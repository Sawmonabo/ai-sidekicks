//! A folder that holds one folder per version of a program the daemon fetches for itself, beside
//! the temporary files a fetch writes there under a name that starts with a dot, so a later fetch
//! removes what a stopped one left.

use std::io;
use std::path::Path;

use crate::missing_entry::MissingEntry as _;
use crate::random_hex::random_hex;

// The random bytes in a temporary file's name.
const TEMPORARY_NAME_BYTES: usize = 8;

/// A temporary file's name: a dot, so a later fetch knows it as one, eight random bytes in hex,
/// then `extension`. Fails when the system gives no random bytes.
pub fn temporary_file_name(extension: &str) -> Result<String, getrandom::Error> {
    let hex = random_hex(TEMPORARY_NAME_BYTES)?;
    Ok(format!(".{hex}{extension}"))
}

/// Removes every file in `folder` whose name starts with a dot, the temporary files a stopped
/// fetch left; a missing folder holds none, and a file already gone counts as removed. Fails when
/// the folder cannot be read or a file cannot be removed.
pub async fn remove_temporary_files(folder: &Path) -> io::Result<()> {
    let Some(mut entries) = tokio::fs::read_dir(folder).await.none_if_missing()? else {
        return Ok(());
    };
    while let Some(entry) = entries.next_entry().await? {
        let is_file = entry.file_type().await?.is_file();
        if is_file && entry.file_name().as_encoded_bytes().starts_with(b".") {
            tokio::fs::remove_file(entry.path())
                .await
                .none_if_missing()?;
        }
    }
    Ok(())
}

/// Removes every folder in `folder` whose name is not in `kept`, with all it holds. Fails when
/// `folder` is missing or cannot be read, or a folder cannot be removed.
pub async fn remove_other_versions(folder: &Path, kept: &[&str]) -> io::Result<()> {
    let mut entries = tokio::fs::read_dir(folder).await?;
    while let Some(entry) = entries.next_entry().await? {
        let is_folder = entry.file_type().await?.is_dir();
        let name = entry.file_name();
        if is_folder && !kept.iter().any(|version| name == *version) {
            tokio::fs::remove_dir_all(entry.path()).await?;
        }
    }
    Ok(())
}
