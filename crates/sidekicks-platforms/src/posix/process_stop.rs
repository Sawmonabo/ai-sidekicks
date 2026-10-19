//! The stop of a pinned process on macOS and Linux: `SIGTERM`, a grace for the process to answer
//! it, then `SIGKILL`, each sent and awaited through the system's own pin of that process.

use std::io::{self, ErrorKind};
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;
use polling::{Events, Poller};

use crate::child_command::ChildEnd;
use crate::pinned_process::KILL_WAIT_BOUND;

/// Stops a pinned process that leads its own group: `send` delivers a signal to it while it runs,
/// a `SIGKILL` also to the rest of its group, and answers `false` when the process has already
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
        // The process's exit ends nothing else of its group, so the kill goes to the rest.
        send(Signal::SIGKILL)?;
        return Ok(ChildEnd::Stop);
    }
    // A process that ends between the grace and the kill ended on the stop it was asked; the kill
    // that found it ended went to the rest of its group.
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

#[cfg(test)]
mod tests {
    use std::io::Read as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use nix::sys::signal::Signal;
    use rstest::rstest;

    use crate::child_command::ChildEnd;
    use crate::pin_child_process;
    use crate::posix::child_command::prepare_lasting_child_command;
    use crate::posix::process_group::read_group_output_to_end;

    // Fails when `SIGKILL` goes first, which ends the answering child by the kill and answers
    // `Kill`; when the `SIGKILL` is skipped, which leaves the trapping child running, so the stop
    // times out; when it goes to the leader alone, or a child that answers the stop leaves the
    // rest of its group alone, either of which leaves the child's own child running, which then
    // prints; or when the kill of a group left with only its exited, unreaped leader fails.
    #[rstest]
    #[case::ignoring_the_stop(
        r#"trap "" TERM; (/bin/sleep 60; echo outlived) & echo ready; read never"#,
        ChildEnd::Kill,
        Signal::SIGKILL
    )]
    #[case::answering_the_stop(
        "(/bin/sleep 60; echo outlived) & echo ready; read never",
        ChildEnd::Stop,
        Signal::SIGTERM
    )]
    #[case::answering_the_stop_alone(
        "echo ready; exec /bin/sleep 30",
        ChildEnd::Stop,
        Signal::SIGTERM
    )]
    fn pinned_process_stop_kills_a_lasting_child_and_its_group_after_the_grace(
        #[case] script: &str,
        #[case] expected_end: ChildEnd,
        #[case] expected_signal: Signal,
    ) {
        let grace = Duration::from_millis(300);
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        prepare_lasting_child_command(&mut command);
        let mut child = command.as_std_mut().spawn().expect("the child starts");
        // The line comes once the trap is set and before the child waits.
        let mut output = child.stdout.take().expect("the child's output is piped");
        let mut ready = [0; 6];
        output
            .read_exact(&mut ready)
            .expect("the child's line reads");
        assert_eq!(&ready, b"ready\n");

        let started = Instant::now();
        let end = pin_child_process(child.id()).and_then(|process| process.stop(grace));
        let elapsed = started.elapsed();

        drop(child.stdin.take());
        let status = child.wait().expect("the child is reaped");
        // The output ends only once every process of the group holding it has ended.
        let rest = read_group_output_to_end(&mut output, child.id(), Duration::from_secs(5));
        assert_eq!(
            end.expect("the child pins and its stop ends it"),
            expected_end
        );
        if expected_end == ChildEnd::Kill {
            assert!(elapsed >= grace, "the kill waits for the grace");
        }
        assert_eq!(status.signal(), Some(expected_signal as i32));
        assert_eq!(rest, Some(Vec::new()));
    }
}
