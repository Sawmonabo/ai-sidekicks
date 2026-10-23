//! The wake a channel folder's watch waits on, as Linux raises it: an inotify watch through
//! `notify`, `IN_MOVED_TO` on the folder and `IN_MODIFY` on a file.

use std::io;
use std::path::Path;

use notify::event::{ModifyKind, RenameMode};
use notify::{Config, EventKind, EventKindMask, INotifyWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

/// Raises a wake each time the watched folder or file changes as its watch asked.
pub(crate) struct ChangeWake {
    // Held so the watch stays on; dropping it ends the watch and its thread.
    _watcher: INotifyWatcher,
    // One pending wake stands for every change since the last read, or the watch's failure.
    wakes: mpsc::Receiver<notify::Result<()>>,
}

impl ChangeWake {
    /// Wakes when an entry is renamed into `folder`. Fails with the system's error when the folder
    /// cannot be watched.
    pub(crate) fn on_folder_renames(folder: &Path) -> io::Result<Self> {
        Self::on_path(folder, EventKindMask::CREATE, |kind| {
            matches!(kind, EventKind::Modify(ModifyKind::Name(RenameMode::To)))
        })
    }

    /// Wakes when the file at `path` is written. Fails with the system's error when the file
    /// cannot be watched.
    pub(crate) fn on_file_appends(path: &Path) -> io::Result<Self> {
        Self::on_path(path, EventKindMask::MODIFY_DATA, |kind| {
            matches!(kind, EventKind::Modify(ModifyKind::Data(_)))
        })
    }

    // A watch on `path` for the inotify events `kinds` asks for, waking on those `is_wake` keeps.
    fn on_path(
        path: &Path,
        kinds: EventKindMask,
        is_wake: fn(&EventKind) -> bool,
    ) -> io::Result<Self> {
        let (sender, wakes) = mpsc::channel(1);
        let mut watcher = INotifyWatcher::new(
            move |event: notify::Result<notify::Event>| match event {
                Ok(event) if is_wake(&event.kind) => {
                    // A full channel already holds a wake that covers this change.
                    if let Err(mpsc::error::TrySendError::Closed(_)) = sender.try_send(Ok(())) {
                        tracing::debug!("a channel watch's change came after its reader ended");
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    // A failure waits for room, so the reader always sees it.
                    if sender.blocking_send(Err(error)).is_err() {
                        tracing::debug!("a channel watch failed after its reader ended");
                    }
                }
            },
            Config::default().with_event_kinds(kinds),
        )
        .map_err(io::Error::other)?;
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        Ok(Self {
            _watcher: watcher,
            wakes,
        })
    }

    /// Completes at the next change, or at once when one came since the last call. Fails with
    /// `notify`'s error when the watch fails.
    pub(crate) async fn changed(&mut self) -> io::Result<()> {
        match self.wakes.recv().await {
            Some(wake) => wake.map_err(io::Error::other),
            None => Err(io::Error::other("the channel watch ended")),
        }
    }
}
