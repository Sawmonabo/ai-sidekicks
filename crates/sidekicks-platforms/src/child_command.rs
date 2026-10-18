//! What every system shares about a child the daemon starts: how the daemon ended it, and the
//! scope a lasting child leaves on a system with none to leave.

#[cfg(not(target_os = "linux"))]
use std::io;

/// How a child was ended: asked to stop, or killed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildEnd {
    /// Asked to stop, by a signal it can answer or by its own means.
    Stop,
    /// Killed, with no chance to answer.
    Kill,
}

/// Moves the lasting child `_process_id` out of the daemon's scope, so ending the daemon does not
/// end it: nothing to leave on this system, whose lasting start already left the daemon's job.
/// Never fails.
#[cfg(not(target_os = "linux"))]
#[expect(
    clippy::unused_async,
    reason = "Linux's move is a call to systemd over D-Bus, and every system shares one signature"
)]
pub async fn leave_daemon_scope(_process_id: u32) -> io::Result<()> {
    Ok(())
}
