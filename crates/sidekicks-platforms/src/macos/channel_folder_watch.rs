//! The wake a channel folder's watch waits on, as macOS raises it: a kqueue vnode filter on the
//! folder or the file, whose queue tokio's reactor waits on without a thread of its own.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent, Kqueue};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

// How many events one drain of the queue reads; the vnode filter clears on read, so one entry
// holds all that a watched file raised.
const DRAINED_EVENTS: usize = 4;

// A queue read that hands back what is pending and never waits; the reactor does the waiting.
const NO_WAIT: libc::timespec = libc::timespec {
    tv_sec: 0,
    tv_nsec: 0,
};

/// Raises a wake each time the watched folder or file changes as its watch asked.
pub(crate) struct ChangeWake {
    queue: AsyncFd<WatchQueue>,
    // The descriptor the filter watches, which only marks the vnode and stays open as long.
    _watched: File,
}

// A kqueue the reactor can wait on.
struct WatchQueue(Kqueue);

impl AsRawFd for WatchQueue {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

impl ChangeWake {
    /// Wakes when `folder`'s entries change, as a rename into it changes them. Needs a tokio
    /// runtime's reactor; fails with the system's error when the folder cannot be opened or watched.
    pub(crate) fn on_folder_renames(folder: &Path) -> io::Result<Self> {
        Self::on_vnode(folder, FilterFlag::NOTE_WRITE)
    }

    /// Wakes when the file at `path` grows or is written. Needs a tokio runtime's reactor; fails with the
    /// system's error when the file cannot be opened or watched.
    pub(crate) fn on_file_appends(path: &Path) -> io::Result<Self> {
        Self::on_vnode(path, FilterFlag::NOTE_EXTEND | FilterFlag::NOTE_WRITE)
    }

    // A vnode filter for `changes` on `path`, opened only to be watched.
    fn on_vnode(path: &Path, changes: FilterFlag) -> io::Result<Self> {
        let watched = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_EVTONLY)
            .open(path)?;
        let queue = Kqueue::new().map_err(io::Error::from)?;
        let filter = KEvent::new(
            usize::try_from(watched.as_raw_fd()).map_err(io::Error::other)?,
            EventFilter::EVFILT_VNODE,
            EvFlags::EV_ADD | EvFlags::EV_CLEAR,
            changes,
            0,
            0,
        );
        queue
            .kevent(&[filter], &mut [], None)
            .map_err(io::Error::from)?;
        // SAFETY: the queue's descriptor stays open for as long as the `AsyncFd` owns the queue, and
        // `as_raw_fd` answers that one descriptor every time. Readable alone, since a kqueue takes
        // no write filter.
        let queue =
            unsafe { AsyncFd::register_with_interest(WatchQueue(queue), Interest::READABLE) }
                .map_err(io::Error::from)?;
        Ok(Self {
            queue,
            _watched: watched,
        })
    }

    /// Completes at the next change, or at once when one came since the last call. Fails with the
    /// system's error when the queue cannot be read.
    pub(crate) async fn changed(&mut self) -> io::Result<()> {
        loop {
            let mut ready = self.queue.readable().await?;
            let mut events = [KEvent::new(
                0,
                EventFilter::EVFILT_VNODE,
                EvFlags::empty(),
                FilterFlag::empty(),
                0,
                0,
            ); DRAINED_EVENTS];
            let count = ready
                .get_inner()
                .0
                .kevent(&[], &mut events, Some(NO_WAIT))
                .map_err(io::Error::from)?;
            ready.clear_ready();
            if count > 0 {
                return Ok(());
            }
        }
    }
}
