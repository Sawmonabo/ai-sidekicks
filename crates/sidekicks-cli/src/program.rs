//! The `sidekicks` program: its arguments, the one error boundary every run passes through, and
//! the process's end. A failure is reported on stderr as one `error: <message>` line, never on
//! stdout and never with a stack, and becomes the run's exit code; a daemon repairing its database
//! file is named in the words the app shows, its counts in the person's number format. A call
//! canceled after a Ctrl-C writes no line and ends the process as the Ctrl-C does.

use std::any::Any;
use std::ffi::OsString;
use std::io::{self, Write};
use std::panic::{self, AssertUnwindSafe};

use clap::{Parser, Subcommand};
use icu_decimal::DecimalFormatter;
use icu_decimal::input::Decimal;
use icu_decimal::options::DecimalFormatterOptions;
use icu_locale_core::Locale;
use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::recovery::{
    DaemonRepairingLinePart, describe_daemon_repairing_line,
};
use sidekicks_platforms::{LocaleCategory, end_as_ctrl_c, system_locale};

use crate::command_context::CommandContext;
use crate::commands::crash::{CrashCommand, run_crash_command};
use crate::commands::daemon::{DaemonCommand, run_daemon_command};
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

/// The program's commands.
#[derive(Debug, Subcommand)]
enum Command {
    /// Read the crash reports this computer keeps.
    #[command(subcommand)]
    Crash(CrashCommand),
    /// Read and drive the background service.
    #[command(subcommand)]
    Daemon(DaemonCommand),
}

/// Runs the program over `args` (the program's name first) and answers how the process ends. Help
/// and the version go to stdout; a refused argument, a bare `sidekicks` among them, goes to stderr
/// with its usage and exits 64; a command's failure or panic goes through [`report_failure`], a
/// panic with no output of its own, since the command's panic hook writes nothing. That hook is
/// the process's own while the command runs, so this crate's tests run under nextest, one process
/// each.
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
        Ok(Ok(code)) => ProcessEnding::Exit(code),
        Ok(Err(failure)) => report_failure(&failure, context),
        Err(payload) => report_failure(&panic_failure(payload.as_ref()), context),
    }
}

/// Runs one command and answers the exit code its run ends with.
fn run_command<Output: Write, ErrorOutput: Write>(
    command: Command,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        Command::Crash(command) => run_crash_command(&command, context),
        Command::Daemon(command) => run_daemon_command(&command, context),
    }
}

