//! A chat's managed workspace: the git-initialized folder `<home>/.ai-sidekicks/workspaces/<session
//! id>` the daemon makes at the chat's create and registers as the chat's managed mount, kept while
//! the chat is archived, and deleted whole when the chat is purged or when its create stopped
//! before the chat was born. It holds the one watch over every chat's workspace and starts it
//! again whenever a create finds the folder holding them gone, since the watch ends with it, or
//! the watch ended; the watch started again walks for every write made since the earlier one
//! last told them all, or for every entry in a folder made again. Each change the watch names
//! recounts the files in that chat's folder onto its managed mount's row, which the sessions list
//! reads as the chat's document count.

use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::remove_tree;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::bounded_read::run_on_own_thread;
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::events::session::pending::PendingSessions;
use tokio::sync::mpsc;
use tokio::sync::oneshot::{self, error::TryRecvError};
use tokio::task::JoinError;
use tokio_util::task::AbortOnDropHandle;

use crate::git::process::{GitCall, GitError, GitRunner, in_folder};
use crate::managed::write_watcher::{ManagedWorkspaceWrite, ManagedWorkspaceWriteWatcher};
use crate::repo::mount::service::{RepoMountService, RepoMountServiceError};

const MANAGED_WORKSPACES_FOLDER_NAME: &str = "workspaces";

// A workspace's own repository folder, the daemon's and not one of the chat's documents.
const GIT_METADATA_FOLDER_NAME: &str = ".git";

// `git init` writes a handful of files; a slow disk still finishes well inside this.
const GIT_INIT_TIMEOUT: Duration = Duration::from_secs(10);

/// The folder holding every chat's managed workspace under `home_folder`, one subfolder per
/// session id.
pub fn managed_workspaces_folder(home_folder: &Path) -> PathBuf {
    home_folder
        .join(DAEMON_DATA_FOLDER_NAME)
        .join(MANAGED_WORKSPACES_FOLDER_NAME)
}

/// The sessions list, told of a chat whose document count moved, which no event carries.
pub trait SessionListRefresh: Send + Sync {
    /// Names a session whose listed facts changed, once the write that changed them committed.
    fn refresh_session(&self, session_id: SessionId);
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
pub enum ManagedWorkspaceError {
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
pub struct ManagedWorkspaceService {
    workspaces_folder: PathBuf,
    place: Option<Place>,
    repo_mounts: Arc<RepoMountService>,
    git: GitRunner,
    changed_folders: Arc<PendingSessions>,
    // `None` once stopped, so no watch starts again.
    write_watch: Mutex<Option<WriteWatch>>,
    document_counting: Mutex<Option<AbortOnDropHandle<()>>>,
}

// The watch over every chat's workspace, the channel it answers on when it ends, and the sender
// a watch started again reports on.
struct WriteWatch {
    watcher: ManagedWorkspaceWriteWatcher,
    failure: oneshot::Receiver<SystemTime>,
    writes: mpsc::Sender<ManagedWorkspaceWrite>,
}

impl WriteWatch {
    // Starts the watch, which walks for every write changed at or after `missed_since` once ready.
    fn start(
        workspaces_folder: PathBuf,
        writes: mpsc::Sender<ManagedWorkspaceWrite>,
        changed_folders: Arc<PendingSessions>,
        missed_since: SystemTime,
    ) -> Self {
        let (watcher, failure) = ManagedWorkspaceWriteWatcher::start(
            workspaces_folder,
            writes.clone(),
            changed_folders,
            missed_since,
        );
        Self {
            watcher,
            failure,
            writes,
        }
    }

