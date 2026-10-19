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
//! - A rescan walks what the system says it lost, never above a watched root, and hands every
//!   entry it finds to the owner like any change.

use std::collections::{BTreeSet, VecDeque};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ignore::WalkBuilder;
use notify::event::{CreateKind, ModifyKind, RenameMode};
use notify::{
    Config, ErrorKind, Event, EventHandler, EventKind, EventKindMask, RecommendedWatcher,
    RecursiveMode, Watcher,
};
use sidekicks_platforms::{WATCHES_TREES, inotify_watch_ceiling, real_path};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};
use tokio::task::JoinError;

use crate::missing_entry::is_missing_entry;

/// How many of the system's events wait for the reader; past it the feed is marked lost and one
/// rescan of every root replaces what was dropped, so a burst costs a walk, never memory.
pub(crate) const FEED_CAPACITY: usize = 1_024;

// The most changed paths one notice carries, so a burst reaches the owner in bounded pieces.
const CHANGE_BATCH_LIMIT: usize = 256;

// The most entries a walk hands over at once, and how many such pieces may wait, so a walk of a
// large tree holds a few hundred paths at a time, never the whole tree.
const WALK_CHUNK_LIMIT: usize = 256;
const WALK_CHUNKS_WAITING: usize = 2;

// The most walks that may wait their turn; past it they fold into one rescan of every root, which
// covers them all.
const PENDING_WALK_LIMIT: usize = 256;

// How a root is watched: the whole tree where the system can, else the root folder alone.
const ROOT_MODE: RecursiveMode = if WATCHES_TREES {
    RecursiveMode::Recursive
} else {
    RecursiveMode::NonRecursive
};

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
            Ok(()) => {}
            // An error dropped here leaves no watch dead unnoticed: the rescan this mark causes
            // watches every root again.
            Err(TrySendError::Full(_)) => self.has_lost_events.store(true, Ordering::Release),
            // The reader is gone, so the watch is being dropped.
            Err(TrySendError::Closed(_)) => {}
        }
    }
}

/// One watch over a set of roots, read by its owner one notice at a time; dropping it ends the
/// system's watch and any walk under way.
pub(crate) struct FileWatch<W = RecommendedWatcher> {
    watcher: Arc<Mutex<W>>,
    roots: Vec<PathBuf>,
    filter: WalkFilter,
    events: mpsc::Receiver<notify::Result<Event>>,
    has_lost_events: Arc<AtomicBool>,
    is_incomplete: Arc<AtomicBool>,
    has_unreported_incomplete: bool,
    pending_walks: VecDeque<WalkRequest>,
    is_full_rescan_pending: bool,
    walk: Option<mpsc::Receiver<WalkOutput>>,
    failure: Option<FileWatchError>,
    has_ended: bool,
}

// One walk: where it starts, inside which root, and whether the root is watched again first.
#[derive(Clone, Debug)]
struct WalkRequest {
    root: PathBuf,
    start: PathBuf,
    rearms_root: bool,
}

// What a walk hands back to the reader.
enum WalkOutput {
    Entries(Vec<PathBuf>),
    CeilingReached,
    RootMissing(PathBuf),
    RootUnwatched {
        root: PathBuf,
        source: notify::Error,
    },
}

enum Next {
    Event(Option<notify::Result<Event>>),
    Walk(Option<WalkOutput>),
}

