//! What a failed connect to a local socket says on every system.

use std::io;

/// Whether a connect to a local socket failed because nothing listens there: no socket at the
/// path, or a socket file no listener serves.
pub fn found_no_listener(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}
