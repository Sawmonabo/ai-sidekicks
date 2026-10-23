//! The Windows side of the terminal interface: `ConPTY` through `alacritty_terminal`, a `polling`
//! wait on each shell's own thread, `taskkill.exe` for a process tree and the console helper's
//! calls.

use std::collections::HashMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::io::{self, ErrorKind, Read, Write};
use std::num::NonZeroU32;
#[cfg(any(test, feature = "test-support"))]
use std::path::Path;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::ptr;
use std::time::Instant;

use alacritty_terminal::event::{OnResize, WindowSize};
use alacritty_terminal::tty::{self, ChildEvent, EventedPty, EventedReadWrite, Pty};
use polling::{Event, Events, PollMode};
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
    GetNumberOfConsoleInputEvents, SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories,
};
use windows_sys::core::BOOL;
use windows_sys::w;

#[cfg(any(test, feature = "test-support"))]
use crate::shell_folder_start::windows::quote_powershell_literal;
use crate::spawner::Spawner;
#[cfg(any(test, feature = "test-support"))]
use crate::terminal::{AbnormalExit, TestProgram};
use crate::terminal::{
    CONSOLE_WAITING_INPUT_ARGUMENT, ConsoleReading, HELPER_PROGRAM_TIME_LIMIT, ProcessTreeEnd,
    TerminalInputRefusal, TerminalMasterReading, TerminalSignal, TerminalSignalRoute, TerminalWake,
    TerminalWaker, read_waiting_input_line, waiting_input_line,
};
use crate::windows::child_command::prepare_child_command;
use crate::windows::known_folder::system_folder;

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

/// Whether a terminal's paused read holds the program's input back too: yes on Windows, whose
/// console stops taking input while its output pipe is full. A write the terminal takes at once
/// may still wait in `ConPTY`'s own pipe, so any write since the pause counts as waiting until a
/// read finds the output empty.
pub const DOES_PAUSED_READ_HOLD_INPUT: bool = true;

/// Whether the system counts the input waiting on a shell's console, which the console helper
/// reads: yes on Windows.
pub const DOES_CONSOLE_COUNT_WAITING_INPUT: bool = true;

/// Sends a POSIX signal, which Windows has none of: always fails with `Unsupported`.
pub fn send_signal(_pid: u32, _signal: TerminalSignal) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows has no POSIX signals",
    ))
}

/// Ends the process `pid` and every process it started with `taskkill.exe /T /F`, from the system
/// folder, started on `spawner`'s thread. Fails with `NotFound` when `taskkill.exe` is not in the
/// system folder, `TimedOut` past [`HELPER_PROGRAM_TIME_LIMIT`], and an error naming the exit code
/// `taskkill.exe` answers with other than 0 (ended) or 128 (no such process,
/// [`ProcessTreeEnd::AlreadyGone`]).
pub async fn end_process_tree(spawner: &Spawner, pid: u32) -> io::Result<ProcessTreeEnd> {
    // Read at each call and never looked up on `PATH`, so no other `taskkill.exe` can run.
    let mut command = hidden_command(system_folder().join("taskkill.exe"));
    // `/T` walks the tree from the one root and `/F` ends each process outright.
    command.args(["/T", "/F", "/PID", &pid.to_string()]);
    let status = run_bounded(spawner, command).await?;
    match status.code() {
        Some(0) => Ok(ProcessTreeEnd::Ended),
        Some(128) => Ok(ProcessTreeEnd::AlreadyGone),
        Some(code) => Err(io::Error::other(format!(
            "taskkill.exe exited with code {code}"
        ))),
        None => Err(io::Error::other("taskkill.exe exited with no code")),
    }
}

/// Runs the console helper `program` with `arguments` and then `pid` in decimal, started on
/// `spawner`'s thread, and waits for it. Fails when it cannot start, with `TimedOut` past
/// [`HELPER_PROGRAM_TIME_LIMIT`], and with an error naming its exit when it does not succeed.
pub async fn run_console_helper(
    spawner: &Spawner,
    program: &OsStr,
    arguments: &[OsString],
    pid: u32,
) -> io::Result<()> {
    let mut command = hidden_command(program);
    command.args(arguments).arg(pid.to_string());
    let status = run_bounded(spawner, command).await?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "the console helper exited with {status}"
        )))
    }
}

