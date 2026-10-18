//! The `sidekicks` program, which reaches the daemon only through `sidekicks-client`: runs the
//! program on the locked process streams and exits with the code its run ends in.

// Set here, not in the workspace table: rustc builds every library's unit tests as a program,
// where this lint reports each `pub` item the tests leave unused.
#![warn(dead_code_pub_in_binary)]

mod command_context;
mod exit_codes;
mod program;

use std::io;

use command_context::CommandContext;
use exit_codes::ProcessEnding;

fn main() -> std::process::ExitCode {
    let mut context = CommandContext {
        stdout: io::stdout().lock(),
        stderr: io::stderr().lock(),
    };
    match program::run_program(std::env::args_os(), &mut context) {
        ProcessEnding::Exit(code) => code.into(),
    }
}
