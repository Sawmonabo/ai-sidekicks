//! The folder each live session works in, kept watched and, for a project's repository, fetched
//! while the session is live. A session is synced when the log commits a change to where it works
//! or whether it is live: its folder's watch and fetch are held anew when the folder moved, the new
//! ones before the old go, and its stream subscribers follow it there; a session no longer live
//! lets both go. It also gives the review notes their reads of a session's folder.
//!
//! - The follower runs on the log's commit hook, so it only marks the session due and starts its
//!   sync; a session is due at most once, and its syncs run one at a time.
//! - A sync that fails is logged and the session keeps what it held; its next syncing event tries
//!   again.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::{RecommendedWatcher, Watcher};
use rusqlite::Connection;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::review_note::diff_line::NotedLineReader;
use crate::review_note::store::{ReviewNoteFolderError, ReviewNoteFolders, WorkingFolderDetach};
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::missing_entry::is_gone;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::schema::session_directory::read_session_state;
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::fetch::{BackgroundFetch, FetchHold, FetchedRepository};
use sidekicks_workspace::git::worktree::watch::{
    WatchHold, WatchTarget, WorkingFolderError, WorkingFolderWatcher,
};
use sidekicks_workspace::working_folder::{
    SessionWorkingFolder, WorkingFolderReadError, read_working_folder,
};

// The events after which a session may work somewhere else, or stop or start being live.
const SYNCING_EVENT_TYPES: [SessionEventType; 8] = [
    SessionEventType::SessionActivated,
    SessionEventType::SessionArchived,
    SessionEventType::SessionReactivated,
    SessionEventType::SessionClosed,
    SessionEventType::WorkspacePrepared,
    SessionEventType::WorkspaceRootLost,
    SessionEventType::WorkspaceArchived,
    SessionEventType::SessionSweptToCheckout,
];

const SESSIONS_IN_STATE_SQL: &str = "SELECT id FROM sessions WHERE state = ? ORDER BY id";

/// What the live session folders read, hold and run.
pub(crate) struct LiveSessionFoldersDeps<W = RecommendedWatcher> {
    /// The pool sessions and their working folders are read on.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's git, for the review notes' line reads.
    pub(crate) git: GitRunner,
    /// The working-folder watch each live folder is held on.
    pub(crate) watcher: Arc<WorkingFolderWatcher<W>>,
    /// The background fetch each live project's repository is held on.
    pub(crate) fetch: Arc<BackgroundFetch>,
}

/// Holds each live session's working folder watched and its project's repository fetched; `W` is
/// the system's file watch, which a test swaps for one it feeds.
pub(crate) struct LiveSessionFolders<W = RecommendedWatcher> {
    deps: LiveSessionFoldersDeps<W>,
    held_by_session: Mutex<HashMap<SessionId, HeldFolder>>,
    // The sessions whose sync is started and has not yet read, each at most once.
    due: Mutex<HashSet<SessionId>>,
    // Each session's syncs run one at a time, so two never hold its folder at once.
    sync_turns: KeyedLock<SessionId>,
    syncs: TaskTracker,
    attachment: Mutex<Option<FollowerAttachment>>,
    stopping: CancellationToken,
    #[cfg(test)]
    synced: tokio::sync::watch::Sender<u64>,
}

// What a live session holds on its folder.
struct HeldFolder {
    // The folder's key, as two holds of one folder compare.
    folder: PathBuf,
    _watch: WatchHold,
    _fetch: Option<FetchHold>,
}

// A live session's folder: where it is watched, and its repository.
struct LiveFolder {
    target: WatchTarget,
    repository_root: PathBuf,
    is_project: bool,
}

