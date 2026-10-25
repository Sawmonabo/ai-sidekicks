//! What a command's wrapper asks of macOS and Linux: running a program in its own place, handing a
//! secret across that start, passing its stop signals on and its child's end on as its own, and
//! driving the terminal of its own it starts a command in from its standard input.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, ErrorKind, Read as _, Write as _};
use std::os::fd::AsRawFd as _;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Command, ExitCode, ExitStatus};

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::Pty;
use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::sys::signal::Signal;
use nix::sys::termios::{SetArg, Termios, cfmakeraw, tcgetattr, tcgetsid, tcsetattr};
use nix::sys::wait::{WaitStatus, waitpid};
use nix::unistd::{Pid, dup, isatty, pipe, tcgetpgrp};
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use crate::posix::process::group::{signal_group, signal_group_once};
use crate::posix::terminal::posix_signal;
use crate::terminal::TerminalSignal;

/// Replaces this process with the program `command` starts, which takes the signal actions a
/// started program takes (`SIGPIPE` back at its default); returns only on failure, with the exec's
/// error.
pub fn exec_command(command: &mut Command) -> io::Error {
    command.exec()
}

/// Replaces this process with the program `command` starts as [`exec_command`] does, `secret`
/// waiting for it on a pipe whose descriptor `secret_variable` names in its environment, so the
/// secret shows in no argument and no environment another process reads. Returns only on failure,
/// with the pipe's or the exec's error.
pub fn exec_with_secret(command: &mut Command, secret_variable: &str, secret: &[u8]) -> io::Error {
    let handed = (|| -> io::Result<_> {
        // The pipe's ends are made without close-on-exec, so the read end stays open across the
        // exec; a pipe holds far more than a key, so the write never waits for the reader.
        let (reader, writer) = pipe().map_err(io::Error::from)?;
        File::from(writer).write_all(secret)?;
        Ok(reader)
    })();
    match handed {
        Ok(reader) => {
            command.env(secret_variable, reader.as_raw_fd().to_string());
            command.exec()
        }
        Err(error) => error,
    }
}

/// Reads to its end and closes the descriptor a start through [`exec_with_secret`] left open,
/// named by `descriptor` as its variable holds it. Fails with `InvalidInput` for a value that names
/// no descriptor, else with the read's error.
pub fn take_inherited_secret(descriptor: &OsStr) -> io::Result<Vec<u8>> {
    let number: i32 = descriptor
        .to_str()
        .and_then(|text| text.parse().ok())
        .filter(|number| *number > 2)
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "no secret descriptor named"))?;
    // Opening the descriptor's own path makes a second descriptor on the pipe, so the inherited
    // one is closed by its number without taking it as owned.
    let mut secret = Vec::new();
    File::open(format!("/dev/fd/{number}"))?.read_to_end(&mut secret)?;
    nix::unistd::close(number).map_err(io::Error::from)?;
    Ok(secret)
}

/// Starts `command` under `name` as the name its program reads as its own. Never fails on macOS
/// and Linux.
pub fn name_program(command: &mut Command, name: &OsStr) -> io::Result<()> {
    command.arg0(name);
    Ok(())
}

/// Hands each `SIGINT`, `SIGTERM` and `SIGHUP` this process receives to `pass_on` on a thread of
/// its own, in place of the signal's own action, for the process's whole life. Fails when the
/// handlers or the thread cannot be made.
pub fn pass_on_stop_signals(
    mut pass_on: impl FnMut(TerminalSignal) + Send + 'static,
) -> io::Result<()> {
    let mut signals = Signals::new([SIGINT, SIGTERM, SIGHUP])?;
    std::thread::Builder::new()
        .name("stop signals".to_owned())
        .spawn(move || {
            for signal in signals.forever() {
                let signal = match signal {
                    SIGINT => TerminalSignal::Interrupt,
                    SIGTERM => TerminalSignal::Terminate,
                    _ => TerminalSignal::Hangup,
                };
                pass_on(signal);
            }
        })?;
    Ok(())
}

/// Starts the child `command` makes in a process group of its own, which it leads, so a signal the
/// wrapper's own group takes reaches it only as the wrapper passes it on.
pub fn start_in_own_group(command: &mut Command) {
    command.process_group(0);
}

/// Sends `signal` to every process of the group `group` leads; a group already gone is no failure.
/// Fails with `InvalidInput` for a group of 0 or past `i32::MAX`, and with the system's error when
/// the send is refused.
pub fn signal_command_group(group: u32, signal: TerminalSignal) -> io::Result<()> {
    signal_group_once(group, posix_signal(signal))?;
    Ok(())
}

/// The number the system gives `signal`, as a child's end by it reads.
pub fn stop_signal_number(signal: TerminalSignal) -> Option<i32> {
    Some(posix_signal(signal) as i32)
}

/// Ends this process by `signal`'s default action, as a process that took it with no handler
/// ends. Returns only when the action could not be taken, with the system's error.
pub fn end_by_stop_signal(signal: TerminalSignal) -> io::Error {
    match signal_hook::low_level::emulate_default_handler(posix_signal(signal) as i32) {
        Ok(()) => io::Error::other("the signal's default action left the process running"),
        Err(error) => error,
    }
}

