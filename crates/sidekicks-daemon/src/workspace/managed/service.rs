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
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;

use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::remove_tree;
use tokio::sync::mpsc;
use tokio::sync::oneshot::{self, error::TryRecvError};
use tokio_util::task::AbortOnDropHandle;

use crate::cleanup_failures::CleanupFailures;
use crate::events::session::pending::PendingSessions;
use crate::file::bounded_read::run_on_own_thread;
use crate::file::real_location::resolve_real_path;
use crate::git::process::{GitCall, GitError, GitRunner, in_folder};
use crate::missing_entry::is_missing_entry;
use crate::session::directory::list_feed::SessionListFeed;
use crate::workspace::managed::write_watcher::{
    ManagedWorkspaceWrite, ManagedWorkspaceWriteWatcher,
};
use crate::workspace::repo::mount::service::{RepoMountService, RepoMountServiceError};

const MANAGED_WORKSPACES_FOLDER_NAME: &str = "workspaces";

// A workspace's own repository folder, the daemon's and not one of the chat's documents.
const GIT_METADATA_FOLDER_NAME: &str = ".git";

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
    changed_folders: Arc<PendingSessions>,
    write_watch: Mutex<WriteWatch>,
    _document_counting: AbortOnDropHandle<()>,
}

// The watch over every chat's workspace, and the channel it answers on when it ends.
struct WriteWatch {
    watcher: ManagedWorkspaceWriteWatcher,
    failure: oneshot::Receiver<SystemTime>,
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
            writes,
            changed_folders,
            missed_since,
        );
        Self { watcher, failure }
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
    pub(crate) fn new(
        home_folder: &Path,
        place: Option<Place>,
        repo_mounts: Arc<RepoMountService>,
        git: GitRunner,
        writes: mpsc::Sender<ManagedWorkspaceWrite>,
        list_feed: Arc<SessionListFeed>,
    ) -> Self {
        let workspaces_folder = managed_workspaces_folder(home_folder);
        let changed_folders = Arc::new(PendingSessions::default());
        // A create right after this may write before the watch is ready, so it catches up from now.
        let write_watch = WriteWatch::start(
            workspaces_folder.clone(),
            writes.clone(),
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
            writes,
            changed_folders,
            write_watch: Mutex::new(write_watch),
            _document_counting: document_counting,
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
    // whose folder is removed ends and a folder made again is not watched by it. The new watch
    // walks for every entry of a folder made again, all of it new, and otherwise for every write
    // since the ended watch last told them all.
    fn keep_write_watch(&self, had_folder: bool) {
        let mut write_watch = self
            .write_watch
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
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
            self.writes.clone(),
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
    list_feed: Arc<SessionListFeed>,
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
                Ok(true) => list_feed.refresh([session_id]),
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

    use sidekicks_contracts::session::directory::{SessionListChange, SessionListEntry};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::{ManagedWorkspaceService, managed_workspaces_folder};
    use crate::database::writer::test_file::TestDatabase;
    use crate::events::session::followers::SessionEventFollowers;
    use crate::git::process::test_git_runner;
    use crate::ipc::stream::feed::{CreditGate, Feed as _};
    use crate::session::directory::list_feed::SessionListFeed;
    use crate::session::directory::list_feed::subscriber::SessionListSubscriber;
    use crate::session::directory::test_rows::insert_session_row;
    use crate::workspace::managed::write_watcher::{
        ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
    };
    use crate::workspace::repo::mount::service::RepoMountService;
    use crate::workspace::repo::root_resolver::RepoRootResolver;

    const WAIT: Duration = Duration::from_secs(20);

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
        let database = TestDatabase::new();
        let repo_mounts =
            RepoMountService::for_test(&database, RepoRootResolver::new(test_git_runner())).await;
        let (writes_sender, mut writes) = mpsc::channel(64);
        let list_feed =
            SessionListFeed::for_test(&database, &Arc::new(SessionEventFollowers::default()));
        let service = ManagedWorkspaceService::new(
            home.path(),
            None,
            repo_mounts,
            test_git_runner(),
            writes_sender,
            list_feed,
        );

        let first = SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70").expect("a session id");
        write_once_and_see_it_reported(&service, first, &mut writes).await;
        fs::remove_dir_all(managed_workspaces_folder(home.path()))
            .expect("the workspaces folder is removed");
        let second = SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71").expect("a session id");
        write_once_and_see_it_reported(&service, second, &mut writes).await;
    }

    // The chat's document count as the next upsert of the list carries it.
    async fn next_document_count(subscriber: &mut SessionListSubscriber, gate: &CreditGate) -> u64 {
        loop {
            let change = timeout(WAIT, subscriber.next(gate))
                .await
                .expect("a change comes")
                .expect("the list reads")
                .expect("the stream goes on");
            if let SessionListChange::Upsert { entry, .. } = change
                && let SessionListEntry::Chat(chat) = *entry
            {
                return chat
                    .document_count
                    .expect("a chat with a workspace counts")
                    .get();
            }
        }
    }

    // Catches a count left unwritten, the `.git` folder counted, a removal that leaves the count
    // high, and a count that moves without the sessions list hearing of it: the chat's row follows
    // the files written into and removed from its folder.
    #[tokio::test]
    async fn a_chats_document_count_follows_its_folder_into_the_sessions_list() {
        let home = tempfile::tempdir().expect("a scratch home");
        let database = TestDatabase::new();
        let repo_mounts =
            RepoMountService::for_test(&database, RepoRootResolver::new(test_git_runner())).await;
        let (writes_sender, _writes) = mpsc::channel(64);
        let list_feed =
            SessionListFeed::for_test(&database, &Arc::new(SessionEventFollowers::default()));
        let service = ManagedWorkspaceService::new(
            home.path(),
            None,
            repo_mounts,
            test_git_runner(),
            writes_sender,
            Arc::clone(&list_feed),
        );
        let session_id =
            SessionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e72").expect("a session id");
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let workspace = service
            .create(session_id)
            .await
            .expect("the workspace is made");
        let opening = list_feed.open().await.expect("the list opens");
        let [SessionListEntry::Chat(chat)] = opening.sessions.as_slice() else {
            panic!("the list holds the one chat");
        };
        assert_eq!(chat.document_count.map(SafeInt::get), Some(0));
        let mut subscriber = opening.subscriber;
        let gate = CreditGate::with_credit(1);

        fs::write(workspace.path.join("plan.md"), "plan").expect("a file is written");
        fs::create_dir(workspace.path.join("notes")).expect("a folder is made");
        fs::write(workspace.path.join("notes").join("draft.md"), "draft").expect("written");
        while next_document_count(&mut subscriber, &gate).await != 2 {}
        fs::remove_file(workspace.path.join("plan.md")).expect("the file is removed");
        while next_document_count(&mut subscriber, &gate).await != 1 {}
    }
}