/// Why the live sessions, or a session's folder, could not be read, synced or followed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LiveFolderError {
    /// The session's working folder could not be read.
    #[error(transparent)]
    Read(#[from] WorkingFolderReadError),
    /// The sessions' states could not be read.
    #[error("the sessions' states could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read did not reach the database.
    #[error("a session's working folder could not be read")]
    Pool(#[from] DatabaseReadError),
    /// The folder's key could not be resolved (a permission refusal).
    #[error("a session's working folder could not be resolved")]
    Folder(#[source] io::Error),
    /// The folder could not be watched or followed.
    #[error(transparent)]
    Watch(#[from] WorkingFolderError),
}

impl<W: Watcher + Send + 'static> LiveSessionFolders<W> {
    /// Live session folders running with `deps`, holding nothing until [`start`](Self::start).
    pub(crate) fn new(deps: LiveSessionFoldersDeps<W>) -> Self {
        Self {
            deps,
            held_by_session: Mutex::new(HashMap::new()),
            due: Mutex::new(HashSet::new()),
            sync_turns: KeyedLock::new(),
            syncs: TaskTracker::new(),
            attachment: Mutex::new(None),
            stopping: CancellationToken::new(),
            #[cfg(test)]
            synced: tokio::sync::watch::Sender::new(0),
        }
    }

    /// Follows every session's committed events on `followers`, then syncs every session live
    /// now. Called inside the daemon's runtime, where each sync runs. Fails when the live sessions
    /// cannot be read.
    pub(crate) async fn start(
        self: &Arc<Self>,
        followers: &Arc<SessionEventFollowers>,
    ) -> Result<(), LiveFolderError> {
        let runtime = Handle::current();
        let follower_runtime = runtime.clone();
        let folders = Arc::downgrade(self);
        // Runs on the writer's pump, so it only starts the sync.
        let attachment = followers.follow_all(move |event| {
            if SYNCING_EVENT_TYPES.contains(&event.envelope.event_type())
                && let Some(folders) = Weak::upgrade(&folders)
            {
                folders.start_sync(event.envelope.session_id(), &follower_runtime);
            }
            Ok(())
        });
        *lock(&self.attachment) = Some(attachment);
        let live = self
            .deps
            .reads
            .read(ReadLength::Long, read_live_sessions)
            .await?;
        for session_id in live {
            self.start_sync(session_id, &runtime);
        }
        Ok(())
    }

    /// Stops following the log, waits for the syncs under way, then lets every hold go.
    pub(crate) async fn stop(&self) {
        self.stopping.cancel();
        let attachment = lock(&self.attachment).take();
        drop(attachment);
        self.syncs.close();
        self.syncs.wait().await;
        let held = std::mem::take(&mut *self.lock_held());
        drop(held);
    }

    // Starts `session_id`'s sync, unless one is started and has not read yet.
    fn start_sync(self: &Arc<Self>, session_id: SessionId, runtime: &Handle) {
        if self.stopping.is_cancelled() || !self.lock_due().insert(session_id) {
            return;
        }
        let folders = Arc::clone(self);
        self.syncs
            .spawn_on(async move { folders.sync(session_id).await }, runtime);
    }

    // Holds what `session_id` works in now, after the syncs before it; a failure is logged and
    // the session keeps what it held.
    async fn sync(&self, session_id: SessionId) {
        let _turn = self.sync_turns.acquire(session_id).await;
        // An event from here on starts another sync, which reads after this one.
        self.lock_due().remove(&session_id);
        if !self.stopping.is_cancelled()
            && let Err(error) = self.sync_now(&session_id).await
        {
            tracing::warn!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "holding the working folder of a session failed; its next change tries again"
            );
        }
        #[cfg(test)]
        self.synced.send_modify(|count| *count += 1);
    }

    async fn sync_now(&self, session_id: &SessionId) -> Result<(), LiveFolderError> {
        let session = *session_id;
        let live = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                read_live_folder(connection, &session)
            })
            .await?;
        let Some(live) = live else {
            let released = self.lock_held().remove(session_id);
            drop(released);
            return Ok(());
        };
        let folder = canonical_folder_path(&live.target.folder)
            .await
            .map_err(LiveFolderError::Folder)?;
        if self
            .lock_held()
            .get(session_id)
            .is_some_and(|held| held.folder == folder)
        {
            return Ok(());
        }
        // The new folder is held before the old one goes, so what both share keeps running.
        let watch = self.deps.watcher.hold(&live.target).await?;
        let fetch = live.is_project.then(|| {
            self.deps.fetch.keep_fresh(FetchedRepository {
                repo_mount_id: live.target.repo_mount_id,
                repository_root: live.repository_root,
                place: live.target.place.clone(),
            })
        });
        let previous = self.lock_held().insert(
            *session_id,
            HeldFolder {
                folder,
                _watch: watch,
                _fetch: fetch,
            },
        );
        drop(previous);
        self.deps.watcher.follow(session_id).await?;
        Ok(())
    }

    // The folder `session_id` works in now, `None` when it works in none on an attached mount.
    async fn read_folder(
        &self,
        session_id: SessionId,
    ) -> Result<Option<LiveFolder>, LiveFolderError> {
        let working = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                read_working_folder(connection, &session_id).map_err(LiveFolderError::Read)
            })
            .await?;
        Ok(live_folder_of(working))
    }

    fn lock_held(&self) -> MutexGuard<'_, HashMap<SessionId, HeldFolder>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.held_by_session)
    }

    fn lock_due(&self) -> MutexGuard<'_, HashSet<SessionId>> {
        // The set holds no invariant a panicking holder could break.
        lock(&self.due)
    }
}

