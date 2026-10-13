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
        let exit_code = code.map_or(0, |code| i64::from(u32::from_ne_bytes(code.to_ne_bytes())));
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
    use rstest::rstest;

    use super::TerminalExit;

    #[rstest]
    // A Windows exit, an access violation's code among them, carries no signal.
    #[case::windows_crash(Some(-1_073_741_819), None, 3_221_225_477, None)]
    // A Windows child the hard stop ended exits with taskkill's code 1 and no signal.
    #[case::windows_hard_stop(Some(1), None, 1, None)]
    #[case::unix_code(Some(3), None, 3, None)]
    // A Unix end by signal carries the signal the system reported, and no code.
    #[case::unix_signal(None, Some(15), 0, Some(15))]
    fn an_exit_carries_only_the_signal_the_system_reported(
        #[case] code: Option<i32>,
        #[case] signal_code: Option<i32>,
        #[case] expected_code: i64,
        #[case] expected_signal: Option<i32>,
    ) {
        let exit = TerminalExit::from_parts(code, signal_code);
        assert_eq!(
            exit,
            TerminalExit {
                exit_code: expected_code,
                signal_code: expected_signal
            }
        );
    }

    #[test]
    fn an_unconfirmed_hard_stop_is_code_one_with_no_signal() {
        let unconfirmed = TerminalExit::unconfirmed();
        assert_eq!(
            unconfirmed,
            TerminalExit {
                exit_code: 1,
                signal_code: None
            }
        );
        assert_eq!(TerminalExit::from_status(None), unconfirmed);
        assert_ne!(unconfirmed, TerminalExit::from_parts(None, Some(1)));
    }
}
