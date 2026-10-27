//! The working-folder watch: tells each subscriber on a folder when the tree there changed, and
//! writes a branch changed outside the app back to every session standing in the folder.
//!
//! - One watch per folder, keyed by [`canonical_folder_path`] and shared by every hold and every
//!   subscriber; it starts with the first and stops with the last.
//! - A folder takes two watches: its tree, less what git ignores and less its git folder, and its
//!   own git folder for its HEAD and its index, since a linked tree's git folder sits inside the
//!   repository's, out of the tree watch's reach.
//! - Where the machine charges one of the person's watches per folder, a tree whose folders would
//!   pass the machine's limit beside the other folders' is checked on a slow tick instead, and so
//!   is a tree whose watch the limit cut short; each change says which of the two found it.
//! - Changes arriving together reach each subscriber as one change; a staleness raised for a
//!   session's folder from outside the watch goes the same way.
//! - A subscription for a session that works in no folder yet waits, sending nothing, until the
//!   session is followed into one.
//! - The repository there may have moved or gone only when its git folder or a linked tree's
//!   `.git` pointer changes, or the tree's root goes, so only those reach the repository-change
//!   receivers.

use std::collections::HashMap;
use std::io;
use std::marker::PhantomData;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use notify::{RecommendedWatcher, Watcher};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::WorkingTreeChange;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{Notify, broadcast, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::file_watch::FileWatchError;
use crate::git::process::{GitError, GitRunner};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::ipc::registry::HandlerError;
use crate::mutex_lock::lock;
use crate::session::working_folder::{WorkingFolderReadError, read_working_folder};
use crate::workspace::folder::canonical_path::canonical_folder_path;

mod branch_write_back;
mod folder;
mod ignored_paths;
mod slow_tick;
#[cfg(test)]
mod tests;

/// How often a folder too large to watch is checked, and the mount-health re-probe's own tick:
/// what it shows is minutes old at most, while git runs a few times an hour.
pub(crate) const SLOW_TICK_INTERVAL: Duration = Duration::from_secs(180);

// Repository changes a receiver may fall behind before it reads a lag, which it answers by
// probing every mount.
const REPOSITORY_CHANGE_CAPACITY: usize = 16;

/// Reads the machine's ceiling on the watches one person's programs hold together; `None` where
/// the machine watches a tree whole, so no folder is too large.
pub(crate) type ReadWatchCeiling = fn() -> io::Result<Option<u64>>;

/// What a subscriber is called with on each change of its session's folder.
pub(crate) type WorkingTreeChangeListener = Arc<dyn Fn(WorkingTreeChange) + Send + Sync>;

/// A folder to keep watched: where it is, the repository mount it belongs to, and the place every
/// git call on it runs.
#[derive(Clone, Debug)]
pub(crate) struct WatchTarget {
    /// The folder, as stored.
    pub(crate) folder: PathBuf,
    /// The mount whose sessions the branch write-back reads.
    pub(crate) repo_mount_id: RepoMountId,
    /// Where the folder is: `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
}

/// What the working-folder watch runs with.
pub(crate) struct WorkingFolderWatcherDeps {
    /// The daemon's git.
    pub(crate) git: GitRunner,
    /// The pool a session's working folder is read on.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The sessions standing in a folder, for the branch write-back.
    pub(crate) occupancy: MountOccupancyReader,
    /// Where `session.branch.changed` is appended.
    pub(crate) events: Arc<WorktreeEventEmitter>,
    /// The daemon's scheduler, which runs each slow tick.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The machine's ceiling on watches, `inotify_watch_ceiling` in the daemon.
    pub(crate) read_watch_ceiling: ReadWatchCeiling,
    /// How often a folder on the slow tick is checked, [`SLOW_TICK_INTERVAL`] in the daemon.
    pub(crate) slow_tick_interval: Duration,
}

/// Why a folder could not be held, subscribed, followed or raised.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkingFolderError {
    /// The session's working folder could not be read; `session.notFound` for a session this
    /// daemon holds no row for.
    #[error(transparent)]
    Read(WorkingFolderReadError),
    /// The read did not reach the database.
    #[error("a session's working folder could not be read")]
    Pool(#[from] DatabaseReadError),
    /// The folder's key could not be resolved (a permission refusal).
    #[error("a working folder could not be resolved")]
    Folder(#[source] io::Error),
    /// The folder's watches could not start.
    #[error("a working folder's watches could not start")]
    Start(#[source] Arc<FolderStartError>),
    /// The watch has stopped.
    #[error("the working-folder watch has stopped")]
    Stopped,
}

impl From<WorkingFolderError> for HandlerError {
    /// An unknown session refuses the call; every other failure is a fault.
    fn from(error: WorkingFolderError) -> Self {
        match error {
            WorkingFolderError::Read(WorkingFolderReadError::Refused(refusal)) => {
                Self::Refused(refusal)
            }
            other @ (WorkingFolderError::Read(WorkingFolderReadError::Database(_))
            | WorkingFolderError::Pool(_)
            | WorkingFolderError::Folder(_)
            | WorkingFolderError::Start(_)
            | WorkingFolderError::Stopped) => Self::Internal(Box::new(other)),
        }
    }
}

/// Why a folder's watches could not start; every hold and subscriber waiting on it gets it.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderStartError {
    /// The tree's own git folder could not be read.
    #[error("the working folder's git folder could not be read")]
    GitFolder(#[source] GitError),
    /// What git ignores in the tree could not be read.
    #[error("what git ignores in the working folder could not be read")]
    IgnoredPaths(#[source] GitError),
    /// The git folder could not be watched.
    #[error("the working folder's git folder could not be watched")]
    GitFolderWatch(#[source] FileWatchError),
}

// How a folder's start ended, shared by every hold and subscriber that waits on it.
type StartOutcome = Result<(), Arc<FolderStartError>>;

/// One watch per working folder, its subscribers, and the branch write-back; `W` is the system's
/// file watch, which a test swaps for one it feeds.
pub(crate) struct WorkingFolderWatcher<W = RecommendedWatcher> {
    shared: Arc<WatcherShared>,
    backend: PhantomData<fn() -> W>,
}

// What the watcher, its holds, its subscriptions and its folders' tasks share.
struct WatcherShared {
    deps: WorkingFolderWatcherDeps,
    state: Mutex<WatcherState>,
    repository_changes: broadcast::Sender<PathBuf>,
    tasks: TaskTracker,
}

#[derive(Default)]
struct WatcherState {
    folders: HashMap<PathBuf, FolderEntry>,
    subscriptions: HashMap<u64, Subscription>,
    next_id: u64,
    // The watches every folder's tree watch holds together, counted against the machine's ceiling.
    held_watches: u64,
    is_stopped: bool,
    #[cfg(test)]
    tree_watch_starts: u64,
}

// One watched folder.
struct FolderEntry {
    // Tells this folder from a later one at the same key.
    id: u64,
    // Its holds and its subscribers.
    hold_count: usize,
    started: watch::Receiver<Option<StartOutcome>>,
    signals: Arc<FolderSignals>,
    // The watches its tree watch holds, counted in `held_watches`.
    tree_watch_count: u64,
    #[cfg(test)]
    feeds: tests::FolderFeeds,
}

// What the watcher tells a folder's task.
struct FolderSignals {
    raise: Notify,
    close: CancellationToken,
}

struct Subscription {
    session_id: SessionId,
    // The folder it is on, `None` while its session works in none.
    folder: Option<FolderKey>,
    on_change: WorkingTreeChangeListener,
}

// A folder's key and the id of the folder entry under it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FolderKey {
    key: PathBuf,
    id: u64,
}

/// Keeps one folder's watches running until it drops.
pub(crate) struct WatchHold {
    shared: Weak<WatcherShared>,
    folder: FolderKey,
}

impl Drop for WatchHold {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.release(&self.folder);
        }
    }
}

/// Sends each change of its session's folder to its listener until it drops.
pub(crate) struct WatchSubscription {
    shared: Weak<WatcherShared>,
    subscription_id: u64,
}

impl Drop for WatchSubscription {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.detach(self.subscription_id);
        }
    }
}