/// Starts `command` on `spawner`'s thread and waits for its exit up to
/// [`HELPER_PROGRAM_TIME_LIMIT`]; a run past it is ended as its child is dropped.
async fn run_bounded(spawner: &Spawner, mut command: Command) -> io::Result<ExitStatus> {
    let mut child = spawner.run(move || command.spawn()).await??;
    tokio::time::timeout(HELPER_PROGRAM_TIME_LIMIT, child.wait())
        .await
        .map_err(|elapsed| io::Error::new(ErrorKind::TimedOut, elapsed))?
}

/// Runs the console helper `program` with `arguments`, [`CONSOLE_WAITING_INPUT_ARGUMENT`] and then
/// `pid` in decimal, started on `spawner`'s thread, and answers how many input events wait unread
/// on that process's console, which the helper writes. Fails as [`run_console_helper`] does, and
/// with `InvalidData` when the helper wrote no count.
pub async fn read_console_waiting_input(
    spawner: &Spawner,
    program: &OsStr,
    arguments: &[OsString],
    pid: u32,
) -> io::Result<u32> {
    let mut command = hidden_command(program);
    command
        .args(arguments)
        .arg(CONSOLE_WAITING_INPUT_ARGUMENT)
        .arg(pid.to_string())
        .stdout(Stdio::piped());
    let child = spawner.run(move || command.spawn()).await??;
    let output = tokio::time::timeout(HELPER_PROGRAM_TIME_LIMIT, child.wait_with_output())
        .await
        .map_err(|elapsed| io::Error::new(ErrorKind::TimedOut, elapsed))??;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "the console helper exited with {}",
            output.status
        )));
    }
    read_waiting_input_line(&output.stdout)
}

/// Writes to `output` how many input events wait unread on the console of the process `pid`, as
/// [`read_console_waiting_input`] reads it; run inside the console helper, which it moves onto
/// that console. Fails with the system's error when the helper cannot attach or read the console's
/// input, or `output` refuses the line.
pub fn write_console_waiting_input(pid: u32, output: &mut impl Write) -> io::Result<()> {
    attach_to_console(pid)?;
    let ConsoleInput { waiting_events, .. } = read_console_input()?;
    output.write_all(waiting_input_line(waiting_events).as_bytes())?;
    output.flush()
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

/// Reads which processes the console of the process `pid`, the `shell` mode's process that started
/// the shell, holds and how it takes input; run inside the console helper, which it moves onto
/// that console. Fails with the system's error when the helper cannot attach, list the console's
/// processes or read its input mode.
pub fn read_console(pid: u32) -> io::Result<ConsoleReading> {
    attach_to_console(pid)?;
    let process_ids = console_process_ids(pid)?;
    let ConsoleInput { mode, .. } = read_console_input()?;
    Ok(ConsoleReading {
        process_ids,
        is_echo_input: mode & ENABLE_ECHO_INPUT != 0,
        is_line_input: mode & ENABLE_LINE_INPUT != 0,
    })
}

/// Reads a terminal's master, which a `ConPTY` does not expose: the console helper reads the
/// console's input mode instead. Always fails with `Unsupported`.
pub fn read_terminal_master(_pty: &Pty) -> io::Result<TerminalMasterReading> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "a pseudo console has no master to read",
    ))
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

