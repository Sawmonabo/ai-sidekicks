//! A child the daemon starts with `Command` on Windows, one opening no console window and ending
//! with the daemon's job; how a child is asked to stop, and how the end the daemon asked is named.

use std::io;
use std::process::ExitStatus;

use ::windows::Win32::System::Threading::PROCESS_CREATION_FLAGS;
use process_wrap::tokio::{ChildWrapper, CommandWrap, CreationFlags, JobObject, KillOnDrop};
use tokio::process::Command;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::child_command::ChildEnd;

/// Whether a process is asked to stop by a signal it can answer: none exists here, so a caller
/// first asks the program to stop by the program's own means, then calls `PinnedProcess::stop`.
pub const CAN_SIGNAL_A_STOP: bool = false;

/// Prepares `command` to start a child of the daemon: it opens no console window, which a daemon
/// with no console of its own would otherwise show for each child. Nothing here ties the child to
/// the daemon: it ends when its handle drops with `kill_on_drop`, and a crash of the daemon leaves
/// it running, so `daemon_pid` is not read. Replaces any creation flags set before.
pub fn prepare_child_command(command: &mut Command, _daemon_pid: u32) {
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Wraps `command` as a child that ends with the daemon: it opens no console window and runs in a
/// job that ends its whole tree when the daemon's handle to it closes, the daemon's crash included,
/// so `_daemon_pid` is not read. The caller spawns it on the daemon's spawner thread; the spawn
/// fails with the system's error when the job cannot be made or joined.
pub fn wrap_child_command(command: Command, _daemon_pid: u32) -> CommandWrap {
    let mut wrap = CommandWrap::from(command);
    // The job sets the creation flags itself, from this wrapper alone.
    wrap.wrap(CreationFlags(PROCESS_CREATION_FLAGS(CREATE_NO_WINDOW)))
        .wrap(JobObject)
        .wrap(KillOnDrop);
    wrap
}

/// Asks `child` to stop by ending its job, its whole tree, since no signal a process answers
/// exists here. Fails with the system's error from the end.
pub fn ask_child_to_stop(child: &mut dyn ChildWrapper) -> io::Result<()> {
    child.start_kill()
}

/// The number of the signal that ended a child: always `None`, since no signal ends a process here.
pub(crate) fn exit_signal_number(_status: &ExitStatus) -> Option<i32> {
    None
}

/// The name of the end the daemon asked when it ended the child itself (`SIGTERM` for a stop,
/// `SIGKILL` for a kill), as the wire carries it; `None` otherwise, since no signal ends a process
/// here and the exit code tells the end.
pub(crate) fn exit_signal_name(
    _status: &ExitStatus,
    asked_end: Option<ChildEnd>,
) -> Option<String> {
    asked_end.map(|end| {
        match end {
            ChildEnd::Stop => "SIGTERM",
            ChildEnd::Kill => "SIGKILL",
        }
        .to_owned()
    })
}
