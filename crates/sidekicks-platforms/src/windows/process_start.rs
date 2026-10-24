//! What a process started with, which Windows does not read here: the daemon's job ends every
//! process it started when the daemon ends, so no search for them reads their start.

use std::io::{self, ErrorKind};

use crate::process_start::ProcessStart;

/// Reads no process's start. Always fails with `Unsupported`.
pub fn read_process_start(_process_id: u32) -> io::Result<Option<ProcessStart>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no other process's start here",
    ))
}

/// Reads no environment. Always fails with `Unsupported`.
pub fn read_process_environment(_process_id: u32) -> io::Result<Option<Vec<String>>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no other process's environment here",
    ))
}
