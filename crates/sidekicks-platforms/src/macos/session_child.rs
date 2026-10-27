//! A session child's start on macOS, through `posix_spawn` with its own session, its output read
//! through a pipe and its reap, since no runtime reaps a child it did not spawn.

use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsFd as _, OwnedFd};
use std::process::ExitStatus;

use nix::sys::signal::Signal;
use tokio::net::unix::pipe::Receiver;

use crate::macos::pinned_process::pin_running_process;
use crate::macos::posix_spawn::{
    SessionLeaderSpawn, SpawnStream, end_spawned_child, reap_ended_child, reap_spawned_child,
    spawn_session_leader,
};
use crate::posix::process::group::signal_group_once;
use crate::session_child::SessionCommand;

/// A started session child: its output, an end for its whole group, and its wait. Dropped before
/// its wait answered, it kills the child alone and reaps it.
pub struct SessionChild {
    /// The child's standard output, read until every process holding it has ended.
    pub output: Receiver,
    id: u32,
    status: Option<ExitStatus>,
}

/// Starts `command` as a child leading a session of its own, through `posix_spawn`, which runs no
/// fork handler in the child: its environment the daemon's own with `command`'s entries set over
/// it, its standard output a pipe whose read end it answers. Runs on the daemon's spawner thread,
/// which has the runtime entered. Fails with the pipe's error or with the spawn's, a program that
/// cannot run among them, or `InvalidInput` for a NUL in one of `command`'s words.
pub fn start_session_child(command: &SessionCommand, _daemon_pid: u32) -> io::Result<SessionChild> {
    let (reader, writer) = io::pipe()?;
    let output = Receiver::from_owned_fd(OwnedFd::from(reader))?;
    let id = spawn_session_leader(&SessionLeaderSpawn {
        program: &command.program,
        argument_zero: &command.argument_zero,
        arguments: &command.arguments,
        environment: inherited_environment(&command.added_environment),
        working_folder: &command.working_folder,
        streams: [
            SpawnStream::NullDevice,
            SpawnStream::Descriptor(writer.as_fd()),
            SpawnStream::NullDevice,
        ],
    })?;
    // The child holds its own copy, so the output ends once it and what it started have ended.
    drop(writer);
    Ok(SessionChild {
        output,
        id,
        status: None,
    })
}

impl SessionChild {
    /// Kills every process of the child's session's group with one signal, the child and what it
    /// started with it, the child ended or not; a group already gone, or a child already reaped,
    /// is no failure. Fails with the system's error when the kill is refused, `EPERM` among them
    /// for a group whose members have all exited but are not yet reaped.
    pub fn end_group(&mut self) -> io::Result<()> {
        if self.status.is_some() {
            return Ok(());
        }
        // Unreaped, the child keeps its id, so its group's id names no other group.
        signal_group_once(self.id, Signal::SIGKILL).map(drop)
    }

    /// Waits for the child's exit and reaps it, with no thread held while it runs, and answers how
    /// it ended, again at a later call. Must be called within the runtime. Fails with the system's
    /// error from the wait or the reap.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        let status = match pin_running_process(self.id)? {
            Some(process) => reap_ended_child(&process).await?,
            // Ended already, so the reap answers at once.
            None => reap_spawned_child(self.id)?,
        };
        self.status = Some(status);
        Ok(status)
    }
}

impl Drop for SessionChild {
    fn drop(&mut self) {
        if self.status.is_none()
            && let Err(error) = end_spawned_child(self.id)
        {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the session child could not be killed and reaped"
            );
        }
    }
}

// The daemon's own environment as `NAME=VALUE` entries, each of `added` set over it.
fn inherited_environment(added: &[(String, String)]) -> Vec<OsString> {
    let inherited = std::env::vars_os().filter(|(name, _)| {
        !added
            .iter()
            .any(|(added_name, _)| OsStr::new(added_name) == name)
    });
    let added = added
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
    inherited
        .chain(added)
        .map(|(name, value)| {
            let mut entry = OsString::with_capacity(name.len() + value.len() + 1);
            entry.push(name);
            entry.push("=");
            entry.push(value);
            entry
        })
        .collect()
}
