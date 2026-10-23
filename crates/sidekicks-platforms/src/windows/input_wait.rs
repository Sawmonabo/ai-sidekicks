//! Whether a command waits on its console's input, as Windows shows it: a console has no master a
//! terminal reading comes from, so the console helper's reading of the console is the input wait's
//! source.

use std::io::{self, ErrorKind};

use crate::input_wait::{InputTerminal, InputWaitReading};
use crate::terminal::ConsoleReading;

impl From<&ConsoleReading> for InputWaitReading {
    /// The console helper's reading as an input wait: input is taken while a process holds the
    /// console, echo is off while the console does not echo input, and it is set as a password
    /// prompt while it also hands input over a line at a time. A wait is never confirmed,
    /// since no thread's pending console read is read here, so the command keeps its input line and
    /// only the waiting mark is missing.
    fn from(console: &ConsoleReading) -> Self {
        Self {
            is_waiting: false,
            is_waiting_in_select: false,
            accepts_input: !console.process_ids.is_empty(),
            is_echo_off: !console.is_echo_input,
            is_password_prompt: console.is_line_input && !console.is_echo_input,
        }
    }
}

/// Reads a wait from a terminal's master, which a console does not have: its wait is the console
/// helper's [`ConsoleReading`] instead. Always fails with `Unsupported`.
pub fn read_input_wait(_terminal: &InputTerminal) -> io::Result<InputWaitReading> {
    Err(console_read_only())
}

/// Checks a wait on a terminal's master, which a console does not have. Always fails with
/// `Unsupported`.
pub fn may_wait_for_input(_terminal: &InputTerminal) -> io::Result<bool> {
    Err(console_read_only())
}

fn console_read_only() -> io::Error {
    io::Error::new(
        ErrorKind::Unsupported,
        "a console's input wait is read by the console helper",
    )
}
