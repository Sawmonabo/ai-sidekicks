//! A child the daemon starts with `Command` on Windows: one opening no console window and ending
//! with the daemon's job, or a lasting one broken away from it; how a child is asked to stop, and
//! how the end the daemon asked is named.

use std::io;
use std::os::windows::io::AsRawHandle as _;
use std::process::ExitStatus;

use ::windows::Win32::System::Threading::PROCESS_CREATION_FLAGS;
use process_wrap::tokio::{ChildWrapper, CommandWrap, CreationFlags, JobObject, KillOnDrop};
use tokio::process::Command;
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, DETACHED_PROCESS,
};

use crate::child_command::ChildEnd;
use crate::windows::error_codes::win32_code;

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

/// Prepares `command` to start a child that outlives the daemon: it breaks away from the daemon's
/// job and has no console. A job that refuses the breakaway fails the spawn, which is the start's
/// failure, never retried inside the job. First clears the inherit flag on this process's standard
/// handles, so the child never holds a pipe this process's starter waits on; fails with the
/// system's error when a handle's flag cannot be cleared.
pub fn prepare_lasting_child_command(command: &mut Command) -> io::Result<()> {
    for handle in [
        io::stdin().as_raw_handle(),
        io::stdout().as_raw_handle(),
        io::stderr().as_raw_handle(),
    ] {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            continue;
        }
        // SAFETY: the handle is one of this process's standard handles, borrowed; clearing its
        // inherit flag neither closes it nor changes its access.
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            let error = io::Error::last_os_error();
            // A closed standard handle cannot be inherited.
            if win32_code(&error) == Some(ERROR_INVALID_HANDLE) {
                continue;
            }
            return Err(error);
        }
    }
    command.creation_flags(CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS);
    Ok(())
}

/// Asks `child` to stop by ending its job, its whole tree, since no signal a process answers
/// exists here. Fails with the system's error from the end.
pub fn ask_child_to_stop(child: &mut dyn ChildWrapper) -> io::Result<()> {
    child.start_kill()
}

/// The name of the end the daemon asked when it ended the child itself (`SIGTERM` for a stop,
/// `SIGKILL` for a kill), as the wire carries it; `None` otherwise, since no signal ends a process
/// here and the exit code tells the end.
pub fn exit_signal_name(_status: &ExitStatus, asked_end: Option<ChildEnd>) -> Option<String> {
    asked_end.map(|end| {
        match end {
            ChildEnd::Stop => "SIGTERM",
            ChildEnd::Kill => "SIGKILL",
        }
        .to_owned()
    })
}
