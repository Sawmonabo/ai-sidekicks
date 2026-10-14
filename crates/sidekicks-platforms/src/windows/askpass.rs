//! The askpass program's listener on Windows, which serves none yet: a named pipe with the default
//! access list would let other accounts read the answers.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use interprocess::local_socket::tokio::Listener;

/// Binds no listener: Windows has no askpass pipe whose access list admits only this account yet.
/// Always fails with `Unsupported`, which means the askpass program was never started.
pub fn askpass_listener(_folder: &Path) -> io::Result<(Listener, PathBuf)> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows has no askpass pipe limited to this account yet",
    ))
}