/// The options `alacritty_terminal` opens a shell's terminal with: `program` with `arguments`
/// started in `working_directory` with `environment` added, its output not drained once it exits,
/// and each argument quoted by the C runtime's rules, since each is its own string. The program is
/// written as given, so one holding a space is put in double quotes, which a path never holds.
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
    let program = if program.contains([' ', '\t']) {
        format!("\"{program}\"")
    } else {
        program
    };
    tty::Options {
        shell: Some(tty::Shell::new(program, arguments)),
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

/// Ends the program in `pty` and drops the PTY, which closes its console and so ends every process
/// on it; `mark_exited` runs first, while the PTY's handle to the program still keeps its process
/// id its own. Blocking, so it runs on a thread of its own.
pub fn release_terminal(pty: Pty, mark_exited: impl FnOnce()) {
    mark_exited();
    drop(pty);
}

/// What a terminal's read loop waits on: the terminal's output and input, the program's exit, its
/// waker and a deadline.
pub struct TerminalWatch {
    pty: Pty,
    waker: TerminalWaker,
    /// Set while the terminal's input pipe can take none of a waiting write.
    input_refusal: TerminalInputRefusal,
    events: Events,
    /// The interest the PTY is registered with, `None` before the first wait registers it.
    interest: Option<Event>,
    /// Whether the next wait answers [`TerminalWake::ChildEvent`] at once, since the program may
    /// have exited before the PTY was registered, which leaves no event to wake the wait.
    is_child_event_pending: bool,
}

impl TerminalWatch {
    /// Makes the watch over `pty`, woken by `waker`, keeping `input_refusal` set while the
    /// terminal's input pipe refuses a waiting write; never fails on Windows.
    pub fn new(
        pty: Pty,
        waker: &TerminalWaker,
        input_refusal: &TerminalInputRefusal,
    ) -> Result<Self, (io::Error, Box<Pty>)> {
        Ok(Self {
            pty,
            waker: waker.clone(),
            input_refusal: input_refusal.clone(),
            events: Events::new(),
            interest: None,
            is_child_event_pending: true,
        })
    }

    /// Waits until the terminal has output for `read_into`, takes some of `write_from`, the
    /// program may have exited, the waker is woken or `deadline` passes, whichever is first.
    /// Reads only into a given buffer, writes only a given slice, and never answers `Read(0)` or
    /// `Wrote(0)`; a refused write answers [`TerminalWake::WriteFailed`]. `ConPTY` reports no end
    /// of output, since its pipe stays open until the PTY is dropped. Fails with the system's error
    /// from the registration, a read or the wait.
    #[expect(
        clippy::unused_async,
        clippy::unused_async_trait_impl,
        reason = "the wait blocks the shell's own thread on Windows, and keeps the signature the \
                  macOS and Linux wait has"
    )]
    pub async fn wait(
        &mut self,
        mut read_into: Option<&mut [u8]>,
        write_from: Option<&[u8]>,
        deadline: Option<Instant>,
    ) -> io::Result<TerminalWake> {
        // Registered before the first answer, so an exit after it posts an event.
        self.register(Event::new(0, read_into.is_some(), write_from.is_some()))?;
        if write_from.is_none() {
            self.input_refusal.set(false);
        }
        if self.is_child_event_pending {
            self.is_child_event_pending = false;
            return Ok(TerminalWake::ChildEvent);
        }
        if self.waker.take_wake() {
            return Ok(TerminalWake::Woken);
        }
        if let Some(wake) = transfer(
            &mut self.pty,
            &self.input_refusal,
            read_into.as_deref_mut(),
            write_from,
        )? {
            return Ok(wake);
        }
        self.events.clear();
        let timeout = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
        match self.waker.poller.wait(&mut self.events, timeout) {
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
        if self.waker.take_wake() {
            return Ok(TerminalWake::Woken);
        }
        if let Some(wake) = transfer(&mut self.pty, &self.input_refusal, read_into, write_from)? {
            return Ok(wake);
        }
        // One wait per call: one that came with nothing to do answers `Woken`, and the caller asks
        // again.
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            Ok(TerminalWake::Deadline)
        } else {
            Ok(TerminalWake::Woken)
        }
    }

    /// Reads what the terminal's output holds now into `read_into`, never waiting, so a loop reads
    /// a burst whole before it delivers it: the count read, or 0 when nothing waits. Fails with the
    /// system's error from the read.
    pub fn read_now(&mut self, read_into: &mut [u8]) -> io::Result<usize> {
        self.pty.reader().read(read_into)
    }

    /// Sends no key as a signal on Windows, whose console turns Ctrl+C typed as `0x03` into its own
    /// event as it reads it, answering `false`. Never fails.
    pub fn send_signal_key(&self, _key: u8) -> io::Result<bool> {
        Ok(false)
    }

    /// The program's status once it has exited; the PTY stays, since `ConPTY`'s output is still
    /// read through it, and its handle keeps the program's id its own until it is dropped.
    pub fn take_child_exit(&mut self) -> Option<Option<ExitStatus>> {
        let ChildEvent::Exited(status) = self.pty.next_child_event()?;
        Some(status)
    }

    /// Sets the terminal's window size to `rows` by `columns` cells, which must lie within
    /// `ConPTY`'s `i16` range; never fails on Windows.
    pub fn resize(&mut self, rows: u16, columns: u16) -> io::Result<()> {
        OnResize::on_resize(
            &mut self.pty,
            WindowSize {
                num_lines: rows,
                num_cols: columns,
                cell_width: 0,
                cell_height: 0,
            },
        );
        Ok(())
    }

    /// Ends the watch and drops the PTY as [`release_terminal`] does, running `mark_exited` first.
    pub fn release(mut self, mark_exited: impl FnOnce()) {
        if self.interest.is_some()
            && let Err(error) = self.pty.deregister(&self.waker.poller)
        {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a terminal's watch could not be undone"
            );
        }
        release_terminal(self.pty, mark_exited);
    }

    /// Registers the PTY with `interest` the first time and again whenever the interest changes.
    fn register(&mut self, interest: Event) -> io::Result<()> {
        match self.interest {
            None => {
                // SAFETY: the PTY outlives the registration, because `release` deregisters it
                // before the PTY is dropped.
                unsafe {
                    self.pty
                        .register(&self.waker.poller, interest, PollMode::Level)
                }?;
            }
            Some(registered) if registered == interest => return Ok(()),
            Some(_) => self
                .pty
                .reregister(&self.waker.poller, interest, PollMode::Level)?,
        }
        self.interest = Some(interest);
        Ok(())
    }
}

