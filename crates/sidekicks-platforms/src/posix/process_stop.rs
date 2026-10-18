//! The stop of a pinned process on macOS and Linux: `SIGTERM`, a grace for the process to answer
//! it, then `SIGKILL`, each sent and awaited through the system's own pin of that process.

use std::io::{self, ErrorKind};
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;
use polling::{Events, Poller};

use crate::caller_process::KILL_WAIT_BOUND;
use crate::child_command::ChildEnd;

/// Stops a pinned process: `send` delivers a signal to it and answers `false` when it has already
/// ended, and `wait_for_end` waits up to a bound for its exit event and answers whether it came.
/// Answers [`ChildEnd::Stop`] when the process ended before the kill, a process already gone
/// included, and [`ChildEnd::Kill`] when the kill ended it. Fails with `TimedOut` when it still
/// runs [`KILL_WAIT_BOUND`] after the kill, and with the error `send` or `wait_for_end` answers.
pub(crate) fn stop_pinned_process(
    grace: Duration,
    mut send: impl FnMut(Signal) -> io::Result<bool>,
    mut wait_for_end: impl FnMut(Duration) -> io::Result<bool>,
) -> io::Result<ChildEnd> {
    if !send(Signal::SIGTERM)? || wait_for_end(grace)? {
        return Ok(ChildEnd::Stop);
    }
    // A process that ends between the grace and the kill ended on the stop it was asked.
    if !send(Signal::SIGKILL)? {
        return Ok(ChildEnd::Stop);
    }
    if wait_for_end(KILL_WAIT_BOUND)? {
        return Ok(ChildEnd::Kill);
    }
    Err(io::Error::new(
        ErrorKind::TimedOut,
        "the process still runs after it was killed",
    ))
}

/// Waits up to `bound` for the one source `poller` watches to post its event; answers whether it
/// came. Fails with the system's error from the wait.
pub(crate) fn wait_for_event(poller: &Poller, bound: Duration) -> io::Result<bool> {
    let give_up_at = Instant::now() + bound;
    let mut events = Events::new();
    loop {
        let timeout = give_up_at.saturating_duration_since(Instant::now());
        events.clear();
        match poller.wait(&mut events, Some(timeout)) {
            Ok(count) if count > 0 => return Ok(true),
            Ok(_) if timeout.is_zero() => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}
