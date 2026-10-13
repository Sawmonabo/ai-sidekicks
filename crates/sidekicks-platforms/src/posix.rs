//! The macOS and Linux side of the terminal interface: POSIX signals, the PTY's window size and a
//! tokio wait over the terminal's master file.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::future::{pending, ready};
use std::io::{self, ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::ptr;
use std::sync::Arc;
use std::time::Instant;

use alacritty_terminal::tty::{self, Pty};
use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use tokio::io::unix::AsyncFd;
use tokio::signal::unix::SignalKind;
use tokio::sync::Notify;

use crate::terminal::{
    ConsoleReading, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute, TerminalWake,
};

/// How `signal` reaches a shell's program: on macOS and Linux every signal is sent as itself.
pub fn terminal_signal_route(signal: TerminalSignal) -> TerminalSignalRoute {
    TerminalSignalRoute::Signal(signal)
}

/// How a close's ending `signal` (hangup, stop, kill) reaches a shell's program: on macOS and Linux
/// it is sent as itself.
pub fn terminal_ending_route(signal: TerminalSignal) -> TerminalSignalRoute {
    TerminalSignalRoute::Signal(signal)
}

/// Sends `signal` to the process `pid` alone; a process already gone is not an error. Fails with
/// `InvalidInput` for a pid past `i32::MAX`, and with the system's error when the send is refused.
pub fn send_signal(pid: u32, signal: TerminalSignal) -> io::Result<()> {
    match kill(process_id(pid)?, posix_signal(signal)) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

/// Ends the process group `pid` leads (a shell's program and every process it started) with
/// `SIGKILL`. Fails with `InvalidInput` for a pid past `i32::MAX`, and with the system's error when
/// the kill is refused; a group already gone answers [`ProcessTreeEnd::AlreadyGone`].
pub fn end_process_tree(pid: u32) -> impl Future<Output = io::Result<ProcessTreeEnd>> {
    // The kill is one system call, so the future is ready at once.
    ready(kill_process_group(pid))
}

/// Runs the console helper, which only Windows has: always fails with `Unsupported`.
pub fn run_console_helper(
    _program: &OsStr,
    _arguments: &[OsString],
    _pid: u32,
) -> impl Future<Output = io::Result<()>> {
    ready(Err(io::Error::new(
        ErrorKind::Unsupported,
        "the console helper runs only on Windows",
    )))
}

/// Sends a console break, which only Windows has: always fails with `Unsupported`.
pub fn send_console_break(_pid: u32) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "a console break exists only on Windows",
    ))
}

/// Reads a console's processes and input mode, which only Windows has: always fails with
/// `Unsupported`.
pub fn read_console(_pid: u32) -> io::Result<ConsoleReading> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "a console exists only on Windows",
    ))
}

/// Restricts where the program loads libraries from; the system's loader on macOS and Linux needs
/// no restriction, so this never fails.
pub fn restrict_library_search() -> io::Result<()> {
    Ok(())
}

/// The options `alacritty_terminal` opens a shell's terminal with: `shell` started in
/// `working_directory` with `environment` added, its output not drained once it exits.
#[expect(
    clippy::implicit_hasher,
    reason = "the map goes straight into alacritty_terminal's options, which take the default hasher"
)]
pub fn terminal_options(
    shell: tty::Shell,
    working_directory: Option<PathBuf>,
    environment: HashMap<String, String>,
) -> tty::Options {
    tty::Options {
        shell: Some(shell),
        working_directory,
        drain_on_exit: false,
        env: environment,
    }
}

/// The process id of the program running in `pty`; always known on macOS and Linux.
pub fn child_process_id(pty: &Pty) -> Option<u32> {
    Some(pty.child().id())
}

