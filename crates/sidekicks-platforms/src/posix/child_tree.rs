//! A child leading a tree of its own on macOS and Linux: the leader of a process group of its own,
//! armed to end with the daemon, whose tree ends by a kill of that group.

use std::io;
use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use process_wrap::tokio::ChildWrapper;
use tokio::process::Command;

use crate::child_tree::{ChildTreeOutputError, check_output_bound};
use crate::posix::child_command::prepare_child_command;
use crate::posix::process::group::signal_group;

/// How much one read of what a child left in a pipe takes at most.
const READY_OUTPUT_CHUNK: usize = 64 * 1024;

/// Starts `command` as the leader of a process group of its own, armed to end with the daemon
/// `daemon_pid`, and killed if its handle drops unreaped. Fails with the spawn's error.
pub(crate) fn spawn_child_tree_process(
    mut command: Command,
    daemon_pid: u32,
) -> io::Result<Box<dyn ChildWrapper>> {
    prepare_child_command(&mut command, daemon_pid);
    command.process_group(0).kill_on_drop(true);
    Ok(Box::new(command.spawn()?))
}

/// Kills every process in the child's group, in a blocking task, since a macOS kill repeats until
/// no member is left. Fails as `signal_group` does, or when the task cannot run.
pub(crate) async fn end_child_tree(process: &mut dyn ChildWrapper) -> io::Result<()> {
    let Some(id) = process.id() else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || signal_group(id, Signal::SIGKILL))
        .await
        .map_err(io::Error::other)??;
    Ok(())
}

/// Kills every process in the child's group on this thread. Fails as `signal_group` does.
pub(crate) fn end_child_tree_now(process: &mut dyn ChildWrapper) -> io::Result<()> {
    if let Some(id) = process.id() {
        signal_group(id, Signal::SIGKILL)?;
    }
    Ok(())
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
