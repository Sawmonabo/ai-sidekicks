//! Replaces a file so that a crash at any moment leaves the old contents or the new, never half of
//! either and never neither: the platform's crash-safe replace writes and renames it, and then the
//! folder itself is flushed where the system can flush one, since until then the rename lives only
//! in memory and a power loss can undo it.

use std::io;
use std::path::{Path, PathBuf};

use tokio::task::JoinError;

use crate::cleanup_failures::CleanupFailures;

/// Why a crash-safe write failed.
#[derive(Debug, thiserror::Error)]
pub enum AtomicWriteError {
    /// Making, writing, flushing or renaming the temporary file failed, so the target keeps its
    /// old contents; the temporary file's removal failure, if any, rides beside it.
    #[error("writing {} failed", path.display())]
    Write {
        /// The file written.
        path: PathBuf,
        /// The file system's failure, with any failure to remove the temporary file.
        #[source]
        failure: CleanupFailures<io::Error>,
    },
    /// The target already holds its new contents, but flushing its folder to disk failed, so a
    /// power loss could still bring the old contents back.
    #[error("{} was written, but flushing its folder to disk failed", path.display())]
    FlushFolder {
        /// The file written.
        path: PathBuf,
        /// The folder flush's own failure.
        #[source]
        failure: io::Error,
    },
    /// The blocking task that wrote the file ended before it finished.
    #[error("the write of {} ended before it finished", path.display())]
    Interrupted {
        /// The file written.
        path: PathBuf,
        /// Why the task ended.
        #[source]
        failure: JoinError,
    },
}

/// Replaces `file_path` with `contents`, a new file made with `mode` less the umask (unused on
/// Windows), durably and all at once. `file_path` is absolute and its folder must exist. A failure
/// before the rename removes the temporary file `<name>.<random>.tmp` and leaves the old file in
/// place. `contents` is moved to the write and dropped there, so a buffer that wipes itself on drop
/// leaves no copy behind.
pub(crate) async fn write_file_atomically(
    file_path: &Path,
    contents: impl AsRef<[u8]> + Send + 'static,
    mode: u32,
) -> Result<(), AtomicWriteError> {
    let target = file_path.to_path_buf();
    match tokio::task::spawn_blocking(move || write_and_flush(&target, contents.as_ref(), mode))
        .await
    {
        Ok(written) => written,
        Err(failure) => Err(AtomicWriteError::Interrupted {
            path: file_path.to_path_buf(),
            failure,
        }),
    }
}

/// Replaces `file_path` with `contents` as [`write_file_atomically`] does, unless it already holds
/// exactly them, so a reader that has the file open never meets a rewrite it did not need. A file
/// that cannot be read is replaced. Fails as [`write_file_atomically`] does.
pub(crate) async fn write_file_atomically_if_changed(
    file_path: &Path,
    contents: &'static [u8],
    mode: u32,
) -> Result<(), AtomicWriteError> {
    if tokio::fs::read(file_path)
        .await
        .is_ok_and(|held| held == contents)
    {
        return Ok(());
    }
    write_file_atomically(file_path, contents, mode).await
}

// The whole write, blocking: the file replaced, then its folder flushed.
fn write_and_flush(target: &Path, contents: &[u8], mode: u32) -> Result<(), AtomicWriteError> {
    sidekicks_platforms::replace_file_atomically(target, contents, mode).map_err(|error| {
        AtomicWriteError::Write {
            path: target.to_path_buf(),
            failure: CleanupFailures::new(
                error.failure,
                error.removal_failure.into_iter().collect(),
                "writing the file",
            ),
        }
    })?;
    let folder = target
        .parent()
        .expect("a path ending in a file name has the folder before it");
    sidekicks_platforms::flush_folder(folder).map_err(|failure| AtomicWriteError::FlushFolder {
        path: target.to_path_buf(),
        failure,
    })
}
