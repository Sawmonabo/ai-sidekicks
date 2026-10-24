//! The daemon's start as its own responsible process, the first thing `main` does, before any
//! thread, socket or lock exists and before the service log starts.

use std::process::ExitCode;

use crate::error_description::describe_error;
use crate::standard_error::write_error_line;

/// Makes the daemon its own responsible process, re-running it in place when it is not yet, so
/// every process it starts reads the daemon as responsible. A failure is written to standard error,
/// the one place left before the service log starts, and answers the exit status `main` returns,
/// so the daemon does not start.
pub(crate) fn become_own_root() -> Result<(), ExitCode> {
    let Err(error) = sidekicks_platforms::become_own_root() else {
        return Ok(());
    };
    let report = format!(
        "the background service could not start: {}",
        describe_error(&error)
    );
    write_error_line(&report);
    Err(ExitCode::FAILURE)
}