impl<W: Watcher + Send + 'static> WorkingFolderWatcher<W> {
    /// A watcher running with `deps`, watching nothing until a hold or a subscription.
    pub(crate) fn new(deps: WorkingFolderWatcherDeps) -> Self {
        Self {
            shared: Arc::new(WatcherShared {
                deps,
                state: Mutex::new(WatcherState::default()),
                repository_changes: broadcast::channel(REPOSITORY_CHANGE_CAPACITY).0,
                tasks: TaskTracker::new(),
            }),
            backend: PhantomData,
        }
    }

    /// Keeps the folder of `target` watched until the returned hold drops, once its watches have
    /// started. Fails with [`WorkingFolderError::Folder`] when the folder cannot be resolved,
    /// [`WorkingFolderError::Start`] when its watches cannot start, and
    /// [`WorkingFolderError::Stopped`] after [`stop`](Self::stop).
    pub(crate) async fn hold(&self, target: &WatchTarget) -> Result<WatchHold, WorkingFolderError> {
        let key = canonical_folder_path(&target.folder)
            .await
            .map_err(WorkingFolderError::Folder)?;
        let (folder, started) = self.acquire(key, target)?;
        let hold = WatchHold {
            shared: Arc::downgrade(&self.shared),
            folder,
        };
        wait_for_start(started).await?;
        Ok(hold)
    }

    /// Calls `on_change` with each change of the folder `session_id` works in until the returned
    /// subscription drops, following the session when it moves; a session that works in no folder
    /// yet is followed once it is in one. Fails with `session.notFound` for a session this daemon
    /// holds no row for, and as [`hold`](Self::hold) does.
    pub(crate) async fn subscribe(
        &self,
        session_id: &SessionId,
        on_change: WorkingTreeChangeListener,
    ) -> Result<WatchSubscription, WorkingFolderError> {
        let target = self.read_target(session_id).await?;
        let subscription_id = {
            let mut state = self.shared.lock_state();
            if state.is_stopped {
                return Err(WorkingFolderError::Stopped);
            }
            let subscription_id = state.take_id();
            state.subscriptions.insert(
                subscription_id,
                Subscription {
                    session_id: *session_id,
                    folder: None,
                    on_change,
                },
            );
            subscription_id
        };
        let subscription = WatchSubscription {
            shared: Arc::downgrade(&self.shared),
            subscription_id,
        };
        if let Some(target) = target {
            let key = canonical_folder_path(&target.folder)
                .await
                .map_err(WorkingFolderError::Folder)?;
            self.attach(subscription_id, key, &target).await?;
        }
        Ok(subscription)
    }

    /// Moves `session_id`'s subscriptions to the folder it works in now, or parks them while it
    /// works in none; run after the session moves. Fails as [`subscribe`](Self::subscribe) does.
    pub(crate) async fn follow(&self, session_id: &SessionId) -> Result<(), WorkingFolderError> {
        let target = self.read_target(session_id).await?;
        let key = match &target {
            Some(target) => Some(
                canonical_folder_path(&target.folder)
                    .await
                    .map_err(WorkingFolderError::Folder)?,
            ),
            None => None,
        };
        let moving: Vec<u64> = self
            .shared
            .lock_state()
            .subscriptions
            .iter()
            .filter(|(_, subscription)| {
                subscription.session_id == *session_id
                    && subscription.folder.as_ref().map(|folder| &folder.key) != key.as_ref()
            })
            .map(|(subscription_id, _)| *subscription_id)
            .collect();
        for subscription_id in moving {
            match (&target, &key) {
                (Some(target), Some(key)) => {
                    self.attach(subscription_id, key.clone(), target).await?;
                }
                (None, _) | (_, None) => self.shared.park(subscription_id),
            }
        }
        Ok(())
    }

    /// Marks the folder `session_id` works in as changed for every subscriber on it, once; an
    /// allowed approval raises it, since work the person has not seen may land there. A session
    /// whose folder is not watched raises nothing. Fails as [`subscribe`](Self::subscribe) does.
    pub(crate) async fn raise_staleness(
        &self,
        session_id: &SessionId,
    ) -> Result<(), WorkingFolderError> {
        let Some(target) = self.read_target(session_id).await? else {
            return Ok(());
        };
        let key = canonical_folder_path(&target.folder)
            .await
            .map_err(WorkingFolderError::Folder)?;
        if let Some(entry) = self.shared.lock_state().folders.get(&key) {
            entry.signals.raise.notify_one();
        }
        Ok(())
    }

    /// A receiver of each watched folder whose repository may have moved or gone, from now on;
    /// on a lag, every mount is to be probed, since a folder was missed.
    pub(crate) fn on_repository_change(&self) -> broadcast::Receiver<PathBuf> {
        self.shared.repository_changes.subscribe()
    }

    /// Stops every folder's watches and drops every subscription, then waits for the folders'
    /// tasks to end; a later hold or subscription fails with [`WorkingFolderError::Stopped`].
    pub(crate) async fn stop(&self) {
        let (folders, subscriptions) = {
            let mut state = self.shared.lock_state();
            state.is_stopped = true;
            state.held_watches = 0;
            (
                std::mem::take(&mut state.folders),
                std::mem::take(&mut state.subscriptions),
            )
        };
        for entry in folders.values() {
            entry.signals.close.cancel();
        }
        // Dropped outside the lock, since a listener may hold anything.
        drop(subscriptions);
        self.shared.tasks.close();
        self.shared.tasks.wait().await;
    }

    // The folder `session_id` works in now, `None` while it works in none on an attached mount.
    async fn read_target(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<WatchTarget>, WorkingFolderError> {
        let session = *session_id;
        let working = self
            .shared
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                read_working_folder(connection, &session).map_err(WorkingFolderError::Read)
            })
            .await?;
        Ok(working
            .working_folder
            .zip(working.repository)
            .map(|(folder, repository)| WatchTarget {
                folder,
                repo_mount_id: repository.repo_mount_id,
                place: working.place,
            }))
    }

    // Takes one hold on the folder at `key`, starting its task when none is watched there.
    fn acquire(
        &self,
        key: PathBuf,
        target: &WatchTarget,
    ) -> Result<(FolderKey, watch::Receiver<Option<StartOutcome>>), WorkingFolderError> {
        let mut state = self.shared.lock_state();
        if state.is_stopped {
            return Err(WorkingFolderError::Stopped);
        }
        if let Some(entry) = state.folders.get_mut(&key) {
            entry.hold_count += 1;
            return Ok((FolderKey { key, id: entry.id }, entry.started.clone()));
        }
        let id = state.take_id();
        let (started_sender, started) = watch::channel(None);
        let signals = Arc::new(FolderSignals {
            raise: Notify::new(),
            close: CancellationToken::new(),
        });
        state.folders.insert(
            key.clone(),
            FolderEntry {
                id,
                hold_count: 1,
                started: started.clone(),
                signals: Arc::clone(&signals),
                tree_watch_count: 0,
                #[cfg(test)]
                feeds: tests::FolderFeeds::default(),
            },
        );
        let folder = FolderKey { key, id };
        self.shared.tasks.spawn(folder::run_folder::<W>(
            Arc::clone(&self.shared),
            folder.clone(),
            target.clone(),
            signals,
            started_sender,
        ));
        Ok((folder, started))
    }

    // Puts the subscription on the folder at `key`, releasing the one it was on, and waits for the
    // folder's start; a failed start parks it again.
    async fn attach(
        &self,
        subscription_id: u64,
        key: PathBuf,
        target: &WatchTarget,
    ) -> Result<(), WorkingFolderError> {
        let (folder, started) = self.acquire(key, target)?;
        let previous = {
            let mut state = self.shared.lock_state();
            match state.subscriptions.get_mut(&subscription_id) {
                Some(subscription) => Ok(subscription.folder.replace(folder.clone())),
                // Detached while the folder's key was read.
                None => Err(()),
            }
        };
        match previous {
            Ok(Some(previous)) => self.shared.release(&previous),
            Ok(None) => {}
            Err(()) => {
                self.shared.release(&folder);
                return Ok(());
            }
        }
        if let Err(error) = wait_for_start(started).await {
            self.shared.park(subscription_id);
            return Err(error);
        }
        Ok(())
    }
}

