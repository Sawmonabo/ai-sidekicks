//! The `environment <marker>` mode the login shell runs during the capture: the daemon's own
//! program prints the environment the shell handed it, every entry ended by a NUL, between two
//! marker lines, so the capture needs no program of the system's and no startup file's alias or
//! function changes what is printed.

use std::io::{self, Write as _};
use std::process::ExitCode;

use sidekicks_platforms::os_text_bytes;

/// The word the daemon's own program is started with to print its environment.
pub(crate) const ENVIRONMENT_MODE: &str = "environment";

/// The marker lines one capture prints around the environment, made from a token fresh at every
/// start, so no startup file prints one by chance.
pub(crate) struct CaptureMarkers {
    /// The line before the environment.
    pub(crate) begin_line: String,
    /// The line after it.
    pub(crate) end_line: String,
}

impl CaptureMarkers {
    /// The markers made from `token`.
    pub(crate) fn new(token: &str) -> Self {
        Self {
            begin_line: format!("__sidekicks_environment_{token}_begin__"),
            end_line: format!("__sidekicks_environment_{token}_end__"),
        }
    }
}

/// Prints this process's environment between the markers made from `token`: the begin line, each
/// entry as `name=value` and a NUL, a line feed, then the end line. Exits 0 once printed, and 1
/// with why on standard error when an entry cannot be written.
pub(crate) fn run_environment_mode(token: &str) -> ExitCode {
    match print_environment(&CaptureMarkers::new(token), &mut io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Nothing is left to report a failed write to; the exit status still says it failed.
            if let Err(write_error) = writeln!(
                io::stderr().lock(),
                "The environment could not be printed: {error}"
            ) {
                drop(write_error);
            }
            ExitCode::FAILURE
        }
    }
}

// Writes the markers and the environment to `output`, as the system holds each entry.
fn print_environment(markers: &CaptureMarkers, output: &mut impl io::Write) -> io::Result<()> {
    writeln!(output, "{}", markers.begin_line)?;
    for (name, value) in std::env::vars_os() {
        output.write_all(&os_text_bytes(&name)?)?;
        output.write_all(b"=")?;
        output.write_all(&os_text_bytes(&value)?)?;
        output.write_all(b"\0")?;
    }
    writeln!(output)?;
    writeln!(output, "{}", markers.end_line)?;
    output.flush()
}
