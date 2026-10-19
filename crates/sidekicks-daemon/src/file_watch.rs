//! The one file watch every owner shares: the system's change feed over the folders an owner
//! names, read through one bounded handler, with lost events turned into rescans.
//!
//! - Where the system watches a whole tree (`FSEvents`, `ReadDirectoryChangesW`) each root takes
//!   one recursive watch and the walk filter drops ignored paths as they arrive; where it watches
//!   one folder at a time (inotify) each folder the filter keeps takes its own watch, and a folder
//!   made later is watched and walked at once, since entries made before its watch lands are
//!   otherwise never told.
//! - The system's callback never waits: it hands each event to a bounded channel, and when that is
//!   full it marks the feed lost, which the reader turns into a rescan of every root.
//! - A rescan walks what the system says it lost, never above a watched root, and hands the owner
//!   only the entries modified at or after the instant the feed was last whole, so a lost feed
//!   never reports the unchanged tree.
//! - A root on a network file system, where a change another computer makes may raise no event,
//!   is read again every two seconds instead of watched by the system.
//! - A root the system's ceiling on watches refuses is tried again every five seconds, on a task
//!   the watch tracks, until it is watched, then walked for what changed meanwhile.

use std::collections::{BTreeSet, VecDeque};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::event::{CreateKind, ModifyKind, RenameMode};
use notify::{
    Config, ErrorKind, Event, EventHandler, EventKind, EventKindMask, RecommendedWatcher, Watcher,
};
use sidekicks_platforms::{WATCHES_TREES, is_on_network_file_system, real_path};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::file::bounded_read::read_within_ceiling;
use crate::missing_entry::is_missing_entry;

mod root_watchers;
#[cfg(test)]
mod tests;
mod walk;

use root_watchers::RootWatchers;
use walk::{ROOT_MODE, WalkOutput, WalkRequest, arm_roots, lock, log_watch_ceiling, walk};

/// How many of the system's events wait for the reader; past it the feed is marked lost and one
/// rescan of every root replaces what was dropped, so a burst costs a walk, never memory.
pub(crate) const FEED_CAPACITY: usize = 1_024;

// The most changed paths one notice carries, so a burst reaches the owner in bounded pieces.
const CHANGE_BATCH_LIMIT: usize = 256;

// How many pieces of a walk's entries may wait for the reader.
const WALK_CHUNKS_WAITING: usize = 2;

// The most walks that may wait their turn; past it they fold into one rescan of every root, which
// covers them all.
const PENDING_WALK_LIMIT: usize = 256;

// How long a root the system's ceiling refused waits before it is tried again.
const CEILING_RETRY_WAIT: Duration = Duration::from_secs(5);

// Whether a root is on a network file system, asked once per root at the watch's start; a test
// answers in place of the system.
type NetworkFileSystemCheck = fn(&Path) -> io::Result<bool>;

/// Which entries under a watched root the watch covers, asked with each entry's path relative to
/// its root. It must refuse every path under a folder it refuses, since a walk never enters that
/// folder while a change inside it is asked about by its whole path.
#[derive(Clone)]
pub(crate) struct WalkFilter {
    keeps: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
}

impl WalkFilter {
    /// A filter keeping each root-relative path `keeps` answers true for.
    pub(crate) fn new(keeps: impl Fn(&Path) -> bool + Send + Sync + 'static) -> Self {
        Self {
            keeps: Arc::new(keeps),
        }
    }

    fn keeps(&self, relative_path: &Path) -> bool {
        (self.keeps)(relative_path)
    }
}

/// What the watch tells its owner.
#[derive(Debug)]
pub(crate) enum FileWatchNotice {
    /// Entries that may have changed, each an absolute path under one of the watch's roots that the
    /// filter keeps; one may name an entry since removed, and none names a root itself.
    Changed(Vec<PathBuf>),
    /// Some folders could not be watched, the system's ceiling on watches reached, so changes in
    /// them are missed; told once, after the folder and the ceiling are logged.
    Incomplete,
    /// The watch has failed and tells nothing more.
    Failed(FileWatchError),
}

