//! A secret handed to a child on a pipe it inherits, named by the descriptor's number in one
//! variable, so the secret shows in no argument and no environment another process reads.

use std::io::{self, Write as _};
use std::os::fd::{AsRawFd as _, OwnedFd};

use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use tokio::process::Command;

/// The hand-over of a secret to a child on a pipe it inherits, which macOS and Linux supply.
#[derive(Clone, Copy, Debug)]
pub struct SecretPipe(());

/// The secret pipe this system supplies, which macOS and Linux always do.
pub fn secret_pipe() -> Option<SecretPipe> {
    Some(SecretPipe(()))
}

impl SecretPipe {
    /// Starts `command` through `spawn` with `secret` waiting for its program on a pipe whose read
    /// end's number `secret_variable` names in its environment, then closes this process's read
    /// end, so the child holds the pipe's only open end and reads the secret to its end. Runs on
    /// the daemon's spawner thread, so no other child starts while the read end is open here and
    /// inherits it; `spawn` adds no `pre_exec`, so macOS starts the child through `posix_spawn`.
    /// Fails with the pipe's error or the spawn's.
    pub fn spawn_with_secret<T>(
        &self,
        mut command: Command,
        secret_variable: &str,
        secret: &[u8],
        spawn: impl FnOnce(Command) -> io::Result<T>,
    ) -> io::Result<T> {
        let reader = make_secret_pipe(secret)?;
        command.env(secret_variable, reader.as_raw_fd().to_string());
        let spawned = spawn(command);
        // The child has its own copy now, or none when the spawn failed.
        drop(reader);
        spawned
    }
}

/// Makes a pipe holding `secret` and answers its read end, the only end a started program
/// inherits; the write end is closed, so a reader sees the secret's end. Fails with the system's
/// error.
pub(crate) fn make_secret_pipe(secret: &[u8]) -> io::Result<OwnedFd> {
    // Both ends are made close-on-exec and only the read end is cleared, so the write end never
    // reaches a child, which would then never see the end of the secret.
    let (reader, mut writer) = io::pipe()?;
    let reader = OwnedFd::from(reader);
    fcntl(&reader, FcntlArg::F_SETFD(FdFlag::empty())).map_err(io::Error::from)?;
    // A pipe holds far more than a key, so the write never waits for the reader.
    writer.write_all(secret)?;
    drop(writer);
    Ok(reader)
}
