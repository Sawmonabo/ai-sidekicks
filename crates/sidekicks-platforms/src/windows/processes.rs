//! This process's user's processes and a process's environment, which Windows does not read: the
//! daemon's job ends every process it started when the daemon ends, so no search for them runs.

use std::io::{self, ErrorKind};

/// Lists no processes. Always fails with `Unsupported`.
pub fn list_user_process_ids() -> io::Result<Vec<u32>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows lists no user's processes here",
    ))
}

/// Reads no environment. Always fails with `Unsupported`.
pub fn read_process_environment(_process_id: u32) -> io::Result<Option<Vec<String>>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no other process's environment here",
    ))
}