/// Sets the terminal's window size to `rows` by `columns` cells. Fails with the system's error when
/// the terminal refuses the size.
pub fn resize_terminal(pty: &mut Pty, rows: u16, columns: u16) -> io::Result<()> {
    let window_size = libc::winsize {
        ws_row: rows,
        ws_col: columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: the descriptor is the PTY's open master, which `pty` keeps alive for the call, and
    // `TIOCSWINSZ` only reads the `winsize` the pointer names, a live local.
    let result = unsafe {
        libc::ioctl(
            pty.file().as_raw_fd(),
            libc::TIOCSWINSZ,
            ptr::from_ref(&window_size),
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// The signal that ended a process, when a signal ended it.
pub fn exit_signal(status: &ExitStatus) -> Option<i32> {
    status.signal()
}

/// Runs a terminal's read loop for the shell's life as a task on `runtime`; `name` names the loop
/// only where it runs on a thread of its own. Never fails on macOS and Linux.
pub fn run_terminal_loop(
    runtime: &tokio::runtime::Handle,
    _name: &str,
    read_loop: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    runtime.spawn(read_loop);
    Ok(())
}

/// Wakes a terminal's read loop from any thread; it can be made before the loop runs, and a wake
/// that comes before the loop waits is kept until it does.
#[derive(Clone)]
pub struct TerminalWaker {
    notify: Arc<Notify>,
}

impl TerminalWaker {
    /// Makes a waker; never fails on macOS and Linux.
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            notify: Arc::new(Notify::new()),
        })
    }

    /// Wakes the loop, whose wait answers [`TerminalWake::Woken`].
    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

/// What a terminal's read loop waits on: the terminal's output and input, the program's state
/// changes, its waker and a deadline.
pub struct TerminalWatch {
    /// A duplicate of the PTY's master, which `alacritty_terminal` made non-blocking.
    master: AsyncFd<File>,
    /// Every `SIGCHLD` the daemon receives.
    child_signal: tokio::signal::unix::Signal,
    notify: Arc<Notify>,
    /// Whether the next wait answers [`TerminalWake::ChildEvent`] at once, since the program may
    /// have exited before the signal listener existed.
    is_child_check_due: bool,
}

impl TerminalWatch {
    /// Makes the watch over `pty`, woken by `waker`; called inside the read loop, since on macOS
    /// and Linux it needs the runtime. [`Self::release`] must run before `pty` is dropped. Fails
    /// when the master cannot be duplicated or watched, or the signal listener cannot be made.
    pub fn new(pty: &mut Pty, waker: &TerminalWaker) -> io::Result<Self> {
        Ok(Self {
            master: AsyncFd::new(pty.file().try_clone()?)?,
            child_signal: tokio::signal::unix::signal(SignalKind::child())?,
            notify: Arc::clone(&waker.notify),
            is_child_check_due: true,
        })
    }

    /// Waits until the terminal has output for `read_into`, takes some of `write_from`, the
    /// program may have changed state, the waker is woken or `deadline` passes, whichever is
    /// first. Reads only into a given buffer, writes only a given slice, and never answers
    /// `Read(0)` or `Wrote(0)`; fails with the system's error from a read, a write or the wait.
    pub async fn wait(
        &mut self,
        _pty: &mut Pty,
        read_into: Option<&mut [u8]>,
        write_from: Option<&[u8]>,
        deadline: Option<Instant>,
    ) -> io::Result<TerminalWake> {
        if self.is_child_check_due {
            self.is_child_check_due = false;
            return Ok(TerminalWake::ChildEvent);
        }
        tokio::select! {
            biased;
            received = self.child_signal.recv() => match received {
                Some(()) => Ok(TerminalWake::ChildEvent),
                None => Err(io::Error::other("the child-exit signal stream ended")),
            },
            () = self.notify.notified() => Ok(TerminalWake::Woken),
            () = sleep_until_deadline(deadline) => Ok(TerminalWake::Deadline),
            wake = write_input(&self.master, write_from) => wake,
            wake = read_output(&self.master, read_into) => wake,
        }
    }

    /// Reads what the terminal holds without waiting, to drain it once the program has exited:
    /// `Some(n)` bytes read, `Some(0)` once the output has ended, `None` when nothing is there yet.
    /// Fails with the system's error from the read.
    pub fn try_read(&mut self, _pty: &mut Pty, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        loop {
            match self.master.get_ref().read(buffer) {
                Ok(count) => return Ok(Some(count)),
                Err(error) if is_hang_up(&error) => return Ok(Some(0)),
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(None),
                Err(error) => return Err(error),
            }
        }
    }

    /// Ends the watch; called before the PTY is dropped, since the master's duplicate keeps the
    /// terminal open. Never fails on macOS and Linux.
    pub fn release(self, _pty: &mut Pty) -> io::Result<()> {
        drop(self.master);
        Ok(())
    }
}

/// Reads the terminal's output into `buffer` once the master is readable; with no buffer it never
/// completes.
async fn read_output(
    master: &AsyncFd<File>,
    buffer: Option<&mut [u8]>,
) -> io::Result<TerminalWake> {
    let Some(buffer) = buffer else {
        return pending().await;
    };
    loop {
        let mut guard = master.readable().await?;
        match guard.try_io(|master| master.get_ref().read(buffer)) {
            Ok(Ok(0)) => return Ok(TerminalWake::OutputEnded),
            Ok(Ok(count)) => return Ok(TerminalWake::Read(count)),
            Ok(Err(error)) if is_hang_up(&error) => return Ok(TerminalWake::OutputEnded),
            Ok(Err(error)) if error.kind() == ErrorKind::Interrupted => {}
            Ok(Err(error)) => return Err(error),
            // The readiness was stale; `try_io` cleared it, so the next wait is a real one.
            Err(_would_block) => {}
        }
    }
}

/// Writes some of `bytes` to the terminal's input once the master is writable; with no bytes it
/// never completes. Fails with `WriteZero` when the terminal takes none of a write.
async fn write_input(master: &AsyncFd<File>, bytes: Option<&[u8]>) -> io::Result<TerminalWake> {
    let Some(bytes) = bytes else {
        return pending().await;
    };
    loop {
        let mut guard = master.writable().await?;
        match guard.try_io(|master| master.get_ref().write(bytes)) {
            Ok(Ok(0)) => {
                return Err(io::Error::new(
                    ErrorKind::WriteZero,
                    "the terminal took no input",
                ));
            }
            Ok(Ok(count)) => return Ok(TerminalWake::Wrote(count)),
            Ok(Err(error)) if is_hang_up(&error) => return Ok(TerminalWake::InputEnded),
            Ok(Err(error)) if error.kind() == ErrorKind::Interrupted => {}
            Ok(Err(error)) => return Err(error),
            // The readiness was stale; `try_io` cleared it, so the next wait is a real one.
            Err(_would_block) => {}
        }
    }
}

/// Completes when `deadline` passes, and never without one.
async fn sleep_until_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
        None => pending().await,
    }
}

/// Whether `error` is the `EIO` a master reports once every holder of the terminal's other side
/// has closed it.
fn is_hang_up(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}

fn kill_process_group(pid: u32) -> io::Result<ProcessTreeEnd> {
    match killpg(process_id(pid)?, Signal::SIGKILL) {
        Ok(()) => Ok(ProcessTreeEnd::Ended),
        Err(Errno::ESRCH) => Ok(ProcessTreeEnd::AlreadyGone),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

/// The POSIX pid for `pid`; fails with `InvalidInput` past `i32::MAX`.
fn process_id(pid: u32) -> io::Result<Pid> {
    i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))
}

fn posix_signal(signal: TerminalSignal) -> Signal {
    match signal {
        TerminalSignal::Interrupt => Signal::SIGINT,
        TerminalSignal::Terminate => Signal::SIGTERM,
        TerminalSignal::Kill => Signal::SIGKILL,
        TerminalSignal::Hangup => Signal::SIGHUP,
    }
}
