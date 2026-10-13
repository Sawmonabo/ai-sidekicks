//! A shell's exit: its code, and the signal that ended it when the operating system reported one.

use std::process::ExitStatus;

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
                Self::from_parts(status.code(), sidekicks_platforms::exit_signal(&status))
            }
            None => Self::unconfirmed(),
        }
    }

    /// The exit read from an exit code and a reported signal: an end by signal carries no code of
    /// its own and reads 0, as does a status that holds neither.
    fn from_parts(code: Option<i32>, signal_code: Option<i32>) -> Self {
        let exit_code = code.map_or(0, |code| i64::from(code.cast_unsigned()));
        Self {
            exit_code,
            signal_code,
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

#[cfg(test)]
mod tests {
    use super::TerminalExit;

    #[test]
    fn a_crash_code_reads_as_its_unsigned_value() {
        // An access violation's code, as Windows reports it in a signed 32-bit integer.
        let exit = TerminalExit::from_parts(Some(-1_073_741_819), None);
        assert_eq!(
            exit,
            TerminalExit {
                exit_code: 3_221_225_477,
                signal_code: None
            }
        );
    }
}
