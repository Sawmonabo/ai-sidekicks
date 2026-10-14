//! The line `uptime` prints, which the measurement tests show beside each figure.

use std::io;
use std::process::Command;

// The program that prints the machine's load, by its full path so no `PATH` entry stands in for it.
const UPTIME_PROGRAM: &str = "/usr/bin/uptime";

/// The line `uptime` prints: the time, how long the machine has run and its load averages. Fails
/// with the start's error when `uptime` cannot start, and with `Other` when it exits with a
/// failure.
pub fn uptime_line() -> io::Result<String> {
    let output = Command::new(UPTIME_PROGRAM).output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "uptime exited with {}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
