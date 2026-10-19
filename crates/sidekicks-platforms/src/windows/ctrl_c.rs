//! The terminal's Ctrl-C on Windows: the wait for the console's Ctrl-C event, through tokio's
//! console control handler, and the ending a command takes after it, `ExitProcess` with
//! `STATUS_CONTROL_C_EXIT`, the code `cmd.exe` reads as a Ctrl-C ending, so a script running the
//! command stops too.

use std::io;

use tokio::signal::windows::{CtrlC, ctrl_c as console_ctrl_c};
use windows_sys::Win32::Foundation::STATUS_CONTROL_C_EXIT;
use windows_sys::Win32::System::Threading::ExitProcess;

/// The exit code of a process a Ctrl-C ended: `STATUS_CONTROL_C_EXIT`.
pub(crate) const CTRL_C_EXIT_CODE: u32 = STATUS_CONTROL_C_EXIT.cast_unsigned();

/// The terminal's Ctrl-C, listened for from [`ctrl_c`] until the listener drops; the command
/// holds it for its whole life, since with no listener left the console's default handler ends
/// the process before the command flushes its output and cancels what it waited on.
#[derive(Debug)]
pub struct CtrlCListener(CtrlC);

impl CtrlCListener {
    /// Waits for the next Ctrl-C. Answers `None` only once the runtime is shutting down, when no
    /// Ctrl-C can arrive any more.
    pub async fn recv(&mut self) -> Option<()> {
        self.0.recv().await
    }
}

/// Starts listening for the console's Ctrl-C event, from inside a tokio runtime; while the
/// listener lives, a Ctrl-C no longer ends the process by itself, and the command ends through
/// [`end_as_ctrl_c`]. Fails when the console control handler cannot be installed.
pub fn ctrl_c() -> io::Result<CtrlCListener> {
    console_ctrl_c().map(CtrlCListener)
}

/// Ends the process the way a Ctrl-C does, with exit code `STATUS_CONTROL_C_EXIT`; the caller
/// flushes its output first, since no destructor runs. Never returns.
pub fn end_as_ctrl_c() -> io::Error {
    // SAFETY: the call takes an exit code and ends the process; nothing it reads is borrowed.
    unsafe { ExitProcess(CTRL_C_EXIT_CODE) }
}
