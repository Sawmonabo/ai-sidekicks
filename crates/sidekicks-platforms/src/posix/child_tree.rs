//! A child leading a tree of its own on macOS and Linux: the leader of a process group of its own,
//! prepared as every child of the daemon is, whose tree ends by a kill of that group.

use std::error::Error;
use std::io;
use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use process_wrap::tokio::ChildWrapper;
use tokio::process::Command;

use crate::child_tree::{ChildTreeOutputError, check_output_bound};
use crate::posix::child_command::prepare_child_command;
use crate::posix::process::group::{IS_GROUP_KILL_REPEATED, signal_group, signal_group_once};

/// How much one read of what a child left in a pipe takes at most.
const READY_OUTPUT_CHUNK: usize = 64 * 1024;

/// Starts `command` as the leader of a process group of its own, prepared as a child of the daemon
/// `daemon_pid` by `prepare_child_command`, and killed if its handle drops unreaped. Fails with the
/// spawn's error.
pub(crate) fn spawn_child_tree_process(
    mut command: Command,
    daemon_pid: u32,
) -> io::Result<Box<dyn ChildWrapper>> {
    prepare_child_command(&mut command, daemon_pid);
    command.process_group(0).kill_on_drop(true);
    Ok(Box::new(command.spawn()?))
}

/// Sends `SIGTERM` to every process in the child's group, in a blocking task, since a macOS signal
/// to a group may list its members and wait between tries; a group already gone is no failure.
/// Fails as `signal_group` does, or when the task cannot run.
pub(crate) async fn ask_child_tree_to_stop(process: &mut dyn ChildWrapper) -> io::Result<()> {
    let Some(id) = process.id() else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || signal_group(id, Signal::SIGTERM))
        .await
        .map_err(io::Error::other)??;
    Ok(())
}

/// Kills every process in the child's group, in a blocking task, since a macOS kill repeats until
/// no member is left; an unreaped child keeps the group's id, so the kill reaches no other group,
/// and a reaped one has no id and nothing is killed. Fails as `signal_group` does, or when the
/// task cannot run.
pub(crate) async fn end_child_tree(process: &mut dyn ChildWrapper) -> io::Result<()> {
    let Some(id) = process.id() else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || signal_group(id, Signal::SIGKILL))
        .await
        .map_err(io::Error::other)??;
    Ok(())
}

/// Kills every process in the dropped child's group without sleeping on an async worker: one kill
/// on this thread, then, where a kill repeats until no member is left, the repeat on a blocking
/// thread when a runtime is current, else on this thread. The repeat holds the leader unreaped and
/// drops it only once done: an unreaped leader keeps its id, so no other group can take that id
/// and receive a repeated kill. Fails as `signal_group` does; a repeat on a blocking thread logs
/// its failure.
pub(crate) fn end_dropped_child_tree(process: Box<dyn ChildWrapper>) -> io::Result<()> {
    let Some(id) = process.id() else {
        return Ok(());
    };
    if !IS_GROUP_KILL_REPEATED {
        return signal_group(id, Signal::SIGKILL).map(drop);
    }
    match signal_group_once(id, Signal::SIGKILL) {
        Ok(false) => return Ok(()),
        Ok(true) => {}
        // A group whose members exited unreaped refuses the kill; the repeat tells it apart.
        Err(error) if error.raw_os_error() == Some(Errno::EPERM as i32) => {}
        Err(error) => return Err(error),
    }
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => {
            drop(runtime.spawn_blocking(move || {
                let repeated = signal_group(id, Signal::SIGKILL);
                // Reaped from here on, once the repeat can reach no other group.
                drop(process);
                if let Err(error) = repeated {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a dropped child's tree could not be ended"
                    );
                }
            }));
            Ok(())
        }
        Err(_no_runtime) => signal_group(id, Signal::SIGKILL).map(drop),
    }
}

/// Reads what `stream`, a pipe tokio keeps non-blocking, holds now into `into`, without waiting
/// for more; fails with `TooLarge` once `into` passes `bound`, else with the read's error.
pub(crate) fn read_ready_output(
    stream: Option<&impl AsFd>,
    into: &mut Vec<u8>,
    bound: usize,
) -> Result<(), ChildTreeOutputError> {
    let Some(stream) = stream else {
        return Ok(());
    };
    let mut chunk = vec![0; READY_OUTPUT_CHUNK];
    loop {
        match nix::unistd::read(stream.as_fd(), &mut chunk) {
            Ok(0) | Err(Errno::EAGAIN) => return Ok(()),
            Ok(count) => {
                into.extend_from_slice(&chunk[..count]);
                check_output_bound(into, bound)?;
            }
            Err(Errno::EINTR) => {}
            Err(errno) => return Err(ChildTreeOutputError::Io(io::Error::from(errno))),
        }
    }
}