/// Ends this process the way its child whose exit is `status` ended: a signal's end raised again
/// as that signal's default action, else the child's own code. Answers the code to exit with only
/// where the raise did not end the process: 128 and the signal's number, as a shell reads it.
pub fn end_as_child_ended(status: ExitStatus) -> ExitCode {
    if let Some(number) = status.signal() {
        if let Err(error) = signal_hook::low_level::emulate_default_handler(number) {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a child's ending signal could not be raised again"
            );
        }
        return ExitCode::from(u8::try_from(128 + number).unwrap_or(u8::MAX));
    }
    status
        .code()
        .and_then(|code| u8::try_from(code).ok())
        .map_or(ExitCode::FAILURE, ExitCode::from)
}

/// The window size of the terminal this process's standard input is, read once; `None` when its
/// standard input is no terminal. Fails with the system's error on any other refusal.
pub fn read_standard_input_window_size() -> io::Result<Option<WindowSize>> {
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `TIOCGWINSZ` writes one `winsize` into the live value, which nothing else reads
    // until the call returns.
    let status = unsafe {
        libc::ioctl(
            libc::STDIN_FILENO,
            libc::c_ulong::from(libc::TIOCGWINSZ),
            &raw mut size,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOTTY) => Ok(None),
            _ => Err(error),
        };
    }
    Ok(Some(WindowSize {
        num_lines: size.ws_row,
        num_cols: size.ws_col,
        cell_width: size.ws_xpixel.checked_div(size.ws_col).unwrap_or(0),
        cell_height: size.ws_ypixel.checked_div(size.ws_row).unwrap_or(0),
    }))
}

/// This process's standard input set raw, every byte passed through as typed, until it drops,
/// which puts back the settings it had.
pub struct RawStandardInput {
    settings: Termios,
}

impl RawStandardInput {
    /// Sets this process's standard input raw; `None` when it is no terminal. Fails with the
    /// system's error when its settings cannot be read or set.
    pub fn enter() -> io::Result<Option<Self>> {
        let input = io::stdin();
        if !isatty(&input).map_err(io::Error::from)? {
            return Ok(None);
        }
        let settings = tcgetattr(&input).map_err(io::Error::from)?;
        let mut raw = settings.clone();
        cfmakeraw(&mut raw);
        tcsetattr(&input, SetArg::TCSANOW, &raw).map_err(io::Error::from)?;
        Ok(Some(Self { settings }))
    }
}

impl Drop for RawStandardInput {
    fn drop(&mut self) {
        if let Err(errno) = tcsetattr(io::stdin(), SetArg::TCSANOW, &self.settings) {
            let error = io::Error::from(errno);
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the standard input's terminal settings could not be put back"
            );
        }
    }
}

/// Sends `signal` to the foreground process group of the terminal `pty` is the master of. Fails
/// with the system's error when the group cannot be read or the signal is refused; a group that
/// has ended takes nothing and is no failure.
pub fn signal_foreground_group(pty: &Pty, signal: TerminalSignal) -> io::Result<()> {
    let group = tcgetpgrp(pty.file()).map_err(io::Error::from)?;
    let group = u32::try_from(group.as_raw()).map_err(io::Error::other)?;
    signal_group_once(group, posix_signal(signal))?;
    Ok(())
}

/// Kills every process of the session the terminal `pty` is the master of started, its foreground
/// group and its leader's group, whatever signal they ignore. Fails with the system's error when
/// the terminal's groups cannot be read or a kill is refused.
pub fn end_terminal_session(pty: &Pty) -> io::Result<()> {
    let master = pty.file();
    let foreground = tcgetpgrp(master).map_err(io::Error::from)?;
    let session = tcgetsid(master).map_err(io::Error::from)?;
    for group in [foreground, session] {
        signal_group(
            u32::try_from(group.as_raw()).map_err(io::Error::other)?,
            Signal::SIGKILL,
        )?;
    }
    Ok(())
}

/// A second handle on the master of `pty` whose reads and writes wait, for a caller copying bytes
/// on threads of its own; the master's one open file is shared, so `pty`'s own handle waits too.
/// Fails with the system's error.
pub fn blocking_terminal_master(pty: &Pty) -> io::Result<File> {
    let master = dup(pty.file()).map_err(io::Error::from)?;
    let flags =
        OFlag::from_bits_retain(fcntl(&master, FcntlArg::F_GETFL).map_err(io::Error::from)?);
    fcntl(&master, FcntlArg::F_SETFL(flags - OFlag::O_NONBLOCK)).map_err(io::Error::from)?;
    Ok(File::from(master))
}

/// Whether the master of `pty` holds output its terminal's program wrote that no read has taken
/// yet, asked with no wait; a terminal whose program side all closed reads as holding some, since
/// a read of it then answers at once. Fails with the system's error.
pub fn has_unread_output(pty: &Pty) -> io::Result<bool> {
    let mut watched = libc::pollfd {
        fd: pty.file().as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: `watched` is one live, writable `pollfd` on the master `pty` keeps open.
    let ready = unsafe { libc::poll(&raw mut watched, 1, 0) };
    if ready < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ready > 0)
}

/// Waits for the command `pty` started to exit and answers its status; the PTY's own drop then
/// finds it reaped. Blocks; fails with the system's error.
pub fn wait_for_terminal_command(pty: &Pty) -> io::Result<ExitStatus> {
    let pid = Pid::from_raw(i32::try_from(pty.child().id()).map_err(io::Error::other)?);
    loop {
        // A stop or a continue is no exit, so the wait goes on past either.
        let status = waitpid(pid, None).map_err(io::Error::from)?;
        if let WaitStatus::Exited(_, code) = status {
            return Ok(ExitStatus::from_raw(code << 8));
        }
        if let WaitStatus::Signaled(_, signal, _) = status {
            return Ok(ExitStatus::from_raw(signal as i32));
        }
    }
}
