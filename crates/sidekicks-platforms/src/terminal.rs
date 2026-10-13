//! What a terminal's read loop and its stops take from the operating system, in the shapes every
//! platform shares; each platform's module implements the calls behind them.

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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalWake {
    /// This many bytes of the terminal's output were read into the buffer; never zero.
    Read(usize),
    /// The terminal's output has ended: every holder of its other side has closed it.
    OutputEnded,
    /// This many bytes of the offered input were written; never zero.
    Wrote(usize),
    /// The terminal takes no more input: its other side has hung up.
    InputEnded,
    /// The program may have changed state; the terminal's `next_child_event` says whether it exited.
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
    /// Every process attached to the console, the helper itself left out.
    pub process_ids: Vec<u32>,
    /// Whether the console echoes what is typed (`ENABLE_ECHO_INPUT`); off at a password prompt.
    pub is_echo_input: bool,
    /// Whether the console hands input over a line at a time (`ENABLE_LINE_INPUT`).
    pub is_line_input: bool,
}

/// The arguments `taskkill.exe` takes to end the process `pid` and every process it started:
/// `/T` walks the tree from that one root and `/F` ends each outright.
pub fn taskkill_arguments(pid: u32) -> [String; 4] {
    [
        "/T".to_owned(),
        "/F".to_owned(),
        "/PID".to_owned(),
        pid.to_string(),
    ]
}