impl<W: Watcher + Send + 'static> FileWatch<W> {
    /// Watches each of `roots` through the backend `W`, resolving each to its real path first,
    /// with `filter` deciding which entries under them are covered; also hands back the feed the
    /// backend calls, through which a test tells changes without the system's own feed. Fails when
    /// a root cannot be resolved or watched, or the backend's watch cannot be made.
    pub(crate) async fn start(
        roots: Vec<PathBuf>,
        filter: WalkFilter,
    ) -> Result<(Self, ChangeFeed), FileWatchError> {
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
        let watcher = W::new(feed.clone(), config).map_err(FileWatchError::WatcherNotMade)?;
        let watcher = Arc::new(Mutex::new(watcher));
        let is_incomplete = Arc::new(AtomicBool::new(false));
        let arming = (
            Arc::clone(&watcher),
            Arc::clone(&is_incomplete),
            roots.clone(),
        );
        let filter_for_arming = filter.clone();
        let has_reached_ceiling = tokio::task::spawn_blocking(move || {
            let (watcher, is_incomplete, roots) = arming;
            arm_roots(&watcher, &is_incomplete, &roots, &filter_for_arming)
        })
        .await
        .map_err(FileWatchError::Interrupted)??;
        let watch = Self {
            watcher,
            roots,
            filter,
            events,
            has_lost_events: Arc::clone(&feed.has_lost_events),
            is_incomplete,
            has_unreported_incomplete: has_reached_ceiling,
            pending_walks: VecDeque::new(),
            is_full_rescan_pending: false,
            walk: None,
            failure: None,
            has_ended: false,
        };
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
                self.queue_full_rescan();
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
                Next::Walk(Some(WalkOutput::RootUnwatched { root, source })) => {
                    self.failure = Some(FileWatchError::RootUnwatched { root, source });
                }
            }
        }
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
                self.take_error(error);
                return;
            }
        };
        if event.need_rescan() {
            self.take_rescan(&event.paths);
            return;
        }
        let may_bring_a_folder = !WATCHES_TREES && may_bring_a_folder(&event.kind);
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
                    });
                } else {
                    changed.insert(path);
                }
            }
        }
    }

    // A rescan with a path walks that subtree, clipped to the roots: a path above a root walks
    // each root under it, never more. A rescan without one walks every root.
    fn take_rescan(&mut self, paths: &[PathBuf]) {
        if paths.is_empty() {
            self.queue_full_rescan();
            return;
        }
        for path in paths {
            if let Some(root) = self.root_holding(path) {
                self.queue_walk(WalkRequest {
                    root,
                    start: path.clone(),
                    rearms_root: false,
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
                    });
                }
            }
        }
    }

    // An error the system's watch reports: the ceiling marks the watch incomplete; any other is
    // logged and what it names is watched again and walked, a root's lost watch among them.
    fn take_error(&mut self, error: notify::Error) {
        match &error.kind {
            ErrorKind::MaxFilesWatch => {
                if !self.is_incomplete.swap(true, Ordering::AcqRel) {
                    log_watch_ceiling(error.paths.first().map(PathBuf::as_path), &error);
                    self.has_unreported_incomplete = true;
                }
            }
            ErrorKind::Generic(_)
            | ErrorKind::Io(_)
            | ErrorKind::PathNotFound
            | ErrorKind::WatchNotFound
            | ErrorKind::InvalidConfig(_) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the file watch reported an error; what it names is watched and read again"
                );
                if error.paths.is_empty() {
                    self.queue_full_rescan();
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

    fn queue_full_rescan(&mut self) {
        self.pending_walks.clear();
        self.pending_walks
            .extend(self.roots.iter().map(|root| WalkRequest {
                root: root.clone(),
                start: root.clone(),
                rearms_root: true,
            }));
        self.is_full_rescan_pending = true;
    }

    fn queue_walk(&mut self, request: WalkRequest) {
        // A rescan of every root still waiting covers any walk asked for since.
        if self.is_full_rescan_pending {
            return;
        }
        let is_covered = self.pending_walks.iter().any(|pending| {
            request.start.starts_with(&pending.start)
                && (pending.rearms_root || !request.rearms_root)
        });
        if is_covered {
            return;
        }
        if self.pending_walks.len() >= PENDING_WALK_LIMIT {
            self.queue_full_rescan();
            return;
        }
        self.pending_walks.push_back(request);
    }

    fn start_next_walk(&mut self) {
        let Some(request) = self.pending_walks.pop_front() else {
            return;
        };
        if self.pending_walks.is_empty() {
            self.is_full_rescan_pending = false;
        }
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
fn may_bring_a_folder(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(CreateKind::File) => false,
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
        | EventKind::Any
        | EventKind::Access(_)
        | EventKind::Remove(_)
        | EventKind::Other => false,
    }
}

// Watches each root, and on a system that watches one folder at a time every folder under it the
// filter keeps; answers whether the system's ceiling stopped that short.
fn arm_roots<W: Watcher>(
    watcher: &Mutex<W>,
    is_incomplete: &AtomicBool,
    roots: &[PathBuf],
    filter: &WalkFilter,
) -> Result<bool, FileWatchError> {
    for root in roots {
        lock(watcher)
            .watch(root, ROOT_MODE)
            .map_err(|source| FileWatchError::RootUnwatched {
                root: root.clone(),
                source,
            })?;
    }
    if WATCHES_TREES {
        return Ok(false);
    }
    let mut has_reached_ceiling = false;
    let mut failure = None;
    for root in roots {
        let request = WalkRequest {
            root: root.clone(),
            start: root.clone(),
            rearms_root: false,
        };
        walk(
            &request,
            filter,
            watcher,
            is_incomplete,
            false,
            &mut |output| {
                match output {
                    WalkOutput::Entries(_) => {}
                    WalkOutput::CeilingReached => has_reached_ceiling = true,
                    WalkOutput::RootMissing(root) => {
                        failure = Some(FileWatchError::RootRemoved { root });
                    }
                    WalkOutput::RootUnwatched { root, source } => {
                        failure = Some(FileWatchError::RootUnwatched { root, source });
                    }
                }
                failure.is_none()
            },
        );
        if let Some(failure) = failure.take() {
            return Err(failure);
        }
    }
    Ok(has_reached_ceiling)
}

// Walks one request's tree with the filter, blocking: watches the root again first when asked,
// watches each folder it keeps where the system watches one folder at a time, and hands every
// entry to `sink` in chunks when `reports_entries`, the root itself aside. Stops when `sink`
// answers false.
fn walk<W: Watcher>(
    request: &WalkRequest,
    filter: &WalkFilter,
    watcher: &Mutex<W>,
    is_incomplete: &AtomicBool,
    reports_entries: bool,
    sink: &mut dyn FnMut(WalkOutput) -> bool,
) {
    let starts_at_root = request.start == request.root;
    if starts_at_root {
        match std::fs::symlink_metadata(&request.root) {
            Ok(_) => {}
            Err(error) if is_missing_entry(&error) => {
                sink(WalkOutput::RootMissing(request.root.clone()));
                return;
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a watched folder could not be read, so it is not walked"
                );
                return;
            }
        }
    }
    if request.rearms_root {
        let rearmed = lock(watcher).watch(&request.root, ROOT_MODE);
        if let Err(source) = rearmed {
            let output = if matches!(source.kind, ErrorKind::PathNotFound) {
                WalkOutput::RootMissing(request.root.clone())
            } else {
                WalkOutput::RootUnwatched {
                    root: request.root.clone(),
                    source,
                }
            };
            sink(output);
            return;
        }
    }
    let root = request.root.clone();
    let entry_filter = filter.clone();
    let mut builder = WalkBuilder::new(&request.start);
    builder
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(move |entry| match entry.path().strip_prefix(&root) {
            Ok(relative_path) => entry_filter.keeps(relative_path),
            Err(_) => false,
        });
    let mut chunk = Vec::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                // An entry removed while the walk runs is no failure.
                if !error.io_error().is_some_and(is_missing_entry) {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "an entry under a watched folder could not be read, so its changes are \
                         not told"
                    );
                }
                continue;
            }
        };
        let is_root = entry.depth() == 0 && starts_at_root;
        if is_root {
            continue;
        }
        let is_folder = entry
            .file_type()
            .is_some_and(|file_type| file_type.is_dir());
        if !WATCHES_TREES
            && is_folder
            && arm_folder(watcher, is_incomplete, entry.path())
            && !sink(WalkOutput::CeilingReached)
        {
            return;
        }
        if reports_entries {
            chunk.push(entry.into_path());
            if chunk.len() >= WALK_CHUNK_LIMIT {
                let full_chunk = std::mem::take(&mut chunk);
                if !sink(WalkOutput::Entries(full_chunk)) {
                    return;
                }
            }
        }
    }
    if !chunk.is_empty() {
        sink(WalkOutput::Entries(chunk));
    }
}