/// Why a file watch could not start or stopped.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FileWatchError {
    /// A root's real path could not be read.
    #[error("the watched folder `{}` could not be resolved", .root.display())]
    RootUnresolved {
        /// The root as the owner named it.
        root: PathBuf,
        /// The resolve's failure.
        #[source]
        source: io::Error,
    },
    /// The system's file watch could not be made.
    #[error("the system's file watch could not be made")]
    WatcherNotMade(#[source] notify::Error),
    /// A root could not be watched, at the start or when its lost watch was made again.
    #[error("the folder `{}` could not be watched", .root.display())]
    RootUnwatched {
        /// The real path of the root.
        root: PathBuf,
        /// The system's refusal.
        #[source]
        source: notify::Error,
    },
    /// A watched root was removed.
    #[error("the watched folder `{}` was removed", .root.display())]
    RootRemoved {
        /// The real path of the root.
        root: PathBuf,
    },
    /// A blocking read the watch waited on stopped before it answered.
    #[error("a file watch read stopped before it finished")]
    Interrupted(#[source] JoinError),
}

/// The handler the system's watch calls on its own thread: it never waits and never reads a file,
/// and a full channel marks the feed lost instead of blocking.
#[derive(Clone)]
pub(crate) struct ChangeFeed {
    events: mpsc::Sender<notify::Result<Event>>,
    has_lost_events: Arc<AtomicBool>,
}

impl EventHandler for ChangeFeed {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        match self.events.try_send(event) {
            // A closed channel means the reader is gone, so the watch is being dropped.
            Ok(()) | Err(TrySendError::Closed(_)) => {}
            // An error dropped here leaves no watch dead unnoticed: the rescan this mark causes
            // watches every root again.
            Err(TrySendError::Full(_)) => self.has_lost_events.store(true, Ordering::Release),
        }
    }
}

/// One watch over a set of roots, read by its owner one notice at a time; dropping it ends the
/// system's watch, any walk under way and any root's retry.
pub(crate) struct FileWatch<W = RecommendedWatcher> {
    watcher: Arc<Mutex<RootWatchers<W>>>,
    roots: Vec<PathBuf>,
    // The instant the watch started, since which a root watched late may have changed untold.
    started_at: SystemTime,
    // The instant the feed was last known whole; a rescan reports only entries changed since.
    whole_since: SystemTime,
    root_retries: mpsc::Receiver<RootRetryOutcome>,
    root_retry_sender: mpsc::Sender<RootRetryOutcome>,
    retries: TaskTracker,
    retry_stop: CancellationToken,
    // How many roots the system's ceiling refused are still tried again.
    roots_awaiting_retry: usize,
    filter: WalkFilter,
    events: mpsc::Receiver<notify::Result<Event>>,
    has_lost_events: Arc<AtomicBool>,
    is_incomplete: Arc<AtomicBool>,
    has_unreported_incomplete: bool,
    pending_walks: VecDeque<WalkRequest>,
    walk: Option<mpsc::Receiver<WalkOutput>>,
    failure: Option<FileWatchError>,
    has_ended: bool,
}

// How a root the ceiling refused came to be watched, or why it could not be.
enum RootRetryOutcome {
    Watched(PathBuf),
    Unwatched {
        root: PathBuf,
        source: notify::Error,
    },
    Interrupted(JoinError),
}

enum Next {
    Event(Option<notify::Result<Event>>),
    Walk(Option<WalkOutput>),
    RootRetry(Option<RootRetryOutcome>),
}

