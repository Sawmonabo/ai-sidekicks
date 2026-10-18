//! The process at the other end of a local connection on Linux, pinned by a process descriptor the
//! kernel recorded at the connect, and a pinned process's parent, pinned the same way; a pinned
//! process's record and its re-pin, and its stop. A process id can be taken by a new process once
//! its holder is reaped; a descriptor never moves to another process, so each read is checked
//! against it and each signal is sent through it.

use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::sync::Arc;
use std::time::Duration;

use interprocess::local_socket::tokio::Stream;
use nix::sys::signal::Signal;
use polling::{Event, Poller};

use crate::caller_process::{PARENT_READ_ATTEMPTS, ParentProcess, ProcessRecord};
use crate::child_command::ChildEnd;
use crate::linux::read_process_stat_field;
use crate::posix::process_stop::{stop_pinned_process, wait_for_event};

// The stat file's field holding the parent's id.
const PARENT_FIELD: usize = 4;

// The stat file's field holding the process's start, in clock ticks since boot.
const START_FIELD: usize = 22;

// The key a stop registers the process's exit under, the only source its poller watches.
const EXIT_KEY: usize = 0;

// The line of a process descriptor's fdinfo file naming its process: `-1` once it is reaped, `0`
// when it lies outside this process's pid namespace.
const FDINFO_PROCESS_PREFIX: &str = "Pid:";

/// A process held by its process descriptor, so a read made through it names that process or
/// finds it ended, never another process given its id.
#[derive(Clone, Debug)]
pub struct PinnedProcess {
    id: u32,
    descriptor: Arc<OwnedFd>,
}

impl PinnedProcess {
    /// The process's id, as this process's pid namespace numbers it.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The record a later process re-pins this one from; `None` once it has been reaped. Fails
    /// with the system's error, and with `InvalidData` for a stat file whose start does not read.
    pub fn record(&self) -> io::Result<Option<ProcessRecord>> {
        let Some(start) = read_process_stat_field(self.id, START_FIELD)? else {
            return Ok(None);
        };
        // The stat file names this process only if its descriptor still names a live one after it.
        if descriptor_process_id(self.descriptor.as_raw_fd())?.is_none() {
            return Ok(None);
        }
        let start = start
            .parse()
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
        Ok(Some(ProcessRecord::new(self.id, start)))
    }

    /// Stops the process: `SIGTERM` through its descriptor, so no process given its id meanwhile is
    /// signaled, then `SIGKILL` once `grace` passes without its exit; blocking, so it runs in
    /// `spawn_blocking`. Answers the end that took effect, [`ChildEnd::Stop`] for a process already
    /// gone; fails with `TimedOut` when it outlives the kill's bound, else with the system's error.
    pub fn stop(&self, grace: Duration) -> io::Result<ChildEnd> {
        stop_pinned_process(
            grace,
            |signal| self.send_signal(signal),
            |bound| self.wait_for_exit(bound),
        )
    }

    // Sends `signal` through the descriptor; `false` when the process has already ended.
    fn send_signal(&self, signal: Signal) -> io::Result<bool> {
        // SAFETY: the descriptor stays open while `self` lives, and the call takes it, a signal
        // number, no signal information and no flags.
        let status = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.descriptor.as_raw_fd(),
                signal as libc::c_int,
                std::ptr::null::<libc::siginfo_t>(),
                0_u32,
            )
        };
        if status == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
        Err(error)
    }

    // Waits up to `bound` for the descriptor to read ready, which it does once the process has
    // exited, an exit before the wait included; answers whether it did.
    fn wait_for_exit(&self, bound: Duration) -> io::Result<bool> {
        let poller = Poller::new()?;
        // SAFETY: the descriptor is held by `self`, which outlives the poller made in this call.
        unsafe { poller.add(&*self.descriptor, Event::readable(EXIT_KEY)) }?;
        wait_for_event(&poller, bound)
    }
}

