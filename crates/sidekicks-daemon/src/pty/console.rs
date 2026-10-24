//! The `console` modes the terminals run on Windows, each attached to a shell's console: `console
//! <pid>` sends the console's processes the hard stop, and `console input <pid>` writes how many
//! input events wait unread there. They start nothing and end as soon as their one call returns.

use std::io;
use std::process::ExitCode;

use sidekicks_platforms::{
    CONSOLE_WAITING_INPUT_ARGUMENT, send_console_break, write_console_waiting_input,
};

use crate::error_description::describe_error;
use crate::standard_error::write_error_line;

/// The word the daemon's own program is started with to run a `console` mode.
pub(crate) const CONSOLE_MODE: &str = "console";

/// Runs the `console` mode on the arguments after its word: `<pid>` sends the console of process
/// `pid` a break, `input <pid>` writes the count of input events waiting on it to standard output.
/// Exits 0 once done, 1 with why on standard error for other arguments or a refused call.
pub(crate) fn run_console_mode(arguments: &[&str]) -> ExitCode {
    let done = match arguments {
        [input, pid] if *input == CONSOLE_WAITING_INPUT_ARGUMENT => {
            read_pid(pid).and_then(|pid| write_console_waiting_input(pid, &mut io::stdout().lock()))
        }
        [pid] => read_pid(pid).and_then(send_console_break),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the console mode is started with a process id, after `input` for a count",
        )),
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            write_error_line(&format!(
                "the console mode failed: {}",
                describe_error(&error)
            ));
            ExitCode::FAILURE
        }
    }
}

// The process id `text` names.
fn read_pid(text: &str) -> io::Result<u32> {
    text.parse()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
}
