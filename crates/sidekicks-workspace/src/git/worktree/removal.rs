//! Removing a worktree: the owners of the processes the daemon started in a tree's folder, which
//! every path that moves or deletes the folder ends first.

use std::error::Error;
use std::path::Path;

use futures::future::BoxFuture;

/// An owner of processes the daemon started, which ends those working in a folder about to be
/// moved or deleted: the setup card's commands, the Terminal pane's shells.
pub trait FolderProcessOwner: Send + Sync {
    /// Ends every process this owner started whose working folder is `folder` or inside it,
    /// answering once each has exited. Fails with the owner's failure, naming what was not ended.
    fn end_processes_in_folder<'a>(
        &'a self,
        folder: &'a Path,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;
}