impl WatcherShared {
    fn lock_state(&self) -> MutexGuard<'_, WatcherState> {
        lock(&self.state)
    }

    // Lets one hold on `folder` go; the last closes the folder and gives its watches back.
    fn release(&self, folder: &FolderKey) {
        let mut state = self.lock_state();
        let Some(entry) = state.folders.get_mut(&folder.key) else {
            return;
        };
        if entry.id != folder.id {
            return;
        }
        entry.hold_count -= 1;
        if entry.hold_count > 0 {
            return;
        }
        if let Some(entry) = state.folders.remove(&folder.key) {
            state.held_watches -= entry.tree_watch_count;
            entry.signals.close.cancel();
        }
    }

    // Moves the subscription off its folder, keeping it until its session is followed again.
    fn park(&self, subscription_id: u64) {
        let previous = self
            .lock_state()
            .subscriptions
            .get_mut(&subscription_id)
            .and_then(|subscription| subscription.folder.take());
        if let Some(previous) = previous {
            self.release(&previous);
        }
    }

    // Drops the subscription and its hold on its folder.
    fn detach(&self, subscription_id: u64) {
        let removed = self.lock_state().subscriptions.remove(&subscription_id);
        if let Some(folder) = removed.and_then(|subscription| subscription.folder) {
            self.release(&folder);
        }
    }
}

impl WatcherState {
    fn take_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

// Waits for a folder's start to end, answering its failure.
async fn wait_for_start(
    mut started: watch::Receiver<Option<StartOutcome>>,
) -> Result<(), WorkingFolderError> {
    let outcome = started
        .wait_for(Option::is_some)
        .await
        // The task dropped its sender unanswered: the folder was closed by the stop.
        .map_err(|_closed| WorkingFolderError::Stopped)?
        .clone();
    match outcome {
        Some(Ok(())) => Ok(()),
        Some(Err(failure)) => Err(WorkingFolderError::Start(failure)),
        None => Err(WorkingFolderError::Stopped),
    }
}