/// Reads into `read_into` and writes from `write_from` once each without waiting, answering the
/// first that moved any bytes, a refused write or a write that began finding no room, and setting
/// `input_refusal` by whether the write found room. `ConPTY`'s pipes answer 0 for nothing yet and
/// for a full pipe.
fn transfer(
    pty: &mut Pty,
    input_refusal: &TerminalInputRefusal,
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
        match pty.writer().write(bytes) {
            Ok(0) => {
                if input_refusal.set(true) {
                    return Ok(Some(TerminalWake::InputRefused));
                }
            }
            Ok(count) => {
                input_refusal.set(false);
                return Ok(Some(TerminalWake::Wrote(count)));
            }
            Err(error) => return Ok(Some(TerminalWake::WriteFailed(error))),
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
        .kill_on_drop(true);
    prepare_child_command(&mut command, std::process::id());
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

/// The ids of every process on the attached console, the helper itself and `start_process_id`
/// left out.
fn console_process_ids(start_process_id: u32) -> io::Result<Vec<u32>> {
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
    process_ids
        .retain(|process_id| *process_id != helper_process_id && *process_id != start_process_id);
    Ok(process_ids)
}

/// The attached console's input mode and how many input events wait on it unread.
struct ConsoleInput {
    mode: CONSOLE_MODE,
    waiting_events: u32,
}

/// The input mode and waiting input events of the attached console, read through a fresh `CONIN$`
/// handle, since the standard handles do not follow an attach.
fn read_console_input() -> io::Result<ConsoleInput> {
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
    let mut mode: CONSOLE_MODE = 0;
    let mut waiting_events: u32 = 0;
    // SAFETY: the handle was opened above and is still open, and the mode pointer names a live
    // local.
    let is_mode_read = unsafe { GetConsoleMode(console_input, &raw mut mode) } != 0;
    // SAFETY: the handle is still open, and the count pointer names a live local.
    let input_read = if is_mode_read
        && unsafe { GetNumberOfConsoleInputEvents(console_input, &raw mut waiting_events) } != 0
    {
        Ok(ConsoleInput {
            mode,
            waiting_events,
        })
    } else {
        Err(io::Error::last_os_error())
    };
    // SAFETY: the handle was opened above and is closed once, here.
    let closed = if unsafe { CloseHandle(console_input) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    match (input_read, closed) {
        (Ok(input), Ok(())) => Ok(input),
        (Ok(_), Err(close_error)) => Err(close_error),
        (Err(read_error), Ok(())) => Err(read_error),
        (Err(read_error), Err(close_error)) => {
            tracing::warn!(
                error = &close_error as &(dyn Error + 'static),
                "the console input handle could not be closed"
            );
            Err(read_error)
        }
    }
}

/// Answers every console control event as handled, so the helper outlives the break it sends.
extern "system" fn ignore_console_control(_control_type: u32) -> BOOL {
    TRUE
}

/// A shell that prints `text` on a line of its own and exits with code 0.
#[cfg(any(test, feature = "test-support"))]
pub fn echo_program(text: &str) -> TestProgram {
    shell_script(&format!("echo {text}"))
}

/// A shell that prints `ready`, waits for one input line, then prints the numbers from 0 below
/// `line_count`, one a line, and exits with code 0.
#[cfg(any(test, feature = "test-support"))]
pub fn waiting_printer(line_count: usize) -> TestProgram {
    let last = line_count.saturating_sub(1);
    shell_script(&format!(
        "echo ready& set /p line=& for /L %i in (0,1,{last}) do @echo %i"
    ))
}

/// A shell that exits with an access violation's code, which the terminal reports as its unsigned
/// value and no signal.
#[cfg(any(test, feature = "test-support"))]
pub fn abnormal_exit() -> AbnormalExit {
    AbnormalExit {
        program: shell_script("exit -1073741819"),
        exit_code: 3_221_225_477,
        signal_code: None,
    }
}

/// A shell that prints `ready` and waits 20 seconds, reading none of its input; the exit is the
/// one the console's interrupt key gives it.
#[cfg(any(test, feature = "test-support"))]
pub fn interruptible_sleeper() -> AbnormalExit {
    AbnormalExit {
        program: shell_script("echo ready& ping -n 21 127.0.0.1 >nul"),
        exit_code: 3_221_225_786,
        signal_code: None,
    }
}

/// A shell that takes its interrupt key as input, prints `ready`, reads one input line and prints
/// `got:<line>`, then reads one key and prints `^C` when it is the interrupt key.
#[cfg(any(test, feature = "test-support"))]
pub fn echoing_line_reader() -> TestProgram {
    TestProgram {
        program: "powershell.exe".to_owned(),
        arguments: vec![
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            "[Console]::TreatControlCAsInput = $true; 'ready'; $line = [Console]::ReadLine(); \
             \"got:$line\"; if ([Console]::ReadKey($true).KeyChar -eq [char]3) { '^C' }"
                .to_owned(),
        ],
    }
}

/// A shell that takes its interrupt key as input, asks its terminal for its device attributes,
/// prints `ready`, copies the next `byte_count` input bytes to the file `path`, then prints `done`.
#[cfg(any(test, feature = "test-support"))]
pub fn input_recorder(path: &Path, byte_count: usize) -> TestProgram {
    let path = quote_powershell_literal(&path.display().to_string());
    TestProgram {
        program: "powershell.exe".to_owned(),
        arguments: vec![
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            format!(
                "[Console]::TreatControlCAsInput = $true; [Console]::Out.Write([char]27 + '[c'); \
                 'ready'; $in = [Console]::OpenStandardInput(); $bytes = New-Object byte[] \
                 {byte_count}; $read = 0; while ($read -lt {byte_count}) {{ $count = \
                 $in.Read($bytes, $read, {byte_count} - $read); if ($count -le 0) {{ break }}; \
                 $read += $count }}; [IO.File]::WriteAllBytes({path}, $bytes); 'done'"
            ),
        ],
    }
}

/// A shell that asks its terminal for its device attributes `question_count` times, prints
/// `asked`, and a second later reads every key waiting on its console, printing
/// `read <keys> key <count>`, where the count is of `Z` keys among them.
#[cfg(any(test, feature = "test-support"))]
pub fn device_attribute_asker(question_count: usize) -> TestProgram {
    TestProgram {
        program: "powershell.exe".to_owned(),
        arguments: vec![
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            format!(
                "[Console]::Out.Write(([char]27 + '[c') * {question_count}); 'asked'; \
                 Start-Sleep 1; $n = 0; $z = 0; while ([Console]::KeyAvailable) {{ \
                 $k = [Console]::ReadKey($true); $n++; if ($k.KeyChar -eq 'Z') {{ $z++ }} }}; \
                 \"read $n key $z\""
            ),
        ],
    }
}

/// A shell that prints `ready`, then prints the numbers from 0, one a line, until it reads the key
/// `Z` without echo, when it prints `key` and exits with code 0.
#[cfg(any(test, feature = "test-support"))]
pub fn key_stopped_printer() -> TestProgram {
    TestProgram {
        program: "powershell.exe".to_owned(),
        arguments: vec![
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            "'ready'; $i = 0; while ($true) { $i; $i++; if ([Console]::KeyAvailable -and \
             [Console]::ReadKey($true).KeyChar -eq 'Z') { 'key'; exit 0 } }"
                .to_owned(),
        ],
    }
}

/// A shell that prints the folder it runs in, then its whole environment, one `NAME=value` a line.
#[cfg(any(test, feature = "test-support"))]
pub fn launch_printer() -> TestProgram {
    shell_script("cd & set")
}

#[cfg(any(test, feature = "test-support"))]
fn shell_script(script: &str) -> TestProgram {
    TestProgram {
        program: "cmd.exe".to_owned(),
        arguments: vec!["/d".to_owned(), "/c".to_owned(), script.to_owned()],
    }
}
