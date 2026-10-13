//! The Windows side of the interface: `ConPTY` through `alacritty_terminal`, a `polling` wait on each
//! shell's own thread, `taskkill.exe` for a process tree and the console helper's calls.

use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, ErrorKind, Read, Write};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::ptr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{OnResize, WindowSize};
use alacritty_terminal::tty::{self, EventedReadWrite, Pty};
use polling::{Event, Events, PollMode, Poller};
use tokio::process::Command;
use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, TRUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    AttachConsole, CONSOLE_MODE, CTRL_BREAK_EVENT, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
    FreeConsole, GenerateConsoleCtrlEvent, GetConsoleMode, GetConsoleProcessList,
    SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories,
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::core::BOOL;
use windows_sys::w;

use crate::terminal::{
    ConsoleReading, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute, TerminalWake,
    taskkill_arguments,
};

/// How long `taskkill.exe` may take to end a process tree.
const TASKKILL_TIME_LIMIT: Duration = Duration::from_secs(5);

/// How many process ids the first console process list read makes room for.
const CONSOLE_PROCESS_LIST_START_LENGTH: usize = 16;

/// How `signal` reaches a shell's program on Windows, which has no signal a program answers: an
/// interrupt is Ctrl+C typed into the terminal, a terminate or hangup a console break, a kill the
/// end of the program's tree.
pub fn terminal_signal_route(signal: TerminalSignal) -> TerminalSignalRoute {
    match signal {
        TerminalSignal::Interrupt => TerminalSignalRoute::WriteInterrupt,
        TerminalSignal::Terminate | TerminalSignal::Hangup => TerminalSignalRoute::ConsoleBreak,
        TerminalSignal::Kill => TerminalSignalRoute::EndTree,
    }
}

/// How a close's ending signal (hangup, stop, kill) reaches a shell's program on Windows: every one
/// ends the program's tree, since no signal reaches a program there.
pub fn terminal_ending_route(_signal: TerminalSignal) -> TerminalSignalRoute {
    TerminalSignalRoute::EndTree
}

/// Sends a POSIX signal, which Windows has none of: always fails with `Unsupported`.
pub fn send_signal(_pid: u32, _signal: TerminalSignal) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows has no POSIX signals",
    ))
}

/// Ends the process `pid` and every process it started with `taskkill.exe /T /F`, from the
/// system's own folder. Fails with `NotFound` when `SystemRoot` is unset, `TimedOut` when the run
/// takes over 5 s, and an error naming the exit code `taskkill.exe` answers with other than 0
/// (ended) or 128 (no such process, [`ProcessTreeEnd::AlreadyGone`]).
pub async fn end_process_tree(pid: u32) -> io::Result<ProcessTreeEnd> {
    // Read at each call and never looked up on `PATH`, so no other `taskkill.exe` can run.
    let system_root = env::var_os("SystemRoot").ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            "SystemRoot is unset, so taskkill.exe has no path",
        )
    })?;
    let mut command = hidden_command(
        Path::new(&system_root)
            .join("System32")
            .join("taskkill.exe"),
    );
    command.args(taskkill_arguments(pid));
    let status = tokio::time::timeout(TASKKILL_TIME_LIMIT, command.status())
        .await
        .map_err(|elapsed| io::Error::new(ErrorKind::TimedOut, elapsed))??;
    match status.code() {
        Some(0) => Ok(ProcessTreeEnd::Ended),
        Some(128) => Ok(ProcessTreeEnd::AlreadyGone),
        Some(code) => Err(io::Error::other(format!(
            "taskkill.exe exited with code {code}"
        ))),
        None => Err(io::Error::other("taskkill.exe exited with no code")),
    }
}

/// Runs the console helper `program` with `arguments` and then `pid` in decimal, and waits for it.
/// Fails when it cannot start, and with an error naming its exit code when it does not succeed.
pub async fn run_console_helper(
    program: &OsStr,
    arguments: &[OsString],
    pid: u32,
) -> io::Result<()> {
    let mut command = hidden_command(program);
    command.args(arguments).arg(pid.to_string());
    let status = command.status().await?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "the console helper exited with {status}"
        )))
    }
}

