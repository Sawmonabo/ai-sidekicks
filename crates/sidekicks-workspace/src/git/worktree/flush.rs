//! Flushing what a put-back wrote to disk, files and folders together, one per processor at a time,
//! so it survives a power loss.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_std::processor_bound::map_with_processor_bound;
use sidekicks_std::settle_all::SettleFailures;
use tokio::task::JoinError;

/// Why one flush to disk failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DiskFlushError {
    /// The system's flush of the entry at `path` failed.
    #[error("flushing {} to disk failed", path.display())]
    Flush {
        /// The file or folder flushed.
        path: PathBuf,
        /// The flush's own failure.
        #[source]
        failure: io::Error,
    },
    /// The blocking task that flushed the entry at `path` ended before it finished.
    #[error("the flush of {} ended before it finished", path.display())]
    Interrupted {
        /// The file or folder flushed.
        path: PathBuf,
        /// Why the task ended.
        #[source]
        failure: JoinError,
    },
}

// The flush of a file, or of a folder's entries.
type Flush = fn(&Path) -> io::Result<()>;

/// Flushes each of `files` and `folders` to disk once, however often it is named, at most one per
/// processor at a time. Every flush settles before a failure is returned: the one failure, or every
/// one named "flushing to disk".
pub(crate) async fn flush_to_disk(
    files: impl IntoIterator<Item = PathBuf>,
    folders: impl IntoIterator<Item = PathBuf>,
) -> Result<(), SettleFailures<DiskFlushError>> {
    let mut seen_files = HashSet::new();
    let mut seen_folders = HashSet::new();
    let flushes = files
        .into_iter()
        .filter(|path| seen_files.insert(path.clone()))
        .map(|path| (path, sidekicks_platforms::flush_file as Flush))
        .chain(
            folders
                .into_iter()
                .filter(|path| seen_folders.insert(path.clone()))
                .map(|path| (path, sidekicks_platforms::flush_folder as Flush)),
        )
        .collect::<Vec<_>>();
    map_with_processor_bound(flushes, "flushing to disk", |(path, flush)| async move {
        let flushed_path = path.clone();
        match tokio::task::spawn_blocking(move || flush(&flushed_path)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(failure)) => Err(DiskFlushError::Flush { path, failure }),
            Err(failure) => Err(DiskFlushError::Interrupted { path, failure }),
        }
    })
    .await
    .map(drop)
}
