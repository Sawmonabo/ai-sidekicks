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
//!   only the entries changed at or after the instant the feed was last whole, by the newer of an
//!   entry's modified and status-change times, so a lost feed never reports the unchanged tree
//!   while a file written with an old modified time kept is still reported. A rescan of one path
//!   leaves that instant; only a rescan of every root moves it, and a wall clock set back lowers
//!   it by the step, read against the monotonic clock. Files inside a folder moved in while the
//!   feed was lost keep their own times and are not reported; the folder's watch tells them after.
//! - A root on a network file system, where a change another computer makes may raise no event,
//!   is read again every two seconds instead of watched by the system, each folder the filter keeps
//!   one level deep.
//! - Once the system's ceiling on watches refuses one, every later watch is skipped and its root
//!   recorded; five seconds on, on a task the watch tracks, the refused roots are watched again
//!   and every recorded root walked again, as often as the ceiling is reached.
//! - The watch's own file reads run on threads of their own or within the bounded read's ceiling,
//!   never on tokio's blocking pool, whose stop waits for a read a hung mount holds.

use std::collections::{BTreeSet, VecDeque};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::event::{CreateKind, ModifyKind, RenameMode};
use notify::{
    Config, ErrorKind, Event, EventHandler, EventKind, EventKindMask, RecommendedWatcher, Watcher,
};
use sidekicks_platforms::is_on_network_file_system;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use sidekicks_std::file::bounded_read::{read_within_ceiling, run_on_own_thread};
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;

mod ceiling;
mod root_watchers;
#[cfg(test)]
mod tests;
mod walk;

use ceiling::{CeilingMisses, CeilingRetryOutcome, log_watch_ceiling, retry_after_ceiling};
use root_watchers::{RootWatchers, arms_each_folder};
use walk::{WalkOutput, WalkRequest, arm_roots, walk};

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

// Whether a root is on a network file system, asked once per root at the watch's start; a test
// answers in place of the system.
type NetworkFileSystemCheck = fn(&Path) -> io::Result<bool>;

/// A root a watch covers, with the filter deciding which entries under it are covered.
pub(crate) struct WatchedRoot {
    /// The root as the owner names it.
    pub(crate) path: PathBuf,
    /// Which entries under the root are covered.
    pub(crate) filter: WalkFilter,
}

