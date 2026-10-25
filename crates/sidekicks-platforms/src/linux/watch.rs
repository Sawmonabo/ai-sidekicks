//! The wake a folder's arrival watch and a file's append watch wait on, as Linux raises it: an
//! inotify watch through `notify`, `IN_MOVED_TO` on the folder, which `IN_DELETE_SELF` or
//! `IN_MOVE_SELF` ends, and `IN_MODIFY` on an open file's inode, whatever becomes of its name; a
//! folder's wake is waited for on a runtime or, for a caller with no runtime, on the calling
//! thread.

use std::fs::File;
use std::io::{self, ErrorKind};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::mpsc as thread_channel;
use std::time::Duration;

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
        Self::on_path(folder, FOLDER_RENAME_KINDS, is_rename_into)
    }

    /// Wakes when the open `file` is written, after its name is removed or replaced too. Fails
    /// with the system's error when the file cannot be watched.
    pub(crate) fn on_file_appends(file: &File) -> io::Result<Self> {
        // The kernel follows the descriptor's own link to the open file, whatever its name holds.
        let descriptor_path = format!("/proc/self/fd/{}", file.as_raw_fd());
        Self::on_path(
            Path::new(&descriptor_path),
            EventKindMask::MODIFY_DATA,
            |kind| matches!(kind, EventKind::Modify(ModifyKind::Data(_))),
        )
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
        let watcher = watch_path(path, kinds, is_wake, sender)?;
        Ok(Self {
            _watcher: watcher,
            wakes,
        })
    }

    /// Completes at the next change, or at once when one came since the last call. Fails with
    /// `notify`'s error when the watch fails, and with `NotFound` once the watched folder is
    /// removed or renamed away.
    pub(crate) async fn changed(&mut self) -> io::Result<()> {
        match self.wakes.recv().await {
            Some(wake) => wake,
            None => Err(watch_ended()),
        }
    }
}

/// Raises a wake each time an entry is renamed into the watched folder, waited for on the calling
/// thread.
pub(crate) struct BlockingChangeWake {
    // Held so the watch stays on; dropping it ends the watch and its thread.
    _watcher: INotifyWatcher,
    // One pending wake stands for every change since the last read, or the watch's failure.
    wakes: thread_channel::Receiver<io::Result<()>>,
}

impl BlockingChangeWake {
    /// Wakes when an entry is renamed into `folder`. Fails with the system's error when the folder
    /// cannot be watched.
    pub(crate) fn on_folder_renames(folder: &Path) -> io::Result<Self> {
        let (sender, wakes) = thread_channel::sync_channel(1);
        let watcher = watch_path(folder, FOLDER_RENAME_KINDS, is_rename_into, sender)?;
        Ok(Self {
            _watcher: watcher,
            wakes,
        })
    }

    /// Waits for the next change, or answers at once when one came since the last call; `false`
    /// when `timeout` passes first, and never so without one. Fails with `notify`'s error when the
    /// watch fails, and with `NotFound` once the folder is removed or renamed away.
    pub(crate) fn changed(&mut self, timeout: Option<Duration>) -> io::Result<bool> {
        let wake = match timeout {
            Some(timeout) => match self.wakes.recv_timeout(timeout) {
                Ok(wake) => wake,
                Err(thread_channel::RecvTimeoutError::Timeout) => return Ok(false),
                Err(thread_channel::RecvTimeoutError::Disconnected) => return Err(watch_ended()),
            },
            None => self
                .wakes
                .recv()
                .map_err(|thread_channel::RecvError| watch_ended())?,
        };
        wake.map(|()| true)
    }
}

// The kinds a folder's rename watch asks for: `CREATE` asks the kernel for `IN_MOVED_TO`, which
// `notify` hands on as a rename's `Modify(Name(To))`, so `MODIFY_NAME` must pass its own filter
// too.
const FOLDER_RENAME_KINDS: EventKindMask = EventKindMask::CREATE
    .union(EventKindMask::MODIFY_NAME)
    .union(ENDING_KINDS);

// Whether `kind` is an entry renamed into the watched folder.
fn is_rename_into(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Modify(ModifyKind::Name(RenameMode::To)))
}

fn watch_ended() -> io::Error {
    io::Error::other("the folder or file watch ended")
}

// Where a watch hands its wakes: one waiting wake stands for every change since the last read,
// and a failure waits for room, so the reader always sees it.
trait WakeSender: Send + 'static {
    // Hands on a wake; `false` once the reader is gone.
    fn send_wake(&self) -> bool;
    // Hands on the watch's failure; `false` once the reader is gone.
    fn send_failure(&self, failure: io::Error) -> bool;
}

impl WakeSender for mpsc::Sender<io::Result<()>> {
    fn send_wake(&self) -> bool {
        !matches!(
            self.try_send(Ok(())),
            Err(mpsc::error::TrySendError::Closed(_))
        )
    }

    fn send_failure(&self, failure: io::Error) -> bool {
        self.blocking_send(Err(failure)).is_ok()
    }
}

impl WakeSender for thread_channel::SyncSender<io::Result<()>> {
    fn send_wake(&self) -> bool {
        !matches!(
            self.try_send(Ok(())),
            Err(thread_channel::TrySendError::Disconnected(_))
        )
    }

    fn send_failure(&self, failure: io::Error) -> bool {
        self.send(Err(failure)).is_ok()
    }
}

// An inotify watch on `path` for the events `kinds` asks for, handing `sender` a wake on those
// `is_wake` keeps and on a lost-events notice, and a failure once `path` itself is removed or
// renamed away when `kinds` asks for those, or once the watch fails.
fn watch_path(
    path: &Path,
    kinds: EventKindMask,
    is_wake: fn(&EventKind) -> bool,
    sender: impl WakeSender,
) -> io::Result<INotifyWatcher> {
    let watched = path.to_path_buf();
    let mut watcher = INotifyWatcher::new(
        move |event: notify::Result<Event>| match event {
            Ok(event) if is_watched_path_gone(&event, &watched) => {
                let ended = io::Error::new(
                    ErrorKind::NotFound,
                    "the watched folder or file was removed or renamed",
                );
                if !sender.send_failure(ended) {
                    tracing::debug!("a watch's folder or file ended after its reader ended");
                }
            }
            Ok(event) if event.need_rescan() || is_wake(&event.kind) => {
                if !sender.send_wake() {
                    tracing::debug!("a watch's change came after its reader ended");
                }
            }
            Ok(_) => {}
            Err(error) => {
                if !sender.send_failure(io::Error::other(error)) {
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
    Ok(watcher)
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
