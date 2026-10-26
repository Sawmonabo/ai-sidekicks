//! The wake a folder's arrival watch and a file's append watch wait on, as macOS raises it: a
//! kqueue vnode filter on the folder or the file, whose queue tokio's reactor waits on without a
//! thread of its own, or the calling thread waits on for a caller with no runtime.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::Duration;

use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent, Kqueue};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

// How many events one drain of the queue reads; the vnode filter clears on read, so one entry
// holds all that a watched file raised.
const DRAINED_EVENTS: usize = 4;

// The changes that end a watch: the watched folder removed or renamed away, or the file system of
// the watched folder or file unmounted.
const ENDING_CHANGES: FilterFlag = FilterFlag::NOTE_DELETE
    .union(FilterFlag::NOTE_RENAME)
    .union(FilterFlag::NOTE_REVOKE);

// A queue read that hands back what is pending and never waits; the reactor does the waiting.
const NO_WAIT: libc::timespec = libc::timespec {
    tv_sec: 0,
    tv_nsec: 0,
};

/// Raises a wake each time the watched folder or file changes as its watch asked.
pub(crate) struct ChangeWake {
    queue: AsyncFd<WatchQueue>,
    // The changes this watch asked for that end it.
    endings: FilterFlag,
    // The folder's descriptor the filter watches, which only marks its vnode and stays open as
    // long; a file's watch is on the descriptor its reader holds.
    _watched_folder: Option<File>,
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
    /// runtime's reactor; fails with the system's error when the folder cannot be opened or
    /// watched.
    pub(crate) fn on_folder_renames(folder: &Path) -> io::Result<Self> {
        let watched = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_EVTONLY)
            .open(folder)?;
        Self::on_vnode(
            watched.as_raw_fd(),
            FilterFlag::NOTE_WRITE | ENDING_CHANGES,
            Some(watched),
        )
    }

    /// Wakes when the open `file` grows or is written, after its name is removed or replaced too.
    /// Needs a tokio runtime's reactor; fails with the system's error when the file cannot be
    /// watched.
    pub(crate) fn on_file_appends(file: &File) -> io::Result<Self> {
        Self::on_vnode(
            file.as_raw_fd(),
            FilterFlag::NOTE_EXTEND | FilterFlag::NOTE_WRITE | FilterFlag::NOTE_REVOKE,
            None,
        )
    }

    // A vnode filter for `changes` on `descriptor`, which `watched_folder` holds open when the
    // watch opened it.
    fn on_vnode(
        descriptor: RawFd,
        changes: FilterFlag,
        watched_folder: Option<File>,
    ) -> io::Result<Self> {
        let queue = vnode_queue(descriptor, changes)?;
        // SAFETY: the queue's descriptor stays open for as long as the `AsyncFd` owns the queue,
        // and `as_raw_fd` answers that one descriptor every time. Readable alone, since a kqueue
        // takes no write filter.
        let queue =
            unsafe { AsyncFd::register_with_interest(WatchQueue(queue), Interest::READABLE) }
                .map_err(io::Error::from)?;
        Ok(Self {
            queue,
            endings: changes & ENDING_CHANGES,
            _watched_folder: watched_folder,
        })
    }

    /// Completes at the next change, or at once when one came since the last call. Fails with the
    /// system's error when the queue cannot be read, and with `NotFound` once a change this watch
    /// ends on comes: its folder removed or renamed away, or its file system unmounted.
    pub(crate) async fn changed(&mut self) -> io::Result<()> {
        loop {
            let mut ready = self.queue.readable().await?;
            let count = read_changes(&ready.get_inner().0, Some(NO_WAIT), self.endings)?;
            ready.clear_ready();
            if count > 0 {
                return Ok(());
            }
        }
    }
}

/// Raises a wake each time the watched folder's entries change, waited for on the calling thread.
pub(crate) struct BlockingChangeWake {
    queue: Kqueue,
    // The folder's descriptor the filter watches, open as long as the watch.
    _watched_folder: File,
}

impl BlockingChangeWake {
    /// Wakes when `folder`'s entries change, as a rename into it changes them. Fails with the
    /// system's error when the folder cannot be opened or watched.
    pub(crate) fn on_folder_renames(folder: &Path) -> io::Result<Self> {
        let watched = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_EVTONLY)
            .open(folder)?;
        let queue = vnode_queue(watched.as_raw_fd(), FilterFlag::NOTE_WRITE | ENDING_CHANGES)?;
        Ok(Self {
            queue,
            _watched_folder: watched,
        })
    }

    /// Waits for the next change, or answers at once when one came since the last call; `false`
    /// when `timeout` passes first, and never so without one; a wait a signal cuts short answers
    /// `true`, which may hold no change. Fails with the system's error when
    /// the queue cannot be read, and with `NotFound` once the folder is removed, renamed away or
    /// unmounted.
    pub(crate) fn changed(&mut self, timeout: Option<Duration>) -> io::Result<bool> {
        let timeout = timeout.map(|timeout| libc::timespec {
            tv_sec: libc::time_t::try_from(timeout.as_secs()).unwrap_or(libc::time_t::MAX),
            tv_nsec: libc::c_long::from(timeout.subsec_nanos()),
        });
        match read_changes(&self.queue, timeout, ENDING_CHANGES) {
            Ok(count) => Ok(count > 0),
            // A signal that cut the wait short is taken as a wake, so the caller lists again.
            Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(true),
            Err(error) => Err(error),
        }
    }
}

// A queue holding a vnode filter for `changes` on `descriptor`.
fn vnode_queue(descriptor: RawFd, changes: FilterFlag) -> io::Result<Kqueue> {
    let queue = Kqueue::new().map_err(io::Error::from)?;
    let filter = KEvent::new(
        usize::try_from(descriptor).map_err(io::Error::other)?,
        EventFilter::EVFILT_VNODE,
        EvFlags::EV_ADD | EvFlags::EV_CLEAR,
        changes,
        0,
        0,
    );
    queue
        .kevent(&[filter], &mut [], None)
        .map_err(io::Error::from)?;
    Ok(queue)
}

// Reads the changes `queue` holds, waiting at most `timeout` for one, and answers how many entries
// it read; fails with `NotFound` once one of `endings` came.
fn read_changes(
    queue: &Kqueue,
    timeout: Option<libc::timespec>,
    endings: FilterFlag,
) -> io::Result<usize> {
    let mut events = [KEvent::new(
        0,
        EventFilter::EVFILT_VNODE,
        EvFlags::empty(),
        FilterFlag::empty(),
        0,
        0,
    ); DRAINED_EVENTS];
    let count = queue
        .kevent(&[], &mut events, timeout)
        .map_err(io::Error::from)?;
    let drained = events.get(..count).unwrap_or(&events);
    if drained
        .iter()
        .any(|event| event.fflags().intersects(endings))
    {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "the watched folder or file was removed, renamed or unmounted",
        ));
    }
    Ok(count)
}
