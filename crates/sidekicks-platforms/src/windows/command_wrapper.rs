//! What a command's wrapper asks of the system, which Windows does not give here: the wrapper runs
//! only where a provider starts commands through a POSIX shell, on macOS and Linux.

use std::convert::Infallible;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, ErrorKind};
use std::process::{Command, ExitCode, ExitStatus};
use std::time::Duration;

use alacritty_terminal::event::WindowSize;

use crate::Pty;
use crate::terminal::TerminalSignal;

/// Replaces no process. Always answers `Unsupported`.
pub fn exec_command(_command: &mut Command) -> io::Error {
    unwrapped()
}

/// Replaces no process. Always answers `Unsupported`.
pub fn exec_with_secret(
    _command: &mut Command,
    _secret_variable: &str,
    _secret: &[u8],
) -> io::Error {
    unwrapped()
}

/// Takes no inherited secret. Always fails with `Unsupported`.
pub fn take_inherited_secret(_descriptor: &OsStr) -> io::Result<Vec<u8>> {
    Err(unwrapped())
}

/// Names no program. Always fails with `Unsupported`.
pub fn name_program(_command: &mut Command, _name: &OsStr) -> io::Result<()> {
    Err(unwrapped())
}

/// Passes no signal on. Always fails with `Unsupported`.
pub fn pass_on_stop_signals(
    _pass_on: impl FnMut(TerminalSignal) + Send + 'static,
) -> io::Result<()> {
    Err(unwrapped())
}

/// Changes nothing: Windows runs no command through the wrapper.
pub fn start_in_own_group(_command: &mut Command) {}

/// Runs no job. Always fails with `Unsupported`.
pub fn run_foreground_job(_command: &mut Command) -> io::Result<ExitStatus> {
    Err(unwrapped())
}

/// Signals no group. Always fails with `Unsupported`.
pub fn signal_command_group(_group: u32, _signal: TerminalSignal) -> io::Result<()> {
    Err(unwrapped())
}

/// No number: Windows has no stop signals.
pub fn stop_signal_number(_signal: TerminalSignal) -> Option<i32> {
    None
}

/// Ends nothing. Always answers `Unsupported`.
pub fn end_by_stop_signal(_signal: TerminalSignal) -> io::Error {
    unwrapped()
}

/// The code to exit with as the child whose exit is `status` did, with no failure; a code past what
/// `ExitCode` holds exits as a failure.
pub fn end_as_child_ended(status: ExitStatus) -> (ExitCode, Option<io::Error>) {
    let code = status
        .code()
        .and_then(|code| u8::try_from(code).ok())
        .map_or(ExitCode::FAILURE, ExitCode::from);
    (code, None)
}

/// Reads no window size. Always fails with `Unsupported`.
pub fn read_standard_input_window_size() -> io::Result<Option<WindowSize>> {
    Err(unwrapped())
}

/// A raw standard input no Windows wrapper sets.
pub struct RawStandardInput(Infallible);

impl RawStandardInput {
    /// Sets nothing raw. Always fails with `Unsupported`.
    pub fn enter() -> io::Result<Option<Self>> {
        Err(unwrapped())
    }

    /// Puts back nothing, as none is ever set.
    pub fn leave(self) -> io::Result<()> {
        match self.0 {}
    }
}

/// Signals no group. Always fails with `Unsupported`.
pub fn signal_foreground_group(_pty: &Pty, _signal: TerminalSignal) -> io::Result<()> {
    Err(unwrapped())
}

/// Ends no session. Always fails with `Unsupported`.
pub fn end_terminal_session(_pty: &Pty) -> io::Result<()> {
    Err(unwrapped())
}

/// Makes no second master. Always fails with `Unsupported`.
pub fn blocking_terminal_master(_pty: &Pty) -> io::Result<File> {
    Err(unwrapped())
}

/// A watch on a terminal's master no Windows wrapper makes.
pub struct TerminalOutputWatch(Infallible);

impl TerminalOutputWatch {
    /// Watches no master. Always fails with `Unsupported`.
    pub fn new(_master: &File) -> io::Result<Self> {
        Err(unwrapped())
    }

    /// Waits for nothing, as no watch is ever made.
    pub fn wait(&self, _timeout: Option<Duration>) -> io::Result<bool> {
        match self.0 {}
    }

    /// Wakes nothing, as no watch is ever made.
    pub fn wake(&self) -> io::Result<()> {
        match self.0 {}
    }
}

/// Waits for no child. Always fails with `Unsupported`.
pub fn wait_for_exit(_pid: u32, _bound: Option<Duration>) -> io::Result<bool> {
    Err(unwrapped())
}

/// Waits for no command. Always fails with `Unsupported`.
pub fn wait_for_terminal_command(_pty: &Pty) -> io::Result<ExitStatus> {
    Err(unwrapped())
}

fn unwrapped() -> io::Error {
    io::Error::new(
        ErrorKind::Unsupported,
        "Windows runs no command through the command wrapper",
    )
}
