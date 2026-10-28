//! Removing a worktree: the owners of the processes the daemon started in a tree's folder, which
//! every path that moves or deletes the folder ends first, all together.

use std::error::Error;
use std::fmt;
use std::path::Path;
use std::sync::Arc;

use futures::future::{BoxFuture, join_all};
use sidekicks_std::error_description::describe_error;

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

/// Why the processes in a folder were not all ended: each owner's failure, in the owners' order.
#[derive(Debug)]
pub struct FolderProcessesEndError {
    /// Each failing owner's failure, kept whole.
    pub failures: Vec<Box<dyn Error + Send + Sync>>,
}

impl fmt::Display for FolderProcessesEndError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the processes started in the folder could not all be ended")?;
        for failure in &self.failures {
            write!(formatter, "; {}", describe_error(failure.as_ref()))?;
        }
        Ok(())
    }
}

impl Error for FolderProcessesEndError {}

/// Ends the processes every one of `owners` started in `folder` or inside it, the owners running
/// together and all settling before this answers, so nothing still runs there once it fails.
/// Fails with every owner's failure.
pub(crate) async fn end_processes_in_folder(
    owners: &[Arc<dyn FolderProcessOwner>],
    folder: &Path,
) -> Result<(), FolderProcessesEndError> {
    let failures: Vec<Box<dyn Error + Send + Sync>> = join_all(
        owners
            .iter()
            .map(|owner| owner.end_processes_in_folder(folder)),
    )
    .await
    .into_iter()
    .filter_map(Result::err)
    .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(FolderProcessesEndError { failures })
    }
}
