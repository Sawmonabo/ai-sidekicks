//! Files: the crash-safe write and removal, publishing without replacing, a read held to a ceiling,
//! a copy to a new path, a copy that hashes as it goes, an open file's clone to a new path, where a
//! file is really reached, the precision of the times a folder keeps, the recursive copy of a tree,
//! and a file-system step, a tree's removal among them, run off the runtime's threads.

use std::io;
use std::path::Path;

use crate::scheduler::budget::run_blocking;

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

/// Runs `step`, a blocking file-system step, on tokio's blocking threads and answers its result,
/// so it must run inside a tokio runtime; the step is measured on the meter of the metered run
/// whose task calls, if any. A step that panicked fails as an `io::Error` of kind `Other` carrying
/// the join's failure.
pub async fn run_on_blocking_thread<T: Send + 'static>(
    step: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    run_blocking(step).await.map_err(io::Error::other).flatten()
}

/// Removes `path` and everything under it as `sidekicks_platforms::remove_tree` does, as a step
/// [`run_on_blocking_thread`] runs; a path already gone is `Ok`. Fails with the removal's error, or
/// with an error of its own when the removal's task did not run to its end.
pub async fn remove_tree_awaited(path: &Path) -> io::Result<()> {
    let path = path.to_path_buf();
    run_on_blocking_thread(move || sidekicks_platforms::remove_tree(&path)).await
}

#[cfg(test)]
mod tests {
    use super::remove_tree_awaited;

    // A tree is removed whole, and one already gone reads as removed. Killed by a removal that is
    // not awaited to its end and by a missing tree read as a failure.
    #[tokio::test]
    async fn the_awaited_removal_removes_a_tree_whole() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let tree = folder.path().join("tree");
        std::fs::create_dir_all(tree.join("inner")).expect("the tree's folders are made");
        std::fs::write(tree.join("inner").join("file"), b"kept").expect("a file is written");

        remove_tree_awaited(&tree)
            .await
            .expect("the tree is removed");
        assert!(!tree.exists(), "the tree is gone");
        remove_tree_awaited(&tree)
            .await
            .expect("a tree already gone reads as removed");
    }
}
