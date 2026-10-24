//! The path an open handle names, which Windows does not read here: only a command's wrapper on
//! macOS and Linux reads its standard output's path.

use std::io::{self, ErrorKind};
use std::os::windows::io::AsHandle;
use std::path::PathBuf;

/// Reads no handle's path. Always fails with `Unsupported`.
pub fn read_descriptor_path(_descriptor: impl AsHandle) -> io::Result<PathBuf> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no handle's path here",
    ))
}
