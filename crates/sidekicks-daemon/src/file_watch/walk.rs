//! The walks of a file watch: watching the roots at its start, and walking a tree to watch its
//! folders where the system watches one folder at a time and to hand its entries to the owner.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use ignore::WalkBuilder;
use notify::{ErrorKind, RecursiveMode, Watcher};
use sidekicks_platforms::{WATCHES_TREES, inotify_watch_ceiling};

use super::root_watchers::RootWatchers;
use super::{FileWatchError, WalkFilter};
use crate::missing_entry::is_missing_entry;

/// How a root is watched: the whole tree where the system can, else the root folder alone.
pub(super) const ROOT_MODE: RecursiveMode = if WATCHES_TREES {
    RecursiveMode::Recursive
} else {
    RecursiveMode::NonRecursive
};

// The most entries a walk hands over at once, so a walk of a large tree holds a few hundred paths
// at a time, never the whole tree.
const WALK_CHUNK_LIMIT: usize = 256;

/// One walk: where it starts, inside which root, whether the root is watched again first, and,
/// for a rescan, the instant before which an entry's last change was already told.
#[derive(Clone, Debug)]
pub(super) struct WalkRequest {
    /// The root the walk is inside.
    pub(super) root: PathBuf,
    /// Where the walk starts: the root or a path under it.
    pub(super) start: PathBuf,
    /// Whether the root is watched again before the walk.
    pub(super) rearms_root: bool,
    /// For a rescan, only entries modified at or after this instant are handed over.
    pub(super) modified_since: Option<SystemTime>,
}

impl WalkRequest {
    /// Whether this walk, still waiting, covers `later`: it starts at or above it, watches the
    /// root again when `later` would, and hands over every entry `later` would.
    pub(super) fn covers(&self, later: &Self) -> bool {
        let covers_entries = match (self.modified_since, later.modified_since) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(since), Some(later_since)) => since <= later_since,
        };
        later.start.starts_with(&self.start)
            && (self.rearms_root || !later.rearms_root)
            && covers_entries
    }
}

/// What a walk hands back to the reader.
pub(super) enum WalkOutput {
    /// Entries under the root, the root itself never among them.
    Entries(Vec<PathBuf>),
    /// The system's ceiling on watches refused a folder.
    CeilingReached,
    /// The root is gone.
    RootMissing(PathBuf),
    /// The root could not be watched again.
    RootUnwatched {
        /// The root.
        root: PathBuf,
        /// The system's refusal.
        source: notify::Error,
    },
}

/// What watching the roots at the start found.
pub(super) struct ArmedRoots {
    /// Whether the system's ceiling stopped the watch of a root or a folder short.
    pub(super) has_reached_ceiling: bool,
    /// The roots the ceiling refused, which are watched again later.
    pub(super) roots_at_ceiling: Vec<PathBuf>,
}

/// Watches each root, and on a system that watches one folder at a time every folder under it the
/// filter keeps; a root the system's ceiling refuses is handed back rather than failing the
/// watch. Fails with the first root another refusal stops, or one removed while it is walked.
pub(super) fn arm_roots<W: Watcher>(
    watcher: &Mutex<RootWatchers<W>>,
    is_incomplete: &AtomicBool,
    roots: &[PathBuf],
    filter: &WalkFilter,
) -> Result<ArmedRoots, FileWatchError> {
    let mut armed = ArmedRoots {
        has_reached_ceiling: false,
        roots_at_ceiling: Vec::new(),
    };
    for root in roots {
        match lock(watcher).watch(root, ROOT_MODE) {
            Ok(()) => {}
            Err(error) if matches!(error.kind, ErrorKind::MaxFilesWatch) => {
                if !is_incomplete.swap(true, Ordering::AcqRel) {
                    log_watch_ceiling(Some(root), &error);
                }
                armed.has_reached_ceiling = true;
                armed.roots_at_ceiling.push(root.clone());
            }
            Err(source) => {
                return Err(FileWatchError::RootUnwatched {
                    root: root.clone(),
                    source,
                });
            }
        }
    }
    if WATCHES_TREES {
        return Ok(armed);
    }
    let mut failure = None;
    for root in roots
        .iter()
        .filter(|root| !armed.roots_at_ceiling.contains(root))
    {
        let request = WalkRequest {
            root: root.clone(),
            start: root.clone(),
            rearms_root: false,
            modified_since: None,
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
                    WalkOutput::CeilingReached => armed.has_reached_ceiling = true,
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
    Ok(armed)
}

/// Walks one request's tree with the filter, blocking: watches the root again first when asked,
/// watches each folder it keeps where the system watches one folder at a time, and hands every
/// entry to `sink` in chunks when `reports_entries`, the root itself aside, and for a rescan only
/// those modified at or after its instant. Stops when `sink` answers false.
pub(super) fn walk<W: Watcher>(
    request: &WalkRequest,
    filter: &WalkFilter,
    watcher: &Mutex<RootWatchers<W>>,
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
        if reports_entries && is_modified_since(entry.path(), request.modified_since) {
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

// Whether the entry at `path` was modified at or after `since`, read without following a link;
// true with no instant, and for an entry whose time cannot be read, which may have changed.
fn is_modified_since(path: &Path, since: Option<SystemTime>) -> bool {
    let Some(since) = since else {
        return true;
    };
    std::fs::symlink_metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_or(true, |modified| modified >= since)
}

// Watches one folder on its own; answers true the first time the system's ceiling refuses one,
// after which no folder is added.
fn arm_folder<W: Watcher>(
    watcher: &Mutex<RootWatchers<W>>,
    is_incomplete: &AtomicBool,
    folder: &Path,
) -> bool {
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

/// Logs that the system's ceiling on watches is reached at `folder`; the ceiling's figure is read
/// only for the log, since the refused watch is what says it is reached.
pub(super) fn log_watch_ceiling(folder: Option<&Path>, error: &notify::Error) {
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

/// The watches, locked; a watcher whose holder panicked is still whole, since each call on it
/// stands alone.
pub(super) fn lock<W>(watcher: &Mutex<W>) -> MutexGuard<'_, W> {
    watcher.lock().unwrap_or_else(PoisonError::into_inner)
}
