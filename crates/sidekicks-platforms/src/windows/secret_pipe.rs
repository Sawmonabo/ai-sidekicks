//! The hand-over of a secret to a child on a pipe it inherits, which Windows does not supply here.

use std::io;

use tokio::process::Command;

/// The hand-over of a secret to a child on a pipe it inherits: none on this system, so no value of
/// this type exists.
#[derive(Clone, Copy, Debug)]
pub enum SecretPipe {}

/// No secret pipe: this system supplies none.
pub fn secret_pipe() -> Option<SecretPipe> {
    None
}

impl SecretPipe {
    /// Never runs, since no secret pipe exists on this system.
    pub fn spawn_with_secret<T>(
        &self,
        _command: Command,
        _secret_variable: &str,
        _secret: &[u8],
        _spawn: impl FnOnce(Command) -> io::Result<T>,
    ) -> io::Result<T> {
        match *self {}
    }
}
