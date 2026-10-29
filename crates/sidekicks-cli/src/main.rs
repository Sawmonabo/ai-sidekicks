//! The `sidekicks` program, which reaches the daemon only through `sidekicks-client`: runs the
//! program on the locked process streams and ends the way its run ends.

// Set here, not in the workspace table: rustc builds every library's unit tests as a program,
// where this lint reports each `pub` item the tests leave unused.
#![warn(dead_code_pub_in_binary)]

mod command_context;
mod commands;
mod confirmation;
mod connected_command;
mod exit_codes;
mod program;

use std::io;

use anstream::stream::RawStream;
use anstream::{AutoStream, ColorChoice};
use command_context::CommandContext;

fn main() -> std::process::ExitCode {
    let (stdout, stderr) = (io::stdout().lock(), io::stderr().lock());
    let mut context = CommandContext {
        is_stdout_styled: shows_styles(&stdout),
        is_stderr_styled: shows_styles(&stderr),
        stdout,
        stderr,
    };
    let ending = program::run_program(std::env::args_os(), &mut context);
    program::end_process(ending, &mut context).into()
}

/// Whether `stream` shows styles, as clap's own output decides: `anstream`'s choice for it
/// (`NO_COLOR`, then `CLICOLOR_FORCE`, then `CLICOLOR=0`, then a terminal that shows colors or
/// runs under a truthy `CLICOLOR` or `CI`), and on a terminal whose escape codes cannot be turned
/// on (a Windows console without them) never, so no stream receives an escape code it would print.
fn shows_styles<S: RawStream>(stream: &S) -> bool {
    match AutoStream::choice(stream) {
        ColorChoice::Never | ColorChoice::Auto => false,
        ColorChoice::Always | ColorChoice::AlwaysAnsi => {
            !stream.is_terminal()
                || anstyle_query::windows::enable_ansi_colors().unwrap_or(true)
                || anstyle_query::term_supports_ansi_color()
        }
    }
}
