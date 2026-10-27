//! A session child's start on macOS, through `posix_spawn` with its own session, its output read
//! through a pipe and its reap, since no runtime reaps a child it did not spawn.

use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsFd as _, OwnedFd};

use nix::sys::signal::Signal;
use tokio::net::unix::pipe::Receiver;

use crate::macos::posix_spawn::{
    SessionLeaderSpawn, SpawnStream, end_spawned_child, spawn_session_leader,
};
use crate::posix::process::group::signal_group;
use crate::session_child::SessionCommand;

/// A started session child: its output and an end for its whole group. Dropped, it kills the
/// child alone and reaps it, the reap on a blocking thread when a runtime is current.
pub struct SessionChild {
    output: Receiver,
    id: u32,
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
    Ok(SessionChild { output, id })
}

impl SessionChild {
    /// The child's standard output, read until every process holding it has ended.
    pub fn output_mut(&mut self) -> &mut Receiver {
        &mut self.output
    }

    /// Kills every process of the child's session's group, the child and what it started with it,
    /// the child ended or not, on a blocking thread, the kill sent again until no member is left;
    /// a group already ended is no failure. Must be called within the runtime. Fails as the group
    /// kill does: with `EPERM` when members refuse it, or `TimedOut` naming those it leaves.
    pub async fn end_group(&mut self) -> io::Result<()> {
        // Unreaped until the drop, the child keeps its id, so its group's id names no other group.
        let id = self.id;
        tokio::task::spawn_blocking(move || signal_group(id, Signal::SIGKILL))
            .await
            .map_err(io::Error::other)?
            .map(drop)
    }
}

impl Drop for SessionChild {
    fn drop(&mut self) {
        if let Err(error) = end_spawned_child(self.id) {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the session child could not be killed and reaped"
            );
        }
    }
}

/// The daemon's own environment as `NAME=VALUE` entries, each of `added` set over it.
pub(crate) fn inherited_environment(added: &[(String, String)]) -> Vec<OsString> {
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
