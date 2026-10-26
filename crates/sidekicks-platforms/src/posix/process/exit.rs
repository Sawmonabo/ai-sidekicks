//! A child's exit awaited without reaping it, so its process id stays its own until its owner
//! reaps it: the wait blocks on the system's exit event for the process (a process descriptor on
//! Linux, a `kqueue` exit filter on macOS), which a stop does not raise.

use std::io::{self, ErrorKind};
use std::mem::MaybeUninit;
use std::time::{Duration, Instant};

use polling::{Events, Poller};

/// The key the process's exit event is registered under, the only source its poller watches.
const EXIT_KEY: usize = 0;

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
/// up, so an exit before it is not missed.
#[cfg(target_os = "linux")]
fn watch_exit_event(pid: u32, give_up_at: Option<Instant>) -> io::Result<bool> {
    use polling::Event;

    use crate::linux::pinned_process::open_process_descriptor;

    // Declared before the poller, so it outlives the poller and the registration in it.
    let descriptor = match open_process_descriptor(pid) {
        Ok(descriptor) => descriptor,
        // No process has the id, so the child has exited; the blocking wait answers at once.
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
            return wait_without_reaping(pid, libc::WEXITED).map(is_exit);
        }
        Err(error) => return Err(error),
    };
    let poller = Poller::new()?;
    // SAFETY: the descriptor is declared before the poller, so it stays open until the poller and
    // its registration are gone.
    unsafe { poller.add(&descriptor, Event::readable(EXIT_KEY)) }?;
    wait_on_exit_event(&poller, pid, give_up_at)
}

/// Waits on `pid`'s exit event through a poller of its own until the child has exited or
/// `give_up_at` passes where one is given; the child's state is read only once the watch is set
/// up, since the exit filter reports only an exit after it is attached, so an exit before it is
/// not missed.
#[cfg(target_os = "macos")]
fn watch_exit_event(pid: u32, give_up_at: Option<Instant>) -> io::Result<bool> {
    use polling::PollMode;
    use polling::os::kqueue::{PollerKqueueExt, Process, ProcessOps};

    use crate::posix::process::id::system_process_id;

    let raw_pid = system_process_id(pid)?;
    let poller = Poller::new()?;
    // SAFETY: the id is the caller's own child, left unreaped until this wait returns, so no other
    // process takes it while the filter is registered.
    let process = unsafe { Process::from_pid(raw_pid, ProcessOps::Exit) };
    match poller.add_filter(process, EXIT_KEY, PollMode::Oneshot) {
        Ok(()) => {}
        // The kernel refuses the filter for a child already exiting, which may not yet read as
        // exited; its exit is under way, so the blocking wait returns at once.
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
            return wait_without_reaping(pid, libc::WEXITED).map(is_exit);
        }
        Err(error) => return Err(error),
    }
    wait_on_exit_event(&poller, pid, give_up_at)
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