/// Which entries under a watched root the watch covers, asked with each entry's path relative to
/// its root, the root itself as the empty path. It must refuse every path under a folder it
/// refuses, since a walk never enters that folder while a change inside it is asked about by its
/// whole path.
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
    /// them are missed until a retry finds room; told once each time the ceiling is reached, after
    /// the folder and the ceiling are logged.
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
    /// A read the watch waited on could not run on its thread or stopped before it answered.
    #[error("a file watch read stopped before it finished")]
    Interrupted(#[source] io::Error),
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
/// system's watch, any walk under way and any retry after the ceiling.
pub(crate) struct FileWatch<W = RecommendedWatcher> {
    // A watcher whose holder panicked is still whole, since each call on it stands alone.
    watcher: Arc<Mutex<RootWatchers<W>>>,
    roots: Vec<PathBuf>,
    // The roots on a network file system, polled rather than watched by the system.
    polled_roots: Arc<[PathBuf]>,
    // The instant the feed was last known whole; a rescan reports only entries changed since.
    whole_since: SystemTime,
    // The monotonic clock's reading when `whole_since` was taken, which shows a wall clock set back.
    whole_since_clock: Instant,
    ceiling_misses: Arc<Mutex<CeilingMisses>>,
    is_ceiling_retry_waiting: bool,
    ceiling_retries: mpsc::Receiver<CeilingRetryOutcome>,
    ceiling_retry_sender: mpsc::Sender<CeilingRetryOutcome>,
    retries: TaskTracker,
    retry_stop: CancellationToken,
    // Each root's filter, in the roots' order.
    filters: Vec<WalkFilter>,
    events: mpsc::Receiver<notify::Result<Event>>,
    has_lost_events: Arc<AtomicBool>,
    has_unreported_incomplete: bool,
    // Polled folders whose failed read is logged, until an event names them again.
    unreadable_polled_folders: BTreeSet<PathBuf>,
    pending_walks: VecDeque<WalkRequest>,
    walk: Option<WalkUnderWay>,
    failure: Option<FileWatchError>,
    has_ended: bool,
}

// The walk the watch reads, with the instant it reports from.
struct WalkUnderWay {
    outputs: mpsc::Receiver<WalkOutput>,
    modified_since: Option<SystemTime>,
}

enum Next {
    Event(Option<notify::Result<Event>>),
    Walk(Option<WalkOutput>),
    CeilingRetry(Option<CeilingRetryOutcome>),
}

impl<W: Watcher + Send + 'static> FileWatch<W> {
    /// Watches each of `roots` through the backend `W`, resolving each to its real path first,
    /// with each root's filter deciding which entries under it are covered, and polls a root on a
    /// network file system instead; also hands back the feed the backend calls, through which a
    /// test tells changes without the system's own feed. A changed path is read against the first
    /// root holding it. Fails when a root cannot be resolved or watched for a reason other than
    /// the system's ceiling, or the backend's watch cannot be made.
    pub(crate) async fn start(
        roots: Vec<WatchedRoot>,
    ) -> Result<(Self, ChangeFeed), FileWatchError> {
        Self::start_checking(roots, is_on_network_file_system).await
    }

    // `start`, with `is_on_network` answering which roots are polled.
    async fn start_checking(
        roots: Vec<WatchedRoot>,
        is_on_network: NetworkFileSystemCheck,
    ) -> Result<(Self, ChangeFeed), FileWatchError> {
        let whole_since_clock = Instant::now();
        let whole_since = whole_seconds_now();
        let mut resolved_roots = Vec::with_capacity(roots.len());
        let mut filters = Vec::with_capacity(roots.len());
        for root in roots {
            match resolve_real_path(&root.path).await {
                Ok(resolved) => resolved_roots.push(resolved),
                Err(source) => {
                    return Err(FileWatchError::RootUnresolved {
                        root: root.path,
                        source,
                    });
                }
            }
            filters.push(root.filter);
        }
        let roots = resolved_roots;
        let mut polled_roots = Vec::new();
        for root in &roots {
            match read_within_ceiling(root, is_on_network).await {
                Ok(true) => polled_roots.push(root.clone()),
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
        let polled_roots: Arc<[PathBuf]> = polled_roots.into();
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
        let watchers = RootWatchers::<W>::new(feed.clone(), config, Arc::clone(&polled_roots))
            .map_err(FileWatchError::WatcherNotMade)?;
        let watcher = Arc::new(Mutex::new(watchers));
        let ceiling_misses = Arc::new(Mutex::new(CeilingMisses::default()));
        let arming = (
            Arc::clone(&watcher),
            Arc::clone(&ceiling_misses),
            roots.clone(),
            filters.clone(),
        );
        let has_reached_ceiling = run_on_own_thread("file watch start", move || {
            let (watcher, ceiling_misses, roots, filters) = arming;
            arm_roots(&watcher, &ceiling_misses, &roots, &filters)
        })
        .await
        .map_err(FileWatchError::Interrupted)??;
        let (ceiling_retry_sender, ceiling_retries) = mpsc::channel(1);
        let mut watch = Self {
            watcher,
            roots,
            polled_roots,
            whole_since,
            whole_since_clock,
            ceiling_misses,
            is_ceiling_retry_waiting: false,
            ceiling_retries,
            ceiling_retry_sender,
            retries: TaskTracker::new(),
            retry_stop: CancellationToken::new(),
            filters,
            events,
            has_lost_events: Arc::clone(&feed.has_lost_events),
            has_unreported_incomplete: has_reached_ceiling,
            unreadable_polled_folders: BTreeSet::new(),
            pending_walks: VecDeque::new(),
            walk: None,
            failure: None,
            has_ended: false,
        };
        if has_reached_ceiling {
            watch.retry_after_ceiling();
        }
        Ok((watch, feed))
    }

    /// The watched roots, each resolved to its real path; every changed path is under one of them.
    pub(crate) fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Walks every root once through the rescan path, reporting the entries changed at or after
    /// `since`, so a change made before this watch was ready is told; for an owner whose earlier
    /// watch ended, `since` being the instant that one's [`FileWatch::whole_since`] read.
    pub(crate) fn catch_up(&mut self, since: SystemTime) {
        let since = whole_seconds_of(since);
        for root in self.roots.clone() {
            self.queue_walk(WalkRequest {
                start: root.clone(),
                root,
                rearms_root: false,
                modified_since: Some(since),
            });
        }
    }

    /// The instant since which every change under the roots has been told or is still to be told
    /// by a walk: when the feed was last whole, lowered by any wall clock step back, or the
    /// earliest instant a walk under way or waiting reports from.
    pub(crate) fn whole_since(&self) -> SystemTime {
        self.pending_walks
            .iter()
            .map(|pending| pending.modified_since)
            .chain(self.walk.as_ref().map(|walk| walk.modified_since))
            .flatten()
            .fold(self.rescan_instant(), SystemTime::min)
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
                    outcome = self.ceiling_retries.recv() => Next::CeilingRetry(outcome),
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
                    self.retry_after_ceiling();
                }
                Next::Walk(Some(WalkOutput::RootMissing(root))) => {
                    self.failure = Some(FileWatchError::RootRemoved { root });
                }
                Next::Walk(Some(WalkOutput::RootUnwatched { root, source }))
                | Next::CeilingRetry(Some(CeilingRetryOutcome::Unwatched { root, source })) => {
                    self.failure = Some(FileWatchError::RootUnwatched { root, source });
                }
                // The watch holds a sender, so the channel never closes while it is read.
                Next::CeilingRetry(None) => {}
                Next::CeilingRetry(Some(CeilingRetryOutcome::Room)) => self.walk_ceiling_misses(),
                Next::CeilingRetry(Some(CeilingRetryOutcome::Interrupted(failure))) => {
                    self.failure = Some(FileWatchError::Interrupted(failure));
                }
            }
        }
    }

    // Once the ceiling refused a watch, tries again after a wait, on a task the watch tracks, until
    // every refused root is watched or refused for another reason; one retry waits at a time, and
    // the task ends with the watch.
    fn retry_after_ceiling(&mut self) {
        if self.is_ceiling_retry_waiting {
            return;
        }
        self.is_ceiling_retry_waiting = true;
        let watcher = Arc::downgrade(&self.watcher);
        let misses = Arc::downgrade(&self.ceiling_misses);
        let stop = self.retry_stop.clone();
        let outcomes = self.ceiling_retry_sender.clone();
        self.retries.spawn(async move {
            let Some(outcome) = retry_after_ceiling(watcher, misses, stop).await else {
                return;
            };
            // A watch dropped meanwhile reads nothing more.
            if outcomes.send(outcome).await.is_err() {
                tracing::debug!("a file watch ended before its retry after the ceiling was told");
            }
        });
    }

    // The retry found room: the watch is complete again, and every root a watch was refused or
    // skipped under is walked again, its folders watched and what changed since the first refusal
    // told; a refusal on the way records it again and tells `Incomplete` again.
    fn walk_ceiling_misses(&mut self) {
        self.is_ceiling_retry_waiting = false;
        let (roots, since) = {
            let mut misses = lock(&self.ceiling_misses);
            (std::mem::take(&mut misses.roots), misses.since.take())
        };
        for root in roots {
            self.queue_walk(WalkRequest {
                start: root.clone(),
                root,
                rearms_root: false,
                modified_since: since,
            });
        }
    }

    // The instant a rescan reports from: when the feed was last known whole, lowered by however
    // far the wall clock has been set back since.
    fn rescan_instant(&self) -> SystemTime {
        let since = lowered_for_clock_step(
            self.whole_since,
            self.whole_since_clock.elapsed(),
            SystemTime::now(),
        );
        if since < self.whole_since {
            tracing::warn!(
                step = ?self.whole_since.duration_since(since).unwrap_or_default(),
                "the wall clock was set back; a rescan reports from as far back"
            );
        }
        since
    }

    // The rescan instant, for a rescan of every root, which makes the feed whole again from now,
    // in whole seconds, since some file systems keep a coarser time.
    fn take_rescan_instant(&mut self) -> SystemTime {
        let since = self.rescan_instant();
        self.whole_since_clock = Instant::now();
        self.whole_since = whole_seconds_now();
        since
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
            self.take_rescan(&event.paths);
            return;
        }
        let may_bring_a_folder = may_bring_a_folder(event.kind);
        for path in event.paths {
            let Some(root) = self.root_holding(&path) else {
                continue;
            };
            if !self.unreadable_polled_folders.is_empty() {
                self.unreadable_polled_folders.remove(&path);
            }
            let Ok(relative_path) = path.strip_prefix(&root) else {
                continue;
            };
            if relative_path.as_os_str().is_empty() {
                named_roots.push(root);
            } else if self.filter_of(&root).keeps(relative_path) {
                if may_bring_a_folder && arms_each_folder(&self.polled_roots, &root) {
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

    // A rescan with a path walks that subtree, clipped to the roots: the root holding the path
    // from the path down, and every root under the path whole, a root nested inside the holding
    // one among them (a linked tree's own git folder sits inside the common folder, whose filter
    // refuses it); it leaves the instant the feed was last whole. A rescan without one walks every
    // root and makes the feed whole again from now. Each reports entries changed at or after the
    // rescan instant.
    fn take_rescan(&mut self, paths: &[PathBuf]) {
        if paths.is_empty() {
            let since = self.take_rescan_instant();
            self.queue_full_rescan(Some(since));
            return;
        }
        let since = self.rescan_instant();
        for path in paths {
            let holding = self.root_holding(path);
            if let Some(root) = holding.clone() {
                self.queue_walk(WalkRequest {
                    root,
                    start: path.clone(),
                    rearms_root: false,
                    modified_since: Some(since),
                });
            }
            let roots_below: Vec<PathBuf> = self
                .roots
                .iter()
                .filter(|root| root.starts_with(path) && Some(*root) != holding.as_ref())
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

    // An error the system's watch reports: the ceiling marks the watch incomplete; a polled folder
    // that cannot be read is logged once, the poll itself reading it again; any other is logged and
    // what it names is watched again and walked, a root's lost watch among them.
    fn take_error(&mut self, error: &notify::Error) {
        match &error.kind {
            ErrorKind::MaxFilesWatch => {
                let named: Vec<PathBuf> = match error.paths.first() {
                    Some(path) => self.root_holding(path).into_iter().collect(),
                    None => self.roots.clone(),
                };
                let mut is_first = false;
                {
                    let mut misses = lock(&self.ceiling_misses);
                    for root in &named {
                        is_first |= misses.record(root, false);
                    }
                }
                if is_first {
                    log_watch_ceiling(error.paths.first().map(PathBuf::as_path), error);
                    self.has_unreported_incomplete = true;
                }
                self.retry_after_ceiling();
            }
            ErrorKind::Io(io_error) if self.take_polled_folder_error(io_error, &error.paths) => {}
            ErrorKind::Generic(_)
            | ErrorKind::Io(_)
            | ErrorKind::PathNotFound
            | ErrorKind::WatchNotFound
            | ErrorKind::InvalidConfig(_) => {
                tracing::warn!(
                    error = error as &(dyn Error + 'static),
                    "the file watch reported an error; what it names is watched and read again"
                );
                if error.paths.is_empty() {
                    let since = self.take_rescan_instant();
                    self.queue_full_rescan(Some(since));
                    return;
                }
                let since = self.rescan_instant();
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

    // Takes a poll's failed read of a folder under a polled root, the root itself aside: a folder
    // that is gone stops being polled, since its parent's poll told its removal, and any other is
    // logged once and not walked, since the poll reads it again every interval. Answers whether
    // `paths` named such a folder.
    fn take_polled_folder_error(&mut self, error: &io::Error, paths: &[PathBuf]) -> bool {
        let Some(folder) = paths.first().filter(|path| {
            self.polled_roots
                .iter()
                .any(|polled| path.starts_with(polled) && *path != polled)
        }) else {
            return false;
        };
        if is_missing_entry(error) {
            self.forget_polled_folder(folder.clone());
        } else if self.unreadable_polled_folders.insert(folder.clone()) {
            tracing::warn!(
                error = error as &(dyn Error + 'static),
                folder = %folder.display(),
                "a folder on a network file system could not be read; its changes are told once \
                 it reads again"
            );
        }
        true
    }

    // Stops polling a folder that is gone, on a thread of its own, since the poll holds its lock
    // while it reads the network.
    fn forget_polled_folder(&self, folder: PathBuf) {
        let watcher = Arc::clone(&self.watcher);
        let forgotten = std::thread::Builder::new()
            .name("file watch poll removal".to_owned())
            .spawn(move || {
                if let Err(error) = lock(&watcher).forget_polled_folder(&folder) {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a removed folder could not stop being polled"
                    );
                }
            });
        if let Err(error) = forgotten {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a removed folder could not stop being polled"
            );
        }
    }

    // A root an event names by itself is checked, each within the bounded read's ceiling: one
    // that is gone fails the watch.
    async fn check_roots(&mut self, mut roots: Vec<PathBuf>) {
        roots.sort();
        roots.dedup();
        for root in roots {
            match read_within_ceiling(&root, |root| std::fs::symlink_metadata(root).map(drop)).await
            {
                Ok(()) => {}
                Err(error) if is_missing_entry(&error) => {
                    self.failure = Some(FileWatchError::RootRemoved { root });
                    return;
                }
                Err(error) => tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a watched folder could not be read to check that it is still there"
                ),
            }
        }
    }

    fn root_holding(&self, path: &Path) -> Option<PathBuf> {
        self.roots
            .iter()
            .find(|root| path.starts_with(root))
            .cloned()
    }

    // The filter of `root`, one of the watch's roots.
    fn filter_of(&self, root: &Path) -> &WalkFilter {
        let index = self
            .roots
            .iter()
            .position(|watched| watched == root)
            .expect("a root the watch names is one of its roots");
        &self.filters[index]
    }

    // A walk of every root in place of every waiting walk, reporting entries changed at or after
    // the earliest of `since` and the instants the waiting walks report from, or every entry when
    // any of them has none.
    fn queue_full_rescan(&mut self, since: Option<SystemTime>) {
        let since = self
            .pending_walks
            .drain(..)
            .map(|walk| walk.modified_since)
            .fold(since, Option::min);
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
            self.queue_full_rescan(request.modified_since);
            return;
        }
        self.pending_walks.push_back(request);
    }

    // Starts the next waiting walk on a thread of its own, which ends early once its reader is
    // dropped, so its handle is not kept.
    fn start_next_walk(&mut self) {
        let Some(request) = self.pending_walks.pop_front() else {
            return;
        };
        let (sender, outputs) = mpsc::channel(WALK_CHUNKS_WAITING);
        let modified_since = request.modified_since;
        let watcher = Arc::clone(&self.watcher);
        let misses = Arc::clone(&self.ceiling_misses);
        let filter = self.filter_of(&request.root).clone();
        let started = std::thread::Builder::new()
            .name("file watch walk".to_owned())
            .spawn(move || {
                walk(&request, &filter, &watcher, &misses, true, &mut |output| {
                    sender.blocking_send(output).is_ok()
                });
            });
        match started {
            Ok(_walk_thread) => {
                self.walk = Some(WalkUnderWay {
                    outputs,
                    modified_since,
                });
            }
            Err(error) => self.failure = Some(FileWatchError::Interrupted(error)),
        }
    }
}

async fn next_walk_output(walk: &mut Option<WalkUnderWay>) -> Option<WalkOutput> {
    match walk {
        Some(walk) => walk.outputs.recv().await,
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
    whole_seconds_of(SystemTime::now())
}

/// Waits for the wall clock's next whole second, so an entry changed before the wait counts as
/// changed before a watch started after it.
#[cfg(test)]
pub(crate) async fn wait_for_the_next_whole_second() {
    let into_second = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the test's clock reads after 1970")
        .subsec_nanos();
    tokio::time::sleep(Duration::from_nanos(u64::from(1_000_000_000 - into_second))).await;
}

// `instant` cut to the whole second; a clock before 1970 reads as 1970, so everything since counts.
fn whole_seconds_of(instant: SystemTime) -> SystemTime {
    let since_epoch = instant.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    UNIX_EPOCH + Duration::from_secs(since_epoch.as_secs())
}

// `whole_since`, lowered by the step when the wall clock reads `now` earlier than it would after
// `elapsed` on the monotonic clock: a clock set back by a step is what makes them differ, and a
// change written after it carries a time that much earlier.
fn lowered_for_clock_step(
    whole_since: SystemTime,
    elapsed: Duration,
    now: SystemTime,
) -> SystemTime {
    let Some(expected_now) = whole_since.checked_add(elapsed) else {
        return whole_since;
    };
    match expected_now.duration_since(now) {
        Ok(step) if !step.is_zero() => {
            whole_seconds_of(whole_since.checked_sub(step).unwrap_or(UNIX_EPOCH))
        }
        Ok(_) | Err(_) => whole_since,
    }
}
