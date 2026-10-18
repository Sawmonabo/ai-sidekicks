//! A child the daemon starts with `Command` on macOS and Linux, armed to end with the daemon.

use tokio::process::Command;

use crate::posix::shell_start::arm_parent_death;

/// Prepares `command` to start a child of the daemon `daemon_pid`: before its program runs, the
/// child arms itself to end with the daemon and checks the daemon is still its parent, since the
/// daemon can end between the fork and the exec. The child's start then fails with `ESRCH` when
/// the daemon is gone, and with the system's error when the arming is refused.
pub fn prepare_child_command(command: &mut Command, daemon_pid: u32) {
    // SAFETY: the closure runs in the forked child before the exec and calls only
    // `arm_parent_death`, which is async-signal-safe and allocates nothing.
    unsafe {
        command.pre_exec(move || arm_parent_death(daemon_pid));
    }
}
