//! A child's exit awaited without reaping it, so its process id stays its own until its owner
//! reaps it: the wait blocks on the system's exit event for the process (a process descriptor on
//! Linux, a `kqueue` exit filter on macOS), which a stop does not raise. [`ExitEvent`] registers
//! that event on a poller another wait drives too, such as a terminal's watch.

use std::io::{self, ErrorKind};
use std::mem::MaybeUninit;
#[cfg(target_os = "macos")]
use std::num::NonZeroI32;
#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;
use std::time::{Duration, Instant};

use polling::{Events, Poller};

/// The key the process's exit event is registered under, the only source its poller watches.
const EXIT_KEY: usize = 0;

/// A child's exit event registered on a poller, posted once: on Linux its process descriptor,
/// held open while registered, and on macOS a `kqueue` exit filter on its id.
pub(crate) struct ExitEvent {
    /// The child's process descriptor, which reads as ready once the child has exited.
    #[cfg(target_os = "linux")]
    descriptor: OwnedFd,
    /// The child's id, which the exit filter is keyed on.
    #[cfg(target_os = "macos")]
    pid: NonZeroI32,
}

impl ExitEvent {
    /// Registers the exit of the child `pid` on `poller` under `key`; `None` when the child is
    /// already exiting, for which no event comes. Fails with `InvalidInput` for a pid of 0 or past
    /// `i32::MAX`, and with the system's error.
    ///
    /// # Safety
    ///
    /// `pid` is the caller's own child, not yet reaped, and the event is taken off `poller` with
    /// [`Self::unregister`], or `poller` dropped, before the event is dropped.
    #[cfg(target_os = "linux")]
    pub(crate) unsafe fn register(
        poller: &Poller,
        pid: u32,
        key: usize,
    ) -> io::Result<Option<Self>> {
        use polling::Event;

        use crate::linux::pinned_process::open_process_descriptor;

        let descriptor = match open_process_descriptor(pid) {
            Ok(descriptor) => descriptor,
            // No process has the id, so the child has exited.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(None),
            Err(error) => return Err(error),
        };
        // SAFETY: the event holds the descriptor, and the caller takes the event off the poller or
        // drops the poller before it drops the event, so the descriptor outlives its registration.
        unsafe { poller.add(&descriptor, Event::readable(key)) }?;
        Ok(Some(Self { descriptor }))
    }

