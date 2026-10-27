//! A child the daemon starts on macOS and Linux: one through `Command`, on Linux armed to end with
//! the daemon and on macOS started through `posix_spawn`, a group of its own's leader, or a lasting
//! one leading a session of its own; how a child is asked to stop, and how the signal that ended
//! one is read and named.

#[cfg(target_os = "linux")]
use std::error::Error;
use std::io;
use std::os::unix::process::ExitStatusExt as _;
use std::process::ExitStatus;
#[cfg(target_os = "linux")]
use std::process::Stdio;

#[cfg(target_os = "linux")]
use nix::sys::prctl::set_thp_disable;
use nix::sys::signal::Signal;
#[cfg(any(target_os = "linux", test))]
use nix::unistd::setsid;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop, ProcessGroup, ProcessSession};
use tokio::process::Command;

use crate::child_command::ChildEnd;
use crate::lasting_child::{LastingChild, LastingCommand};
#[cfg(target_os = "macos")]
use crate::macos::lasting_child::{
    end_unrecorded_lasting_child, reap_lasting_child, spawn_lasting_child_process,
};
use crate::pin_child_process;
#[cfg(target_os = "linux")]
use crate::posix::shell_start::arm_parent_death;

/// Whether a process is asked to stop by a signal it can answer, as every process here is.
pub const CAN_SIGNAL_A_STOP: bool = true;

/// Whether a socket's path can be a link to the socket bound elsewhere, which a program moves to
/// point its callers at another listener, as every path here can.
pub const CAN_LINK_A_SOCKET: bool = true;

/// Prepares `command`, whose program is an absolute path, to start a child of the daemon
/// `daemon_pid`. On Linux, before its program runs, the child arms itself to end with the daemon
/// and checks the daemon is still its parent, since the daemon can end between the fork and the
/// exec; its start then fails with `ESRCH` when the daemon is gone, and with the system's error
/// when the arming is refused. On macOS nothing is added, so std starts it through `posix_spawn`:
/// a fork in a process running threads runs the system's fork handlers in the child, which abort
/// it when another thread was inside a one-time initialization.
#[cfg_attr(
    target_os = "macos",
    expect(
        unused_variables,
        reason = "macOS adds nothing, having no parent-death signal and no gap between a fork and \
                  an exec to check"
    )
)]
pub fn prepare_child_command(command: &mut Command, daemon_pid: u32) {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the closure runs in the forked child before the exec and calls only
        // `arm_parent_death`, which is async-signal-safe and allocates nothing.
        unsafe {
            command.pre_exec(move || arm_parent_death(daemon_pid));
        }
    }
}

/// Wraps `command` as a child of the daemon `daemon_pid`, prepared as [`prepare_child_command`]
/// prepares it and killed when its handle drops. The caller spawns it on the daemon's spawner
/// thread; the spawn fails as [`prepare_child_command`] says.
pub fn wrap_child_command(mut command: Command, daemon_pid: u32) -> CommandWrap {
    prepare_child_command(&mut command, daemon_pid);
    let mut wrap = CommandWrap::from(command);
    wrap.wrap(KillOnDrop);
    wrap
}

/// Wraps `command` as a child of the daemon `daemon_pid` leading a process group of its own, so
/// what it started can be ended with it: prepared as [`prepare_child_command`] prepares it;
/// `start_kill` and `signal` on its handle reach the whole group, while dropping the handle kills
/// the child alone. The caller spawns it on the daemon's spawner thread; the spawn fails as
/// [`prepare_child_command`] says.
pub fn wrap_group_child_command(mut command: Command, daemon_pid: u32) -> CommandWrap {
    prepare_child_command(&mut command, daemon_pid);
    let mut wrap = CommandWrap::from(command);
    wrap.wrap(ProcessGroup::leader()).wrap(KillOnDrop);
    wrap
}

/// Wraps `command` as a child of the daemon `daemon_pid` leading a session of its own, for an
/// interactive shell, which opens the terminal and stops itself while its group is not the
/// terminal's foreground one: as [`wrap_group_child_command`] wraps it, the session made in the
/// child between its fork and its exec, so on macOS std forks it. The caller spawns it on the
/// daemon's spawner thread; the spawn fails as [`prepare_child_command`] says, or with the
/// system's error when the session is refused.
pub fn wrap_session_child_command(mut command: Command, daemon_pid: u32) -> CommandWrap {
    prepare_child_command(&mut command, daemon_pid);
    let mut wrap = CommandWrap::from(command);
    wrap.wrap(ProcessSession).wrap(KillOnDrop);
    wrap
}

