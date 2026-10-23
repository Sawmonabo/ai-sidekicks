//! What a terminal's read loop and its stops take from the operating system, in the shapes every
//! platform shares; each platform's module implements the calls behind them.

use std::error::Error;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use alacritty_terminal::tty::Pty;
use polling::Poller;

/// How long a helper program the terminals start (`taskkill.exe`, the console helper) may run, and
/// how long an outright end of a process tree is waited for before its exit is reported anyway.
pub const HELPER_PROGRAM_TIME_LIMIT: Duration = Duration::from_secs(5);

/// A signal the daemon sends a shell's program, named as POSIX names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalSignal {
    /// `SIGINT`, as Ctrl+C sends it.
    Interrupt,
    /// `SIGTERM`, the graceful hard stop.
    Terminate,
    /// `SIGKILL`, the immediate hard stop.
    Kill,
    /// `SIGHUP`, as a closed terminal sends it.
    Hangup,
}

/// How a signal reaches a shell's program on the running system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalSignalRoute {
    /// The signal itself, sent to the program's process (macOS and Linux).
    Signal(TerminalSignal),
    /// Byte `0x03` written to the terminal's input, which the console turns into Ctrl+C for every
    /// process on it (Windows).
    WriteInterrupt,
    /// A break event sent to every process on the program's console, escalated to [`Self::EndTree`]
    /// when the program has not exited once its grace has passed (Windows).
    ConsoleBreak,
    /// The program and every process it started, ended outright (Windows).
    EndTree,
}

/// What woke a terminal's read loop.
#[derive(Debug)]
pub enum TerminalWake {
    /// This many bytes of the terminal's output were read into the buffer; never zero.
    Read(usize),
    /// The terminal's output has ended: every holder of its other side has closed it.
    OutputEnded,
    /// This many bytes of the offered input were written; never zero.
    Wrote(usize),
    /// The terminal takes no more input: its other side has hung up.
    InputEnded,
    /// The system refused the offered input; the terminal may still take later input.
    WriteFailed(io::Error),
    /// The terminal began refusing the offered input, having no room for any of it.
    InputRefused,
    /// The program may have exited; the watch's `take_child_exit` says whether it did.
    ChildEvent,
    /// Its waker was woken.
    Woken,
    /// The deadline passed.
    Deadline,
}

/// How an outright end of a process tree went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessTreeEnd {
    /// The tree was ended.
    Ended,
    /// No process had the root's id: the tree was already gone.
    AlreadyGone,
}

/// What a console helper read from the console of a shell's program.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleReading {
    /// Every process attached to the console, the helper and the `shell` mode's process that
    /// started the shell left out.
    pub process_ids: Vec<u32>,
    /// Whether the console echoes what is typed (`ENABLE_ECHO_INPUT`); off at a password prompt.
    pub is_echo_input: bool,
    /// Whether the console hands input over a line at a time (`ENABLE_LINE_INPUT`).
    pub is_line_input: bool,
}

/// What a terminal's master shows of the terminal, read by whoever holds the master: its
/// foreground process group, what `FIONREAD` counts on the master, and its echo and line settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalMasterReading {
    /// The terminal's foreground process group, named by its leader's process id.
    pub foreground_group: u32,
    /// The bytes `FIONREAD` counts on the master: on macOS the input queued unread for the program,
    /// on Linux the program's output the master has not read yet.
    pub queued_bytes: u32,
    /// Whether the terminal echoes what is typed (`ECHO`).
    pub is_echo_on: bool,
    /// Whether the terminal hands input over a line at a time (`ICANON`).
    pub is_canonical: bool,
}

impl TerminalMasterReading {
    /// Whether the terminal is set as a password prompt sets it: a line at a time with echo off. A
    /// full-screen program turns line input off with echo, so it is not one.
    pub fn is_password_prompt(&self) -> bool {
        self.is_canonical && !self.is_echo_on
    }
}

/// The device number of a terminal's program side, which tells a descriptor open on that terminal
/// from every other, whatever path opened it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TerminalDevice(pub u64);

/// A terminal a command runs in as its own session's leader, the terminal its controlling one: the
/// open PTY, whose master reads the command's output and takes its input, and the device number
/// of its program side.
pub struct InnerTerminal {
    /// The open PTY, with the command it started.
    pub pty: Pty,
    /// The device number of the PTY's program side.
    pub device: TerminalDevice,
}

