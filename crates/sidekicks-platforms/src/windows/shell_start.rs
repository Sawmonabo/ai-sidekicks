//! The Windows pieces of the `shell` mode: the default shell, the launch the daemon sends it over
//! the start's pipe, the middle process that starts the shell with exactly its environment and
//! relays its exit, and the plain words a failed start reads as.

use std::env;
use std::io;
use std::os::windows::process::CommandExt as _;
use std::path::PathBuf;
use std::process::Command;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_BAD_EXE_FORMAT, ERROR_CRC, ERROR_EXE_MACHINE_TYPE_MISMATCH,
    ERROR_FILE_NOT_FOUND, ERROR_FILENAME_EXCED_RANGE, ERROR_PATH_NOT_FOUND, ERROR_READ_FAULT,
    FALSE, TRUE,
};
use windows_sys::Win32::System::Console::{
    CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    SetConsoleCtrlHandler,
};
use windows_sys::core::BOOL;

use crate::shell_start::{ShellLaunch, ShellStart, ShellStartError};
use crate::windows::shell_start_confirmation::receive_launch;

/// The arguments that start a shell as a login shell: none, since Windows' shells have no login
/// form.
pub const LOGIN_SHELL_ARGUMENTS: &[&str] = &[];

/// The platform's default shell: the command interpreter `ComSpec` names, read at each call, else
/// `cmd.exe`.
pub fn default_shell() -> PathBuf {
    env::var_os("ComSpec").map_or_else(|| PathBuf::from("cmd.exe"), PathBuf::from)
}

/// Whether a shell's end with the daemon follows the thread that started it: never on Windows,
/// where the daemon's job ends every shell.
#[cfg(any(test, feature = "test-support"))]
pub const DOES_PARENT_DEATH_FOLLOW_STARTING_THREAD: bool = false;

/// The POSIX shell that runs a line no other shell is named for: `sh` on the search path, as Git
/// for Windows installs it, since Windows has none of its own.
pub const POSIX_SHELL: &str = "sh";

/// Whether [`POSIX_SHELL`] knows no `builtin`: no on Windows, where Git's `sh` is bash.
#[cfg(any(test, feature = "test-support"))]
pub const DOES_POSIX_SHELL_LACK_BUILTIN: bool = false;

/// Prepares the `shell` mode's own process for the shell's start and answers the launch the daemon
/// sent over the start's pipe, served by the daemon `daemon_pid`; the mode keeps the folder it was
/// spawned in, and [`start_program`] starts the shell in the launch's folder. Fails with
/// [`ShellStartError::Unconfirmed`] when the launch does not come from the daemon.
pub fn prepare_shell_start(daemon_pid: u32) -> Result<ShellLaunch, ShellStartError> {
    receive_launch(daemon_pid).map_err(ShellStartError::Unconfirmed)
}

/// The `shell` mode's stand-in tests start shells through: reads the launch its parent serves, as
/// the mode does, and starts the shell. Returns only on failure, with the error that stopped it.
#[cfg(any(test, feature = "test-support"))]
pub fn run_shell_start_stand_in() -> io::Error {
    let own_id = sysinfo::Pid::from_u32(std::process::id());
    let mut system = crate::process_table();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[own_id]), true);
    let Some(parent) = system.process(own_id).and_then(sysinfo::Process::parent) else {
        return io::Error::new(
            io::ErrorKind::NotFound,
            "the stand-in's parent could not be read",
        );
    };
    match receive_launch(parent.as_u32()) {
        Ok(launch) => start_program(&launch.shell),
        Err(error) => error,
    }
}

// The plain words a failed start's error reads as, where the system's own text is not shown: a
// missing file or folder, a refusal, a file this computer cannot run, a path past the system's
// limit and a disk that failed to read.
const START_FAILURE_WORDS: &[(u32, &str)] = &[
    (ERROR_FILE_NOT_FOUND, "no such file"),
    (ERROR_PATH_NOT_FOUND, "no such file"),
    (ERROR_ACCESS_DENIED, "not allowed to run"),
    (ERROR_BAD_EXE_FORMAT, "not a program for this computer"),
    (
        ERROR_EXE_MACHINE_TYPE_MISMATCH,
        "not a program for this computer",
    ),
    (ERROR_FILENAME_EXCED_RANGE, "its path is too long"),
    (ERROR_READ_FAULT, "the disk could not be read"),
    (ERROR_CRC, "the disk could not be read"),
];

/// The plain words a failed start's error `code` reads as; `None` for an error shown in the
/// system's own text.
pub(crate) fn start_failure_words(code: i32) -> Option<&'static str> {
    START_FAILURE_WORDS
        .iter()
        .find_map(|&(listed, words)| (listed.cast_signed() == code).then_some(words))
}

/// Starts `start`'s program in its folder with exactly its arguments, its raw tail written after
/// them as given, and its environment, waits for it and ends this process with the program's exit
/// code, returning only when the handler routine cannot be registered or the program cannot be
/// started or waited for. This process keeps the folder it was spawned in, so it never holds the
/// shell's. It ends through `std::process::exit`, since `ExitCode` holds only a `u8` and setting a
/// raw 32-bit code on it is not stable; the exit hands the code to `ExitProcess` as the same 32
/// bits.
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
    // up on the block's own `PATH`; the console is inherited.
    let mut command = Command::new(&start.program);
    command
        .args(&start.arguments)
        .current_dir(&start.folder)
        .env_clear()
        .envs(start.environment.iter().map(|(name, value)| (name, value)));
    if let Some(tail) = &start.raw_command_tail {
        command.raw_arg(tail);
    }
    let status = match command.status() {
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
