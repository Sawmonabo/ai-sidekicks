//! The `sidekicks-daemon` program's dispatch: what one run of the program is, read from the name it
//! was started by and then from its arguments. A link named for the clone's askpass runs that;
//! otherwise the first words choose a helper mode, `shell <daemon pid>`, `console <pid>`, `console
//! input <pid>`, `environment <marker>`, `index`, `database copy`, `database restore <backup
//! folder>` or `database shell`; with no words it is the service. The `hook`, `wsl`, `banners` and
//! `minidump` modes and the `sidekicks-command-wrapper` and `sidekicks-command-askpass` links are
//! their own features' to add here.

use std::ffi::{CString, OsString, c_int};
use std::io::{self, Write as _};
use std::path::Path;
use std::process::ExitCode;

use crate::daemon::login_shell_environment::printing::{ENVIRONMENT_MODE, run_environment_mode};
use crate::daemon::start::run_service;
use crate::pty::console::{CONSOLE_MODE, run_console_mode};
use crate::pty::shell::mode::{SHELL_MODE, run_shell_mode};
use crate::recovery::database_file::copy::{DATABASE_COPY_MODE, run_database_copy};
use crate::recovery::database_file::restore::{DATABASE_RESTORE_MODE, run_database_restore};
use crate::recovery::database_file::sqlite_shell::DATABASE_SHELL_MODE;
use crate::session::search::index::build_mode::{SEARCH_INDEX_BUILD_MODE, run_search_index_build};
use crate::workspace::clone::askpass::program::{GIT_ASKPASS_PROGRAM_NAME, run_git_askpass};

/// SQLite's own shell, run with C arguments, its first the program's name; it answers the shell's
/// exit code. `main` supplies it, since the shell is a C function only `main` may call.
pub type SqliteShell = fn(&[CString]) -> c_int;

/// Runs one run of the program, as its name and arguments choose, `run_sqlite_shell` running the
/// `database shell` mode; answers the run's exit code. An unknown mode exits 1 with why on
/// standard error.
pub fn run_daemon_program(run_sqlite_shell: SqliteShell) -> ExitCode {
    let mut arguments = std::env::args_os();
    let program_name = arguments.next().unwrap_or_default();
    if Path::new(&program_name)
        .file_stem()
        .is_some_and(|stem| stem == GIT_ASKPASS_PROGRAM_NAME)
    {
        return run_git_askpass();
    }
    let arguments: Vec<OsString> = arguments.collect();
    let words: Vec<String> = arguments
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    match words.as_slice() {
        [] => run_service(),
        [SHELL_MODE, daemon_pid] => run_shell_mode(daemon_pid),
        [CONSOLE_MODE, rest @ ..] => run_console_mode(rest),
        [ENVIRONMENT_MODE, marker] => run_environment_mode(marker),
        [SEARCH_INDEX_BUILD_MODE, ..] => run_search_index_build(),
        [first, second, ..] if [*first, *second] == DATABASE_COPY_MODE => run_database_copy(),
        [first, second, ..] if [*first, *second] == DATABASE_RESTORE_MODE => {
            run_database_restore(&arguments[2..])
        }
        [first, second, ..] if [*first, *second] == DATABASE_SHELL_MODE => {
            run_database_shell(run_sqlite_shell, &program_name, &arguments[2..])
        }
        _ => {
            // Nothing is left to report a failed write to; the exit status still says it failed.
            if let Err(error) = writeln!(
                io::stderr().lock(),
                "sidekicks-daemon has no mode {}",
                words.join(" ")
            ) {
                drop(error);
            }
            ExitCode::FAILURE
        }
    }
}

// Runs SQLite's shell with the program's name and `arguments`, each passed as the system's own
// bytes, its standard streams binary first, so a byte the shell reads or writes passes as it is;
// the shell's exit code is the run's, a code past a byte reading as a failure.
fn run_database_shell(
    run_sqlite_shell: SqliteShell,
    program_name: &OsString,
    arguments: &[OsString],
) -> ExitCode {
    if let Err(error) = sidekicks_platforms::set_binary_standard_streams() {
        // Nothing is left to report a failed write to; the exit status still says it failed.
        if let Err(write_error) = writeln!(
            io::stderr().lock(),
            "The database shell's standard streams could not be made binary: {error}"
        ) {
            drop(write_error);
        }
        return ExitCode::FAILURE;
    }
    let shell_arguments: io::Result<Vec<CString>> = std::iter::once(program_name)
        .chain(arguments)
        .map(|argument| {
            let bytes = sidekicks_platforms::os_text_bytes(argument)?;
            CString::new(bytes.into_owned()).map_err(io::Error::from)
        })
        .collect();
    let shell_arguments = match shell_arguments {
        Ok(shell_arguments) => shell_arguments,
        Err(error) => {
            // Nothing is left to report a failed write to; the exit status still says it failed.
            if let Err(write_error) = writeln!(
                io::stderr().lock(),
                "The database shell's arguments cannot be passed: {error}"
            ) {
                drop(write_error);
            }
            return ExitCode::FAILURE;
        }
    };
    u8::try_from(run_sqlite_shell(&shell_arguments)).map_or(ExitCode::FAILURE, ExitCode::from)
}
