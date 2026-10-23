//! This process's user's processes, which Windows does not list: the daemon's job ends every
//! process it started when the daemon ends, so no search for them runs.

use std::io::{self, ErrorKind};

/// Lists no processes. Always fails with `Unsupported`.
pub fn list_user_process_ids() -> io::Result<Vec<u32>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows lists no user's processes here",
    ))
}
