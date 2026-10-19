//! A chat's managed workspace: the git-initialized folder `<home>/.ai-sidekicks/workspaces/<session
//! id>` the daemon makes at the chat's create and registers as the chat's managed mount, kept while
//! the chat is archived, and deleted whole when the chat is purged or when its create stopped
//! before the chat was born.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::remove_tree;

use crate::cleanup_failures::CleanupFailures;
use crate::file::real_location::resolve_real_path;
use crate::git::process::{GitCall, GitError, GitRunner, in_folder};
use crate::workspace::repo::mount::service::{RepoMountService, RepoMountServiceError};

const MANAGED_WORKSPACES_FOLDER_NAME: &str = "workspaces";

// `git init` writes a handful of files; a slow disk still finishes well inside this.
const GIT_INIT_TIMEOUT: Duration = Duration::from_secs(10);

/// The folder holding every chat's managed workspace under `home_folder`, one subfolder per
/// session id.
#[expect(dead_code, reason = "a chat's create and its purge")]
pub(crate) fn managed_workspaces_folder(home_folder: &Path) -> PathBuf {
    home_folder
        .join(DAEMON_DATA_FOLDER_NAME)
        .join(MANAGED_WORKSPACES_FOLDER_NAME)
}

/// A chat's managed workspace as its create made it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedWorkspace {
    /// Its managed mount.
    pub(crate) repo_mount_id: RepoMountId,
    /// The workspace folder, with every link resolved: the mount's canonical root.
    pub(crate) path: PathBuf,
}

/// Why making or deleting a chat's managed workspace failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ManagedWorkspaceError {
    /// The folder holding every chat's workspace could not be made or resolved.
    #[error("the managed workspaces folder could not be made")]
    WorkspacesFolder(#[source] io::Error),
    /// The mount row could not be written or deleted, or was refused.
    #[error(transparent)]
    Mount(#[from] RepoMountServiceError),
    /// The chat's workspace folder could not be made.
    #[error("the chat's workspace folder could not be made")]
    Folder(#[source] io::Error),
    /// git could not make the folder a repository.
    #[error("the chat's workspace could not be made a git repository")]
    Init(#[source] GitError),
    /// The chat's workspace folder could not be removed.
    #[error("the chat's workspace folder could not be removed")]
    Removal(#[source] io::Error),
    /// Making the workspace failed after its row was written, and removing what it had made
    /// failed too; both causes are kept.
    #[error(transparent)]
    MadeAndNotRemoved(Box<CleanupFailures<ManagedWorkspaceError>>),
}

/// Makes and deletes chats' managed workspaces, each with its managed mount row.
#[expect(dead_code, reason = "a chat's create and its purge")]
pub(crate) struct ManagedWorkspaceService {
    workspaces_folder: PathBuf,
    place: Option<Place>,
    repo_mounts: Arc<RepoMountService>,
    git: GitRunner,
}

#[expect(dead_code, reason = "a chat's create and its purge")]
impl ManagedWorkspaceService {
    /// The workspaces under `home_folder`, which is in `place` (`None` on macOS and Linux), their
    /// rows written through `repo_mounts` and each made a repository through `git`.
    pub(crate) fn new(
        home_folder: &Path,
        place: Option<Place>,
        repo_mounts: Arc<RepoMountService>,
        git: GitRunner,
    ) -> Self {
        Self {
            workspaces_folder: managed_workspaces_folder(home_folder),
            place,
            repo_mounts,
            git,
        }
    }

    /// Makes the chat's workspace folder, makes it a git repository and registers it as the chat's
    /// managed mount. Refuses `repoMount.alreadyAttached` when the session already has one, before
    /// touching any folder; a failure after the row is written removes the folder and the row, and
    /// fails with [`ManagedWorkspaceError::MadeAndNotRemoved`] when that removal fails too.
    pub(crate) async fn create(
        &self,
        session_id: SessionId,
    ) -> Result<ManagedWorkspace, ManagedWorkspaceError> {
        tokio::fs::create_dir_all(&self.workspaces_folder)
            .await
            .map_err(ManagedWorkspaceError::WorkspacesFolder)?;
        // Every mount root has its links resolved; the session id below it adds no link.
        let workspace_path = resolve_real_path(&self.workspaces_folder)
            .await
            .map_err(ManagedWorkspaceError::WorkspacesFolder)?
            .join(session_id.to_string());
        // The row first: its unique index refuses a second create before the first's folder is
        // touched.
        let repo_mount_id = self
            .repo_mounts
            .attach_managed(session_id, &workspace_path, self.place.as_ref())
            .await?;
        if let Err(creation_failure) = self.make_repository(&workspace_path).await {
            return Err(match self.remove(session_id, &workspace_path).await {
                Ok(()) => creation_failure,
                Err(removal_failure) => {
                    ManagedWorkspaceError::MadeAndNotRemoved(Box::new(CleanupFailures::new(
                        creation_failure,
                        vec![removal_failure],
                        "making a chat's managed workspace",
                    )))
                }
            });
        }
        Ok(ManagedWorkspace {
            repo_mount_id,
            path: workspace_path,
        })
    }

    /// Deletes the chat's workspace folder whole, then its mount row and every row on it. A
    /// session with no managed workspace changes nothing, so a repeat is safe. Fails with the
    /// removal's or the write's failure.
    pub(crate) async fn delete(&self, session_id: SessionId) -> Result<(), ManagedWorkspaceError> {
        self.remove(session_id, &self.workspace_path_of(session_id))
            .await
    }

    /// Deletes the chat's workspace folder whole and leaves its rows, for a caller that deletes
    /// them in its own write. A session with no managed workspace changes nothing. Fails with the
    /// removal's failure.
    pub(crate) async fn delete_folder(
        &self,
        session_id: SessionId,
    ) -> Result<(), ManagedWorkspaceError> {
        remove_folder(self.workspace_path_of(session_id)).await
    }

    // Built from the session id under the daemon's own folder, never read from a row, so a removal
    // reaches nothing but a chat's workspace.
    fn workspace_path_of(&self, session_id: SessionId) -> PathBuf {
        self.workspaces_folder.join(session_id.to_string())
    }

    // `--template=` outranks `GIT_TEMPLATE_DIR` and `init.templateDir`, and git copies no template
    // when it is empty, so the person's template hooks stay out of the chat's repository.
    async fn make_repository(&self, workspace_path: &Path) -> Result<(), ManagedWorkspaceError> {
        tokio::fs::create_dir_all(workspace_path)
            .await
            .map_err(ManagedWorkspaceError::Folder)?;
        let call = GitCall::write(in_folder(
            workspace_path,
            &["init", "--quiet", "--template="],
        ))
        .with_timeout(Some(GIT_INIT_TIMEOUT));
        self.git
            .run(self.place.as_ref(), call)
            .await
            .map_err(ManagedWorkspaceError::Init)?;
        Ok(())
    }

    // The folder before the rows: a removal that fails leaves the row naming what is still on disk.
    async fn remove(
        &self,
        session_id: SessionId,
        workspace_path: &Path,
    ) -> Result<(), ManagedWorkspaceError> {
        remove_folder(workspace_path.to_path_buf()).await?;
        self.repo_mounts.delete_managed(session_id).await?;
        Ok(())
    }
}

async fn remove_folder(path: PathBuf) -> Result<(), ManagedWorkspaceError> {
    tokio::task::spawn_blocking(move || remove_tree(&path))
        .await
        .map_err(io::Error::other)
        .and_then(|removed| removed)
        .map_err(ManagedWorkspaceError::Removal)
}
