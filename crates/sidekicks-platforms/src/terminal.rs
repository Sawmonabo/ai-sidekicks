//! What a terminal's read loop and its stops take from the operating system, in the shapes every
//! platform shares; each platform's module implements the calls behind them.

use std::error::Error;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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
    /// Every process attached to the console, the helper and the `shell-start` process that
    /// started the shell left out.
    pub process_ids: Vec<u32>,
    /// Whether the console echoes what is typed (`ENABLE_ECHO_INPUT`); off at a password prompt.
    pub is_echo_input: bool,
    /// Whether the console hands input over a line at a time (`ENABLE_LINE_INPUT`).
    pub is_line_input: bool,
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