impl ProcessRecord {
    /// The process this record names, pinned; `None` when it has ended or its id now names another
    /// process. Fails with the system's error.
    pub fn pin(self) -> io::Result<Option<PinnedProcess>> {
        let descriptor = match open_process_descriptor(self.id()) {
            Ok(descriptor) => descriptor,
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(None),
            Err(error) => return Err(error),
        };
        let process = PinnedProcess {
            id: self.id(),
            descriptor: Arc::new(descriptor),
        };
        // A start read after the open that matches the record names the recorded process, which
        // then also held the id at the open, since no later process carries its start.
        Ok(process
            .record()?
            .filter(|record| *record == self)
            .map(|_| process))
    }
}

/// The caller's own child `id`, pinned; the child is not yet reaped, so no other process can take
/// its id meanwhile. Fails with `ESRCH` when no process has the id, else with the system's error.
pub fn pin_child_process(id: u32) -> io::Result<PinnedProcess> {
    Ok(PinnedProcess {
        id,
        descriptor: Arc::new(open_process_descriptor(id)?),
    })
}

/// The process at the other end of `stream`, the one that connected (or listened, on a socket the
/// daemon dialed), pinned by the descriptor the kernel took at the connect. `None` when that
/// process has been reaped; fails with the system's error otherwise, `ENOPROTOOPT` on a kernel
/// before 6.5, which records no descriptor, and `Other` for a process outside this pid namespace.
pub fn read_peer_process(stream: &Stream) -> io::Result<Option<PinnedProcess>> {
    let Stream::UdSocket(socket) = stream;
    let mut descriptor: libc::c_int = -1;
    let mut length = libc::socklen_t::try_from(size_of::<libc::c_int>())
        .expect("an int's size fits in a socklen_t");
    // SAFETY: the socket is open for the call, and the buffer is a live `c_int` of the length
    // given, which the call fills with a new descriptor this process then owns.
    let status = unsafe {
        libc::getsockopt(
            socket.inner().as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERPIDFD,
            (&raw mut descriptor).cast(),
            &raw mut length,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        // Kernels before 6.16 refuse a peer already reaped with `EINVAL`.
        if error.raw_os_error() == Some(libc::EINVAL) {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: the call succeeded, so `descriptor` is a new open descriptor nothing else owns.
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let Some(id) = descriptor_process_id(descriptor.as_raw_fd())? else {
        return Ok(None);
    };
    Ok(Some(PinnedProcess {
        id,
        descriptor: Arc::new(descriptor),
    }))
}

/// `process`'s parent, pinned: its id is read, the parent's descriptor opened, then the
/// process's parent read again, and only an unchanged id is taken, since a parent's exit moves its
/// children to another parent before its id can be reused. Fails with the system's error, and with
/// `Other` when the parent kept changing.
pub fn read_parent_process(process: &PinnedProcess) -> io::Result<ParentProcess> {
    for _ in 0..PARENT_READ_ATTEMPTS {
        let Some(parent_id) = read_parent_id(process)? else {
            return Ok(ParentProcess::Ended);
        };
        if parent_id == 0 {
            return Ok(ParentProcess::Root);
        }
        let parent = match open_process_descriptor(parent_id) {
            Ok(parent) => parent,
            // The parent ended between the reads; the process has a new one.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => continue,
            Err(error) => return Err(error),
        };
        match read_parent_id(process)? {
            None => return Ok(ParentProcess::Ended),
            Some(again) if again == parent_id => {
                return Ok(ParentProcess::Pinned(PinnedProcess {
                    id: parent_id,
                    descriptor: Arc::new(parent),
                }));
            }
            Some(_) => {}
        }
    }
    Err(io::Error::other(
        "the process's parent kept changing while it was read",
    ))
}

/// This process, pinned.
#[cfg(any(test, feature = "test-support"))]
pub fn this_process() -> PinnedProcess {
    let id = std::process::id();
    PinnedProcess {
        id,
        descriptor: Arc::new(
            open_process_descriptor(id).expect("this process opens its own descriptor"),
        ),
    }
}

/// `process`'s parent's id from its stat file, `None` once it has been reaped. The read names
/// `process` only if its descriptor still names a live process after it, so that is checked.
fn read_parent_id(process: &PinnedProcess) -> io::Result<Option<u32>> {
    let Some(parent) = read_process_stat_field(process.id, PARENT_FIELD)? else {
        return Ok(None);
    };
    if descriptor_process_id(process.descriptor.as_raw_fd())?.is_none() {
        return Ok(None);
    }
    parent
        .parse()
        .map(Some)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

/// The id of the process `descriptor` holds, from its fdinfo file; `None` once it is reaped. Fails
/// with `Other` for a process outside this pid namespace, and `InvalidData` for a file with no id.
fn descriptor_process_id(descriptor: RawFd) -> io::Result<Option<u32>> {
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{descriptor}"))?;
    let invalid = || {
        io::Error::new(
            ErrorKind::InvalidData,
            "a process descriptor's fdinfo names no process",
        )
    };
    let id: i64 = fdinfo
        .lines()
        .find_map(|line| line.strip_prefix(FDINFO_PROCESS_PREFIX))
        .ok_or_else(invalid)?
        .trim()
        .parse()
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
    match id {
        -1 => Ok(None),
        0 => Err(io::Error::other(
            "the process lies outside this pid namespace",
        )),
        id => u32::try_from(id)
            .map(Some)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error)),
    }
}

/// A new descriptor holding process `id`. Fails with `ESRCH` when no process has the id, and with
/// `InvalidInput` for an id past `i32::MAX`, which no process has.
pub(crate) fn open_process_descriptor(id: u32) -> io::Result<OwnedFd> {
    let pid = libc::pid_t::try_from(id)
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
    // SAFETY: `pidfd_open` takes a pid and no flags and returns a new descriptor or -1.
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let descriptor = RawFd::try_from(descriptor).map_err(io::Error::other)?;
    // SAFETY: the call succeeded, so `descriptor` is a new open descriptor nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(test)]
mod tests {
    use interprocess::local_socket::tokio::Stream;
    use interprocess::os::unix::uds_local_socket::tokio::Stream as UnixSocketStream;

    use std::sync::Arc;

    use super::{PinnedProcess, open_process_descriptor, read_parent_process, read_peer_process};
    use crate::caller_process::ParentProcess;

    #[test]
    fn pins_this_process_as_its_own_peer_and_its_parent_until_each_ends() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .expect("a runtime");
        let _entered = runtime.enter();
        let (near, far) = tokio::net::UnixStream::pair().expect("a connected socket pair");
        let stream = Stream::from(UnixSocketStream::from(near));

        let peer = read_peer_process(&stream)
            .expect("the peer reads")
            .expect("the peer runs");
        assert_eq!(peer.id(), std::process::id());
        // The descriptor recorded at the connect outlives the other end.
        drop(far);
        assert!(
            read_peer_process(&stream)
                .expect("a closed peer reads")
                .is_some()
        );
        match read_parent_process(&peer).expect("the parent reads") {
            ParentProcess::Pinned(parent) => {
                assert_eq!(parent.id(), std::os::unix::process::parent_id());
            }
            other @ (ParentProcess::Root | ParentProcess::Ended) => {
                panic!("expected the parent, got {other:?}")
            }
        }

        // A descriptor whose process was reaped pins nothing, though the id beside it still runs.
        let mut child = std::process::Command::new("/bin/true")
            .spawn()
            .expect("the child starts");
        let descriptor = open_process_descriptor(child.id()).expect("the child's descriptor opens");
        child.wait().expect("the child is reaped");
        let reaped = PinnedProcess {
            id: std::process::id(),
            descriptor: Arc::new(descriptor),
        };
        assert!(matches!(
            read_parent_process(&reaped).expect("a reaped process reads"),
            ParentProcess::Ended
        ));
    }
}
