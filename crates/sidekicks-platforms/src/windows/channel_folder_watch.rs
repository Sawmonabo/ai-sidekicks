//! The wake a channel folder's watch waits on, which Windows does not raise here: the channel
//! serves a command's wrapper, which runs on macOS and Linux.

use std::convert::Infallible;
use std::future::Ready;
use std::io::{self, ErrorKind};
use std::path::Path;

/// A wake no watch on Windows makes.
pub(crate) struct ChangeWake(Infallible);

impl ChangeWake {
    /// Watches no folder. Always fails with `Unsupported`.
    pub(crate) fn on_folder_renames(_folder: &Path) -> io::Result<Self> {
        Err(unwatched())
    }

    /// Watches no file. Always fails with `Unsupported`.
    pub(crate) fn on_file_appends(_path: &Path) -> io::Result<Self> {
        Err(unwatched())
    }

    /// Never called, since no wake is ever made.
    pub(crate) fn changed(&mut self) -> Ready<io::Result<()>> {
        match self.0 {}
    }
}

fn unwatched() -> io::Error {
    io::Error::new(
        ErrorKind::Unsupported,
        "Windows watches no channel folder here",
    )
}