    /// Registers the exit of the child `pid` on `poller` under `key`; `None` when the child is
    /// already exiting, for which no event comes. Fails with `InvalidInput` for a pid of 0 or past
    /// `i32::MAX`, and with the system's error.
    ///
    /// # Safety
    ///
    /// `pid` is the caller's own child, not yet reaped, and the event is taken off `poller` with
    /// [`Self::unregister`], or `poller` dropped, before the event is dropped.
    #[cfg(target_os = "macos")]
    pub(crate) unsafe fn register(
        poller: &Poller,
        pid: u32,
        key: usize,
    ) -> io::Result<Option<Self>> {
        use polling::PollMode;
        use polling::os::kqueue::PollerKqueueExt;

        use crate::posix::process::id::system_process_id;

        let pid = system_process_id(pid)?;
        // SAFETY: the caller's own child, unreaped, so no other process has its id.
        match poller.add_filter(unsafe { exit_filter(pid) }, key, PollMode::Oneshot) {
            Ok(()) => Ok(Some(Self { pid })),
            // The kernel refuses the filter for a child already exiting, which may not yet read
            // as exited; the poller still lists the id it refused, so the id is taken off it.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
                // SAFETY: as above; a delete only names the filter.
                poller.delete_filter(unsafe { exit_filter(pid) })?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Takes the event off `poller`, whether or not it was posted. Fails with the system's error.
    #[cfg(target_os = "linux")]
    pub(crate) fn unregister(self, poller: &Poller) -> io::Result<()> {
        poller.delete(&self.descriptor)
    }

    /// Takes the event off `poller`, whether or not it was posted. Fails with the system's error.
    #[cfg(target_os = "macos")]
    pub(crate) fn unregister(self, poller: &Poller) -> io::Result<()> {
        use polling::os::kqueue::PollerKqueueExt;

        // SAFETY: a delete only names the filter, which the kernel removed already once posted.
        poller.delete_filter(unsafe { exit_filter(self.pid) })
    }
}

/// The `kqueue` filter for the exit of process `pid`.
///
/// # Safety
///
/// `pid` is the caller's own child, not yet reaped.
#[cfg(target_os = "macos")]
unsafe fn exit_filter(pid: NonZeroI32) -> polling::os::kqueue::Process<'static> {
    use polling::os::kqueue::{Process, ProcessOps};

    // SAFETY: the caller's contract: the id is its own unreaped child's.
    unsafe { Process::from_pid(pid, ProcessOps::Exit) }
}

/// Blocks until the child `pid` has exited, leaving it unreaped, or until `bound` passes where one
/// is given; answers whether it exited. A stop or a continue does not end the wait. `pid` must be
/// the caller's own child, not yet reaped, so no other process can take its id during the wait.
/// Fails with the system's error when the child cannot be waited for or its exit event cannot be
/// watched.
pub fn wait_for_exit(pid: u32, bound: Option<Duration>) -> io::Result<bool> {
    watch_exit_event(pid, bound.map(|bound| Instant::now() + bound))
}

/// Waits on `pid`'s exit event through a poller of its own until the child has exited or
/// `give_up_at` passes where one is given; the child's state is read only once the watch is set
/// up, since the exit filter reports only an exit after it is attached, so an exit before it is
/// not missed.
fn watch_exit_event(pid: u32, give_up_at: Option<Instant>) -> io::Result<bool> {
    let poller = Poller::new()?;
    // SAFETY: `pid` is the caller's own unreaped child, and the event is taken off the poller
    // below before it is dropped.
    let Some(exit_event) = (unsafe { ExitEvent::register(&poller, pid, EXIT_KEY) })? else {
        // The child is exiting, so the blocking wait returns at once.
        return wait_without_reaping(pid, libc::WEXITED).map(is_exit);
    };
    let exited = wait_on_exit_event(&poller, pid, give_up_at);
    exit_event.unregister(&poller)?;
    exited
}

/// Waits on `poller`, which watches `pid`'s exit event, until the child has exited or
/// `give_up_at` passes where one is given. Once the event comes, a process descriptor's readiness
/// or hangup or the exit filter's note, the exit is under way, so a blocking wait returns at once:
/// macOS posts the event before the exit reads as one to `waitid`, and its one-shot filter posts no
/// second.
fn wait_on_exit_event(poller: &Poller, pid: u32, give_up_at: Option<Instant>) -> io::Result<bool> {
    let mut events = Events::new();
    loop {
        if has_exited(pid)? {
            return Ok(true);
        }
        let timeout =
            give_up_at.map(|give_up_at| give_up_at.saturating_duration_since(Instant::now()));
        if timeout.is_some_and(|timeout| timeout.is_zero()) {
            return Ok(false);
        }
        events.clear();
        match poller.wait(&mut events, timeout) {
            Ok(count) if count > 0 => {
                return wait_without_reaping(pid, libc::WEXITED).map(is_exit);
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

/// Whether the child `pid` has exited, leaving it unreaped. Fails with the system's error.
fn has_exited(pid: u32) -> io::Result<bool> {
    wait_without_reaping(pid, libc::WEXITED | libc::WNOHANG).map(is_exit)
}

/// Whether a wait's `si_code` reads as an exit, a kill or a core dump: macOS answers a wait for an
/// exit with a stopped child's state too.
fn is_exit(code: libc::c_int) -> bool {
    matches!(code, libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED)
}

/// One `waitid` for the child `pid` in the states `options` name, leaving it unreaped; answers the
/// `si_code` of what it found, 0 where a `WNOHANG` wait found nothing and `CLD_EXITED` for a child
/// already gone (`ECHILD`). Fails with the system's error from the wait.
fn wait_without_reaping(pid: u32, options: libc::c_int) -> io::Result<libc::c_int> {
    loop {
        let mut information = MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: the information pointer names a live local the call writes at most one
        // `siginfo_t` into, and `WNOWAIT` leaves the process unreaped.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                libc::id_t::from(pid),
                information.as_mut_ptr(),
                libc::WNOWAIT | options,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::ECHILD) => return Ok(libc::CLD_EXITED),
                _ => return Err(error),
            }
        }
        // SAFETY: the zeroed struct is a valid `siginfo_t`, which a `WNOHANG` wait that found
        // nothing leaves with a zero code.
        return Ok(unsafe { information.assume_init_ref() }.si_code);
    }
}

/// Blocks until the child `pid` has stopped, leaving its state for the next wait. Fails with the
/// system's error from the wait.
#[cfg(test)]
pub(crate) fn wait_for_stop(pid: u32) -> io::Result<()> {
    wait_without_reaping(pid, libc::WSTOPPED).map(drop)
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    use super::{wait_for_exit, wait_for_stop};

    // Fails when the exit event does not end the wait, when the bound does not, or when a stopped
    // child reads as exited, as macOS answers a wait for an exit with a stop's state. Mutation:
    // `is_exit` answering true for any code but 0.
    #[test]
    fn the_exit_wait_ends_on_the_exit_event_and_gives_up_at_its_bound_past_a_stop() {
        let mut quick = Command::new("/bin/sh")
            .args(["-c", "sleep 0.2"])
            .spawn()
            .expect("the child starts");
        let started = Instant::now();
        assert!(wait_for_exit(quick.id(), Some(Duration::from_secs(10))).expect("the wait runs"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the exit ends the wait, not its bound"
        );
        quick
            .wait()
            .expect("the child is reaped after the wait left it");

        let mut slow = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("the child starts");
        let started = Instant::now();
        let bound = Duration::from_millis(300);
        assert!(!wait_for_exit(slow.id(), Some(bound)).expect("the wait runs"));
        assert!(started.elapsed() >= bound);

        let pid = Pid::from_raw(i32::try_from(slow.id()).expect("a process id"));
        kill(pid, Signal::SIGSTOP).expect("the child is stopped");
        wait_for_stop(slow.id()).expect("the stop lands");
        let started = Instant::now();
        assert!(!wait_for_exit(slow.id(), Some(bound)).expect("the wait runs"));
        assert!(started.elapsed() >= bound, "a stop ended the wait");
        slow.kill().expect("the test ends its own child");
        assert!(wait_for_exit(slow.id(), None).expect("the wait runs"));
        slow.wait().expect("the child is reaped");
    }
}
