//! The folders whose move or deletion is under way, in which no setup step starts: a removal marks
//! its folder, ends the commands running there and keeps the mark until its move lands.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use notify::Watcher;

use super::{
    REMOVAL_END_GRACE, REMOVED_END_REASON, RunningCommand, WorktreeSetupError, WorktreeSetupRunner,
    end_all,
};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::worktree::path_holds::PathHold;
use crate::git::worktree::removal::{FolderProcessHold, FolderProcessOwner};
use crate::trust_envelope::is_contained_within;

impl<W: Watcher + Send + 'static> WorktreeSetupRunner<W> {
    /// Ends every running setup command whose tree is `folder` or inside it: each is asked to
    /// stop and ended after a grace, its step failing as removed; answers once each has exited,
    /// with a hold under which no step starts in the folder and a retry there is refused
    /// `worktree.notFound`. Run before the folder is moved or deleted, the hold kept until that
    /// lands. Fails with `Folder` when `folder` cannot be resolved, and with `CommandsNotEnded`
    /// naming each command that could not be ended.
    async fn end_processes_in_folder(&self, folder: &Path) -> Result<PathHold, WorktreeSetupError> {
        let folder_key = canonical_folder_path(folder)
            .await
            .map_err(WorktreeSetupError::Folder)?;
        // Marked under the lock the commands are read under, so a command either is read here or
        // sees the mark before it starts.
        let (hold, running) = {
            let state = self.shared.lock();
            let hold = state.closing_folders.hold(&folder_key);
            let running: Vec<(PathBuf, Arc<RunningCommand>)> = state
                .cards
                .values()
                .filter_map(|card| {
                    Some((
                        card.made.as_ref()?.tree_path.clone(),
                        Arc::clone(card.running_command.as_ref()?),
                    ))
                })
                .collect();
            (hold, running)
        };
        let mut in_folder = Vec::new();
        for (tree_path, command) in running {
            let tree_key = canonical_folder_path(&tree_path)
                .await
                .map_err(WorktreeSetupError::Folder)?;
            if is_contained_within(&tree_key, &folder_key) {
                in_folder.push(command);
            }
        }
        end_all(&in_folder, REMOVED_END_REASON, REMOVAL_END_GRACE).await?;
        Ok(hold)
    }
}

impl<W: Watcher + Send + 'static> FolderProcessOwner for WorktreeSetupRunner<W> {
    fn end_processes_in_folder<'a>(
        &'a self,
        folder: &'a Path,
    ) -> BoxFuture<'a, Result<FolderProcessHold, Box<dyn Error + Send + Sync>>> {
        // The removal keeps the hold until its move or deletion lands, so no step starts there.
        Box::pin(async move {
            let hold = WorktreeSetupRunner::end_processes_in_folder(self, folder).await?;
            Ok(Box::new(hold) as FolderProcessHold)
        })
    }
}

/// The key a tree's folder is compared by: resolved, or as written when it cannot be resolved, as
/// a tree whose folder is gone cannot.
pub(super) async fn tree_key_of(tree_path: &Path) -> PathBuf {
    match canonical_folder_path(tree_path).await {
        Ok(tree_key) => tree_key,
        Err(error) => {
            tracing::debug!(
                error = &error as &(dyn std::error::Error + 'static),
                "a setup tree's folder could not be resolved, so it is compared as written"
            );
            tree_path.to_path_buf()
        }
    }
}
