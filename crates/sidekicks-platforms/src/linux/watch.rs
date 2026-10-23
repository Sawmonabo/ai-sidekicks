//! The wake a folder's arrival watch and a file's append watch wait on, as Linux raises it: an
//! inotify watch through `notify`, `IN_MOVED_TO` on the folder, which `IN_DELETE_SELF` or
//! `IN_MOVE_SELF` ends, and `IN_MODIFY` on a file's inode, whatever becomes of its name.

use std::io::{self, ErrorKind};
use std::path::Path;

use notify::event::{ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, EventKindMask, INotifyWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

// The kinds that carry the watched folder's own end: `notify` reports `IN_DELETE_SELF` as a removal
// and `IN_MOVE_SELF` as a rename, each at the watched path itself.
const ENDING_KINDS: EventKindMask = EventKindMask::REMOVE.union(EventKindMask::MODIFY_NAME);

/// Raises a wake each time the watched folder or file changes as its watch asked.
pub(crate) struct ChangeWake {
    // Held so the watch stays on; dropping it ends the watch and its thread.
    _watcher: INotifyWatcher,
    // One pending wake stands for every change since the last read, or the watch's failure.
    wakes: mpsc::Receiver<io::Result<()>>,
}

impl ChangeWake {
    /// Wakes when an entry is renamed into `folder`. Fails with the system's error when the folder
    /// cannot be watched.
    pub(crate) fn on_folder_renames(folder: &Path) -> io::Result<Self> {
        // `CREATE` asks the kernel for `IN_MOVED_TO`, which `notify` hands on as a rename's
        // `Modify(Name(To))`, so `MODIFY_NAME` must pass its own filter too.
        let kinds = EventKindMask::CREATE | EventKindMask::MODIFY_NAME | ENDING_KINDS;
        Self::on_path(folder, kinds, |kind| {
            matches!(kind, EventKind::Modify(ModifyKind::Name(RenameMode::To)))
        })
    }

    /// Wakes when the file at `path` is written, after its name is removed or replaced too. Fails
    /// with the system's error when the file cannot be watched.
    pub(crate) fn on_file_appends(path: &Path) -> io::Result<Self> {
        Self::on_path(path, EventKindMask::MODIFY_DATA, |kind| {
            matches!(kind, EventKind::Modify(ModifyKind::Data(_)))
        })
    }

    // A watch on `path` for the inotify events `kinds` asks for, waking on those `is_wake` keeps
    // and on a lost-events notice, and failing once `path` itself is removed or renamed away when
    // `kinds` asks for those.
    fn on_path(
        path: &Path,
        kinds: EventKindMask,
        is_wake: fn(&EventKind) -> bool,
    ) -> io::Result<Self> {
        let (sender, wakes) = mpsc::channel(1);
        let watched = path.to_path_buf();
        let mut watcher = INotifyWatcher::new(
            move |event: notify::Result<Event>| match event {
                Ok(event) if is_watched_path_gone(&event, &watched) => {
                    let ended = io::Error::new(
                        ErrorKind::NotFound,
                        "the watched folder or file was removed or renamed",
                    );
                    // A failure waits for room, so the reader always sees it.
                    if sender.blocking_send(Err(ended)).is_err() {
                        tracing::debug!("a watch's folder or file ended after its reader ended");
                    }
                }
                Ok(event) if event.need_rescan() || is_wake(&event.kind) => {
                    // A full channel already holds a wake that covers this change.
                    if let Err(mpsc::error::TrySendError::Closed(_)) = sender.try_send(Ok(())) {
                        tracing::debug!("a watch's change came after its reader ended");
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    // A failure waits for room, so the reader always sees it.
                    if sender.blocking_send(Err(io::Error::other(error))).is_err() {
                        tracing::debug!("a folder or file watch failed after its reader ended");
                    }
                }
            },
            Config::default().with_event_kinds(kinds),
        )
        .map_err(io::Error::other)?;
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|error| {
                // A path already gone fails as opening it would.
                if matches!(error.kind, notify::ErrorKind::PathNotFound) {
                    io::Error::new(ErrorKind::NotFound, error)
                } else {
                    io::Error::other(error)
                }
            })?;
        Ok(Self {
            _watcher: watcher,
            wakes,
        })
    }

    /// Completes at the next change, or at once when one came since the last call. Fails with
    /// `notify`'s error when the watch fails, and with `NotFound` once the watched folder is removed
    /// or renamed away.
    pub(crate) async fn changed(&mut self) -> io::Result<()> {
        match self.wakes.recv().await {
            Some(wake) => wake,
            None => Err(io::Error::other("the folder or file watch ended")),
        }
    }
}

// Whether `event` is the watched path's own removal or rename, which `notify` reports at the path
// itself, where an entry's inside a folder carries the entry's path.
fn is_watched_path_gone(event: &Event, watched: &Path) -> bool {
    matches!(event.paths.as_slice(), [path] if path == watched)
        && matches!(
            event.kind,
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        )
}