    // The instant since which writes may be unreported once the watch has ended, its failure
    // logged where it ended; `None` while it runs. A watch that ended without telling, its reader
    // of writes gone or its task stopped, may have missed anything.
    fn writes_missed_since(&mut self) -> Option<SystemTime> {
        match self.failure.try_recv() {
            Ok(missed_since) => Some(missed_since),
            Err(TryRecvError::Closed) => Some(UNIX_EPOCH),
            Err(TryRecvError::Empty) => self.watcher.has_finished().then_some(UNIX_EPOCH),
        }
    }
}

#[expect(dead_code, reason = "a chat's create and its purge")]
impl ManagedWorkspaceService {
    /// The workspaces under `home_folder`, which is in `place` (`None` on macOS and Linux), their
    /// rows written through `repo_mounts`, each made a repository through `git`, and every write a
    /// chat makes in one sent on `writes`; starts the watch that reports them, and the task that
    /// recounts a chat's files on each change and names the chat to `list_feed` when its count
    /// moved. Dropping the service ends both.
    pub fn new(
        home_folder: &Path,
        place: Option<Place>,
        repo_mounts: Arc<RepoMountService>,
        git: GitRunner,
        writes: mpsc::Sender<ManagedWorkspaceWrite>,
        list_feed: Arc<dyn SessionListRefresh>,
    ) -> Self {
        let workspaces_folder = managed_workspaces_folder(home_folder);
        let changed_folders = Arc::new(PendingSessions::default());
        // A create right after this may write before the watch is ready, so it catches up from now.
        let write_watch = WriteWatch::start(
            workspaces_folder.clone(),
            writes,
            Arc::clone(&changed_folders),
            SystemTime::now(),
        );
        let document_counting = AbortOnDropHandle::new(tokio::spawn(count_documents(
            workspaces_folder.clone(),
            Arc::clone(&changed_folders),
            Arc::clone(&repo_mounts),
            list_feed,
        )));
        Self {
            workspaces_folder,
            place,
            repo_mounts,
            git,
            changed_folders,
            write_watch: Mutex::new(Some(write_watch)),
            document_counting: Mutex::new(Some(document_counting)),
        }
    }

