//! A child the daemon starts with `Command` on macOS and Linux: one armed to end with the daemon,
//! or a lasting one leading a session of its own; how a child is asked to stop, and how the signal
//! that ended one is read and named.

use std::error::Error;
use std::io;
use std::os::unix::process::ExitStatusExt as _;
use std::process::{ExitStatus, Stdio};

#[cfg(target_os = "linux")]
use nix::sys::prctl::set_thp_disable;
use nix::sys::signal::Signal;
use nix::unistd::setsid;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop, ProcessSession};
use tokio::process::Command;

use crate::child_command::ChildEnd;
use crate::lasting_child::{LastingChild, LastingCommand};
use crate::pin_child_process;
use crate::posix::shell_start::arm_parent_death;

/// Whether a process is asked to stop by a signal it can answer, as every process here is.
pub const CAN_SIGNAL_A_STOP: bool = true;

/// Whether a socket's path can be a link to the socket bound elsewhere, which a program moves to
/// point its callers at another listener, as every path here can.
pub const CAN_LINK_A_SOCKET: bool = true;

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

/// Wraps `command` as a child that ends with the daemon `daemon_pid` and leads a session of its
/// own, so its whole group, what it started included, can be ended at once: prepared as
/// [`prepare_child_command`] prepares it; `start_kill` on its handle kills the whole group, while
/// dropping the handle kills the child alone. The caller spawns it on the daemon's spawner thread;
/// the spawn fails as [`prepare_child_command`] says, or with the system's error when the session
/// is refused.
pub fn wrap_session_child_command(mut command: Command, daemon_pid: u32) -> CommandWrap {
    prepare_child_command(&mut command, daemon_pid);
    let mut wrap = CommandWrap::from(command);
    wrap.wrap(ProcessSession).wrap(KillOnDrop);
    wrap
}

/// Starts `command` as a child that outlives the daemon, then pins it and reads its record: it
/// leads a session of its own, so neither a terminal's hangup nor a signal to the daemon's group
/// reaches it, and its whole group can be killed; it arms no parent-death signal, and on Linux
/// clears the huge-page switch the daemon set for itself. Runs on the daemon's spawner thread.
/// Fails with the system's error from the start, a refused session among them, or from the pin,
/// which kills the child first.
pub fn spawn_lasting_child(command: LastingCommand) -> io::Result<LastingChild> {
    let mut child_command = Command::new(&command.program);
    child_command
        .args(&command.arguments)
        .env_clear()
        .envs(command.environment)
        .current_dir(&command.working_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(command.error_output));
    prepare_lasting_child_command(&mut child_command);
    let mut child = child_command.spawn()?;
    let pinned = child
        .id()
        .ok_or_else(|| io::Error::other("the started child has no process id"))
        .and_then(pin_child_process)
        .and_then(|process| {
            let record = process
                .record()?
                .ok_or_else(|| io::Error::other("the child ended as it started"))?;
            Ok((process, record))
        });
    match pinned {
        Ok((process, record)) => Ok(LastingChild {
            process,
            record,
            exit: Box::pin(async move { child.wait().await }),
        }),
        Err(error) => {
            // Nothing unrecorded outlives the start; tokio reaps the dropped child.
            if let Err(kill_error) = child.start_kill() {
                tracing::warn!(
                    error = &kill_error as &(dyn Error + 'static),
                    "the unrecorded lasting child could not be killed"
                );
            }
            Err(error)
        }
    }
}

/// Prepares `command` so that, before its program runs, the child leads a session of its own and,
/// on Linux, clears the huge-page switch the daemon set for itself; the child's start fails with
/// the system's error when either is refused.
pub(crate) fn prepare_lasting_child_command(command: &mut Command) {
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
}

/// Asks `child` to stop with `SIGTERM` to its own process id, never its group, so a running reply
/// can finish. Fails with the system's error from the send.
pub fn ask_child_to_stop(child: &mut dyn ChildWrapper) -> io::Result<()> {
    child.signal(libc::SIGTERM)
}

/// The number of the signal that ended a child; `None` for a child that exited.
pub(crate) fn exit_signal_number(status: ExitStatus) -> Option<i32> {
    status.signal()
}

/// The name of the signal that ended a child, as the wire carries it (`SIGKILL`); `None` for a
/// child that exited. `_asked_end` is not read: the status names the signal itself here.
pub(crate) fn exit_signal_name(status: ExitStatus, _asked_end: Option<ChildEnd>) -> Option<String> {
    status.signal().and_then(signal_name)
}

/// The end the daemon's own kill of a lasting child left in its exit: always `None`, since the
/// status names the signal itself here. Never fails.
pub fn lasting_child_asked_end(_status: &ExitStatus) -> Option<ChildEnd> {
    None
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
    use nix::sys::signal::Signal;
    use nix::unistd::{Pid, getsid};

    use super::{prepare_lasting_child_command, signal_name};
    use crate::posix::process::id::system_process_id;

    // Fails when the `setsid` is dropped, which leaves the child in the test's own session.
    #[test]
    fn a_lasting_child_leads_its_own_session() {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("30");
        prepare_lasting_child_command(&mut command);
        let mut child = command.as_std_mut().spawn().expect("the child starts");
        let pid = Pid::from_raw(system_process_id(child.id()).expect("a child's id").get());

        let session = getsid(Some(pid));

        child.kill().expect("the test ends its own child");
        child.wait().expect("the child is reaped");
        assert_eq!(session.expect("the child's session reads"), pid);
    }

    // Fails when a signal number missing from `Signal`'s list gets no name, as Linux's real-time
    // signals would.
    #[test]
    fn every_exit_signal_the_system_defines_has_a_name() {
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
