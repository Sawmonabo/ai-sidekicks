//! The macOS and Linux side of the terminal interface: POSIX signals, the keys a terminal turns
//! into signals, the PTY's window size and a poller over the terminal and its program's exit,
//! whose descriptor the runtime watches; `inner` starts a command in a terminal of its own.

pub(crate) mod inner;

use std::collections::HashMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::future::{pending, ready};
use std::io::{self, ErrorKind, Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::path::PathBuf;
use std::process::ExitStatus;
use std::ptr;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use alacritty_terminal::tty::{self, ChildEvent, EventedPty, EventedReadWrite, Pty};
use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::sys::termios::{LocalFlags, SpecialCharacterIndices, tcgetattr, tcgetsid};
use nix::unistd::{Pid, tcgetpgrp};
use polling::{Event, Events, PollMode, Poller};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

#[cfg(target_os = "linux")]
use crate::linux::input_wait::read_queued_input_bytes;
use crate::posix::process::exit::wait_for_exit;
use crate::posix::process::group::signal_group;
use crate::posix::process::id::system_process_id;
use crate::spawner::Spawner;
#[cfg(any(test, feature = "test-support"))]
use crate::terminal::{AbnormalExit, TestProgram};
use crate::terminal::{
    ConsoleReading, ProcessTreeEnd, TerminalInputRefusal, TerminalMasterReading, TerminalSignal,
    TerminalSignalRoute, TerminalWake, TerminalWaker,
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
/// `InvalidInput` for a pid of 0 or past `i32::MAX`, and with the system's error when the send is
/// refused.
pub fn send_signal(pid: u32, signal: TerminalSignal) -> io::Result<()> {
    match kill(
        Pid::from_raw(system_process_id(pid)?.get()),
        posix_signal(signal),
    ) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

/// Whether a terminal's paused read holds the program's input back too: no on macOS and Linux,
/// where the terminal takes input while its output waits unread.
pub const DOES_PAUSED_READ_HOLD_INPUT: bool = false;

/// Whether the system counts the input waiting on a shell's console, which the console helper
/// reads: no on macOS and Linux, which have no console.
pub const DOES_CONSOLE_COUNT_WAITING_INPUT: bool = false;

/// Ends the process group `pid` leads with `SIGKILL`, on a blocking thread; no stop takes this
/// route on macOS or Linux, and a job an interactive shell moved into a group of its own is
/// outside it. Fails with `InvalidInput` for a pid of 0 or past `i32::MAX`, and with the system's
/// error when the kill is refused; a group already gone answers [`ProcessTreeEnd::AlreadyGone`].
pub async fn end_process_tree(_spawner: &Spawner, pid: u32) -> io::Result<ProcessTreeEnd> {
    // A group whose kill macOS refuses is listed, which waits, so the kill leaves the runtime.
    tokio::task::spawn_blocking(move || signal_process_group(pid, TerminalSignal::Kill))
        .await
        .map_err(io::Error::other)?
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

/// Asks the console helper how much input waits on a console, which only Windows has: always
/// fails with `Unsupported`.
pub fn read_console_waiting_input(
    _spawner: &Spawner,
    _program: &OsStr,
    _arguments: &[OsString],
    _pid: u32,
) -> impl Future<Output = io::Result<u32>> + Send {
    ready(Err(io::Error::new(
        ErrorKind::Unsupported,
        "the console helper runs only on Windows",
    )))
}

/// Writes how much input waits on a console, which only Windows has: always fails with
/// `Unsupported`.
pub fn write_console_waiting_input(_pid: u32, _output: &mut impl Write) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "a console exists only on Windows",
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

/// The options `alacritty_terminal` opens a shell's terminal with: `program` with `arguments`
/// started in `working_directory` with `environment` added, its output not drained once it exits.
#[expect(
    clippy::implicit_hasher,
    reason = "the map goes straight into alacritty_terminal's options, which take the default \
              hasher"
)]
pub fn terminal_options(
    program: String,
    arguments: Vec<String>,
    working_directory: Option<PathBuf>,
    environment: HashMap<String, String>,
) -> tty::Options {
    tty::Options {
        shell: Some(tty::Shell::new(program, arguments)),
        working_directory,
        drain_on_exit: false,
        env: environment,
    }
}

/// The process id of the program running in `pty`; always known on macOS and Linux.
pub fn child_process_id(pty: &Pty) -> Option<u32> {
    Some(pty.child().id())
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

/// How long a released terminal's program has to exit on its hangup before it is killed, so a
/// program that ignores the hangup cannot hold the release.
const RELEASE_HANGUP_GRACE: Duration = Duration::from_secs(2);

/// Ends the program in `pty`, which the caller found not yet exited, and drops the PTY; blocking,
/// so it runs on a thread of its own. The program's process group gets a hangup, then `SIGKILL`
/// when the program's exit event has not come within a short grace or cannot be watched, and the
/// program is waited for; `mark_exited` runs once it has exited and before its process id is
/// freed, so a caller that sends signals under the same lock as the mark never reaches a process
/// that took the id. Both signals go to the group the program leads (its start made it a session
/// leader), so the commands it started end with it; a job it moved into a group of its own is
/// outside the send. The program stays unreaped until the drop, so its id, which is its group's,
/// cannot be taken by another process while the signals are sent.
pub fn release_terminal(pty: Pty, mark_exited: impl FnOnce()) {
    let process_id = pty.child().id();
    if let Err(error) = signal_process_group(process_id, TerminalSignal::Hangup) {
        tracing::warn!(
            process_id,
            error = &error as &(dyn Error + 'static),
            "a released terminal's program got no hangup"
        );
    }
    // The program is left unreaped, so its id stays its own until the drop below reaps it.
    let waited = match wait_for_exit(process_id, Some(RELEASE_HANGUP_GRACE)) {
        Ok(true) => Ok(true),
        bounded => {
            match bounded {
                Ok(_) => tracing::warn!(
                    process_id,
                    "a released terminal's program ignored its hangup, so it is killed"
                ),
                // The program may still run, so it is killed, which a program already exited and
                // unreaped ignores, before the wait that has no bound.
                Err(error) => tracing::warn!(
                    process_id,
                    error = &error as &(dyn Error + 'static),
                    "a released terminal's program's exit could not be watched, so it is killed"
                ),
            }
            if let Err(error) = signal_process_group(process_id, TerminalSignal::Kill) {
                tracing::error!(
                    process_id,
                    error = &error as &(dyn Error + 'static),
                    "a released terminal's program could not be killed"
                );
            }
            wait_for_exit(process_id, None)
        }
    };
    if let Err(error) = waited {
        tracing::error!(
            process_id,
            error = &error as &(dyn Error + 'static),
            "a released terminal's program could not be waited for"
        );
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
/// descriptor the runtime watches. It ends through [`Self::release`]: dropped while its program
/// runs, it drops the PTY in place, which blocks until the program exits.
pub struct TerminalWatch {
    /// The PTY until its program is reaped; dropped right after the reap, since its drop sends a
    /// hangup to the program's id.
    pty: Option<Pty>,
    /// A duplicate of the PTY's master, which `alacritty_terminal` made non-blocking; it reads the
    /// output that is left once the PTY is gone, and takes the window size.
    master: File,
    poller: AsyncFd<Arc<Poller>>,
    waker: TerminalWaker,
    /// Set while the terminal can take none of a waiting write.
    input_refusal: TerminalInputRefusal,
    events: Events,
    /// The interest the terminal is registered with.
    interest: Event,
    /// Set once a master reading has logged that its program's side could not be opened.
    peer_failure_noted: Once,
}

impl TerminalWatch {
    /// Makes the watch over `pty`, woken by `waker`, keeping `input_refusal` set while the terminal
    /// refuses a waiting write; called inside the read loop, since it needs the runtime. Fails,
    /// handing the PTY back, when the master cannot be duplicated or the poller cannot be watched.
    pub fn new(
        mut pty: Pty,
        waker: &TerminalWaker,
        input_refusal: &TerminalInputRefusal,
    ) -> Result<Self, (io::Error, Box<Pty>)> {
        let master = match pty.file().try_clone() {
            Ok(master) => master,
            Err(error) => return Err((error, Box::new(pty))),
        };
        let interest = Event::none(TERMINAL_KEY);
        // SAFETY: the PTY's descriptors outlive the registration, because the watch deletes it
        // before the PTY is dropped (`drop_pty`, `release`) and on the failure below.
        if let Err(error) = unsafe { pty.register(&waker.poller, interest, PollMode::Level) } {
            return Err((error, Box::new(pty)));
        }
        // SAFETY: the poller's descriptor stays open for as long as the `Arc` the `AsyncFd` holds
        // keeps the poller alive, and `as_raw_fd` answers that one descriptor every time.
        let registered = unsafe {
            AsyncFd::register_with_interest(Arc::clone(&waker.poller), Interest::READABLE)
        };
        let poller = match registered {
            Ok(poller) => poller,
            Err(registration) => {
                let error = io::Error::from(registration);
                if let Err(deregister_error) = pty.deregister(&waker.poller) {
                    tracing::warn!(
                        error = &deregister_error as &(dyn Error + 'static),
                        "a terminal's watch could not be undone"
                    );
                }
                return Err((error, Box::new(pty)));
            }
        };
        Ok(Self {
            pty: Some(pty),
            master,
            poller,
            waker: waker.clone(),
            input_refusal: input_refusal.clone(),
            events: Events::new(),
            interest,
            peer_failure_noted: Once::new(),
        })
    }

    /// What the terminal's master shows of it now, as [`read_terminal_master`] reads it. Fails
    /// with `NotFound` once the program is reaped and its PTY gone, and otherwise as that read
    /// fails.
    pub fn read_master(&self) -> io::Result<TerminalMasterReading> {
        let pty = self.pty.as_ref().ok_or_else(|| {
            io::Error::new(
                ErrorKind::NotFound,
                "the terminal's program has been reaped",
            )
        })?;
        read_terminal_master(pty, &self.peer_failure_noted)
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
        if write_from.is_none() {
            self.input_refusal.set(false);
        }
        loop {
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Ok(TerminalWake::Deadline);
            }
            // The terminal is polled before the waker is read, so a wake for a key typed after
            // the terminal began taking input again finds the refusal already cleared.
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
            // The poll above takes a wake's notice off the poller, so a wake raised before it
            // would leave nothing to make the poller readable.
            if self.waker.take_wake() {
                return Ok(TerminalWake::Woken);
            }
            tokio::select! {
                ready = self.poller.readable() => ready?.clear_ready(),
                () = sleep_until_deadline(deadline) => {}
            }
        }
    }

    /// Reads what the terminal's output holds now into `read_into`, never waiting, so a loop reads
    /// a burst whole before it delivers it: the count read, or 0 when a read would block or the
    /// output has ended, which the next [`Self::wait`] tells apart. Fails with the system's error
    /// from the read.
    pub fn read_now(&mut self, read_into: &mut [u8]) -> io::Result<usize> {
        match (&self.master).read(read_into) {
            Ok(count) => Ok(count),
            Err(error) if is_hang_up(&error) || is_retry(&error) => Ok(0),
            Err(error) => Err(error),
        }
    }

    /// Sends `key` as `SIGINT`, `SIGQUIT` or `SIGTSTP` to the terminal's foreground program when
    /// the terminal's settings have `ISIG` on and `key` is their interrupt, quit or suspend
    /// character, answering whether it did, so the key reaches a program that reads none of its
    /// input. Fails with the system's error when the settings cannot be read or the signal cannot
    /// be sent.
    pub fn send_signal_key(&self, key: u8) -> io::Result<bool> {
        let settings = tcgetattr(self.master.as_fd()).map_err(io::Error::from)?;
        if !settings.local_flags.contains(LocalFlags::ISIG) {
            return Ok(false);
        }
        let bound = [
            (SpecialCharacterIndices::VINTR, libc::SIGINT),
            (SpecialCharacterIndices::VQUIT, libc::SIGQUIT),
            (SpecialCharacterIndices::VSUSP, libc::SIGTSTP),
        ]
        .into_iter()
        .find(|(character, _signal)| {
            let bound_key = settings.control_chars[*character as usize];
            bound_key != libc::_POSIX_VDISABLE && bound_key == key
        });
        let Some((_character, signal)) = bound else {
            return Ok(false);
        };
        let descriptor = self.master.as_raw_fd();
        // SAFETY: the descriptor is the watch's open duplicate of the master, and `TIOCSIG` takes
        // the signal number itself as its argument.
        if unsafe { libc::ioctl(descriptor, libc::c_ulong::from(libc::TIOCSIG), signal) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(true)
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
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a terminal's watch could not be undone"
                    );
                }
                release_terminal(pty, mark_exited);
            }
            None => {
                if let Err(error) = self.poller.get_ref().delete(&self.master) {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a terminal's watch could not be undone"
                    );
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
        let mut is_child_event = false;
        let mut is_readable = false;
        let mut is_writable = false;
        for event in self.events.iter() {
            is_child_event |= event.key == CHILD_KEY;
            is_readable |= event.readable && event.key != CHILD_KEY;
            is_writable |= event.writable && event.key != CHILD_KEY;
        }
        // The poll just asked whether the terminal takes input, so a write it found no room for is
        // refused until a later poll finds room, and one it found room for is not; set before the
        // program's event returns, so the signal keys taken next never read a stale refusal.
        let is_newly_refused = write_from.is_some() && self.input_refusal.set(!is_writable);
        if is_child_event {
            return Ok(Some(TerminalWake::ChildEvent));
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
                Ok(count) => {
                    self.input_refusal.set(false);
                    return Ok(Some(TerminalWake::Wrote(count)));
                }
                Err(error) if is_hang_up(&error) => return Ok(Some(TerminalWake::InputEnded)),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    if self.input_refusal.set(true) {
                        return Ok(Some(TerminalWake::InputRefused));
                    }
                }
                Err(error) if is_retry(&error) => {}
                Err(error) => return Ok(Some(TerminalWake::WriteFailed(error))),
            }
        }
        Ok(is_newly_refused.then_some(TerminalWake::InputRefused))
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
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a terminal's watch could not be moved off its PTY"
            );
        }
        drop(pty);
        // SAFETY: the duplicate is the watch's own and outlives the registration, which `release`
        // deletes before the watch is dropped.
        let added = unsafe { poller.add_with_mode(&self.master, self.interest, PollMode::Level) };
        if let Err(error) = added {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a terminal's watch could not be moved onto its master"
            );
        }
    }
}

// `FIONREAD`, which Linux also names `TIOCINQ`: the bytes a terminal's descriptor counts as
// queued.
nix::ioctl_read_bad!(read_queued_byte_count, libc::FIONREAD, libc::c_int);

/// The bytes `FIONREAD` counts on `descriptor`, a terminal's master or its program's side. Fails
/// with the system's error when the read is refused.
pub(crate) fn read_queued_bytes(descriptor: BorrowedFd<'_>) -> io::Result<u32> {
    let mut queued_bytes: libc::c_int = 0;
    // SAFETY: the descriptor is open for the call, and the pointer names a live local the call
    // fills with one integer.
    unsafe { read_queued_byte_count(descriptor.as_raw_fd(), &raw mut queued_bytes) }
        .map_err(io::Error::from)?;
    u32::try_from(queued_bytes).map_err(|error| {
        io::Error::new(
            ErrorKind::InvalidData,
            format!("the terminal counts {queued_bytes} queued bytes: {error}"),
        )
    })
}

/// What the master of `pty` shows of its terminal, read with no right over its program; a Linux
/// input count that cannot be read is absent and logged once for `peer_failure_noted`, which the
/// holder keeps one of per terminal. Fails with the system's error when a read of the master is
/// refused, and with `InvalidData` when the terminal has no session or no foreground group.
#[cfg_attr(
    not(target_os = "linux"),
    expect(
        unused_variables,
        reason = "macOS counts the program's input on the master, which cannot fail on its own"
    )
)]
pub fn read_terminal_master(
    pty: &Pty,
    peer_failure_noted: &Once,
) -> io::Result<TerminalMasterReading> {
    let master = pty.file().as_fd();
    let session_leader = process_group_id(
        "session",
        tcgetsid(master).map_err(io::Error::from)?.as_raw(),
    )?;
    let foreground_group = process_group_id(
        "foreground group",
        tcgetpgrp(master).map_err(io::Error::from)?.as_raw(),
    )?;
    let master_queued_bytes = read_queued_bytes(master)?;
    // Linux hands back the program's side's settings, and macOS keeps one record for both sides,
    // so its master counts the program's unread input; Linux counts it on the program's side,
    // opened from the master for that count alone.
    let settings = tcgetattr(master).map_err(io::Error::from)?;
    #[cfg(not(target_os = "linux"))]
    let queued_input_bytes = Some(master_queued_bytes);
    #[cfg(target_os = "linux")]
    let queued_input_bytes = match read_queued_input_bytes(master) {
        Ok(queued_bytes) => Some(queued_bytes),
        Err(error) => {
            peer_failure_noted.call_once(|| {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a terminal's program side could not be opened to count its input, so its \
                     commands read as not waiting"
                );
            });
            None
        }
    };
    Ok(TerminalMasterReading {
        session_leader,
        foreground_group,
        queued_input_bytes,
        #[cfg(target_os = "linux")]
        unread_output_bytes: master_queued_bytes,
        is_echo_on: settings.local_flags.contains(LocalFlags::ECHO),
        is_canonical: settings.local_flags.contains(LocalFlags::ICANON),
    })
}

