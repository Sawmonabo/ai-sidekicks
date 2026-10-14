//! The measurement tests' readings, neither of which Windows reports.

use std::io;

use crate::footprint::ProcessFootprint;

/// This process's footprint, which only macOS reports. Always fails with `Unsupported`.
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "only macOS reports a process's footprint",
    ))
}

/// The line `uptime` prints, a program Windows lacks. Always fails with `Unsupported`.
pub fn uptime_line() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows has no uptime program",
    ))
}
