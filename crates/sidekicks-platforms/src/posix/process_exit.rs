//! A child's exit awaited without reaping it, so its process id stays its own until its owner
//! reaps it: a bounded wait blocks on the system's exit event for the process (a process
//! descriptor on Linux, a `kqueue` exit filter on macOS), an unbounded one in `waitid` itself.

use std::io::{self, ErrorKind};
use std::mem::MaybeUninit;
use std::time::{Duration, Instant};

use polling::{Events, Poller};

/// The key the process's exit event is registered under, the only source its poller watches.
const EXIT_KEY: usize = 0;

/// Blocks until the child `pid` has exited, leaving it unreaped, or until `bound` passes; answers
/// whether it exited. Fails with the system's error when the child cannot be waited for or its
/// exit event cannot be watched.
pub(crate) fn wait_for_exit(pid: u32, bound: Option<Duration>) -> io::Result<bool> {
    let Some(bound) = bound else {
        wait_without_reaping(pid, 0)?;
        return Ok(true);
    };
    let give_up_at = Instant::now() + bound;
    if has_exited(pid)? {
        return Ok(true);
    }
    watch_exit_event(pid, give_up_at)
}

/// Waits on `pid`'s exit event through a poller of its own until the child has exited or
/// `give_up_at` passes; the child's state is read again after each event and after the watch is
/// set up, so an exit before it is not missed.
#[cfg(target_os = "linux")]
fn watch_exit_event(pid: u32, give_up_at: Instant) -> io::Result<bool> {
    use polling::Event;

    use crate::linux::caller_process::open_process_descriptor;

    // Declared before the poller, so it outlives the poller and the registration in it.
    let descriptor = open_process_descriptor(pid)?;
    let poller = Poller::new()?;
    // SAFETY: the descriptor is declared before the poller, so it stays open until the poller and
    // its registration are gone.
    unsafe { poller.add(&descriptor, Event::readable(EXIT_KEY)) }?;
    wait_on_exit_event(&poller, pid, give_up_at)
}

/// Waits on `pid`'s exit event through a poller of its own until the child has exited or
/// `give_up_at` passes; the child's state is read again after each event and after the watch is
/// set up, so an exit before it is not missed.
#[cfg(target_os = "macos")]
fn watch_exit_event(pid: u32, give_up_at: Instant) -> io::Result<bool> {
    use std::num::NonZeroI32;

    use polling::PollMode;
    use polling::os::kqueue::{PollerKqueueExt, Process, ProcessOps};

    let raw_pid = i32::try_from(pid)
        .ok()
        .and_then(NonZeroI32::new)
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "no child has this process id"))?;
    let poller = Poller::new()?;
    // SAFETY: the id is the caller's own child, left unreaped until this wait returns, so no other
    // process takes it while the filter is registered.
    let process = unsafe { Process::from_pid(raw_pid, ProcessOps::Exit) };
    match poller.add_filter(process, EXIT_KEY, PollMode::Oneshot) {
        Ok(()) => {}
        // The kernel refuses the filter for a child that already exited.
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) && has_exited(pid)? => {
            return Ok(true);
        }
        Err(error) => return Err(error),
    }
    wait_on_exit_event(&poller, pid, give_up_at)
}

/// Waits on `poller`, which watches `pid`'s exit event, until the child has exited or
/// `give_up_at` passes.
fn wait_on_exit_event(poller: &Poller, pid: u32, give_up_at: Instant) -> io::Result<bool> {
    let mut events = Events::new();
    loop {
        if has_exited(pid)? {
            return Ok(true);
        }
        let timeout = give_up_at.saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            return Ok(false);
        }
        events.clear();
        match poller.wait(&mut events, Some(timeout)) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

/// Whether the child `pid` has exited, leaving it unreaped. Fails with the system's error.
fn has_exited(pid: u32) -> io::Result<bool> {
    wait_without_reaping(pid, libc::WNOHANG)
}

/// One `waitid` for the child `pid`'s exit with `options` added, leaving it unreaped; answers
/// whether it found the exit, which a wait without `WNOHANG` always does. Fails with the system's
/// error from the wait.
fn wait_without_reaping(pid: u32, options: libc::c_int) -> io::Result<bool> {
    loop {
        let mut information = MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: the information pointer names a live local the call writes at most one
        // `siginfo_t` into, and `WNOWAIT` leaves the process unreaped.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                libc::id_t::from(pid),
                information.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT | options,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        // SAFETY: the zeroed struct is a valid `siginfo_t`, which a `WNOHANG` wait that found no
        // exit leaves with a zero process id.
        return Ok(unsafe { information.assume_init_ref().si_pid() } != 0);
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    use super::wait_for_exit;

    #[test]
    fn the_exit_wait_ends_on_the_exit_event_and_gives_up_at_its_bound() {
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
        slow.kill().expect("the test ends its own child");
        slow.wait().expect("the child is reaped");
    }
}
