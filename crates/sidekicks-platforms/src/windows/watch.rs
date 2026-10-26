//! The wake a folder's arrival watch and a file's append watch wait on, which Windows does not
//! raise here: both serve a command's wrapper, which runs on macOS and Linux.

use std::convert::Infallible;
use std::fs::File;
use std::future::Ready;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::time::Duration;

/// A wake no watch on Windows makes.
pub(crate) struct ChangeWake(Infallible);

impl ChangeWake {
    /// Watches no folder. Always fails with `Unsupported`.
    pub(crate) fn on_folder_renames(_folder: &Path) -> io::Result<Self> {
        Err(unwatched())
    }

    /// Watches no file. Always fails with `Unsupported`.
    pub(crate) fn on_file_appends(_file: &File) -> io::Result<Self> {
        Err(unwatched())
    }

    /// Never called, since no wake is ever made.
    pub(crate) fn changed(&mut self) -> Ready<io::Result<()>> {
        match self.0 {}
    }
}

/// A wake on the calling thread no watch on Windows makes.
pub(crate) struct BlockingChangeWake(Infallible);

impl BlockingChangeWake {
    /// Watches no folder. Always fails with `Unsupported`.
    pub(crate) fn on_folder_renames(_folder: &Path) -> io::Result<Self> {
        Err(unwatched())
    }

    /// Never called, since no wake is ever made.
    pub(crate) fn changed(&mut self, _timeout: Option<Duration>) -> io::Result<bool> {
        match self.0 {}
    }
}

fn unwatched() -> io::Error {
    io::Error::new(
        ErrorKind::Unsupported,
        "Windows watches no folder or file here",
    )
}