// Watches one folder on its own; answers true the first time the system's ceiling refuses one,
// after which no folder is added.
fn arm_folder<W: Watcher>(watcher: &Mutex<W>, is_incomplete: &AtomicBool, folder: &Path) -> bool {
    if is_incomplete.load(Ordering::Acquire) {
        return false;
    }
    let Err(error) = lock(watcher).watch(folder, RecursiveMode::NonRecursive) else {
        return false;
    };
    match &error.kind {
        ErrorKind::MaxFilesWatch => {
            let is_first = !is_incomplete.swap(true, Ordering::AcqRel);
            if is_first {
                log_watch_ceiling(Some(folder), &error);
            }
            is_first
        }
        // Removed while the walk ran.
        ErrorKind::PathNotFound => false,
        ErrorKind::Generic(_)
        | ErrorKind::Io(_)
        | ErrorKind::WatchNotFound
        | ErrorKind::InvalidConfig(_) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                folder = %folder.display(),
                "a folder could not be watched, so changes in it are not told"
            );
            false
        }
    }
}

// The ceiling's figure is read only for the log: the refused watch is what says it is reached.
fn log_watch_ceiling(folder: Option<&Path>, error: &notify::Error) {
    match inotify_watch_ceiling() {
        Ok(ceiling) => tracing::warn!(
            error = error as &(dyn Error + 'static),
            ?folder,
            ?ceiling,
            "the system's ceiling on watched folders is reached; folders past it are not watched"
        ),
        Err(ceiling_error) => tracing::warn!(
            error = error as &(dyn Error + 'static),
            ceiling_error = &ceiling_error as &(dyn Error + 'static),
            ?folder,
            "the system's ceiling on watched folders is reached; folders past it are not watched"
        ),
    }
}

// A watcher whose holder panicked is still whole: each call on it stands alone.
fn lock<W>(watcher: &Mutex<W>) -> MutexGuard<'_, W> {
    watcher.lock().unwrap_or_else(PoisonError::into_inner)
}
