//! A shell's exit: its code, and the signal that ended it when the operating system reported one.

use std::process::ExitStatus;

use sidekicks_platforms::read_child_exit;

/// How a shell's program ended, reported once per terminal and after its last output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalExit {
    /// The program's exit code; a Windows code reads as its unsigned 32-bit value, so a crash reads
    /// 3221225477.
    pub exit_code: i64,
    /// The signal that ended the program, present only when the operating system reported one.
    pub signal_code: Option<i32>,
}

impl TerminalExit {
    /// The exit the operating system reported for the program, or the unconfirmed one when it
    /// reported no status.
    pub(crate) fn from_status(status: Option<ExitStatus>) -> Self {
        match status {
            Some(status) => {
                let exit = read_child_exit(&status, None);
                Self {
                    exit_code: exit.exit_code,
                    signal_code: exit.signal_number,
                }
            }
            None => Self::unconfirmed(),
        }
    }

    /// The exit reported for a hard stop the system never confirmed: code 1 and no signal, so it
    /// is never taken for a real signal observation.
    pub(crate) fn unconfirmed() -> Self {
        Self {
            exit_code: 1,
            signal_code: None,
        }
    }
}
