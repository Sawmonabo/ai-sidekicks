//! Which process is at the other end of a local connection, and a process's parent, on Windows,
//! which reads neither yet.

use std::io::{self, ErrorKind};

use interprocess::local_socket::tokio::Stream;

/// Reads no peer: Windows has no caller check yet. Always fails with `Unsupported`.
pub fn read_peer_process_id(_stream: &Stream) -> io::Result<Option<u32>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no local connection's peer process yet",
    ))
}

/// Reads no parent: Windows has no caller check yet. Always fails with `Unsupported`.
pub fn read_parent_process_id(_process_id: u32) -> io::Result<Option<u32>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no process's parent yet",
    ))
}