// The id a terminal names its `kind` of process group by, which is its leader's process id.
fn process_group_id(kind: &str, id: libc::pid_t) -> io::Result<u32> {
    u32::try_from(id).ok().filter(|id| *id > 0).ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidData,
            format!("the terminal names no {kind} ({id})"),
        )
    })
}

/// Completes when `deadline` passes, and never without one.
async fn sleep_until_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
        None => pending().await,
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

/// Sends `signal` to the process group `pid` leads, answering whether the group was still there.
/// Fails with `InvalidInput` for a pid of 0 or past `i32::MAX`, and with the system's error when
/// the send is refused.
fn signal_process_group(pid: u32, signal: TerminalSignal) -> io::Result<ProcessTreeEnd> {
    Ok(if signal_group(pid, posix_signal(signal))? {
        ProcessTreeEnd::Ended
    } else {
        ProcessTreeEnd::AlreadyGone
    })
}

/// The POSIX signal `signal` names.
pub(crate) fn posix_signal(signal: TerminalSignal) -> Signal {
    match signal {
        TerminalSignal::Interrupt => Signal::SIGINT,
        TerminalSignal::Terminate => Signal::SIGTERM,
        TerminalSignal::Kill => Signal::SIGKILL,
        TerminalSignal::Hangup => Signal::SIGHUP,
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

/// A shell that takes its terminal's input unread and byte by byte, its interrupt key left on,
/// prints `ready` and sleeps 20 seconds; the exit is the one its interrupt key gives it.
#[cfg(any(test, feature = "test-support"))]
pub fn interruptible_sleeper() -> AbnormalExit {
    AbnormalExit {
        program: shell_script("stty -icanon -echo; echo ready; exec sleep 20"),
        exit_code: 0,
        signal_code: Some(libc::SIGINT),
    }
}

/// A shell that ignores its interrupt, has its terminal echo its input with the interrupt key
/// shown as `^C` and keep the input on that key, prints `ready`, reads one input line and prints
/// `got:<line>`, then exits after one more line, so input written behind the first line is
/// echoed before it exits.
#[cfg(any(test, feature = "test-support"))]
pub fn echoing_line_reader() -> TestProgram {
    shell_script(concat!(
        "trap '' INT; stty echo echoctl noflsh; echo ready; ",
        "read line; echo \"got:$line\"; read rest"
    ))
}

/// A shell that turns its terminal raw with no echo, asks it for its device attributes, prints
/// `ready`, copies the next `byte_count` input bytes to the file `path`, then prints `done`.
#[cfg(any(test, feature = "test-support"))]
pub fn input_recorder(path: &std::path::Path, byte_count: usize) -> TestProgram {
    let path = path.display().to_string().replace('\'', "'\\''");
    shell_script(&format!(
        "stty raw -echo; printf '\\033[c'; echo ready; head -c {byte_count} > '{path}'; echo done"
    ))
}

/// A shell that takes its input unread and byte by byte, asks its terminal for its device
/// attributes `question_count` times, prints `asked`, and a second later reads every input byte
/// until two seconds pass with none, printing `read <bytes> key <count>`, where the count is of
/// `Z` bytes among them.
#[cfg(any(test, feature = "test-support"))]
pub fn device_attribute_asker(question_count: usize) -> TestProgram {
    shell_script(&format!(
        "stty -icanon -echo; i=0; while [ $i -lt {question_count} ]; do printf '\\033[c'; \
         i=$((i+1)); done; echo asked; sleep 1; stty min 0 time 20; cat | od -An -tx1 -v | \
         awk '{{for(i=1;i<=NF;i++){{n++; if($i==\"5a\")z++}}}} \
         END{{print \"read \" n+0 \" key \" z+0}}'"
    ))
}

/// A shell that takes its terminal's input unread and without echo, prints `ready`, then prints
/// the numbers from 0, one a line, until it reads the key `Z`, when it prints `key` and exits with
/// code 0.
#[cfg(any(test, feature = "test-support"))]
pub fn key_stopped_printer() -> TestProgram {
    shell_script(
        "stty -icanon -echo min 0 time 0; echo ready; i=0; while :; do echo $i; i=$((i+1)); \
         key=$(dd bs=1 count=1 2>/dev/null); if [ \"$key\" = Z ]; then echo key; exit 0; fi; done",
    )
}

/// A shell that prints the folder it runs in, then its whole environment, one `NAME=value` a line.
#[cfg(any(test, feature = "test-support"))]
pub fn launch_printer() -> TestProgram {
    shell_script("pwd -P; env")
}

#[cfg(any(test, feature = "test-support"))]
fn shell_script(script: &str) -> TestProgram {
    TestProgram {
        program: "/bin/sh".to_owned(),
        arguments: vec!["-c".to_owned(), script.to_owned()],
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::{RELEASE_HANGUP_GRACE, release_terminal, terminal_options};
    use crate::posix::process::exit::wait_for_stop;
    use crate::posix::terminal::inner::{
        TEST_WINDOW_SIZE, end_inner_terminal, read_until_marker, start_inner_terminal,
    };

    // Fails when a program stopped as its terminal is released reads as exited, so it is never
    // killed and the PTY's drop waits on it for good. It ignores the hangup, which macOS otherwise
    // lets end a stopped session leader. Mutation: `is_exit` answering true for any code but 0; or
    // `release_terminal`'s kill after the grace deleted.
    #[test]
    fn a_stopped_program_is_killed_within_the_release_s_grace() {
        let options = terminal_options(
            "/bin/sh".to_owned(),
            vec![
                "-c".to_owned(),
                "trap '' HUP; echo ready; kill -STOP $$; sleep 30".to_owned(),
            ],
            None,
            HashMap::new(),
        );
        let terminal =
            start_inner_terminal(&options, TEST_WINDOW_SIZE).expect("the terminal starts");
        let process_id = terminal.pty.child().id();
        if let Err(output) = read_until_marker(&terminal.pty, "ready", Duration::from_secs(20)) {
            end_inner_terminal(terminal);
            panic!("the program did not print ready: {output}");
        }
        wait_for_stop(process_id).expect("the program stops");
        let (released, was_released) = mpsc::channel();
        thread::spawn(move || {
            release_terminal(terminal.pty, || {});
            released.send(()).expect("the test waits for the release");
        });
        was_released
            .recv_timeout(RELEASE_HANGUP_GRACE + Duration::from_secs(5))
            .expect("the release ends within its grace");
    }
}