/// Wakes a terminal's read loop from any thread; it can be made before the loop runs, and a wake
/// that comes before the loop waits is kept until it does.
#[derive(Clone)]
pub struct TerminalWaker {
    /// The poller the loop's wait blocks on, which a wake interrupts.
    pub(crate) poller: Arc<Poller>,
    /// Set by each wake and cleared by the wait that answers it, since a poller's own wake carries
    /// no event to tell it apart from a wait that found nothing.
    pub(crate) is_woken: Arc<AtomicBool>,
}

impl TerminalWaker {
    /// Makes a waker with the poller its loop waits on. Fails when the system cannot make the
    /// poller.
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            poller: Arc::new(Poller::new()?),
            is_woken: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Wakes the loop, whose wait answers [`TerminalWake::Woken`]; a wake the system refuses is
    /// logged, since no caller waits on its answer.
    pub fn wake(&self) {
        self.is_woken.store(true, Ordering::SeqCst);
        if let Err(error) = self.poller.notify() {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the terminal's read loop could not be woken"
            );
        }
    }

    /// Whether a wake came since the last call, clearing it.
    pub(crate) fn take_wake(&self) -> bool {
        self.is_woken.swap(false, Ordering::SeqCst)
    }
}

/// Whether a terminal refuses its input now: its watch sets it when the terminal could take none
/// of a waiting write, and clears it once a write goes through or no write waits, so the read loop
/// sends a key typed while the input is backed up as its signal instead.
#[derive(Clone, Debug, Default)]
pub struct TerminalInputRefusal {
    is_refused: Arc<AtomicBool>,
}

impl TerminalInputRefusal {
    /// A terminal taking its input, as every terminal starts.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the terminal's watch last found it unable to take a waiting write.
    pub fn is_refused(&self) -> bool {
        self.is_refused.load(Ordering::SeqCst)
    }

    /// Sets whether the terminal refuses its input, answering whether it began refusing it now.
    pub(crate) fn set(&self, is_refused: bool) -> bool {
        let was_refused = self.is_refused.swap(is_refused, Ordering::SeqCst);
        is_refused && !was_refused
    }
}

/// The argument, after the console helper's own and before the process id, that asks the helper
/// how many input events wait unread on that process's console rather than to send it a break.
pub const CONSOLE_WAITING_INPUT_ARGUMENT: &str = "input";

/// The start of the line the console helper writes the waiting input count on.
#[cfg_attr(
    not(any(target_os = "windows", test)),
    expect(
        dead_code,
        reason = "only the Windows console helper writes the line and reads it back"
    )
)]
const WAITING_INPUT_LINE_START: &str = "waiting-input-events ";

/// The line the console helper writes `waiting_input_events` on, for [`read_waiting_input_line`].
#[cfg_attr(
    not(any(target_os = "windows", test)),
    expect(
        dead_code,
        reason = "only the Windows console helper writes the line and reads it back"
    )
)]
pub(crate) fn waiting_input_line(waiting_input_events: u32) -> String {
    format!("{WAITING_INPUT_LINE_START}{waiting_input_events}\n")
}

/// The waiting input count in the console helper's output, read from its one line that starts as
/// [`waiting_input_line`] writes it. Fails with `InvalidData` when no line carries a count.
#[cfg_attr(
    not(any(target_os = "windows", test)),
    expect(
        dead_code,
        reason = "only the Windows console helper writes the line and reads it back"
    )
)]
pub(crate) fn read_waiting_input_line(output: &[u8]) -> io::Result<u32> {
    String::from_utf8_lossy(output)
        .lines()
        .find_map(|line| line.strip_prefix(WAITING_INPUT_LINE_START)?.parse().ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the console helper wrote no waiting input count",
            )
        })
}

/// A program a test runs in a terminal, with its arguments.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Debug)]
pub struct TestProgram {
    /// The program.
    pub program: String,
    /// Its arguments, in order.
    pub arguments: Vec<String>,
}

/// A test program that ends abnormally, and the exit the system reports for it.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Debug)]
pub struct AbnormalExit {
    /// The program.
    pub program: TestProgram,
    /// The exit code the terminal reports.
    pub exit_code: i64,
    /// The signal the terminal reports, where the system reports one.
    pub signal_code: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::{read_waiting_input_line, waiting_input_line};

    #[test]
    fn the_helper_s_waiting_input_line_reads_back_among_other_output() {
        let output = format!(
            "running 1 test\n{}test result: ok\n",
            waiting_input_line(4_096)
        );

        assert_eq!(read_waiting_input_line(output.as_bytes()).ok(), Some(4_096));
        assert!(read_waiting_input_line(b"waiting-input-events many\n").is_err());
    }
}