/// Sends a break to every process on the console of the process `pid`; run inside the console
/// helper, which it moves onto that console. Fails with the system's error when the helper cannot
/// attach to the console or send the break.
pub fn send_console_break(pid: u32) -> io::Result<()> {
    attach_to_console(pid)?;
    // Attaching resets the helper's handler list, and the default handler would end the helper
    // by its own break.
    // SAFETY: the routine is a plain function that lives as long as the program and reads nothing.
    if unsafe { SetConsoleCtrlHandler(Some(ignore_console_control), TRUE) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Group 0 is every process on the console.
    // SAFETY: the call takes two plain values.
    if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Reads which processes the console of the process `pid` holds and how it takes input; run
/// inside the console helper, which it moves onto that console. Fails with the system's error when
/// the helper cannot attach, list the console's processes or read its input mode.
pub fn read_console(pid: u32) -> io::Result<ConsoleReading> {
    attach_to_console(pid)?;
    let process_ids = console_process_ids()?;
    let input_mode = console_input_mode()?;
    Ok(ConsoleReading {
        process_ids,
        is_echo_input: input_mode & ENABLE_ECHO_INPUT != 0,
        is_line_input: input_mode & ENABLE_LINE_INPUT != 0,
    })
}

/// Makes the program load libraries only from the system's own folder, so `ConPTY` comes from
/// kernel32 and never a `conpty.dll` beside the program or on `PATH`. Process-wide and cannot be
/// reverted; fails with the system's error when Windows refuses it.
pub fn restrict_library_search() -> io::Result<()> {
    // SAFETY: the call takes one plain flag value.
    if unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The options `alacritty_terminal` opens a shell's terminal with: `shell` started in
/// `working_directory` with `environment` added, its output not drained once it exits, and each
/// argument quoted by the C runtime's rules, since each is its own string.
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
        escape_args: true,
    }
}

/// The process id of the program running in `pty`, when Windows reported one.
pub fn child_process_id(pty: &Pty) -> Option<u32> {
    pty.child_watcher().pid().map(NonZeroU32::get)
}

/// Sets the terminal's window size to `rows` by `columns` cells; never fails on Windows.
pub fn resize_terminal(pty: &mut Pty, rows: u16, columns: u16) -> io::Result<()> {
    OnResize::on_resize(
        pty,
        WindowSize {
            num_lines: rows,
            num_cols: columns,
            cell_width: 0,
            cell_height: 0,
        },
    );
    Ok(())
}

/// The signal that ended a process: always `None`, since a Windows exit carries no POSIX signal.
pub fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

/// Runs a terminal's read loop for the shell's life on a thread of its own named `name`, driven by
/// `runtime`, since the loop blocks in its wait. Fails when the thread cannot be made.
pub fn run_terminal_loop(
    runtime: &tokio::runtime::Handle,
    name: &str,
    read_loop: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let runtime = runtime.clone();
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || runtime.block_on(read_loop))?;
    Ok(())
}

/// Wakes a terminal's read loop from any thread; it can be made before the loop runs, and a wake
/// that comes before the loop waits is kept until it does.
#[derive(Clone)]
pub struct TerminalWaker {
    poller: Arc<Poller>,
}

impl TerminalWaker {
    /// Makes a waker with the poller its loop waits on. Fails when Windows cannot make the poller.
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            poller: Arc::new(Poller::new()?),
        })
    }

    /// Wakes the loop, whose wait answers [`TerminalWake::Woken`]; a wake Windows refuses is
    /// logged, since no caller waits on its answer.
    pub fn wake(&self) {
        if let Err(error) = self.poller.notify() {
            tracing::warn!(error = %error, "the terminal's read loop could not be woken");
        }
    }
}

