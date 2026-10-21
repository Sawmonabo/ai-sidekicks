//! The advertised socket path of a service on Windows: the service binds that path itself, with no
//! link in front of it, so there is no link to read, move or remove.

use std::io;
use std::path::{Path, PathBuf};

/// The socket a link at `link` names: always `None`, since no link stands there. Never fails.
pub fn read_socket_link(_link: &Path) -> io::Result<Option<PathBuf>> {
    Ok(None)
}

/// Refuses with `Unsupported`: the path is the socket itself, so a caller that meets the refusal
/// stops one service before it starts the next on the same path.
pub fn replace_socket_link(_link: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "a socket path on Windows is the socket itself and cannot be moved",
    ))
}

/// Removes nothing and answers `false`: no link stands at a socket path. Never fails.
pub fn remove_socket_link(_link: &Path) -> io::Result<bool> {
    Ok(false)
}
