//! Files: the crash-safe write and removal, publishing without replacing, a read held to a ceiling,
//! a copy to a new path, a copy that hashes as it goes, an open file's clone to a new path, where a
//! file is really reached, the precision of the times a folder keeps, the recursive copy of a tree,
//! the folder of a fetched program's versions, and a file-system step run off the runtime's
//! threads.

use std::io;

pub mod atomic_write;
pub mod bounded_read;
pub mod clone_open_file;
pub mod clone_or_copy;
pub mod hashing_copy;
pub mod publish_without_replacing;
pub mod real_location;
pub mod removal_after_failure;
pub mod time_precision;
pub mod tree_copy;
pub mod version_folders;

/// Runs `step`, a blocking file-system step, on tokio's blocking threads and answers its result,
/// so it must run inside a tokio runtime. A step that panicked fails as an `io::Error` of kind
/// `Other` carrying the join's failure.
pub async fn run_on_blocking_thread<T: Send + 'static>(
    step: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(step)
        .await
        .map_err(io::Error::other)
        .flatten()
}
