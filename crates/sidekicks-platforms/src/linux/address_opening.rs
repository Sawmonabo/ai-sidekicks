//! Opening an address on Linux through the freedesktop.org tools: `xdg-mime` names the application
//! registered for the address's scheme, and `xdg-open` hands the address to it.

use std::io::{self, ErrorKind};
use std::process::{Command, Stdio};

use crate::address_opening::no_handler_error;

/// Opens `address` in the application registered for its scheme, `xdg-open` started and not waited
/// on. Fails with `NotFound` when `xdg-mime` names no application for the scheme, with
/// `InvalidInput` when the address has no scheme, and with `Other` when either tool cannot start
/// or `xdg-mime` fails.
pub fn open_address(address: &str) -> io::Result<()> {
    let (scheme, _) = address.split_once(':').ok_or_else(|| {
        io::Error::new(ErrorKind::InvalidInput, "the address to open has no scheme")
    })?;
    let handler_query = Command::new("xdg-mime")
        .args(["query", "default", &format!("x-scheme-handler/{scheme}")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| tool_start_error("xdg-mime", &error))?;
    if !handler_query.status.success() {
        return Err(io::Error::other(format!(
            "xdg-mime could not name the address's application ({})",
            handler_query.status
        )));
    }
    if handler_query.stdout.trim_ascii().is_empty() {
        return Err(no_handler_error());
    }
    // The application the tool starts outlives this call, and the process this child leaves at
    // its end is reaped by the system once the command line exits.
    #[expect(
        clippy::zombie_processes,
        reason = "the open is handed off and not waited on, and the command line exits right after"
    )]
    let _opener = Command::new("xdg-open")
        .arg(address)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| tool_start_error("xdg-open", &error))?;
    Ok(())
}

// A tool that cannot start, kept apart from `NotFound` so a missing `xdg-utils` never reads as an
// address no application claims.
fn tool_start_error(tool: &str, error: &io::Error) -> io::Error {
    io::Error::other(format!("{tool} could not start: {error}"))
}
