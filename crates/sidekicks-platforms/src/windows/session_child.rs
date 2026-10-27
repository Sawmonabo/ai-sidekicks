//! A session child's start on Windows, which has no sessions and no terminal that stops a process:
//! a child in a job of its own that ends with the daemon.

use std::io;
use std::process::Stdio;

use process_wrap::tokio::ChildWrapper;
use tokio::process::{ChildStdout, Command};

use crate::session_child::SessionCommand;
use crate::windows::child_command::wrap_child_command;

/// A started session child: its output and an end for its whole tree. Dropped, it closes the
/// child's job, which ends the whole tree.
pub struct SessionChild {
    output: ChildStdout,
    child: Box<dyn ChildWrapper>,
}

/// Starts `command` as `wrap_child_command` wraps a child, opening no console window, in a job
/// that holds its whole tree: its environment the daemon's own with `command`'s entries set over
/// it, its standard output a pipe whose read end it answers; `argument_zero` is not read. Runs on
/// the daemon's spawner thread. Fails with the system's error when the job cannot be made or
/// joined, or with the spawn's.
pub fn start_session_child(command: &SessionCommand, daemon_pid: u32) -> io::Result<SessionChild> {
    let mut child_command = Command::new(&command.program);
    child_command
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
        .stderr(Stdio::null());
    let mut child = wrap_child_command(child_command, daemon_pid).spawn()?;
    let output = child
        .stdout()
        .take()
        .expect("the session child's standard output is piped");
    Ok(SessionChild { output, child })
}

impl SessionChild {
    /// The child's standard output, read until every process holding it has ended.
    pub fn output_mut(&mut self) -> &mut ChildStdout {
        &mut self.output
    }

    /// Ends the child's whole job, the child and what it started with it, the child ended or not;
    /// the end is sent at the call, and the future, awaited as the other systems' end is, answers
    /// at once. Fails with the system's error from the end.
    pub fn end_group(&mut self) -> impl Future<Output = io::Result<()>> {
        std::future::ready(self.child.start_kill())
    }
}
