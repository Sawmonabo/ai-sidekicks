//! A local socket listener on Windows, which binds none yet: the daemon's socket there is a named
//! pipe whose access list admits only this account, not built yet.

use std::io::{self, ErrorKind};
use std::path::Path;

use interprocess::local_socket::tokio::Listener;

/// Binds no listener: Windows has no local socket limited to this account yet. Always fails with
/// `Unsupported`.
pub fn bind_socket_listener(_socket_path: &Path) -> io::Result<Listener> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows has no local socket limited to this account yet",
    ))
}