/// Starts `command` as a child that outlives the daemon, then pins it and reads its record: it
/// leads a session of its own, so neither a terminal's hangup nor a signal to the daemon's group
/// reaches it, and its whole group can be killed; it arms no parent-death signal, and on Linux
/// clears the huge-page switch the daemon set for itself. On macOS it starts through
/// `posix_spawn`, as [`prepare_child_command`] says why, and its exit reaps it once its end is
/// seen. Runs on the daemon's spawner thread. Fails with the system's error from the start, a
/// refused session among them, or from the pin, which kills and reaps the child first, leaving it
/// unreaped only where the kill is refused.
#[cfg(target_os = "macos")]
pub fn spawn_lasting_child(command: LastingCommand) -> io::Result<LastingChild> {
    let id = spawn_lasting_child_process(&command)?;
    // The daemon's copy of the error output closes here; the child holds its own.
    drop(command);
    let pinned = pin_child_process(id).and_then(|process| {
        let record = process
            .record()?
            .ok_or_else(|| io::Error::other("the child ended as it started"))?;
        Ok((process, record))
    });
    match pinned {
        Ok((process, record)) => {
            let watched = process.clone();
            Ok(LastingChild {
                process,
                record,
                exit: Box::pin(async move {
                    watched.wait_for_end().await?;
                    // A zombie by now, so the reap answers at once.
                    tokio::task::spawn_blocking(move || reap_lasting_child(id))
                        .await
                        .map_err(io::Error::other)?
                }),
            })
        }
        Err(error) => {
            // Nothing unrecorded outlives the start, and nothing is left a zombie.
            if let Err(end_error) = end_unrecorded_lasting_child(id) {
                tracing::warn!(
                    error = &end_error as &(dyn std::error::Error + 'static),
                    "the unrecorded lasting child could not be killed and reaped"
                );
            }
            Err(error)
        }
    }
}

/// Starts `command` as a child that outlives the daemon, as the macOS start does but through
/// `Command`, prepared by [`prepare_lasting_child_command`]. Runs on the daemon's spawner thread.
/// Fails with the system's error from the start, a refused session among them, or from the pin,
/// which kills the child first.
#[cfg(target_os = "linux")]
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
/// the system's error when either is refused. The fork this needs is Linux's lasting start's, and
/// on macOS only a test's.
#[cfg(any(target_os = "linux", test))]
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

/// Asks `child` to stop with `SIGTERM` to its own process id, so a running reply can finish; a
/// child [`wrap_group_child_command`] wraps takes it as its whole group, what it started included.
/// Fails with the system's error from the send.
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
    use std::fs::File;
    use std::os::unix::process::ExitStatusExt as _;
    use std::time::Duration;

    use nix::sys::signal::Signal;
    use nix::unistd::{Pid, getpgid, getsid};

    use super::{signal_name, spawn_lasting_child};
    use crate::lasting_child::LastingCommand;
    use crate::posix::process::id::system_process_id;

    // Fails when the session is dropped, which leaves the child in the test's own session and
    // group, and when its exit no longer reaps it, which leaves the wait without an answer.
    #[tokio::test]
    async fn a_lasting_child_leads_its_own_session() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let error_output = File::create(folder.path().join("error output")).expect("the file");
        let child = spawn_lasting_child(LastingCommand {
            program: "/bin/sleep".into(),
            arguments: vec!["30".to_owned()],
            environment: Vec::new(),
            working_folder: folder.path().to_path_buf(),
            error_output,
        })
        .expect("the child starts");
        let pid = Pid::from_raw(system_process_id(child.process.id()).expect("an id").get());

        let session = getsid(Some(pid));
        let group = getpgid(Some(pid));

        let process = child.process.clone();
        tokio::task::spawn_blocking(move || process.stop(Duration::from_secs(5)))
            .await
            .expect("the stop runs")
            .expect("the test ends its own child");
        let status = child.exit.await.expect("the child is reaped");
        assert_eq!(session.expect("the child's session reads"), pid);
        assert_eq!(group.expect("the child's group reads"), pid);
        assert_eq!(status.signal(), Some(Signal::SIGTERM as i32));
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
