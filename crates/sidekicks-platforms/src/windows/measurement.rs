//! The measurement tests' readings, neither of which is read on Windows.

use std::io;

use crate::footprint::ProcessFootprint;

/// This process's footprint, not read on Windows. Always fails with `Unsupported`.
pub fn process_footprint() -> io::Result<ProcessFootprint> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the process footprint is not read on Windows",
    ))
}

/// The line `uptime` prints, a program Windows lacks. Always fails with `Unsupported`.
pub fn uptime_line() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows has no uptime program",
    ))
}
