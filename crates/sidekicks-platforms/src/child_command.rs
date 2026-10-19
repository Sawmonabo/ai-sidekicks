//! What every system shares about a child the daemon starts: how the daemon ended it, how its end
//! reads as the wire and a terminal carry it, and the scope a lasting child leaves on a system
//! with none to leave.

#[cfg(not(target_os = "linux"))]
use std::io;
use std::process::ExitStatus;

#[cfg(unix)]
use crate::posix::child_command::{exit_signal_name, exit_signal_number};
#[cfg(windows)]
use crate::windows::child_command::{exit_signal_name, exit_signal_number};

/// How a child was ended: asked to stop, or killed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildEnd {
    /// Asked to stop, by a signal it can answer or by its own means.
    Stop,
    /// Killed, with no chance to answer.
    Kill,
}

/// How a child ended, as the wire and a terminal carry it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChildExit {
    /// The exit code: a Windows code read as its unsigned 32-bit value, so a crash reads
    /// 3221225477, and 0 for an end that carries no code, an end by a signal among them.
    pub exit_code: i64,
    /// The number of the signal that ended the child, where the system reports one; always `None`
    /// on Windows, which has no signals.
    pub signal_number: Option<i32>,
    /// The signal's name as the wire carries it (`SIGKILL`, `SIGRTMIN+3`): on macOS and Linux the
    /// signal that ended the child, on Windows the end the daemon asked when it ended the child
    /// itself, or read from a lasting child's exit (`SIGTERM` for a stop, `SIGKILL` for a kill).
    pub signal_name: Option<String>,
}

/// How the child whose exit is `status` ended, `asked_end` being the end the daemon asked when it
/// ended the child itself, or read from a lasting child's exit, and `None` otherwise. Never fails.
pub fn read_child_exit(status: &ExitStatus, asked_end: Option<ChildEnd>) -> ChildExit {
    ChildExit {
        exit_code: wire_exit_code(status.code()),
        signal_number: exit_signal_number(*status),
        signal_name: exit_signal_name(*status, asked_end),
    }
}

// Windows reports its unsigned 32-bit code as an `i32` of the same bits.
fn wire_exit_code(code: Option<i32>) -> i64 {
    code.map_or(0, |code| i64::from(code.cast_unsigned()))
}

/// Moves the lasting child `_process_id` out of the daemon's scope, so ending the daemon does not
/// end it: nothing to leave on this system, whose lasting start already left the daemon's job.
/// Never fails.
#[cfg(not(target_os = "linux"))]
pub async fn leave_daemon_scope(_process_id: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::wire_exit_code;

    // Fails when the signed code is read as is, which gives a crash a negative code.
    #[test]
    fn child_exit_reads_a_crash_code_as_its_unsigned_value() {
        // An access violation's code, as Windows reports it in a signed 32-bit integer.
        assert_eq!(wire_exit_code(Some(-1_073_741_819)), 3_221_225_477);
        assert_eq!(wire_exit_code(None), 0);
    }
}