/// What a terminal's read loop waits on: the terminal's output and input, the program's exit, its
/// waker and a deadline.
pub struct TerminalWatch {
    poller: Arc<Poller>,
    events: Events,
    /// The interest the PTY is registered with, `None` before the first wait registers it.
    interest: Option<Event>,
    /// Whether the next wait answers [`TerminalWake::ChildEvent`] at once, since the program may
    /// have exited before the PTY was registered, which leaves no event to wake the wait.
    is_child_event_pending: bool,
}

impl TerminalWatch {
    /// Makes the watch woken by `waker`; called inside the read loop, since on macOS and Linux it
    /// needs the runtime. [`Self::release`] must run before `pty` is dropped; never fails on
    /// Windows.
    pub fn new(_pty: &mut Pty, waker: &TerminalWaker) -> io::Result<Self> {
        Ok(Self {
            poller: Arc::clone(&waker.poller),
            events: Events::new(),
            interest: None,
            is_child_event_pending: true,
        })
    }

    /// Waits until the terminal has output for `read_into`, takes some of `write_from`, the
    /// program may have exited, the waker is woken or `deadline` passes, whichever is first.
    /// Reads only into a given buffer, writes only a given slice, and never answers `Read(0)` or
    /// `Wrote(0)`; fails with the system's error from the registration, the I/O or the wait.
    #[expect(
        clippy::unused_async,
        reason = "the wait blocks the shell's own thread on Windows, and keeps the signature the \
                  macOS and Linux wait has"
    )]
    pub async fn wait(
        &mut self,
        pty: &mut Pty,
        mut read_into: Option<&mut [u8]>,
        write_from: Option<&[u8]>,
        deadline: Option<Instant>,
    ) -> io::Result<TerminalWake> {
        // Registered before the first answer, so an exit after it posts an event.
        self.register(
            pty,
            Event::new(0, read_into.is_some(), write_from.is_some()),
        )?;
        if self.is_child_event_pending {
            self.is_child_event_pending = false;
            return Ok(TerminalWake::ChildEvent);
        }
        if let Some(wake) = transfer(pty, read_into.as_deref_mut(), write_from)? {
            return Ok(wake);
        }
        self.events.clear();
        let timeout = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
        match self.poller.wait(&mut self.events, timeout) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => return Ok(TerminalWake::Woken),
            Err(error) => return Err(error),
        }
        if self
            .events
            .iter()
            .any(|event| event.key == tty::PTY_CHILD_EVENT_TOKEN)
        {
            return Ok(TerminalWake::ChildEvent);
        }
        if let Some(wake) = transfer(pty, read_into, write_from)? {
            return Ok(wake);
        }
        // One wait per call: a wake that came with nothing to do answers `Woken`, and the caller
        // asks again.
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            Ok(TerminalWake::Deadline)
        } else {
            Ok(TerminalWake::Woken)
        }
    }

    /// Reads what the terminal holds without waiting, to drain it once the program has exited:
    /// `Some(n)` bytes read, `None` when nothing is there, since `ConPTY` reports its end only
    /// through the program's exit. Never fails on Windows.
    pub fn try_read(&mut self, pty: &mut Pty, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        let count = pty.reader().read(buffer)?;
        Ok((count > 0).then_some(count))
    }

    /// Ends the watch; called before the PTY is dropped, since the registration must not outlive
    /// the PTY. Fails with the error the deregistration answers.
    pub fn release(self, pty: &mut Pty) -> io::Result<()> {
        if self.interest.is_some() {
            pty.deregister(&self.poller)?;
        }
        Ok(())
    }

    /// Registers `pty` with `interest` the first time and again whenever the interest changes.
    fn register(&mut self, pty: &mut Pty, interest: Event) -> io::Result<()> {
        match self.interest {
            None => {
                // SAFETY: the PTY outlives the registration, because `release` deregisters it
                // before the PTY is dropped, a contract `new` states.
                unsafe { pty.register(&self.poller, interest, PollMode::Level) }?;
            }
            Some(registered) if registered == interest => return Ok(()),
            Some(_) => pty.reregister(&self.poller, interest, PollMode::Level)?,
        }
        self.interest = Some(interest);
        Ok(())
    }
}