impl<W: Watcher + Send + 'static> ReviewNoteFolders for LiveSessionFolders<W> {
    fn open_line_reader(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<NotedLineReader>, ReviewNoteFolderError>> {
        async move {
            // A chat's managed folder is no repository, so it has no diff to read.
            let Some(live) = self
                .read_folder(session_id)
                .await
                .map_err(review_note_folder_error)?
                .filter(|live| live.is_project)
            else {
                return Ok(None);
            };
            match resolve_real_path(&live.target.folder).await {
                Ok(_resolved) => Ok(Some(NotedLineReader::new(
                    self.deps.git.clone(),
                    live.target.place,
                    live.target.folder,
                ))),
                Err(error) if is_gone(&error) => Ok(None),
                Err(error) => Err(ReviewNoteFolderError(Box::new(error))),
            }
        }
        .boxed()
    }

    fn follow_working_folder(
        &self,
        session_id: SessionId,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> BoxFuture<'_, Result<Option<WorkingFolderDetach>, ReviewNoteFolderError>> {
        async move {
            if self
                .read_folder(session_id)
                .await
                .map_err(review_note_folder_error)?
                .is_none()
            {
                return Ok(None);
            }
            let subscription = self
                .deps
                .watcher
                .subscribe(&session_id, Arc::new(move |_change| on_change()))
                .await
                .map_err(|error| ReviewNoteFolderError(Box::new(error)))?;
            let detach: WorkingFolderDetach = Box::new(move || drop(subscription));
            Ok(Some(detach))
        }
        .boxed()
    }
}

fn review_note_folder_error(error: LiveFolderError) -> ReviewNoteFolderError {
    ReviewNoteFolderError(Box::new(error))
}

// The folder `session_id` works in while it is live, `None` when it is not live or works in no
// folder on an attached mount.
fn read_live_folder(
    connection: &Connection,
    session_id: &SessionId,
) -> Result<Option<LiveFolder>, LiveFolderError> {
    let state = read_session_state(connection, session_id)?;
    if state != Some(SessionState::Active) {
        return Ok(None);
    }
    Ok(live_folder_of(read_working_folder(connection, session_id)?))
}

// Where a session's working folder is watched, `None` while it has no root on an attached mount.
fn live_folder_of(working: SessionWorkingFolder) -> Option<LiveFolder> {
    let (folder, repository) = working.working_folder.zip(working.repository)?;
    Some(LiveFolder {
        target: WatchTarget {
            folder,
            repo_mount_id: repository.repo_mount_id,
            place: working.place,
        },
        repository_root: repository.repository_root,
        is_project: repository.is_project,
    })
}

// The sessions live now.
fn read_live_sessions(connection: &Connection) -> Result<Vec<SessionId>, LiveFolderError> {
    Ok(connection
        .prepare_cached(SESSIONS_IN_STATE_SQL)?
        .query_map([<&'static str>::from(SessionState::Active)], |row| {
            text_column(row, 0, |text| SessionId::new(&text))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