impl<W: Watcher + Send + 'static> FileWatch<W> {
    /// Watches each of `roots` through the backend `W`, resolving each to its real path first,
    /// with `filter` deciding which entries under them are covered, and polls a root on a network
    /// file system instead; also hands back the feed the backend calls, through which a test tells
    /// changes without the system's own feed. Fails when a root cannot be resolved or watched for
    /// a reason other than the system's ceiling, or the backend's watch cannot be made.
    pub(crate) async fn start(
        roots: Vec<PathBuf>,
        filter: WalkFilter,
    ) -> Result<(Self, ChangeFeed), FileWatchError> {
        Self::start_checking(roots, filter, is_on_network_file_system).await
    }

    // `start`, with `is_on_network` answering which roots are polled.
    async fn start_checking(
        roots: Vec<PathBuf>,
        filter: WalkFilter,
        is_on_network: NetworkFileSystemCheck,
    ) -> Result<(Self, ChangeFeed), FileWatchError> {
        let started_at = whole_seconds_now();
        let roots = tokio::task::spawn_blocking(move || {
            roots
                .into_iter()
                .map(|root| match real_path(&root) {
                    Ok(resolved) => Ok(resolved),
                    Err(source) => Err(FileWatchError::RootUnresolved { root, source }),
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(FileWatchError::Interrupted)??;
        let (sender, events) = mpsc::channel(FEED_CAPACITY);
        let feed = ChangeFeed {
            events: sender,
            has_lost_events: Arc::new(AtomicBool::new(false)),
        };
        // Access events other than a close after writing are noise that would only fill the feed,
        // and a link is never followed out of a root.
        let config = Config::default()
            .with_event_kinds(EventKindMask::CORE | EventKindMask::ACCESS_CLOSE)
            .with_follow_symlinks(false);
        let mut watchers =
            RootWatchers::<W>::new(feed.clone(), config).map_err(FileWatchError::WatcherNotMade)?;
        for root in &roots {
            match read_within_ceiling(root, is_on_network).await {
                Ok(true) => watchers.poll_root(root.clone()),
                Ok(false) => {}
                // The system's watch is the one left to try; it tells what it can.
                Err(error) => tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    root = %root.display(),
                    "whether a watched folder is on a network file system could not be read; the \
                     system watches it"
                ),
            }
        }
        let watcher = Arc::new(Mutex::new(watchers));
        let is_incomplete = Arc::new(AtomicBool::new(false));
        let arming = (
            Arc::clone(&watcher),
            Arc::clone(&is_incomplete),
            roots.clone(),
        );
        let filter_for_arming = filter.clone();
        let armed = tokio::task::spawn_blocking(move || {
            let (watcher, is_incomplete, roots) = arming;
            arm_roots(&watcher, &is_incomplete, &roots, &filter_for_arming)
        })
        .await
        .map_err(FileWatchError::Interrupted)??;
        let (root_retry_sender, root_retries) = mpsc::channel(roots.len().max(1));
        let watch = Self {
            watcher,
            roots,
            started_at,
            whole_since: started_at,
            root_retries,
            root_retry_sender,
            retries: TaskTracker::new(),
            retry_stop: CancellationToken::new(),
            roots_awaiting_retry: armed.roots_at_ceiling.len(),
            filter,
            events,
            has_lost_events: Arc::clone(&feed.has_lost_events),
            is_incomplete,
            has_unreported_incomplete: armed.has_reached_ceiling,
            pending_walks: VecDeque::new(),
            walk: None,
            failure: None,
            has_ended: false,
        };
        for root in armed.roots_at_ceiling {
            watch.retry_root_at_ceiling(root);
        }
        Ok((watch, feed))
    }

    /// The watched roots, each resolved to its real path; every changed path is under one of them.
    pub(crate) fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// The next thing the watch has to tell, waiting for the system's feed or a walk; `None` once
    /// the watch has failed and told it.
    pub(crate) async fn next_notice(&mut self) -> Option<FileWatchNotice> {
        loop {
            if self.has_ended {
                return None;
            }
            if let Some(failure) = self.failure.take() {
                self.has_ended = true;
                return Some(FileWatchNotice::Failed(failure));
            }
            if self.has_unreported_incomplete {
                self.has_unreported_incomplete = false;
                return Some(FileWatchNotice::Incomplete);
            }
            if self.has_lost_events.swap(false, Ordering::AcqRel) {
                let since = self.take_rescan_instant();
                self.queue_full_rescan(Some(since));
            }
            if self.walk.is_none() {
                self.start_next_walk();
            }
            let next = {
                let walk = &mut self.walk;
                tokio::select! {
                    biased;
                    event = self.events.recv() => Next::Event(event),
                    output = next_walk_output(walk) => Next::Walk(output),
                    outcome = self.root_retries.recv() => Next::RootRetry(outcome),
                }
            };
            match next {
                // Only a dropped watch closes the feed, and the watch is held here.
                Next::Event(None) => {
                    self.has_ended = true;
                    return None;
                }
                Next::Event(Some(first)) => {
                    let mut changed = BTreeSet::new();
                    let mut named_roots = Vec::new();
                    self.take_event(first, &mut changed, &mut named_roots);
                    while changed.len() < CHANGE_BATCH_LIMIT {
                        match self.events.try_recv() {
                            Ok(event) => self.take_event(event, &mut changed, &mut named_roots),
                            Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                        }
                    }
                    if !named_roots.is_empty() {
                        self.check_roots(named_roots).await;
                    }
                    if !changed.is_empty() {
                        return Some(FileWatchNotice::Changed(changed.into_iter().collect()));
                    }
                }
                Next::Walk(None) => self.walk = None,
                Next::Walk(Some(WalkOutput::Entries(paths))) => {
                    return Some(FileWatchNotice::Changed(paths));
                }
                Next::Walk(Some(WalkOutput::CeilingReached)) => {
                    self.has_unreported_incomplete = true;
                }
                Next::Walk(Some(WalkOutput::RootMissing(root))) => {
                    self.failure = Some(FileWatchError::RootRemoved { root });
                }
                Next::Walk(Some(WalkOutput::RootUnwatched { root, source }))
                | Next::RootRetry(Some(RootRetryOutcome::Unwatched { root, source })) => {
                    self.failure = Some(FileWatchError::RootUnwatched { root, source });
                }
                // The watch holds a sender, so the channel never closes while it is read.
                Next::RootRetry(None) => {}
                Next::RootRetry(Some(RootRetryOutcome::Watched(root))) => {
                    // Watched now, and what changed under it since the watch started is told; once
                    // every refused root is watched, folders past the ceiling are tried again too.
                    self.roots_awaiting_retry -= 1;
                    if self.roots_awaiting_retry == 0 {
                        self.is_incomplete.store(false, Ordering::Release);
                    }
                    self.queue_walk(WalkRequest {
                        start: root.clone(),
                        root,
                        rearms_root: false,
                        modified_since: Some(self.started_at),
                    });
                }
                Next::RootRetry(Some(RootRetryOutcome::Interrupted(failure))) => {
                    self.failure = Some(FileWatchError::Interrupted(failure));
                }
            }
        }
    }

    // Tries a root the system's ceiling refused again every few seconds, on a task the watch
    // tracks, until the system watches it or refuses it for another reason; the task ends with
    // the watch.
    fn retry_root_at_ceiling(&self, root: PathBuf) {
        let watcher: Weak<Mutex<RootWatchers<W>>> = Arc::downgrade(&self.watcher);
        let outcomes = self.root_retry_sender.clone();
        let stop = self.retry_stop.clone();
        self.retries.spawn(async move {
            loop {
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = tokio::time::sleep(CEILING_RETRY_WAIT) => {}
                }
                let Some(watcher) = watcher.upgrade() else {
                    return;
                };
                let retried = root.clone();
                let watched =
                    tokio::task::spawn_blocking(move || lock(&watcher).watch(&retried, ROOT_MODE))
                        .await;
                let outcome = match watched {
                    Ok(Ok(())) => RootRetryOutcome::Watched(root),
                    Ok(Err(error)) if matches!(error.kind, ErrorKind::MaxFilesWatch) => continue,
                    Ok(Err(source)) => RootRetryOutcome::Unwatched { root, source },
                    Err(failure) => RootRetryOutcome::Interrupted(failure),
                };
                // A watch dropped meanwhile reads nothing more.
                if outcomes.send(outcome).await.is_err() {
                    tracing::debug!("a file watch ended before its retried root was told");
                }
                return;
            }
        });
    }

    // The instant the feed was last known whole, for a rescan to report from; the feed is whole
    // again from now, in whole seconds, since some file systems keep a coarser modified time.
    fn take_rescan_instant(&mut self) -> SystemTime {
        std::mem::replace(&mut self.whole_since, whole_seconds_now())
    }

    // Sorts one event from the feed: a change the filter keeps, a rescan, a folder to watch and
    // walk, a root named by itself, or an error.
    fn take_event(
        &mut self,
        event: notify::Result<Event>,
        changed: &mut BTreeSet<PathBuf>,
        named_roots: &mut Vec<PathBuf>,
    ) {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                self.take_error(&error);
                return;
            }
        };
        if event.need_rescan() {
            let since = self.take_rescan_instant();
            self.take_rescan(&event.paths, since);
            return;
        }
        let may_bring_a_folder = !WATCHES_TREES && may_bring_a_folder(event.kind);
        for path in event.paths {
            let Some(root) = self.root_holding(&path) else {
                continue;
            };
            let Ok(relative_path) = path.strip_prefix(&root) else {
                continue;
            };
            if relative_path.as_os_str().is_empty() {
                named_roots.push(root);
            } else if self.filter.keeps(relative_path) {
                if may_bring_a_folder {
                    // The walk reports the entry itself, and watches it first when it is a folder.
                    self.queue_walk(WalkRequest {
                        root,
                        start: path,
                        rearms_root: false,
                        modified_since: None,
                    });
                } else {
                    changed.insert(path);
                }
            }
        }
    }

    // A rescan with a path walks that subtree, clipped to the roots: a path above a root walks
    // each root under it, never more. A rescan without one walks every root. Each reports entries
    // modified at or after `since`.
    fn take_rescan(&mut self, paths: &[PathBuf], since: SystemTime) {
        if paths.is_empty() {
            self.queue_full_rescan(Some(since));
            return;
        }
        for path in paths {
            if let Some(root) = self.root_holding(path) {
                self.queue_walk(WalkRequest {
                    root,
                    start: path.clone(),
                    rearms_root: false,
                    modified_since: Some(since),
                });
            } else {
                let roots_below: Vec<PathBuf> = self
                    .roots
                    .iter()
                    .filter(|root| root.starts_with(path))
                    .cloned()
                    .collect();
                for root in roots_below {
                    self.queue_walk(WalkRequest {
                        start: root.clone(),
                        root,
                        rearms_root: false,
                        modified_since: Some(since),
                    });
                }
            }
        }
    }

    // An error the system's watch reports: the ceiling marks the watch incomplete; any other is
    // logged and what it names is watched again and walked, a root's lost watch among them.
    fn take_error(&mut self, error: &notify::Error) {
        match &error.kind {
            ErrorKind::MaxFilesWatch => {
                if !self.is_incomplete.swap(true, Ordering::AcqRel) {
                    log_watch_ceiling(error.paths.first().map(PathBuf::as_path), error);
                    self.has_unreported_incomplete = true;
                }
            }
            ErrorKind::Generic(_)
            | ErrorKind::Io(_)
            | ErrorKind::PathNotFound
            | ErrorKind::WatchNotFound
            | ErrorKind::InvalidConfig(_) => {
                tracing::warn!(
                    error = error as &(dyn Error + 'static),
                    "the file watch reported an error; what it names is watched and read again"
                );
                let since = self.take_rescan_instant();
                if error.paths.is_empty() {
                    self.queue_full_rescan(Some(since));
                    return;
                }
                for path in &error.paths {
                    let Some(root) = self.root_holding(path) else {
                        continue;
                    };
                    let rearms_root = *path == root;
                    self.queue_walk(WalkRequest {
                        root,
                        start: path.clone(),
                        rearms_root,
                        modified_since: Some(since),
                    });
                }
            }
        }
    }

    // A root an event names by itself is checked: one that is gone fails the watch.
    async fn check_roots(&mut self, mut roots: Vec<PathBuf>) {
        roots.sort();
        roots.dedup();
        let missing_root = tokio::task::spawn_blocking(move || {
            roots
                .into_iter()
                .find(|root| match std::fs::symlink_metadata(root) {
                    Ok(_) => false,
                    Err(error) if is_missing_entry(&error) => true,
                    Err(error) => {
                        tracing::warn!(
                            error = &error as &(dyn Error + 'static),
                            "a watched folder could not be read to check that it is still there"
                        );
                        false
                    }
                })
        })
        .await;
        match missing_root {
            Ok(Some(root)) => self.failure = Some(FileWatchError::RootRemoved { root }),
            Ok(None) => {}
            Err(failure) => self.failure = Some(FileWatchError::Interrupted(failure)),
        }
    }

    fn root_holding(&self, path: &Path) -> Option<PathBuf> {
        self.roots
            .iter()
            .find(|root| path.starts_with(root))
            .cloned()
    }

    // A walk of every root in place of every waiting walk, reporting entries modified at or after
    // `since`, or every entry with none.
    fn queue_full_rescan(&mut self, since: Option<SystemTime>) {
        self.pending_walks.clear();
        self.pending_walks
            .extend(self.roots.iter().map(|root| WalkRequest {
                root: root.clone(),
                start: root.clone(),
                rearms_root: true,
                modified_since: since,
            }));
    }

    fn queue_walk(&mut self, request: WalkRequest) {
        if self
            .pending_walks
            .iter()
            .any(|pending| pending.covers(&request))
        {
            return;
        }
        if self.pending_walks.len() >= PENDING_WALK_LIMIT {
            // The rescan replacing them reports every entry any of them would.
            let since = self
                .pending_walks
                .iter()
                .chain([&request])
                .map(|walk| walk.modified_since)
                .min()
                .flatten();
            self.queue_full_rescan(since);
            return;
        }
        self.pending_walks.push_back(request);
    }

    fn start_next_walk(&mut self) {
        let Some(request) = self.pending_walks.pop_front() else {
            return;
        };
        let (sender, receiver) = mpsc::channel(WALK_CHUNKS_WAITING);
        let watcher = Arc::clone(&self.watcher);
        let is_incomplete = Arc::clone(&self.is_incomplete);
        let filter = self.filter.clone();
        // The walk ends early when its reader is dropped, so its handle is not kept.
        drop(tokio::task::spawn_blocking(move || {
            walk(
                &request,
                &filter,
                &watcher,
                &is_incomplete,
                true,
                &mut |output| sender.blocking_send(output).is_ok(),
            );
        }));
        self.walk = Some(receiver);
    }
}

async fn next_walk_output(walk: &mut Option<mpsc::Receiver<WalkOutput>>) -> Option<WalkOutput> {
    match walk {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

// Whether an event can bring a folder that inotify does not watch yet: one made, or one moved in.
fn may_bring_a_folder(kind: EventKind) -> bool {
    match kind {
        EventKind::Create(CreateKind::Any | CreateKind::Folder | CreateKind::Other)
        | EventKind::Modify(ModifyKind::Name(
            RenameMode::Any | RenameMode::To | RenameMode::Both | RenameMode::Other,
        )) => true,
        EventKind::Modify(
            ModifyKind::Name(RenameMode::From)
            | ModifyKind::Any
            | ModifyKind::Data(_)
            | ModifyKind::Metadata(_)
            | ModifyKind::Other,
        )
        | EventKind::Create(CreateKind::File)
        | EventKind::Any
        | EventKind::Access(_)
        | EventKind::Remove(_)
        | EventKind::Other => false,
    }
}

impl<W> Drop for FileWatch<W> {
    fn drop(&mut self) {
        self.retry_stop.cancel();
        self.retries.close();
    }
}

// Now, cut to the whole second, so an entry written in the same second as a rescan's instant on a
// file system that keeps whole seconds still counts as written at or after it.
fn whole_seconds_now() -> SystemTime {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock reads after 1970");
    UNIX_EPOCH + Duration::from_secs(since_epoch.as_secs())
}