/// Reads into `read_into` and writes from `write_from` once each without waiting, answering the
/// first that moved any bytes. `ConPTY`'s pipes answer 0 for nothing yet and for a full pipe.
fn transfer(
    pty: &mut Pty,
    read_into: Option<&mut [u8]>,
    write_from: Option<&[u8]>,
) -> io::Result<Option<TerminalWake>> {
    if let Some(buffer) = read_into {
        let count = pty.reader().read(buffer)?;
        if count > 0 {
            return Ok(Some(TerminalWake::Read(count)));
        }
    }
    if let Some(bytes) = write_from {
        let count = pty.writer().write(bytes)?;
        if count > 0 {
            return Ok(Some(TerminalWake::Wrote(count)));
        }
    }
    Ok(None)
}

/// A command for a console program that opens no window (the daemon has no console of its own),
/// with no standard streams, ended if its run is dropped.
fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    command
}

/// Moves the helper off its own console and onto the console of the process `pid`. Fails with the
/// system's error when the attach is refused.
fn attach_to_console(pid: u32) -> io::Result<()> {
    // A failure here means the helper had no console, which is what the attach needs.
    // SAFETY: the call takes no arguments and only detaches this process from its console.
    unsafe { FreeConsole() };
    // SAFETY: the call takes one plain process id.
    if unsafe { AttachConsole(pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The ids of every process on the attached console, the helper itself left out.
fn console_process_ids() -> io::Result<Vec<u32>> {
    let mut process_ids = vec![0_u32; CONSOLE_PROCESS_LIST_START_LENGTH];
    loop {
        let capacity =
            u32::try_from(process_ids.len()).expect("the list is sized from a u32 process count");
        // SAFETY: the pointer and capacity describe `process_ids`, of which the call writes at
        // most `capacity` entries.
        let count = unsafe { GetConsoleProcessList(process_ids.as_mut_ptr(), capacity) };
        if count == 0 {
            return Err(io::Error::last_os_error());
        }
        let count = usize::try_from(count).expect("a u32 fits in usize on Windows");
        // A count past the capacity is the size the list needs; the entries were not written.
        if count <= process_ids.len() {
            process_ids.truncate(count);
            break;
        }
        process_ids.resize(count, 0);
    }
    let helper_process_id = std::process::id();
    process_ids.retain(|process_id| *process_id != helper_process_id);
    Ok(process_ids)
}

/// The input mode of the attached console, read through a fresh `CONIN$` handle, since the
/// standard handles do not follow an attach.
fn console_input_mode() -> io::Result<CONSOLE_MODE> {
    // SAFETY: the name is a static wide string ending in NUL, and the security attributes and
    // template handle are optional, so null.
    let console_input = unsafe {
        CreateFileW(
            w!("CONIN$"),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if console_input == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut input_mode: CONSOLE_MODE = 0;
    // SAFETY: the handle was opened above and is still open, and the mode pointer names a live
    // local.
    let mode_read = if unsafe { GetConsoleMode(console_input, &raw mut input_mode) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(input_mode)
    };
    // SAFETY: the handle was opened above and is closed once, here.
    let closed = if unsafe { CloseHandle(console_input) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    match (mode_read, closed) {
        (Ok(input_mode), Ok(())) => Ok(input_mode),
        (Ok(_), Err(close_error)) => Err(close_error),
        (Err(mode_error), Ok(())) => Err(mode_error),
        (Err(mode_error), Err(close_error)) => {
            tracing::warn!(error = %close_error, "the console input handle could not be closed");
            Err(mode_error)
        }
    }
}

/// Answers every console control event as handled, so the helper outlives the break it sends.
unsafe extern "system" fn ignore_console_control(_control_type: u32) -> BOOL {
    TRUE
}