/// Writes clap's help, version or refusal to the stream clap names for it, in clap's styles when
/// that stream shows them: exit 0 for help and the version, 64 for a refusal, 141 when that
/// stream's reader went away.
fn report_parse_refusal<Output: Write, ErrorOutput: Write>(
    refusal: &clap::Error,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ProcessEnding {
    let rendered = refusal.render();
    let render = |is_styled: bool| {
        if is_styled {
            rendered.ansi().to_string()
        } else {
            rendered.to_string()
        }
    };
    let (written, code) = if refusal.use_stderr() {
        let text = render(context.is_stderr_styled);
        (write_all(&mut context.stderr, &text), ExitCode::Usage)
    } else {
        let code = if refusal.exit_code() == 0 {
            ExitCode::Success
        } else {
            ExitCode::Usage
        };
        let text = render(context.is_stdout_styled);
        (write_all(&mut context.stdout, &text), code)
    };
    match written {
        Ok(()) => ProcessEnding::Exit(code),
        Err(error) => report_failure(&error.into(), context),
    }
}

/// The one error boundary: writes `error: <message>` to stderr and answers how the run ends. A
/// daemon number with no exit code adds its own line and exits 70; a closed output pipe exits 141
/// with nothing written, since no one is left to read it; a call canceled after a Ctrl-C takes the
/// Ctrl-C ending with nothing written, as the terminal already shows the Ctrl-C.
pub(crate) fn report_failure<Output: Write, ErrorOutput: Write>(
    failure: &anyhow::Error,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ProcessEnding {
    let (code, lines) = match exit_code_for_failure(failure) {
        Ok(ProcessEnding::CtrlC) => return ProcessEnding::CtrlC,
        Ok(ProcessEnding::Exit(ExitCode::BrokenPipe)) => {
            return ProcessEnding::Exit(ExitCode::BrokenPipe);
        }
        Ok(ProcessEnding::Exit(code)) => (code, format!("error: {}\n", describe_failure(failure))),
        Err(unmapped) => (
            ExitCode::Software,
            format!("error: {}\nerror: {unmapped}\n", describe_failure(failure)),
        ),
    };
    ProcessEnding::Exit(write_error_lines(&lines, code, context))
}

/// The failure's message: the repair's line when the daemon refused as `daemon.repairing`, its
/// counts in the person's number format, else every cause in the failure's chain.
fn describe_failure(failure: &anyhow::Error) -> String {
    match repairing_line_parts(failure) {
        Some(parts) => write_repairing_line(parts, system_locale(LocaleCategory::Number).as_ref()),
        None => format!("{failure:#}"),
    }
}

/// The repair's line in parts when the failure's first client error is the `daemon.repairing`
/// refusal; a detail that does not read as the refusal's reads as no count.
fn repairing_line_parts(failure: &anyhow::Error) -> Option<Vec<DaemonRepairingLinePart>> {
    let client_error = failure
        .chain()
        .find_map(|cause| cause.downcast_ref::<ClientError>())?;
    let ClientError::Remote(remote) = client_error else {
        return None;
    };
    let details = remote.repairing_details()?;
    Some(describe_daemon_repairing_line(details.progress))
}

/// The repair's line from its parts, each count grouped as `locale` writes numbers, and in plain
/// digits for the POSIX locale (`None`).
fn write_repairing_line(parts: Vec<DaemonRepairingLinePart>, locale: Option<&Locale>) -> String {
    let formatter = locale.map(|locale| {
        DecimalFormatter::try_new(locale.into(), DecimalFormatterOptions::default())
            .expect("the compiled number data covers every locale through its fallback")
    });
    parts
        .into_iter()
        .map(|part| match (part, &formatter) {
            (DaemonRepairingLinePart::Words(words), _) => words,
            (DaemonRepairingLinePart::Count(count), Some(formatter)) => {
                formatter.format(&Decimal::from(count)).to_string()
            }
            (DaemonRepairingLinePart::Count(count), None) => count.to_string(),
        })
        .collect()
}

/// Ends the process as `ending` asks, answering the exit code for `main` to return: an exit's own
/// code, and for the Ctrl-C ending, once both streams are flushed (since nothing runs after it),
/// the process ends as a Ctrl-C ends it, a flush that failed for a reason other than a reader gone
/// away written to stderr first. Answers only when that ending fails, with its line on stderr and
/// 70.
pub(crate) fn end_process<Output: Write, ErrorOutput: Write>(
    ending: ProcessEnding,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ExitCode {
    match ending {
        ProcessEnding::Exit(code) => code,
        ProcessEnding::CtrlC => {
            let flushed = context.stdout.flush().and_then(|()| context.stderr.flush());
            // A reader gone away loses only output no one is left to read; any other lost output
            // is named, and the command still ends as a Ctrl-C does, so a script running it stops.
            if let Err(error) = flushed
                && error.kind() != io::ErrorKind::BrokenPipe
            {
                write_error_lines(&format!("error: {error}\n"), ExitCode::Software, context);
            }
            let failure = end_as_ctrl_c();
            let lines = format!("error: the command could not end as a Ctrl-C does: {failure}\n");
            write_error_lines(&lines, ExitCode::Software, context)
        }
    }
}

/// Writes `lines` to stderr and answers `code`, or 141 when stderr's reader went away, as a broken
/// stdout decides it, or 70 when the write failed otherwise.
fn write_error_lines<Output: Write, ErrorOutput: Write>(
    lines: &str,
    code: ExitCode,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> ExitCode {
    match write_all(&mut context.stderr, lines) {
        Ok(()) => code,
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => ExitCode::BrokenPipe,
        Err(_) => ExitCode::Software,
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
    use sidekicks_contracts::daemon::recovery::{
        DaemonRepairProgress, describe_daemon_repairing_line,
    };
    use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
    use sidekicks_contracts::jsonrpc::message::JsonRpcErrorData;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::record::JsonRecord;

    use super::{report_failure, run_program, write_repairing_line};
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
            is_stdout_styled: false,
            is_stderr_styled: false,
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
            is_stdout_styled: false,
            is_stderr_styled: false,
        };
        let ending = run_program(["sidekicks", "--help"].map(OsString::from), &mut context);
        assert_eq!(ending, ProcessEnding::Exit(ExitCode::BrokenPipe));
    }

    #[rstest]
    #[case::failing_body(
        anyhow!("the body failed"),
        "error: the body failed\n",
        ExitCode::Software
    )]
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
    #[case::repairing_with_no_count(
        repairing(None).into(),
        "error: Repairing saved sessions after an unexpected shutdown…\n",
        ExitCode::Unavailable
    )]
    #[case::repairing_with_its_count(
        repairing(Some(serde_json::json!({ "progress": { "done": 12, "total": 34 } }))).into(),
        "error: Repairing saved sessions after an unexpected shutdown · 12 of 34\n",
        ExitCode::Unavailable
    )]
    #[case::repairing_with_a_count_that_does_not_read(
        repairing(Some(serde_json::json!({ "progress": { "done": "many" } }))).into(),
        "error: Repairing saved sessions after an unexpected shutdown…\n",
        ExitCode::Unavailable
    )]
    fn a_failure_is_one_error_line_on_stderr_and_nothing_on_stdout(
        #[case] failure: anyhow::Error,
        #[case] reported: &str,
        #[case] expected: ExitCode,
    ) {
        let mut context = context();
        let ending = report_failure(&failure, &mut context);
        assert_eq!(ending, ProcessEnding::Exit(expected));
        assert_eq!(context.stdout, b"");
        assert_eq!(String::from_utf8(context.stderr).expect("UTF-8"), reported);
    }

    /// The `daemon.repairing` refusal, its detail `fields`.
    fn repairing(fields: Option<serde_json::Value>) -> ClientError {
        ClientError::Remote(RemoteError {
            code: i64::from(JsonRpcErrorCode::DomainRefusal.code()),
            message: "repairing".to_owned(),
            data: Some(JsonRpcErrorData {
                refusal: RefusalCode::DaemonRepairing.as_str().to_owned(),
                category: RefusalCategory::Known(KnownRefusalCategory::Unavailable),
                fields: fields.map(|fields| {
                    serde_json::from_value::<JsonRecord>(fields).expect("the detail is a record")
                }),
            }),
        })
    }

    #[rstest]
    #[case::grouped_as_the_us_writes_them(Some("en-US"), "1,234 of 56,789")]
    #[case::grouped_as_germany_writes_them(Some("de-DE"), "1.234 of 56.789")]
    #[case::plain_digits_for_the_posix_locale(None, "1234 of 56789")]
    fn the_repairing_line_groups_its_counts_as_the_locale_writes_numbers(
        #[case] locale: Option<&str>,
        #[case] counts: &str,
    ) {
        let locale = locale.map(|tag| tag.parse().expect("a locale"));
        let parts = describe_daemon_repairing_line(Some(DaemonRepairProgress {
            done: SafeInt::new(1_234).expect("a safe integer"),
            total: SafeInt::new(56_789).expect("a safe integer"),
        }));

        let line = write_repairing_line(parts, locale.as_ref());

        assert_eq!(
            line,
            format!("Repairing saved sessions after an unexpected shutdown · {counts}")
        );
    }
}
