//! The watches one file watch holds: the system's own, and a poll for each root on a network file
//! system, whose changes made on another computer the system's feed may never tell.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{Config, PollWatcher, RecursiveMode, Watcher};

use super::ChangeFeed;

/// How often a root on a network file system is read again for changes.
pub(super) const NETWORK_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The system's watch, and, made at the first root that needs it, a poll of each root on a network
/// file system; both hand their events to the one feed.
pub(super) struct RootWatchers<W> {
    native: W,
    polling: Option<PollWatcher>,
    polled_roots: Vec<PathBuf>,
    feed: ChangeFeed,
    config: Config,
}

impl<W: Watcher> RootWatchers<W> {
    /// The system's watch made with `config`, both it and any poll handing events to `feed`.
    /// Fails when the system's watch cannot be made.
    pub(super) fn new(feed: ChangeFeed, config: Config) -> notify::Result<Self> {
        Ok(Self {
            native: W::new(feed.clone(), config)?,
            polling: None,
            polled_roots: Vec::new(),
            feed,
            config,
        })
    }

    /// Marks `root` as on a network file system, so it is polled rather than watched by the
    /// system; called before the root is first watched.
    pub(super) fn poll_root(&mut self, root: PathBuf) {
        self.polled_roots.push(root);
    }

    /// Watches `path`, a root or a folder under one, as `mode` asks: a polled root's whole tree in
    /// one poll, which already covers a folder under it, and any other path through the system's
    /// watch. Fails with the backend's refusal.
    pub(super) fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        let Some(polled_root) = self.polled_roots.iter().find(|root| path.starts_with(root)) else {
            return self.native.watch(path, mode);
        };
        if polled_root != path {
            return Ok(());
        }
        let polling = match &mut self.polling {
            Some(polling) => polling,
            empty => empty.insert(PollWatcher::new(
                self.feed.clone(),
                self.config.with_poll_interval(NETWORK_POLL_INTERVAL),
            )?),
        };
        polling.watch(path, RecursiveMode::Recursive)
    }
}
