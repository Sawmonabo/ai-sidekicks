//! The `sidekicks` program: its arguments and the one error boundary every run passes through.
//! Every failure is reported on stderr as one `error: <message>` line, never on stdout and never
//! with a stack, and becomes the run's exit code.

use std::any::Any;
use std::ffi::OsString;
use std::io::{self, Write};
use std::panic::{self, AssertUnwindSafe};

use clap::{Parser, Subcommand};

use crate::command_context::CommandContext;
use crate::exit_codes::{ExitCode, ProcessEnding, exit_code_for_failure};

/// The program's arguments; each command joins [`Command`].
#[derive(Debug, Parser)]
#[command(
    name = "sidekicks",
    version,
    about = "Drive AI Sidekicks sessions from the terminal.",
    arg_required_else_help = true
)]
pub(crate) struct Cli {
    /// The command to run.
    #[command(subcommand)]
    command: Command,
}

/// The commands, each landing with the unit that builds it.
#[derive(Debug, Subcommand)]
enum Command {}

/// Runs the program over `args` (the program's name first) and answers how the process ends. Help
/// and the version go to stdout; a refused argument, a bare `sidekicks` among them, goes to stderr
/// with its usage and exits 64; a command's failure or panic goes through [`report_failure`], a
/// panic with no output of its own, since the command's panic hook writes nothing.
pub(crate) fn run_program<Output: Write, ErrorOutput: Write>(
    args: impl IntoIterator<Item = OsString>,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ProcessEnding {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(refusal) => return report_parse_refusal(&refusal, context),
    };
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| run_command(cli.command, context)));
    panic::set_hook(default_hook);
    match outcome {
        Ok(Ok(())) => ProcessEnding::Exit(ExitCode::Success),
        Ok(Err(failure)) => report_failure(&failure, context),
        Err(payload) => report_failure(&panic_failure(payload.as_ref()), context),
    }
}

