//! The `sidekicks` program, which reaches the daemon only through `sidekicks-client`: runs the
//! program on the locked process streams and exits with the code its run ends in.

// Set here, not in the workspace table: rustc builds every library's unit tests as a program,
// where this lint reports each `pub` item the tests leave unused.
#![warn(dead_code_pub_in_binary)]

mod command_context;
mod exit_codes;
mod program;

use std::io::{self, IsTerminal as _};

use command_context::CommandContext;
use exit_codes::ProcessEnding;

fn main() -> std::process::ExitCode {
    let (stdout, stderr) = (io::stdout(), io::stderr());
    let mut context = CommandContext {
        is_stdout_styled: shows_styles(stdout.is_terminal()),
        is_stderr_styled: shows_styles(stderr.is_terminal()),
        stdout: stdout.lock(),
        stderr: stderr.lock(),
    };
    match program::run_program(std::env::args_os(), &mut context) {
        ProcessEnding::Exit(code) => code.into(),
    }
}

/// Whether a stream shows styles, as clap's own output decides: never under `NO_COLOR`, always
/// under `CLICOLOR_FORCE`, and otherwise when it is a terminal that shows colors, so no file or
/// pipe receives an escape code unasked.
fn shows_styles(is_terminal: bool) -> bool {
    !anstyle_query::no_color()
        && (anstyle_query::clicolor_force()
            || (is_terminal && anstyle_query::term_supports_color()))
}
