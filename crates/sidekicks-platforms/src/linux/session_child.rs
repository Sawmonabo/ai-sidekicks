//! A session child's start on Linux, through `Command`, which makes the session in the child
//! before its program runs.

use std::io;
use std::process::Stdio;

use nix::sys::signal::Signal;
use nix::unistd::setsid;
use tokio::process::{Child, ChildStdout, Command};

use crate::posix::child_command::prepare_child_command;
use crate::posix::process::group::signal_group;
use crate::session_child::SessionCommand;

/// A started session child: its output and an end for its whole group. Dropped, it kills the
/// child alone, and the runtime reaps it.
pub struct SessionChild {
    output: ChildStdout,
    child: Child,
}

/// Starts `command` as a child of the daemon `daemon_pid` leading a session of its own, prepared
/// as `prepare_child_command` prepares it, the session made in the child before its program runs:
/// its environment the daemon's own with `command`'s entries set over it, its standard output a
/// pipe whose read end it answers. Runs on the daemon's spawner thread. Fails as
/// `prepare_child_command` says, with the system's error when the session is refused, or with the
/// spawn's.
pub fn start_session_child(command: &SessionCommand, daemon_pid: u32) -> io::Result<SessionChild> {
    let mut child_command = Command::new(&command.program);
    child_command
        .arg0(&command.argument_zero)
        .args(&command.arguments)
        .envs(
            command
                .added_environment
                .iter()
                .map(|(name, value)| (name, value)),
        )
        .current_dir(&command.working_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    prepare_child_command(&mut child_command, daemon_pid);
    // SAFETY: the closure runs in the forked child before the exec and makes only `setsid`, which
    // is async-signal-safe and allocates nothing.
    unsafe {
        child_command.pre_exec(|| {
            setsid()?;
            Ok(())
        });
    }
    let mut child = child_command.spawn()?;
    let output = child
        .stdout
        .take()
        .expect("the session child's standard output is piped");
    Ok(SessionChild { output, child })
}

impl SessionChild {
    /// The child's standard output, read until every process holding it has ended.
    pub fn output_mut(&mut self) -> &mut ChildStdout {
        &mut self.output
    }

    /// Kills every process of the child's session's group, the child and what it started with it,
    /// the child ended or not, on a blocking thread; a group already ended is no failure. Must be
    /// called within the runtime. Fails with the system's error when the kill is refused.
    pub async fn end_group(&mut self) -> io::Result<()> {
        // Unreaped until the drop, the child keeps its id, so its group's id names no other group.
        let Some(id) = self.child.id() else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || signal_group(id, Signal::SIGKILL))
            .await
            .map_err(io::Error::other)?
            .map(drop)
    }
}
