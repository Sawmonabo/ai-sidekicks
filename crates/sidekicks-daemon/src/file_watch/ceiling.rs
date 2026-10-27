//! The system's ceiling on watches: what it refused, and the retry that watches it all again once
//! there is room, as often as the ceiling is reached.

use std::collections::BTreeSet;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Weak};
use std::time::{Duration, SystemTime};

use notify::{ErrorKind, Watcher};
use sidekicks_platforms::inotify_watch_ceiling;
use tokio_util::sync::CancellationToken;

use super::root_watchers::RootWatchers;
use super::walk::ROOT_MODE;
use super::whole_seconds_now;
use crate::file::bounded_read::run_on_own_thread;
use crate::mutex_lock::lock;

/// How long the watch waits after the ceiling refused a watch before it tries again.
pub(super) const CEILING_RETRY_WAIT: Duration = Duration::from_secs(5);

/// What the system's ceiling on watches refused since the last retry found room; while it holds a
/// root, the watch is incomplete and no further folder is watched.
#[derive(Debug, Default)]
pub(super) struct CeilingMisses {
    /// Each root a refused or skipped watch was under, its own watch or a folder's.
    pub(super) roots: BTreeSet<PathBuf>,
    /// The roots whose own watch was refused, watched first when a retry finds room.
    pub(super) unwatched_roots: BTreeSet<PathBuf>,
    /// The instant of the first refusal since the last retry, since which a change under those
    /// roots may have gone untold.
    pub(super) since: Option<SystemTime>,
}

impl CeilingMisses {
    /// Whether a watch was refused or skipped since the last retry found room.
    pub(super) fn is_incomplete(&self) -> bool {
        !self.roots.is_empty()
    }

    /// Records that a watch under `root` was refused or skipped, the root's own watch when
    /// `is_root_unwatched`; answers whether it is the first since the last retry found room.
    pub(super) fn record(&mut self, root: &Path, is_root_unwatched: bool) -> bool {
        let is_first = !self.is_incomplete();
        self.roots.insert(root.to_path_buf());
        if is_root_unwatched {
            self.unwatched_roots.insert(root.to_path_buf());
        }
        self.since.get_or_insert_with(whole_seconds_now);
        is_first
    }
}

/// How a retry after the ceiling ended.
pub(super) enum CeilingRetryOutcome {
    /// Every root the ceiling refused is watched now, so the roots it missed are walked again.
    Room,
    /// A root the ceiling refused was refused again for another reason.
    Unwatched {
        /// The root.
        root: PathBuf,
        /// The system's refusal.
        source: notify::Error,
    },
    /// The retry's thread could not run or stopped before it answered.
    Interrupted(io::Error),
}

/// Waits [`CEILING_RETRY_WAIT`], then watches each root the ceiling refused, waiting again while
/// the ceiling still refuses one; answers once every one is watched or another refusal stops it,
/// and `None` when `stop` comes or the watch is gone first.
pub(super) async fn retry_after_ceiling<W: Watcher + Send + 'static>(
    watcher: Weak<Mutex<RootWatchers<W>>>,
    misses: Weak<Mutex<CeilingMisses>>,
    stop: CancellationToken,
) -> Option<CeilingRetryOutcome> {
    loop {
        tokio::select! {
            () = stop.cancelled() => return None,
            () = tokio::time::sleep(CEILING_RETRY_WAIT) => {}
        }
        let (Some(watcher), Some(misses)) = (watcher.upgrade(), misses.upgrade()) else {
            return None;
        };
        let tried = run_on_own_thread("file watch ceiling retry", move || {
            let unwatched_roots: Vec<PathBuf> =
                lock(&misses).unwatched_roots.iter().cloned().collect();
            for root in unwatched_roots {
                match lock(&watcher).watch(&root, ROOT_MODE) {
                    Ok(()) => {
                        lock(&misses).unwatched_roots.remove(&root);
                    }
                    Err(error) if matches!(error.kind, ErrorKind::MaxFilesWatch) => return None,
                    Err(source) => return Some(CeilingRetryOutcome::Unwatched { root, source }),
                }
            }
            Some(CeilingRetryOutcome::Room)
        })
        .await;
        match tried {
            Ok(Some(outcome)) => return Some(outcome),
            // Still no room.
            Ok(None) => {}
            Err(failure) => return Some(CeilingRetryOutcome::Interrupted(failure)),
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
            "the system's ceiling on watched folders is reached; folders past it are watched once \
             there is room"
        ),
        Err(ceiling_error) => tracing::warn!(
            error = error as &(dyn Error + 'static),
            ceiling_error = &ceiling_error as &(dyn Error + 'static),
            ?folder,
            "the system's ceiling on watched folders is reached; folders past it are watched once \
             there is room"
        ),
    }
}