    /// Ends the watch of the chats' writes, which drops the last sender of `writes` once its task
    /// is gone, so their reader ends after the writes already sent, and ends the recount of the
    /// chats' files, waiting for it. A write the watch had not yet sent is not kept as a version,
    /// which the stop logs once. A create after it starts no watch. Fails only when the recount's
    /// task panicked.
    pub async fn stop(&self) -> Result<(), JoinError> {
        let write_watch = lock(&self.write_watch).take();
        if let Some(write_watch) = write_watch {
            drop(write_watch);
            tracing::info!(
                stopped_at = %jiff::Timestamp::now(),
                "the chats' write watch stopped; writes it had not yet reported are not kept as \
                 versions"
            );
        }
        let counting = lock(&self.document_counting).take();
        let Some(counting) = counting else {
            return Ok(());
        };
        counting.abort();
        match counting.await {
            Err(error) if error.is_panic() => Err(error),
            Ok(()) | Err(_) => Ok(()),
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
    pub async fn delete_folder(&self, session_id: SessionId) -> Result<(), ManagedWorkspaceError> {
        remove_folder(self.workspace_path_of(session_id)).await
    }

    // Starts the watch again when the folder it watched was gone or it has ended, since a watch
    // whose folder is removed ends and a folder made again is not watched by it. The new watch
    // walks for every entry of a folder made again, all of it new, and otherwise for every write
    // since the ended watch last told them all.
    fn keep_write_watch(&self, had_folder: bool) {
        let mut write_watch = lock(&self.write_watch);
        let Some(write_watch) = write_watch.as_mut() else {
            return;
        };
        let missed_since = if had_folder {
            match write_watch.writes_missed_since() {
                Some(missed_since) => missed_since,
                None => return,
            }
        } else {
            UNIX_EPOCH
        };
        *write_watch = WriteWatch::start(
            self.workspaces_folder.clone(),
            write_watch.writes.clone(),
            Arc::clone(&self.changed_folders),
            missed_since,
        );
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

// Recounts the files in every chat's folder once at the start, since a change made while the
// daemon was down reaches no watch, then in each folder the watch names, and stores the count on
// the chat's managed mount, naming the chat to the sessions list when it moved. A count that
// cannot be read or stored is logged and left as it was until the folder's next change.
async fn count_documents(
    workspaces_folder: PathBuf,
    changed_folders: Arc<PendingSessions>,
    repo_mounts: Arc<RepoMountService>,
    list_feed: Arc<dyn SessionListRefresh>,
) {
    let listed_folder = workspaces_folder.clone();
    match run_on_own_thread("chat folders listing", move || {
        list_chat_folders(&listed_folder)
    })
    .await
    .and_then(|listed| listed)
    {
        Ok(session_ids) => {
            for session_id in session_ids {
                changed_folders.add(session_id);
            }
        }
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the chats' folders could not be listed; each count waits for its folder's next change"
        ),
    }
    loop {
        for session_id in changed_folders.take().await {
            let folder = workspaces_folder.join(session_id.to_string());
            let count = match run_on_own_thread("chat document count", move || count_files(&folder))
                .await
                .and_then(|counted| counted)
            {
                Ok(Some(count)) => count,
                // A folder deleted with its chat counts nothing; its row goes with it.
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a chat's files could not be counted; its document count stays as it was"
                    );
                    continue;
                }
            };
            match repo_mounts.record_document_count(session_id, count).await {
                Ok(true) => list_feed.refresh_session(session_id),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a chat's document count could not be stored; it stays as it was"
                ),
            }
        }
    }
}

// The session of each chat folder under `workspaces_folder`; none once the folder is gone.
fn list_chat_folders(workspaces_folder: &Path) -> io::Result<Vec<SessionId>> {
    let entries = match std::fs::read_dir(workspaces_folder) {
        Ok(entries) => entries,
        Err(error) if is_missing_entry(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut session_ids = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(session_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| SessionId::new(name).ok())
        {
            session_ids.push(session_id);
        }
    }
    Ok(session_ids)
}

// The files in a chat's workspace folder, its `.git` folder aside, without following a link;
// `None` once the folder is gone. An entry that cannot be read is passed over; the folder itself
// failing fails the count.
fn count_files(folder: &Path) -> io::Result<Option<u64>> {
    let walk = WalkBuilder::new(folder)
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(|entry| {
            entry.depth() != 1 || entry.file_name() != OsStr::new(GIT_METADATA_FOLDER_NAME)
        })
        .build();
    let mut count = 0;
    for walked in walk {
        match walked {
            Ok(entry) => {
                if entry.file_type().is_some_and(|kind| kind.is_file()) {
                    count += 1;
                }
            }
            Err(error) if error.depth().is_none_or(|depth| depth == 0) => {
                if error.io_error().is_some_and(is_missing_entry) {
                    return Ok(None);
                }
                return Err(io::Error::other(error));
            }
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "an entry of a chat's workspace could not be read, so the chat's count passes it"
            ),
        }
    }
    Ok(Some(count))
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
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::{ManagedWorkspaceService, SessionListRefresh, managed_workspaces_folder};
    use crate::git::process::test_git_runner;
    use crate::git::worktree::schema::schema_parts;
    use crate::managed::write_watcher::{ManagedWorkspaceWrite, ManagedWorkspaceWriteKind};
    use crate::repo::mount::service::RepoMountService;
    use crate::repo::root_resolver::RepoRootResolver;

    const WAIT: Duration = Duration::from_secs(20);

    // The sessions list's stand-in: sends on each session it is named.
    struct NamedSessions(mpsc::UnboundedSender<SessionId>);

    impl SessionListRefresh for NamedSessions {
        fn refresh_session(&self, session_id: SessionId) {
            self.0
                .send(session_id)
                .expect("the test hears the sessions named");
        }
    }

    // The service for workspaces under `home` on `database`, and what hears each chat it names to
    // the sessions list.
    async fn start_service(
        home: &tempfile::TempDir,
        database: &TestDatabase,
        writes: mpsc::Sender<ManagedWorkspaceWrite>,
    ) -> (mpsc::UnboundedReceiver<SessionId>, ManagedWorkspaceService) {
        let repo_mounts =
            RepoMountService::for_test(database, RepoRootResolver::new(test_git_runner())).await;
        let (named_sender, named) = mpsc::unbounded_channel();
        let service = ManagedWorkspaceService::new(
            home.path(),
            None,
            repo_mounts,
            test_git_runner(),
            writes,
            Arc::new(NamedSessions(named_sender)),
        );
        (named, service)
    }

    // Makes the session's workspace, writes one file in it at once, before the watch may be
    // ready, and waits for that one write to be reported.
    async fn write_once_and_see_it_reported(
        service: &ManagedWorkspaceService,
        session_id: SessionId,
        writes: &mut mpsc::Receiver<ManagedWorkspaceWrite>,
    ) {
        let workspace = service
            .create(session_id)
            .await
            .expect("the workspace is made");
        fs::write(workspace.path.join("note.txt"), "written").expect("a file is written");
        let write = loop {
            let write = timeout(WAIT, writes.recv())
                .await
                .expect("a write is reported in time")
                .expect("the watch keeps reporting");
            // A write still told from an earlier session's workspace is passed over.
            if write.session_id == session_id {
                break write;
            }
        };
        assert_eq!(
            write,
            ManagedWorkspaceWrite {
                session_id,
                relative_path: PathBuf::from("note.txt"),
                kind: ManagedWorkspaceWriteKind::File,
            }
        );
    }

    // Catches a watch left dead once its folder is removed, and a watch started again that misses
    // a write made before it was ready: a chat made after the removal writes once, at once, and
    // that write must be reported.
    #[tokio::test]
    async fn a_create_after_the_workspaces_folder_is_removed_watches_it_again() {
        let home = tempfile::tempdir().expect("a scratch home");
        let database = TestDatabase::new(schema_parts());
        let (writes_sender, mut writes) = mpsc::channel(64);
        let (_named, service) = start_service(&home, &database, writes_sender).await;

        let first = SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70").expect("a session id");
        write_once_and_see_it_reported(&service, first, &mut writes).await;
        fs::remove_dir_all(managed_workspaces_folder(home.path()))
            .expect("the workspaces folder is removed");
        let second = SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71").expect("a session id");
        write_once_and_see_it_reported(&service, second, &mut writes).await;
    }

    // The chat's document count as its managed mount's row holds it.
    fn stored_document_count(database: &TestDatabase, session_id: SessionId) -> i64 {
        database
            .reader()
            .query_row(
                "SELECT document_count FROM repo_mounts WHERE managed_session_id = ?1",
                [session_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the chat's mount row reads")
    }

    // The chat's document count once the sessions list is next named the chat.
    async fn next_document_count(
        named: &mut mpsc::UnboundedReceiver<SessionId>,
        database: &TestDatabase,
        session_id: SessionId,
    ) -> i64 {
        let named = timeout(WAIT, named.recv())
            .await
            .expect("the sessions list is named the chat in time")
            .expect("the service keeps naming chats");
        assert_eq!(named, session_id);
        stored_document_count(database, session_id)
    }

    // Catches a count left unwritten, the `.git` folder counted, a removal that leaves the count
    // high, and a count that moves without the sessions list being named the chat: the chat's row
    // follows the files written into and removed from its folder, and each move names the chat.
    #[tokio::test]
    async fn a_chats_document_count_follows_its_folder_and_names_the_chat_to_the_list() {
        let home = tempfile::tempdir().expect("a scratch home");
        let database = TestDatabase::new(schema_parts());
        let (writes_sender, _writes) = mpsc::channel(64);
        let (mut named, service) = start_service(&home, &database, writes_sender).await;
        let session_id =
            SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e72").expect("a session id");
        let workspace = service
            .create(session_id)
            .await
            .expect("the workspace is made");
        assert_eq!(stored_document_count(&database, session_id), 0);

        fs::write(workspace.path.join("plan.md"), "plan").expect("a file is written");
        fs::create_dir(workspace.path.join("notes")).expect("a folder is made");
        fs::write(workspace.path.join("notes").join("draft.md"), "draft").expect("written");
        while next_document_count(&mut named, &database, session_id).await != 2 {}
        fs::remove_file(workspace.path.join("plan.md")).expect("the file is removed");
        while next_document_count(&mut named, &database, session_id).await != 1 {}
    }
}
