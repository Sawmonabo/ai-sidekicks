//! What the daemon's `shell` mode starts a shell from, why its start can fail, and the daemon's
//! confirmation that it started the mode, in the shapes every platform shares; each platform's
//! module holds the calls behind them.

use std::ffi::OsString;
use std::io;

/// The environment variable that carries the number of the `shell` mode's end of the daemon's
/// confirmation of its start.
#[cfg(any(target_os = "macos", test, feature = "test-support"))]
pub(crate) const SHELL_START_CONFIRMATION: &str = "SIDEKICKS_SHELL_START_CONFIRMATION";

/// One shell the `shell` mode starts: the program, its arguments and exactly its
/// environment. It derives no `Debug`, since the environment may hold secrets.
pub struct ShellStart {
    /// The shell's program: an absolute path, or a bare name looked up on the environment's `PATH`.
    pub program: OsString,
    /// The arguments the program starts with, in order, as the mode read them after `--`.
    pub arguments: Vec<OsString>,
    /// Exactly the shell's environment, in order, one entry per name; a name is never empty and
    /// holds no `=`, and no name or value holds a NUL.
    pub environment: Vec<(String, String)>,
}

/// Why the `shell` mode could not prepare its own process to start a shell.
#[derive(Debug, thiserror::Error)]
pub enum ShellStartError {
    /// The daemon that opened the shell is no longer the mode's parent, so the shell would outlive
    /// it.
    #[error("the daemon that opened this shell is no longer its parent")]
    DaemonGone,
    /// The system refused to arm the parent-death signal or clear the huge-page switch.
    #[error("the system refused to arm the shell's process")]
    ArmingRefused(#[source] io::Error),
    /// The system refused to set `SIGPIPE` back to its default.
    #[error("the system refused to set SIGPIPE back to its default")]
    SignalResetRefused(#[source] io::Error),
    /// No confirmation came from a parent that is the daemon that opened the shell, so the mode
    /// does not start a program as its own responsible process.
    #[error("the daemon that opened this shell did not confirm its start")]
    Unconfirmed(#[source] io::Error),
}

/// The daemon's side of one shell start's confirmation: nothing on this system, whose shells keep
/// no responsible process.
#[cfg(not(target_os = "macos"))]
pub struct ShellStartConfirmation;

#[cfg(not(target_os = "macos"))]
impl ShellStartConfirmation {
    /// Nothing to open on this system. Never fails.
    pub fn new() -> io::Result<Self> {
        Ok(Self)
    }

    /// No entry: the `shell` mode here waits for no confirmation.
    pub fn environment_entry(&self) -> Option<(String, String)> {
        None
    }

    /// Nothing to confirm on this system. Never fails.
    pub fn confirm(&mut self, _shell_process_id: u32) -> io::Result<()> {
        Ok(())
    }
}