fn run_command<Output: Write, ErrorOutput: Write>(
    command: Command,
    _context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<()> {
    match command {}
}

/// Writes clap's help, version or refusal to the stream clap names for it, in clap's styles when
/// the context is styled: exit 0 for help and the version, 64 for a refusal, 141 when that
/// stream's reader went away.
fn report_parse_refusal<Output: Write, ErrorOutput: Write>(
    refusal: &clap::Error,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ProcessEnding {
    let rendered = refusal.render();
    let text = if context.is_styled {
        rendered.ansi().to_string()
    } else {
        rendered.to_string()
    };
    let (written, code) = if refusal.use_stderr() {
        (write_all(&mut context.stderr, &text), ExitCode::Usage)
    } else {
        let code = if refusal.exit_code() == 0 {
            ExitCode::Success
        } else {
            ExitCode::Usage
        };
        (write_all(&mut context.stdout, &text), code)
    };
    match written {
        Ok(()) => ProcessEnding::Exit(code),
        Err(error) => report_failure(&error.into(), context),
    }
}

/// The one error boundary: writes `error: <message>` to stderr and answers the failure's exit
/// code. A daemon number with no exit code adds its own line and exits 70; a closed output pipe
/// exits 141 with nothing written, since no one is left to read it.
pub(crate) fn report_failure<Output: Write, ErrorOutput: Write>(
    failure: &anyhow::Error,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ProcessEnding {
    let (code, lines) = match exit_code_for_failure(failure) {
        Ok(ExitCode::BrokenPipe) => return ProcessEnding::Exit(ExitCode::BrokenPipe),
        Ok(code) => (code, format!("error: {failure:#}\n")),
        Err(unmapped) => (
            ExitCode::Software,
            format!("error: {failure:#}\nerror: {unmapped}\n"),
        ),
    };
    match write_all(&mut context.stderr, &lines) {
        Ok(()) => ProcessEnding::Exit(code),
        // A broken stderr decides the exit code, as a broken stdout does.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
            ProcessEnding::Exit(ExitCode::BrokenPipe)
        }
        Err(_) => ProcessEnding::Exit(ExitCode::Software),
    }
}

fn write_all(stream: &mut impl Write, text: &str) -> io::Result<()> {
    stream.write_all(text.as_bytes())?;
    stream.flush()
}

/// A caught panic as a failure, with its message when it carried one.
fn panic_failure(payload: &(dyn Any + Send)) -> anyhow::Error {
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("no message");
    anyhow::anyhow!("the command failed unexpectedly: {message}")
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io::{self, Write};

    use anyhow::anyhow;
    use rstest::rstest;
    use sidekicks_client::error::{ClientError, RemoteError};

    use super::{report_failure, run_program};
    use crate::command_context::CommandContext;
    use crate::exit_codes::{ExitCode, ProcessEnding};

    /// A stream whose reader went away.
    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    fn context() -> CommandContext<Vec<u8>, Vec<u8>> {
        CommandContext {
            stdout: Vec::new(),
            stderr: Vec::new(),
            is_styled: false,
        }
    }

    fn run(args: &[&str]) -> (ProcessEnding, String, String) {
        let mut context = context();
        let ending = run_program(args.iter().map(OsString::from), &mut context);
        let stdout = String::from_utf8(context.stdout).expect("UTF-8");
        let stderr = String::from_utf8(context.stderr).expect("UTF-8");
        (ending, stdout, stderr)
    }

    #[rstest]
    #[case::help(&["sidekicks", "--help"], "Usage: sidekicks")]
    #[case::version(&["sidekicks", "--version"], env!("CARGO_PKG_VERSION"))]
    fn help_and_the_version_go_to_stdout_and_succeed(#[case] args: &[&str], #[case] shown: &str) {
        let (ending, stdout, stderr) = run(args);
        assert_eq!(ending, ProcessEnding::Exit(ExitCode::Success));
        assert!(stdout.contains(shown), "{stdout}");
        assert!(stderr.is_empty(), "{stderr}");
    }

    #[rstest]
    #[case::bare(&["sidekicks"], "Usage: sidekicks")]
    #[case::unknown_word(&["sidekicks", "frobnicate"], "frobnicate")]
    fn a_refused_argument_goes_to_stderr_alone_and_exits_64(
        #[case] args: &[&str],
        #[case] shown: &str,
    ) {
        let (ending, stdout, stderr) = run(args);
        assert_eq!(ending, ProcessEnding::Exit(ExitCode::Usage));
        assert!(stdout.is_empty(), "{stdout}");
        assert!(stderr.contains(shown), "{stderr}");
    }

    #[test]
    fn help_into_a_closed_pipe_exits_141() {
        let mut context = CommandContext {
            stdout: ClosedPipe,
            stderr: Vec::new(),
            is_styled: false,
        };
        let ending = run_program(["sidekicks", "--help"].map(OsString::from), &mut context);
        assert_eq!(ending, ProcessEnding::Exit(ExitCode::BrokenPipe));
    }

    #[rstest]
    #[case::failing_body(anyhow!("the body failed"), "error: the body failed\n", ExitCode::Software)]
    #[case::unmapped_daemon_number(
        ClientError::Remote(RemoteError {
            code: -32_099,
            message: "an unknown code".to_owned(),
            data: None,
        }).into(),
        "error: an unknown code\n\
         error: The background service returned error code -32099, which has no exit code\n",
        ExitCode::Software
    )]
    fn a_failure_is_one_error_line_on_stderr_and_nothing_on_stdout(
        #[case] failure: anyhow::Error,
        #[case] reported: &str,
        #[case] expected: ExitCode,
    ) {
        let mut context = context();
        let ending = report_failure(&failure, &mut context);
        assert_eq!(ending, ProcessEnding::Exit(expected));
        assert!(context.stdout.is_empty());
        assert_eq!(String::from_utf8(context.stderr).expect("UTF-8"), reported);
    }
}
