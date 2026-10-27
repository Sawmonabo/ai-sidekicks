//! A local socket listener on Windows, which binds none yet: the daemon's socket there is a named
//! pipe whose access list admits only this account, not built yet.

use std::io::{self, ErrorKind};
use std::path::Path;

use interprocess::local_socket::tokio::Listener;

/// Whether [`bind_socket_listener`] binds a listener: not on Windows until its named pipe lands.
#[cfg(any(test, feature = "test-support"))]
pub const CAN_BIND_A_SOCKET_LISTENER: bool = false;

/// Binds no listener: Windows has no local socket limited to this account yet. Always fails with
/// `Unsupported`.
pub fn bind_socket_listener(_socket_path: &Path) -> io::Result<Listener> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows has no local socket limited to this account yet",
    ))
}
