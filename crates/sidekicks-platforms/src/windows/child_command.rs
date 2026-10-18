//! A child the daemon starts with `Command` on Windows, opening no console window.

use tokio::process::Command;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// Prepares `command` to start a child of the daemon: it opens no console window, which a daemon
/// with no console of its own would otherwise show for each child. Nothing here ties the child to
/// the daemon: it ends when its handle drops with `kill_on_drop`, and a crash of the daemon leaves
/// it running, so `daemon_pid` is not read. Replaces any creation flags set before.
pub fn prepare_child_command(command: &mut Command, _daemon_pid: u32) {
    command.creation_flags(CREATE_NO_WINDOW);
}
