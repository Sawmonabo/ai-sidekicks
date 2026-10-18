//! A child the daemon starts with `Command` on macOS and Linux: one armed to end with the daemon,
//! or a lasting one in a session of its own; how a child is asked to stop, and how the signal that
//! ended one is named.

use std::io;
use std::os::unix::process::ExitStatusExt as _;
use std::process::ExitStatus;

#[cfg(target_os = "linux")]
use nix::sys::prctl::set_thp_disable;
use nix::sys::signal::Signal;
use nix::unistd::setsid;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use tokio::process::Command;

use crate::child_command::ChildEnd;
use crate::posix::shell_start::arm_parent_death;

/// Whether a process is asked to stop by a signal it can answer, as every process here is.
pub const CAN_SIGNAL_A_STOP: bool = true;

/// Prepares `command` to start a child of the daemon `daemon_pid`: before its program runs, the
/// child arms itself to end with the daemon and checks the daemon is still its parent, since the
/// daemon can end between the fork and the exec. The child's start then fails with `ESRCH` when
/// the daemon is gone, and with the system's error when the arming is refused.
pub fn prepare_child_command(command: &mut Command, daemon_pid: u32) {
    // SAFETY: the closure runs in the forked child before the exec and calls only
    // `arm_parent_death`, which is async-signal-safe and allocates nothing.
    unsafe {
        command.pre_exec(move || arm_parent_death(daemon_pid));
    }
}

/// Wraps `command` as a child that ends with the daemon `daemon_pid`: prepared as
/// [`prepare_child_command`] prepares it, and killed when its handle drops. The caller spawns it on
/// the daemon's spawner thread; the spawn fails as [`prepare_child_command`] says.
pub fn wrap_child_command(mut command: Command, daemon_pid: u32) -> CommandWrap {
    prepare_child_command(&mut command, daemon_pid);
    let mut wrap = CommandWrap::from(command);
    wrap.wrap(KillOnDrop);
    wrap
}

/// Prepares `command` to start a child that outlives the daemon: before its program runs, the
/// child leads a session of its own, so neither a terminal's hangup nor a signal to the daemon's
/// group reaches it, and arms no parent-death signal; on Linux it also clears the huge-page switch
/// the daemon set for itself. Never fails here; the spawn fails with the system's error when the
/// session is refused.
pub fn prepare_lasting_child_command(command: &mut Command) -> io::Result<()> {
    // SAFETY: the closure runs in the forked child before the exec and makes only `setsid` and,
    // on Linux, `prctl`, which are async-signal-safe and allocate nothing.
    unsafe {
        command.pre_exec(|| {
            setsid()?;
            #[cfg(target_os = "linux")]
            set_thp_disable(false)?;
            Ok(())
        });
    }
    Ok(())
}

/// Asks `child` to stop with `SIGTERM` to its own process id, never its group, so a running reply
/// can finish. Fails with the system's error from the send.
pub fn ask_child_to_stop(child: &mut dyn ChildWrapper) -> io::Result<()> {
    child.signal(libc::SIGTERM)
}

/// The name of the signal that ended a child, as the wire carries it (`SIGKILL`); `None` for a
/// child that exited. `_asked_end` is not read: the status names the signal itself here.
pub fn exit_signal_name(status: &ExitStatus, _asked_end: Option<ChildEnd>) -> Option<String> {
    status.signal().and_then(signal_name)
}

/// The name of signal `number`: the system's own name, or, for a Linux real-time signal no name
/// covers, its place from `SIGRTMIN` as signal(7) writes it (`SIGRTMIN+3`); `None` for a number no
/// signal here has.
fn signal_name(number: i32) -> Option<String> {
    if let Ok(signal) = Signal::try_from(number) {
        return Some(signal.as_str().to_owned());
    }
    // The kernel's real-time signals below glibc's `SIGRTMIN`, which glibc keeps for itself, are
    // counted from it too (`SIGRTMIN-2`). macOS has none, and every signal it sends is listed.
    #[cfg(target_os = "linux")]
    if (1..=libc::SIGRTMAX()).contains(&number) {
        let first = libc::SIGRTMIN();
        return Some(if number >= first {
            format!("SIGRTMIN+{}", number - first)
        } else {
            format!("SIGRTMIN-{}", first - number)
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader};
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use nix::sys::signal::Signal;
    use nix::unistd::{Pid, getsid};
    use rstest::rstest;

    use super::{prepare_lasting_child_command, signal_name};
    use crate::child_command::ChildEnd;
    #[cfg(target_os = "linux")]
    use crate::linux::caller_process::pin_child_process;
    #[cfg(target_os = "macos")]
    use crate::macos::caller_process::pin_child_process;

    // Mutation killed: dropping the `setsid` leaves the child in the test's own session.
    #[test]
    fn a_lasting_child_leads_its_own_session() {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("30");
        prepare_lasting_child_command(&mut command).expect("the command prepares");
        let mut child = command.as_std_mut().spawn().expect("the child starts");
        let pid = Pid::from_raw(i32::try_from(child.id()).expect("a process id fits an i32"));

        let session = getsid(Some(pid));

        child.kill().expect("the test ends its own child");
        child.wait().expect("the child is reaped");
        assert_eq!(session.expect("the child's session reads"), pid);
    }

    // Mutations killed: sending `SIGKILL` first ends the sleeper by the kill and answers `Kill`;
    // skipping the `SIGKILL` leaves the trapping child running, so the stop times out.
    #[rstest]
    #[case::ignoring_the_stop(
        r#"trap "" TERM; echo ready; read never"#,
        ChildEnd::Kill,
        Signal::SIGKILL
    )]
    #[case::answering_the_stop("echo ready; exec /bin/sleep 30", ChildEnd::Stop, Signal::SIGTERM)]
    fn a_lasting_process_that_ignores_the_stop_signal_is_killed_after_the_grace(
        #[case] script: &str,
        #[case] expected_end: ChildEnd,
        #[case] expected_signal: Signal,
    ) {
        let grace = Duration::from_millis(300);
        let mut child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("the child starts");
        // The line comes once the trap is set and before the child waits.
        let mut ready = String::new();
        BufReader::new(child.stdout.take().expect("the child's output is piped"))
            .read_line(&mut ready)
            .expect("the child's line reads");
        assert_eq!(ready, "ready\n");

        let started = Instant::now();
        let end = pin_child_process(child.id()).and_then(|process| process.stop(grace));
        let elapsed = started.elapsed();

        drop(child.stdin.take());
        let status = child.wait().expect("the child is reaped");
        assert_eq!(
            end.expect("the child pins and its stop ends it"),
            expected_end
        );
        if expected_end == ChildEnd::Kill {
            assert!(elapsed >= grace, "the kill waits for the grace");
        }
        assert_eq!(status.signal(), Some(expected_signal as i32));
    }

    // Mutation killed: answering `None` for a number `Signal` does not list leaves Linux's
    // real-time signals unnamed.
    #[test]
    fn every_signal_the_system_defines_has_a_name_for_a_lasting_child() {
        let listed = Signal::iterator().map(|signal| signal as i32);
        #[cfg(target_os = "linux")]
        let numbers = listed.chain(libc::SIGRTMIN()..=libc::SIGRTMAX());
        #[cfg(target_os = "macos")]
        let numbers = listed;
        for number in numbers {
            assert!(
                signal_name(number).is_some_and(|name| name.starts_with("SIG")),
                "signal {number} has no name"
            );
        }
    }
}
