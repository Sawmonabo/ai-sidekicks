//! A chat's managed workspace: the git-initialized folder `<home>/.ai-sidekicks/workspaces/<session
//! id>` the daemon makes at the chat's create and registers as the chat's managed mount, kept while
//! the chat is archived, and deleted whole when the chat is purged or when its create stopped
//! before the chat was born. It holds the one watch over every chat's workspace and starts it
//! again whenever a create finds the folder holding them gone, since the watch ends with it.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::remove_tree;
use tokio::sync::mpsc;
use tokio::sync::oneshot::{self, error::TryRecvError};

use crate::cleanup_failures::CleanupFailures;
use crate::file::real_location::resolve_real_path;
use crate::git::process::{GitCall, GitError, GitRunner, in_folder};
use crate::workspace::managed::write_watcher::{
    ManagedWorkspaceWatchError, ManagedWorkspaceWrite, ManagedWorkspaceWriteWatcher,
};
use crate::workspace::repo::mount::service::{RepoMountService, RepoMountServiceError};

const MANAGED_WORKSPACES_FOLDER_NAME: &str = "workspaces";

// `git init` writes a handful of files; a slow disk still finishes well inside this.
const GIT_INIT_TIMEOUT: Duration = Duration::from_secs(10);

/// The folder holding every chat's managed workspace under `home_folder`, one subfolder per
/// session id.
#[cfg_attr(not(test), expect(dead_code, reason = "a chat's create and its purge"))]
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

/// Makes and deletes chats' managed workspaces, each with its managed mount row, and reports the
/// writes chats make in them.
#[cfg_attr(not(test), expect(dead_code, reason = "a chat's create and its purge"))]
pub(crate) struct ManagedWorkspaceService {
    workspaces_folder: PathBuf,
    place: Option<Place>,
    repo_mounts: Arc<RepoMountService>,
    git: GitRunner,
    writes: mpsc::Sender<ManagedWorkspaceWrite>,
    write_watch: Mutex<WriteWatch>,
}

// The watch over every chat's workspace, and the channel it answers on when it ends.
struct WriteWatch {
    _watcher: ManagedWorkspaceWriteWatcher,
    failure: oneshot::Receiver<ManagedWorkspaceWatchError>,
}

impl WriteWatch {
    fn start(workspaces_folder: PathBuf, writes: mpsc::Sender<ManagedWorkspaceWrite>) -> Self {
        let (watcher, failure) = ManagedWorkspaceWriteWatcher::start(workspaces_folder, writes);
        Self {
            _watcher: watcher,
            failure,
        }
    }

    // Whether the watch has ended; its failure is logged where it ended.
    fn has_ended(&mut self) -> bool {
        match self.failure.try_recv() {
            Err(TryRecvError::Empty) => false,
            Ok(_) | Err(TryRecvError::Closed) => true,
        }
    }
}

#[cfg_attr(not(test), expect(dead_code, reason = "a chat's create and its purge"))]
impl ManagedWorkspaceService {
    /// The workspaces under `home_folder`, which is in `place` (`None` on macOS and Linux), their
    /// rows written through `repo_mounts`, each made a repository through `git`, and every write a
    /// chat makes in one sent on `writes`; starts the watch that reports them.
    pub(crate) fn new(
        home_folder: &Path,
        place: Option<Place>,
        repo_mounts: Arc<RepoMountService>,
        git: GitRunner,
        writes: mpsc::Sender<ManagedWorkspaceWrite>,
    ) -> Self {
        let workspaces_folder = managed_workspaces_folder(home_folder);
        let write_watch = WriteWatch::start(workspaces_folder.clone(), writes.clone());
        Self {
            workspaces_folder,
            place,
            repo_mounts,
            git,
            writes,
            write_watch: Mutex::new(write_watch),
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
        let had_folder = tokio::fs::try_exists(&self.workspaces_folder)
            .await
            .map_err(ManagedWorkspaceError::WorkspacesFolder)?;
        tokio::fs::create_dir_all(&self.workspaces_folder)
            .await
            .map_err(ManagedWorkspaceError::WorkspacesFolder)?;
        self.keep_write_watch(had_folder);
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

    // Starts the watch again when the folder it watched was gone or it has ended, since a watch
    // whose folder is removed ends and a folder made again is not watched by it.
    fn keep_write_watch(&self, had_folder: bool) {
        let mut write_watch = self
            .write_watch
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if had_folder && !write_watch.has_ended() {
            return;
        }
        *write_watch = WriteWatch::start(self.workspaces_folder.clone(), self.writes.clone());
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use sidekicks_contracts::session::id::SessionId;
    use tokio::sync::mpsc;
    use tokio::time::{Instant, timeout};

    use super::{ManagedWorkspaceService, managed_workspaces_folder};
    use crate::database::writer::test_file::TestDatabase;
    use crate::git::process::test_git_runner;
    use crate::workspace::managed::write_watcher::ManagedWorkspaceWrite;
    use crate::workspace::repo::mount::service::RepoMountService;
    use crate::workspace::repo::root_resolver::RepoRootResolver;

    const WAIT: Duration = Duration::from_secs(20);

    // Makes the session's workspace and writes in it until the watch reports one, since the watch starts on
    // its own task and a write before it is armed is not seen.
    async fn wait_for_a_reported_write(
        service: &ManagedWorkspaceService,
        session_id: SessionId,
        writes: &mut mpsc::Receiver<ManagedWorkspaceWrite>,
    ) {
        let workspace = service
            .create(session_id)
            .await
            .expect("the workspace is made");
        let deadline = Instant::now() + WAIT;
        for attempt in 0_u32.. {
            assert!(Instant::now() < deadline, "no write was reported in time");
            fs::write(
                workspace.path.join(format!("note-{attempt}.txt")),
                "written",
            )
            .expect("a file is written");
            // A write still told from an earlier session's workspace is passed over.
            if let Ok(Some(write)) = timeout(Duration::from_millis(500), writes.recv()).await
                && write.session_id == session_id
            {
                return;
            }
        }
    }

    // Catches a watch left dead once its folder is removed: a chat made after the removal must
    // still have its writes reported.
    #[tokio::test]
    async fn a_create_after_the_workspaces_folder_is_removed_watches_it_again() {
        let home = tempfile::tempdir().expect("a scratch home");
        let database = TestDatabase::new();
        let repo_mounts =
            RepoMountService::for_test(&database, RepoRootResolver::new(test_git_runner())).await;
        let (writes_sender, mut writes) = mpsc::channel(64);
        let service = ManagedWorkspaceService::new(
            home.path(),
            None,
            repo_mounts,
            test_git_runner(),
            writes_sender,
        );

        let first = SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70").expect("a session id");
        wait_for_a_reported_write(&service, first, &mut writes).await;
        fs::remove_dir_all(managed_workspaces_folder(home.path()))
            .expect("the workspaces folder is removed");
        let second = SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71").expect("a session id");
        wait_for_a_reported_write(&service, second, &mut writes).await;
    }
}
