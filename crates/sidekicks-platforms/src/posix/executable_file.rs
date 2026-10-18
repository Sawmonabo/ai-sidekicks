//! Whether a path names a file this process may run, on macOS and Linux.

use std::path::Path;

use nix::unistd::{AccessFlags, access};

/// Whether `path`, its links followed, is a file this process may execute: a file, since `X_OK`
/// alone passes a folder, that `access` grants execution of. Any error reads as no, since the
/// probe answers a question and a missing or unreadable file is not one to run.
pub(crate) fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        && access(path, AccessFlags::X_OK).is_ok()
}
