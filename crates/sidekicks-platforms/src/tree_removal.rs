//! A tree's removal awaited from async code, run on tokio's blocking threads so no async worker
//! waits on the file system.

use std::io;
use std::path::Path;

use tokio::task::JoinError;

use crate::remove_tree;

/// Removes `path` and everything under it as [`remove_tree`] does, awaited off the async workers;
/// a path already gone is `Ok`. Fails with the removal's error, or with an error of its own when
/// the removal's task did not run to its end.
pub async fn remove_tree_awaited(path: &Path) -> io::Result<()> {
    let path = path.to_path_buf();
    removal_outcome(tokio::task::spawn_blocking(move || remove_tree(&path)).await)
}

// The removal's own outcome, or the task's failure to finish as an error of its own.
fn removal_outcome(joined: Result<io::Result<()>, JoinError>) -> io::Result<()> {
    joined.map_err(io::Error::other)?
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::{removal_outcome, remove_tree_awaited};

    // A tree is removed whole, and a removal whose task never finished fails rather than reading
    // as removed. Killed by a removal that is not awaited to its end and by the task's failure
    // dropped.
    #[tokio::test]
    async fn the_awaited_removal_removes_a_tree_and_fails_when_its_task_does_not_finish() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let tree = folder.path().join("tree");
        std::fs::create_dir_all(tree.join("inner")).expect("the tree's folders are made");
        std::fs::write(tree.join("inner").join("file"), b"kept").expect("a file is written");

        remove_tree_awaited(&tree)
            .await
            .expect("the tree is removed");

        assert!(!tree.exists(), "the tree is gone");
        let task = tokio::spawn(std::future::pending::<io::Result<()>>());
        task.abort();
        assert!(removal_outcome(task.await).is_err());
    }
}
