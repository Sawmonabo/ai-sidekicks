//! The macOS and Linux side of the terminal interface: POSIX signals, the PTY's window size and a
//! poller over the terminal and its program's exit, whose descriptor the runtime watches.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::future::{pending, ready};
use std::io::{self, ErrorKind, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::ptr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use alacritty_terminal::tty::{self, ChildEvent, EventedPty, EventedReadWrite, Pty};
use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use polling::{Event, Events, PollMode, Poller};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

use crate::spawner::Spawner;
#[cfg(any(test, feature = "test-support"))]
use crate::terminal::{AbnormalExit, TestProgram};
use crate::terminal::{
    ConsoleReading, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute, TerminalWake,
    TerminalWaker,
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
pub fn end_process_tree(
    _spawner: &Spawner,
    pid: u32,
) -> impl Future<Output = io::Result<ProcessTreeEnd>> + Send {
    // The kill is one system call, so the future is ready at once.
    ready(kill_process_group(pid))
}

/// Runs the console helper, which only Windows has: always fails with `Unsupported`.
pub fn run_console_helper(
    _spawner: &Spawner,
    _program: &OsStr,
    _arguments: &[OsString],
    _pid: u32,
) -> impl Future<Output = io::Result<()>> + Send {
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

/// Ends the program in `pty`, which the caller found not yet exited, and drops the PTY; blocking,
/// so it runs on a thread of its own. The program gets a hangup and is waited for; `mark_exited`
/// runs once it has exited and before its process id is freed, so a caller that sends signals
/// under the same lock as the mark never reaches a process that took the id.
pub fn release_terminal(pty: Pty, mark_exited: impl FnOnce()) {
    let process_id = pty.child().id();
    if let Err(error) = send_signal(process_id, TerminalSignal::Hangup) {
        tracing::warn!(process_id, %error, "a released terminal's program got no hangup");
    }
    // The program is left unreaped, so its id stays its own until the drop below reaps it.
    if let Err(error) = wait_without_reaping(process_id) {
        tracing::error!(process_id, %error, "a released terminal's program could not be waited for");
    }
    mark_exited();
    // The drop's own hangup reaches the exited, unreaped program, then the drop reaps it.
    drop(pty);
}

/// The key the terminal's input and output are registered under, as `alacritty_terminal` sets it.
const TERMINAL_KEY: usize = 0;

/// The key `alacritty_terminal` registers its child-signal pipe under.
const CHILD_KEY: usize = 1;

/// What a terminal's read loop waits on: the terminal's output and input, the program's exit (its
/// `SIGCHLD` pipe in `alacritty_terminal`), its waker and a deadline, all through one poller whose
/// descriptor the runtime watches.
pub struct TerminalWatch {
    /// The PTY until its program is reaped; dropped right after the reap, since its drop sends a
    /// hangup to the program's id.
    pty: Option<Pty>,
    /// A duplicate of the PTY's master, which `alacritty_terminal` made non-blocking; it reads the
    /// output that is left once the PTY is gone, and takes the window size.
    master: File,
    poller: AsyncFd<Arc<Poller>>,
    waker: TerminalWaker,
    events: Events,
    /// The interest the terminal is registered with.
    interest: Event,
}

impl TerminalWatch {
    /// Makes the watch over `pty`, woken by `waker`; called inside the read loop, since it needs
    /// the runtime. Fails, handing the PTY back, when the master cannot be duplicated or the poller
    /// cannot be watched.
    pub fn new(mut pty: Pty, waker: &TerminalWaker) -> Result<Self, (io::Error, Pty)> {
        let master = match pty.file().try_clone() {
            Ok(master) => master,
            Err(error) => return Err((error, pty)),
        };
        let interest = Event::none(TERMINAL_KEY);
        // SAFETY: the PTY's descriptors outlive the registration, because the watch deletes it
        // before the PTY is dropped (`drop_pty`, `release`) and on the failure below.
        if let Err(error) = unsafe { pty.register(&waker.poller, interest, PollMode::Level) } {
            return Err((error, pty));
        }
        let poller = match AsyncFd::with_interest(Arc::clone(&waker.poller), Interest::READABLE) {
            Ok(poller) => poller,
            Err(error) => {
                if let Err(deregister_error) = pty.deregister(&waker.poller) {
                    tracing::warn!(error = %deregister_error, "a terminal's watch could not be undone");
                }
                return Err((error, pty));
            }
        };
        Ok(Self {
            pty: Some(pty),
            master,
            poller,
            waker: waker.clone(),
            events: Events::new(),
            interest,
        })
    }

    /// Waits until the terminal has output for `read_into`, takes some of `write_from`, the
    /// program may have exited, the waker is woken or `deadline` passes, whichever is first.
    /// Reads only into a given buffer, writes only a given slice, and never answers `Read(0)` or
    /// `Wrote(0)`; a refused write answers [`TerminalWake::WriteFailed`]. Fails with the system's
    /// error from a read or the wait.
    pub async fn wait(
        &mut self,
        mut read_into: Option<&mut [u8]>,
        write_from: Option<&[u8]>,
        deadline: Option<Instant>,
    ) -> io::Result<TerminalWake> {
        self.set_interest(Event::new(
            TERMINAL_KEY,
            read_into.is_some(),
            write_from.is_some(),
        ))?;
        loop {
            if self.waker.take_wake() {
                return Ok(TerminalWake::Woken);
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Ok(TerminalWake::Deadline);
            }
            self.events.clear();
            match self
                .poller
                .get_ref()
                .wait(&mut self.events, Some(Duration::ZERO))
            {
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
            if let Some(wake) = self.take_events(read_into.as_deref_mut(), write_from)? {
                return Ok(wake);
            }
            tokio::select! {
                ready = self.poller.readable() => ready?.clear_ready(),
                () = sleep_until_deadline(deadline) => {}
            }
        }
    }

    /// Reaps the program when it has exited, answering its status; the caller holds its signal
    /// lock across this. The PTY is dropped right after the reap, which sends its hangup to the
    /// reaped program's id at once rather than whenever the terminal closes.
    pub fn take_child_exit(&mut self) -> Option<Option<ExitStatus>> {
        let ChildEvent::Exited(status) = self.pty.as_mut()?.next_child_event()?;
        self.drop_pty();
        Some(status)
    }

    /// Sets the terminal's window size to `rows` by `columns` cells. Fails with the system's error
    /// when the terminal refuses the size.
    pub fn resize(&mut self, rows: u16, columns: u16) -> io::Result<()> {
        let window_size = libc::winsize {
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: the descriptor is the watch's open duplicate of the master, and `TIOCSWINSZ`
        // only reads the `winsize` the pointer names, a live local.
        let result = unsafe {
            libc::ioctl(
                self.master.as_raw_fd(),
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

    /// Ends the watch and drops the PTY. A program not yet exited is ended as
    /// [`release_terminal`] ends it, blocking, with `mark_exited` run before its id is freed; a
    /// reaped one needs neither.
    pub fn release(mut self, mark_exited: impl FnOnce()) {
        match self.pty.take() {
            Some(mut pty) => {
                if let Err(error) = pty.deregister(self.poller.get_ref()) {
                    tracing::warn!(%error, "a terminal's watch could not be undone");
                }
                release_terminal(pty, mark_exited);
            }
            None => {
                if let Err(error) = self.poller.get_ref().delete(&self.master) {
                    tracing::warn!(%error, "a terminal's watch could not be undone");
                }
            }
        }
    }

    /// Answers the first thing the poller's events let the watch do: the program's exit, a read,
    /// or a write; `None` when they offer nothing.
    fn take_events(
        &mut self,
        read_into: Option<&mut [u8]>,
        write_from: Option<&[u8]>,
    ) -> io::Result<Option<TerminalWake>> {
        let mut is_readable = false;
        let mut is_writable = false;
        for event in self.events.iter() {
            if event.key == CHILD_KEY {
                return Ok(Some(TerminalWake::ChildEvent));
            }
            is_readable |= event.readable;
            is_writable |= event.writable;
        }
        if is_readable && let Some(buffer) = read_into {
            match (&self.master).read(buffer) {
                Ok(0) => return Ok(Some(TerminalWake::OutputEnded)),
                Ok(count) => return Ok(Some(TerminalWake::Read(count))),
                Err(error) if is_hang_up(&error) => return Ok(Some(TerminalWake::OutputEnded)),
                Err(error) if is_retry(&error) => {}
                Err(error) => return Err(error),
            }
        }
        if is_writable && let Some(bytes) = write_from {
            match (&self.master).write(bytes) {
                Ok(0) => {
                    let error = io::Error::new(ErrorKind::WriteZero, "the terminal took no input");
                    return Ok(Some(TerminalWake::WriteFailed(error)));
                }
                Ok(count) => return Ok(Some(TerminalWake::Wrote(count))),
                Err(error) if is_hang_up(&error) => return Ok(Some(TerminalWake::InputEnded)),
                Err(error) if is_retry(&error) => {}
                Err(error) => return Ok(Some(TerminalWake::WriteFailed(error))),
            }
        }
        Ok(None)
    }

    /// Registers the terminal with `interest` when it changed.
    fn set_interest(&mut self, interest: Event) -> io::Result<()> {
        if interest == self.interest {
            return Ok(());
        }
        let poller = self.poller.get_ref();
        match &mut self.pty {
            Some(pty) => pty.reregister(poller, interest, PollMode::Level)?,
            None => poller.modify_with_mode(&self.master, interest, PollMode::Level)?,
        }
        self.interest = interest;
        Ok(())
    }

    /// Drops the reaped program's PTY, moving the watch onto the master's duplicate, which keeps
    /// the terminal's output readable.
    fn drop_pty(&mut self) {
        let Some(mut pty) = self.pty.take() else {
            return;
        };
        let poller = self.poller.get_ref();
        if let Err(error) = pty.deregister(poller) {
            tracing::warn!(%error, "a terminal's watch could not be moved off its PTY");
        }
        drop(pty);
        // SAFETY: the duplicate is the watch's own and outlives the registration, which `release`
        // deletes before the watch is dropped.
        let added = unsafe { poller.add_with_mode(&self.master, self.interest, PollMode::Level) };
        if let Err(error) = added {
            tracing::warn!(%error, "a terminal's watch could not be moved onto its master");
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

/// Blocks until the process `pid` has exited, leaving it unreaped so its id stays its own. Fails
/// with the system's error from the wait.
fn wait_without_reaping(pid: u32) -> io::Result<()> {
    let mut information = MaybeUninit::<libc::siginfo_t>::zeroed();
    loop {
        // SAFETY: the information pointer names a live local the call writes at most one
        // `siginfo_t` into, and `WNOWAIT` leaves the process unreaped.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                libc::id_t::from(pid),
                information.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Whether a read or write found nothing to do yet and is tried again at the next event.
fn is_retry(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted)
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

/// The `shell-start` stand-in tests open shells through: `/usr/bin/env`, which ends its options at
/// `--` and runs the program after it with the environment it was given.
#[cfg(any(test, feature = "test-support"))]
pub fn pass_through_start() -> TestProgram {
    TestProgram {
        program: "/usr/bin/env".to_owned(),
        arguments: vec!["--".to_owned()],
    }
}

/// A shell that prints `text` on a line of its own and exits with code 0.
#[cfg(any(test, feature = "test-support"))]
pub fn echo_program(text: &str) -> TestProgram {
    shell_script(&format!("echo {text}"))
}

/// A shell that turns its terminal's echo off, prints `ready`, waits for one input line, then
/// prints the numbers from 0 below `line_count`, one a line, and exits with code 0.
#[cfg(any(test, feature = "test-support"))]
pub fn waiting_printer(line_count: usize) -> TestProgram {
    shell_script(&format!(
        "stty -echo; echo ready; read line; i=0; \
         while [ $i -lt {line_count} ]; do echo $i; i=$((i+1)); done"
    ))
}

/// A shell that ends itself with `SIGTERM`, which the terminal reports as code 0 and signal 15.
#[cfg(any(test, feature = "test-support"))]
pub fn abnormal_exit() -> AbnormalExit {
    AbnormalExit {
        program: shell_script("kill -TERM $$"),
        exit_code: 0,
        signal_code: Some(libc::SIGTERM),
    }
}

#[cfg(any(test, feature = "test-support"))]
fn shell_script(script: &str) -> TestProgram {
    TestProgram {
        program: "/bin/sh".to_owned(),
        arguments: vec!["-c".to_owned(), script.to_owned()],
    }
}
