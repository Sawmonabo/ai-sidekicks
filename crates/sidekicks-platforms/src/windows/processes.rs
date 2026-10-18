//! One user's processes and a process's environment, which Windows does not read.

use std::io::{self, ErrorKind};

/// Lists no processes: only macOS reads one user's processes. Always fails with `Unsupported`.
pub fn list_user_process_ids(_user_id: u32) -> io::Result<Vec<u32>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "only macOS lists one user's processes",
    ))
}

/// Reads no environment: only macOS reads another process's environment. Always fails with
/// `Unsupported`.
pub fn read_process_environment(_process_id: u32) -> io::Result<Option<Vec<String>>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "only macOS reads another process's environment",
    ))
}
