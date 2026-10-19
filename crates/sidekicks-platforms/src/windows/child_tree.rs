//! A child leading a tree of its own on Windows: in a job of its own that opens no console window
//! and that closing the daemon's handle does not end, whose tree ends by ending that job.

use std::io;
use std::time::Duration;

use ::windows::Win32::System::Threading::PROCESS_CREATION_FLAGS;
use process_wrap::tokio::{ChildWrapper, CommandWrap, CreationFlags, JobObject};
use tokio::process::Command;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// How long a child's output is still read after its exit: a read here cannot ask what the pipe
/// holds without waiting, so it waits this long for an end of file a process left in the job may
/// hold off.
pub(crate) const OUTPUT_READ_AFTER_EXIT: Duration = Duration::from_secs(1);

/// Starts `command` in a job of its own that opens no console window and that closing its handle
/// does not end, so a process the child leaves behind runs on after a normal exit. Fails with the
/// spawn's error or the job's.
pub(crate) fn spawn_child_tree_process(
    mut command: Command,
    _daemon_pid: u32,
) -> io::Result<Box<dyn ChildWrapper>> {
    command.kill_on_drop(true);
    let mut wrap = CommandWrap::from(command);
    // The job sets the creation flags itself, from this wrapper alone.
    wrap.wrap(CreationFlags(PROCESS_CREATION_FLAGS(CREATE_NO_WINDOW)))
        .wrap(JobObject);
    wrap.spawn()
}

/// Ends every process in the child's job on this thread. Fails with the system's error.
pub(crate) fn end_child_tree_now(process: &mut dyn ChildWrapper) -> io::Result<()> {
    process.start_kill()
}
