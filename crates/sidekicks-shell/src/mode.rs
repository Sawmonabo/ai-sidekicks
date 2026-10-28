//! The `shell` mode: the daemon's own program, started in a terminal's PTY, which starts the shell
//! the daemon launched it with once the daemon has confirmed it started this process. Where the
//! shell cannot be started, it says so on one line above the prompt, titles the terminal after the
//! platform's default shell and starts that instead; started without the daemon's confirmation, it
//! starts nothing.

use std::error::Error;
use std::io::{self, Write as _};
use std::path::Path;
use std::process::ExitCode;

use sidekicks_platforms::{ShellStart, describe_start_failure, prepare_shell_start, start_program};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::standard_error::write_error_line;

/// The word the daemon's own program is started with, before the daemon's process id, to run the
/// `shell` mode.
pub const SHELL_MODE: &str = "shell";

/// Runs the `shell` mode for the daemon whose process id is `daemon_pid`, as the argument after
/// the mode's word gives it: never returns once a shell starts; exits 1 with why on standard
/// error when the argument is not a process id, the daemon did not confirm the start, or neither
/// the shell nor its fallback could be started.
pub fn run_shell_mode(daemon_pid: &str) -> ExitCode {
    let Ok(daemon_pid) = daemon_pid.parse::<u32>() else {
        return fail("the shell mode is started with the daemon's process id");
    };
    let launch = match prepare_shell_start(daemon_pid) {
        Ok(launch) => launch,
        Err(error) => return fail(&describe_error(&error)),
    };
    let failure = start_program(&launch.shell);
    if let Err(error) = write_fallback_notice(&launch.shell, &failure, &launch.fallback) {
        // The fallback still starts; the person sees its prompt without the line.
        drop(error);
    }
    let fallback_failure = start_program(&launch.fallback);
    fail(&describe_error(&fallback_failure as &(dyn Error + 'static)))
}

// The line above the fallback shell's prompt, with its line break, naming the shell that could
// not start, why, and the shell that runs instead.
fn fallback_notice(attempted: &str, reason: &str, fallback: &str) -> String {
    format!("Could not start {attempted} ({reason}), so this tab runs {fallback}.\r\n")
}

// Writes the terminal's title, the fallback shell's file name, and the notice, in one write, so
// the two reach the screen together before the fallback's first output.
fn write_fallback_notice(
    shell: &ShellStart,
    failure: &io::Error,
    fallback: &ShellStart,
) -> io::Result<()> {
    let title = Path::new(&fallback.program).file_name().map_or_else(
        || fallback.program.clone(),
        |name| name.to_string_lossy().into_owned(),
    );
    let text = format!(
        "\x1b]2;{title}\x07{}",
        fallback_notice(
            &shell.program,
            &describe_start_failure(failure),
            &fallback.program
        )
    );
    let mut output = io::stdout().lock();
    output.write_all(text.as_bytes())?;
    output.flush()
}

// Writes why the mode started no shell to standard error, and answers the failure's exit code.
fn fail(why: &str) -> ExitCode {
    write_error_line(&format!("the shell mode started no shell: {why}"));
    ExitCode::FAILURE
}
