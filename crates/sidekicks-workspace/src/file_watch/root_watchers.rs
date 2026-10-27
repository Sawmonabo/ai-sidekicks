//! The watches one file watch holds: the system's own, and a poll of each folder under a root on a
//! network file system, whose changes made on another computer the system's feed may never tell.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, PollWatcher, RecursiveMode, Watcher};
use sidekicks_platforms::WATCHES_TREES;

use super::ChangeFeed;

/// How often a folder under a root on a network file system is read again for changes.
pub(super) const NETWORK_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Whether each folder under `root` takes a watch of its own: on a system that watches one folder
/// at a time, and under a root in `polled_roots`, whose poll reads each folder it holds one level
/// deep, so a folder the walk filter refuses is never read.
pub(super) fn arms_each_folder(polled_roots: &[PathBuf], root: &Path) -> bool {
    !WATCHES_TREES || polled_roots.iter().any(|polled| polled == root)
}

/// The system's watch, and, made at the first folder that needs it, a poll of each folder under a
/// root on a network file system; both hand their events to the one feed.
pub(super) struct RootWatchers<W> {
    native: W,
    polling: Option<PollWatcher>,
    polled_roots: Arc<[PathBuf]>,
    // Each folder the poll reads, so a folder watched again keeps the poll's model of it.
    polled_folders: HashSet<PathBuf>,
    feed: ChangeFeed,
    config: Config,
}

impl<W: Watcher> RootWatchers<W> {
    /// The system's watch made with `config`, both it and any poll handing events to `feed`, with
    /// every path under `polled_roots` polled rather than watched by the system. Fails when the
    /// system's watch cannot be made.
    pub(super) fn new(
        feed: ChangeFeed,
        config: Config,
        polled_roots: Arc<[PathBuf]>,
    ) -> notify::Result<Self> {
        Ok(Self {
            native: W::new(feed.clone(), config)?,
            polling: None,
            polled_roots,
            polled_folders: HashSet::new(),
            feed,
            config,
        })
    }

    /// Whether each folder under `root` takes a watch of its own; see [`arms_each_folder`].
    pub(super) fn arms_each_folder(&self, root: &Path) -> bool {
        arms_each_folder(&self.polled_roots, root)
    }

    /// Watches `path`, a root or a folder under one: a folder under a polled root by the poll, one
    /// level deep and only once, since a poll's watch cannot lapse and a second would replace the
    /// poll's model of the folder, and any other path through the system's watch as `mode` asks.
    /// Fails with the backend's refusal.
    pub(super) fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        if !self
            .polled_roots
            .iter()
            .any(|polled| path.starts_with(polled))
        {
            return self.native.watch(path, mode);
        }
        if self.polled_folders.contains(path) {
            return Ok(());
        }
        let polling = match &mut self.polling {
            Some(polling) => polling,
            empty => empty.insert(PollWatcher::new(
                self.feed.clone(),
                self.config.with_poll_interval(NETWORK_POLL_INTERVAL),
            )?),
        };
        polling.watch(path, RecursiveMode::NonRecursive)?;
        self.polled_folders.insert(path.to_path_buf());
        Ok(())
    }

    /// Stops polling `folder`, a folder under a polled root that is gone, so its poll stops
    /// reporting that it cannot be read. Fails with the poll's refusal.
    pub(super) fn forget_polled_folder(&mut self, folder: &Path) -> notify::Result<()> {
        if !self.polled_folders.remove(folder) {
            return Ok(());
        }
        match &mut self.polling {
            Some(polling) => polling.unwatch(folder),
            None => Ok(()),
        }
    }
}
