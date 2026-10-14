//! What the daemon's `shell-start` mode starts a shell from, and why its start can fail, in the
//! shapes every platform shares; each platform's module holds the calls behind them.

use std::ffi::OsString;
use std::io;

/// One shell the `shell-start` mode starts: the program, its arguments and exactly its
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

/// Why the `shell-start` mode could not prepare its own process to start a shell.
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
}
