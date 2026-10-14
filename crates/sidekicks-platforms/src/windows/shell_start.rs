//! The Windows pieces of the `shell-start` mode: the default shell, and the middle process that
//! starts the shell with exactly its environment and relays its exit.

use std::env;
use std::io;
use std::path::PathBuf;
use std::process::Command;

use windows_sys::Win32::Foundation::{FALSE, TRUE};
use windows_sys::Win32::System::Console::{
    CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    SetConsoleCtrlHandler,
};
use windows_sys::core::BOOL;

use crate::shell_start::{ShellStart, ShellStartError};

/// The arguments that start a shell as a login shell: none, since Windows' shells have no login
/// form.
pub const LOGIN_SHELL_ARGUMENTS: &[&str] = &[];

/// The platform's default shell: the command interpreter `ComSpec` names, read at each call, else
/// `cmd.exe`.
pub fn default_shell() -> PathBuf {
    env::var_os("ComSpec").map_or_else(|| PathBuf::from("cmd.exe"), PathBuf::from)
}

/// Arms the process to end with the daemon: nothing to do on Windows, where the daemon's
/// kill-on-close job ends every shell with it; never fails.
pub fn arm_parent_death(_daemon_pid: u32) -> io::Result<()> {
    Ok(())
}

/// Prepares the `shell-start` mode's own process for the shell's start: nothing to do on Windows;
/// never fails.
pub fn prepare_shell_start(_daemon_pid: u32) -> Result<(), ShellStartError> {
    Ok(())
}

/// Starts `start`'s program with exactly its arguments and environment, waits for it and ends this
/// process with the program's exit code, returning only when the handler routine cannot be
/// registered or the program cannot be started or waited for. It ends through
/// `std::process::exit`, since `ExitCode` holds only a `u8` and setting a raw 32-bit code on it is
/// not stable; the exit hands the code to `ExitProcess` as the same 32 bits.
#[expect(
    clippy::exit,
    reason = "the shell's 32-bit exit code passes on only through process::exit, since ExitCode \
              holds a u8"
)]
pub fn start_program(start: &ShellStart) -> io::Error {
    // Registered before the shell starts; a routine is never inherited, so the shell keeps the
    // console's default handling.
    // SAFETY: the routine is a plain function that lives as long as the program and reads nothing.
    if unsafe { SetConsoleCtrlHandler(Some(outlast_console_control), TRUE) } == 0 {
        return io::Error::last_os_error();
    }
    // std sorts the block and replaces repeated names case-insensitively, and looks a bare name
    // up on the block's own `PATH`; the working folder and the console are inherited.
    let status = match Command::new(&start.program)
        .args(&start.arguments)
        .env_clear()
        .envs(start.environment.iter().map(|(name, value)| (name, value)))
        .status()
    {
        Ok(status) => status,
        Err(error) => return error,
    };
    // Windows reports the unsigned 32-bit code as an `i32` of the same bits.
    let code = status
        .code()
        .expect("a Windows exit always carries its code");
    std::process::exit(code)
}

/// Keeps this process alive through the console's control events, so its wait relays the shell's
/// exit: Ctrl+C and Ctrl+Break are handled, and a close, logoff or shutdown parks the routine's
/// thread, since returning would let the system end the process before the main thread exits with
/// the shell's code.
extern "system" fn outlast_console_control(control_type: u32) -> BOOL {
    match control_type {
        CTRL_C_EVENT | CTRL_BREAK_EVENT => TRUE,
        CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => loop {
            std::thread::park();
        },
        _ => FALSE,
    }
}
