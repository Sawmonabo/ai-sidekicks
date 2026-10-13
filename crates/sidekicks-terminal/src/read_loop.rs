//! Each shell's read loop: it reads the terminal's output into the screen copy and to the caller,
//! writes the caller's input in order, and reports the program's exit after its last output.

use std::io;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::tty::{ChildEvent, EventedPty, Pty};
use bytes::Bytes;
use sidekicks_platforms::{TerminalSignal, TerminalWake, TerminalWaker, TerminalWatch};
use tokio::runtime::Handle;
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};
use tokio::sync::mpsc::{self, OwnedPermit};
use tokio::sync::{oneshot, watch};
use tracing::Instrument;
use vte::ansi::Processor;

use crate::exit::TerminalExit;
use crate::pty::{TerminalWriteError, WriteQueue};
use crate::screen::TerminalScreen;

/// How many of the caller's writes and resizes wait for the loop before a caller waits for room.
const COMMAND_CAPACITY: usize = 16;

/// How many chunks of output wait for the caller before the loop stops reading.
const OUTPUT_CAPACITY: usize = 8;

/// The most one read takes, so at most 64 KiB of output waits for the caller.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// The most read after the program's exit, so a process left writing to the terminal cannot hold
/// the exit back.
const EXIT_DRAIN_BYTES: usize = 1024 * 1024;

/// Takes a shell's output before the screen copy, the scrollback and the caller see it.
pub trait OutputFilter: Send + 'static {
    /// Appends to `kept` what stays of `chunk`; it may hold bytes back for a later chunk.
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>);

    /// Appends to `kept` what the filter still holds, once the output has ended.
    fn finish(&mut self, kept: &mut Vec<u8>);
}

/// What a shell's output reports to the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    /// A chunk of the shell's output, as the filter kept it.
    Output(Bytes),
    /// The program's exit, after its last output.
    Exit(TerminalExit),
}

/// A shell's output, then its exit; nothing is reported once the terminal's close begins.
pub struct TerminalOutput {
    chunks: mpsc::Receiver<Bytes>,
    control: Arc<TerminalControl>,
    has_yielded_exit: bool,
}

impl TerminalOutput {
    /// The next chunk of output, then the exit once, then `None`; `None` at once when the close
    /// began, which reports no exit.
    pub async fn next(&mut self) -> Option<TerminalEvent> {
        if self.control.is_closing() {
            return None;
        }
        let chunk = self.chunks.recv().await;
        if self.control.is_closing() {
            return None;
        }
        match chunk {
            Some(chunk) => {
                // The loop may be waiting for room to read into.
                self.control.waker.wake();
                Some(TerminalEvent::Output(chunk))
            }
            None if self.has_yielded_exit => None,
            None => {
                self.has_yielded_exit = true;
                self.control.reported_exit().map(TerminalEvent::Exit)
            }
        }
    }
}

/// A caller's request the loop carries out on the terminal.
enum LoopCommand {
    Write {
        bytes: Bytes,
        answer: oneshot::Sender<Result<(), TerminalWriteError>>,
    },
    Resize {
        rows: u16,
        columns: u16,
        answer: oneshot::Sender<io::Result<()>>,
    },
}

/// Whether the program's exit has been reported, and which.
enum ExitReport {
    Pending,
    Reported(TerminalExit),
}

/// What the loop knows of the program.
struct ChildState {
    has_exited: bool,
}

/// One shell's controls, shared by the terminals and the shell's read loop.
pub(crate) struct TerminalControl {
    commands: mpsc::Sender<LoopCommand>,
    waker: TerminalWaker,
    is_paused: AtomicBool,
    is_closing: AtomicBool,
    process_id: Option<u32>,
    /// Held while the program is reaped and while a signal is sent, so no signal reaches a
    /// process that took a reaped program's id.
    child_state: Mutex<ChildState>,
    child_exit: watch::Sender<bool>,
    /// Held while the closing flag is set, so no exit is reported once the close begins.
    exit_report: Mutex<ExitReport>,
    exit_reported: watch::Sender<bool>,
}

impl TerminalControl {
    /// The process id of the program the terminal started, where the system gives one.
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Writes `bytes` to the terminal's input, answering once every byte is written. Fails with
    /// `Closed` once the close began, `Ended` once the input or the program ended, and `Failed`
    /// for a write the system refused.
    pub(crate) async fn write(&self, bytes: Bytes) -> Result<(), TerminalWriteError> {
        if self.is_closing() {
            return Err(TerminalWriteError::Closed);
        }
        let (answer, answered) = oneshot::channel();
        if self
            .commands
            .send(LoopCommand::Write { bytes, answer })
            .await
            .is_err()
        {
            return Err(self.ended_write_error());
        }
        self.waker.wake();
        answered
            .await
            .unwrap_or_else(|_loop_ended| Err(self.ended_write_error()))
    }

    /// Resizes the terminal and its screen copy to `rows` by `columns` cells. Fails when the
    /// system refuses the size or the read loop has ended.
    pub(crate) async fn resize(&self, rows: u16, columns: u16) -> io::Result<()> {
        let (answer, answered) = oneshot::channel();
        if self
            .commands
            .send(LoopCommand::Resize {
                rows,
                columns,
                answer,
            })
            .await
            .is_err()
        {
            return Err(loop_ended_error());
        }
        self.waker.wake();
        answered
            .await
            .unwrap_or_else(|_loop_ended| Err(loop_ended_error()))
    }

    /// Stops reading the terminal, so its output waits in the system's buffer.
    pub(crate) fn pause(&self) {
        self.is_paused.store(true, Ordering::SeqCst);
        self.waker.wake();
    }

    /// Reads the terminal again; the output that waited arrives in order.
    pub(crate) fn resume(&self) {
        self.is_paused.store(false, Ordering::SeqCst);
        self.waker.wake();
    }

    /// Begins the terminal's close: from here on nothing is reported, writes are refused and the
    /// output is read and discarded until the program exits.
    pub(crate) fn begin_close(&self) {
        {
            let _exit_report = self.lock_exit_report();
            self.is_closing.store(true, Ordering::SeqCst);
        }
        self.waker.wake();
    }

    /// Sends `signal` to the program; sends nothing once the program has exited, since its id may
    /// already be another process's. Fails when the program has no process id or the system
    /// refuses the signal.
    pub(crate) fn send_signal(&self, signal: TerminalSignal) -> io::Result<()> {
        let child_state = self.lock_child_state();
        if child_state.has_exited {
            return Ok(());
        }
        let Some(process_id) = self.process_id else {
            return Err(io::Error::other("the terminal's program has no process id"));
        };
        sidekicks_platforms::send_signal(process_id, signal)
    }

    /// Whether the program has exited and been reaped.
    pub(crate) fn has_child_exited(&self) -> bool {
        self.lock_child_state().has_exited
    }

    /// Resolves once the program has exited, at once when it already has.
    pub(crate) async fn child_exited(&self) {
        let mut child_exit = self.child_exit.subscribe();
        child_exit
            .wait_for(|has_exited| *has_exited)
            .await
            .map(drop)
            .expect("the control keeps the exit's sender while it is borrowed");
    }

    /// Reports the unconfirmed exit for a program a hard stop ended; does nothing once the close
    /// began or an exit was reported.
    pub(crate) fn report_forced_end(&self) {
        if self.report_exit(TerminalExit::unconfirmed()) {
            self.waker.wake();
        }
    }

    /// Whether an exit, real or forced, has been reported.
    pub(crate) fn is_exit_reported(&self) -> bool {
        self.reported_exit().is_some()
    }

    /// Resolves once an exit, real or forced, is reported, at once when one already is.
    pub(crate) async fn exit_reported(&self) {
        let mut exit_reported = self.exit_reported.subscribe();
        exit_reported
            .wait_for(|is_reported| *is_reported)
            .await
            .map(drop)
            .expect("the control keeps the report's sender while it is borrowed");
    }

    fn is_closing(&self) -> bool {
        self.is_closing.load(Ordering::SeqCst)
    }

    fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    fn reported_exit(&self) -> Option<TerminalExit> {
        match *self.lock_exit_report() {
            ExitReport::Pending => None,
            ExitReport::Reported(exit) => Some(exit),
        }
    }

    /// Reports `exit` unless the close began or an exit was reported; answers whether it did.
    fn report_exit(&self, exit: TerminalExit) -> bool {
        {
            let mut exit_report = self.lock_exit_report();
            if self.is_closing() {
                return false;
            }
            match *exit_report {
                ExitReport::Reported(_) => return false,
                ExitReport::Pending => *exit_report = ExitReport::Reported(exit),
            }
        }
        self.exit_reported
            .send_modify(|is_reported| *is_reported = true);
        true
    }

    /// Reaps the program when the terminal's child event says it exited, answering its status.
    fn take_child_exit(&self, pty: &mut Pty) -> Option<Option<ExitStatus>> {
        let mut child_state = self.lock_child_state();
        match pty.next_child_event() {
            Some(ChildEvent::Exited(status)) => {
                child_state.has_exited = true;
                drop(child_state);
                self.child_exit.send_modify(|has_exited| *has_exited = true);
                Some(status)
            }
            None => None,
        }
    }

    /// The error a write gets once the loop is gone: the input ended with the program, or the
    /// terminal closed.
    fn ended_write_error(&self) -> TerminalWriteError {
        if self.has_child_exited() {
            TerminalWriteError::Ended
        } else {
            TerminalWriteError::Closed
        }
    }

    fn lock_child_state(&self) -> MutexGuard<'_, ChildState> {
        self.child_state
            .lock()
            .expect("no panic holds a terminal's lock, since a panic ends the daemon")
    }

    fn lock_exit_report(&self) -> MutexGuard<'_, ExitReport> {
        self.exit_report
            .lock()
            .expect("no panic holds a terminal's lock, since a panic ends the daemon")
    }
}

/// A shell whose read loop is running: its controls, its screen copy and its output.
pub(crate) struct StartedLoop<L: EventListener> {
    /// The controls the terminals drive the shell with.
    pub(crate) control: Arc<TerminalControl>,
    /// The screen copy and the scrollback window, under the lock the loop draws them with.
    pub(crate) screen: Arc<Mutex<TerminalScreen<L>>>,
    /// The shell's output, then its exit.
    pub(crate) output: TerminalOutput,
}

/// Starts the read loop of the shell in `pty` on `runtime`, its screen copy `rows` by `columns`
/// cells heard by `listener`, every chunk of output passing `filter` first; `name` names the
/// loop in logs and threads. Runs on the caller's thread, needing no runtime context. Fails when
/// the loop's waker or thread cannot be made.
pub(crate) fn start_read_loop<L, F>(
    runtime: &Handle,
    name: &str,
    pty: Pty,
    rows: u16,
    columns: u16,
    listener: L,
    filter: F,
) -> io::Result<StartedLoop<L>>
where
    L: EventListener + Send + 'static,
    F: OutputFilter,
{
    let process_id = sidekicks_platforms::child_process_id(&pty);
    let waker = match TerminalWaker::new() {
        Ok(waker) => waker,
        Err(error) => {
            drop_on_own_thread(pty, name);
            return Err(error);
        }
    };
    let (commands, command_receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (child_exit, _) = watch::channel(false);
    let (exit_reported, _) = watch::channel(false);
    let control = Arc::new(TerminalControl {
        commands,
        waker,
        is_paused: AtomicBool::new(false),
        is_closing: AtomicBool::new(false),
        process_id,
        child_state: Mutex::new(ChildState { has_exited: false }),
        child_exit,
        exit_report: Mutex::new(ExitReport::Pending),
        exit_reported,
    });
    let screen = Arc::new(Mutex::new(TerminalScreen::new(rows, columns, listener)));
    let (output_sender, output_receiver) = mpsc::channel(OUTPUT_CAPACITY);
    let guard = PtyGuard {
        pty: Some(pty),
        control: Arc::clone(&control),
        name: name.to_owned(),
    };
    let read_loop = ReadLoop {
        control: Arc::clone(&control),
        screen: Arc::clone(&screen),
        filter,
        commands: command_receiver,
        processor: Processor::new(),
        queue: WriteQueue::new(),
        read_buffer: vec![0; READ_CHUNK_BYTES].into_boxed_slice(),
        kept: Vec::with_capacity(READ_CHUNK_BYTES),
        output: Some(output_sender),
        permit: None,
        is_output_ended: false,
        has_closed: false,
    };
    let span = tracing::info_span!("terminal read loop", terminal = name);
    sidekicks_platforms::run_terminal_loop(runtime, name, read_loop.run(guard).instrument(span))?;
    Ok(StartedLoop {
        output: TerminalOutput {
            chunks: output_receiver,
            control: Arc::clone(&control),
            has_yielded_exit: false,
        },
        control,
        screen,
    })
}

/// Holds a shell's PTY for its loop; a PTY whose program has not exited is dropped on a thread of
/// its own, since the drop waits for the program and must not block a runtime thread.
struct PtyGuard {
    pty: Option<Pty>,
    control: Arc<TerminalControl>,
    name: String,
}

impl PtyGuard {
    fn pty_mut(&mut self) -> &mut Pty {
        self.pty
            .as_mut()
            .expect("the PTY leaves its guard only when the guard drops")
    }
}

impl Drop for PtyGuard {
    fn drop(&mut self) {
        let Some(pty) = self.pty.take() else {
            return;
        };
        if self.control.has_child_exited() {
            drop(pty);
        } else {
            drop_on_own_thread(pty, &self.name);
        }
    }
}

/// Drops `pty` on a new thread, since its drop waits for a program that has not exited.
fn drop_on_own_thread(pty: Pty, name: &str) {
    let dropping = thread::Builder::new()
        .name(format!("{name} release"))
        .spawn(move || drop(pty));
    if let Err(error) = dropping {
        // A thread that could not start drops its work, so the PTY was dropped on this thread.
        tracing::error!(
            %error,
            terminal = name,
            "a terminal's PTY could not be dropped on its own thread"
        );
    }
}

/// How the loop's watch over the program ended.
enum LoopEnd {
    /// The program exited, with the status the system reported.
    ChildExited(Option<ExitStatus>),
    /// The wait failed twice in a row, so the loop can no longer watch the terminal.
    WaitFailed,
}

/// What one shell's read loop owns besides its PTY and its watch.
struct ReadLoop<L: EventListener, F> {
    control: Arc<TerminalControl>,
    screen: Arc<Mutex<TerminalScreen<L>>>,
    filter: F,
    commands: mpsc::Receiver<LoopCommand>,
    processor: Processor,
    queue: WriteQueue,
    read_buffer: Box<[u8]>,
    /// What the filter kept of the last chunk.
    kept: Vec<u8>,
    /// The caller's output, gone once the close began, an exit was reported or the caller left.
    output: Option<mpsc::Sender<Bytes>>,
    /// Room for one chunk of output; held only beside the output, since it keeps the channel open.
    permit: Option<OwnedPermit<Bytes>>,
    is_output_ended: bool,
    has_closed: bool,
}

impl<L, F> ReadLoop<L, F>
where
    L: EventListener + Send + 'static,
    F: OutputFilter,
{
    async fn run(mut self, mut guard: PtyGuard) {
        let pty = guard.pty_mut();
        let mut watch = match TerminalWatch::new(pty, &self.control.waker) {
            Ok(watch) => watch,
            Err(error) => {
                tracing::error!(%error, "the terminal could not be watched");
                self.control.report_exit(TerminalExit::unconfirmed());
                return;
            }
        };
        match self.watch_child(pty, &mut watch).await {
            LoopEnd::ChildExited(status) => self.drain_to_exit(pty, &mut watch, status).await,
            LoopEnd::WaitFailed => {
                self.control.report_exit(TerminalExit::unconfirmed());
            }
        }
        // The report comes before the output's end, so the caller reads it once the output ends.
        self.end_output();
        if let Err(error) = watch.release(pty) {
            tracing::error!(%error, "the terminal's watch could not be released");
        }
    }

    /// Reads, writes and serves commands until the program exits or the wait fails twice in a
    /// row.
    async fn watch_child(&mut self, pty: &mut Pty, watch: &mut TerminalWatch) -> LoopEnd {
        let mut has_failed = false;
        loop {
            self.take_commands(pty);
            self.apply_stops();
            self.reserve_output();
            // Without an output the bytes are read and discarded, so a program that ignores the
            // close's hangup is not blocked on a full terminal.
            let can_read = !self.is_output_ended
                && (self.output.is_none() || (self.permit.is_some() && !self.control.is_paused()));
            let deadline = self.processor.sync_timeout().sync_timeout();
            let wake = watch
                .wait(
                    pty,
                    can_read.then_some(&mut *self.read_buffer),
                    self.queue.pending_bytes(),
                    deadline,
                )
                .await;
            match wake {
                Ok(wake) => {
                    has_failed = false;
                    match wake {
                        TerminalWake::Read(count) => self.take_read(count),
                        TerminalWake::OutputEnded => self.is_output_ended = true,
                        TerminalWake::Wrote(count) => self.queue.advance(count),
                        TerminalWake::InputEnded => self.end_input(),
                        TerminalWake::ChildEvent => {
                            if let Some(status) = self.control.take_child_exit(pty) {
                                return LoopEnd::ChildExited(status);
                            }
                        }
                        TerminalWake::Woken => {}
                        TerminalWake::Deadline => self.stop_sync(),
                    }
                }
                Err(error) => {
                    tracing::error!(%error, "the terminal's wait failed");
                    if has_failed {
                        return LoopEnd::WaitFailed;
                    }
                    has_failed = true;
                    // From here the loop only waits for the program: no read, and no write.
                    self.queue.fail(error);
                    self.end_input();
                    self.is_output_ended = true;
                }
            }
        }
    }

    /// Delivers what the terminal still holds once the program exited, at most
    /// `EXIT_DRAIN_BYTES`, then what the filter held, then reports the exit.
    async fn drain_to_exit(
        &mut self,
        pty: &mut Pty,
        watch: &mut TerminalWatch,
        status: Option<ExitStatus>,
    ) {
        self.end_input();
        let mut drained = 0;
        loop {
            self.take_commands(pty);
            self.apply_stops();
            self.reserve_output();
            if self.output.is_none() {
                break;
            }
            if self.permit.is_some() && !self.control.is_paused() {
                if !self.is_output_ended && drained < EXIT_DRAIN_BYTES {
                    match watch.try_read(pty, &mut self.read_buffer) {
                        Ok(Some(0) | None) => self.is_output_ended = true,
                        Ok(Some(count)) => {
                            drained += count;
                            self.take_read(count);
                        }
                        Err(error) => {
                            tracing::error!(%error, "the terminal's output could not be drained");
                            self.is_output_ended = true;
                        }
                    }
                    continue;
                }
                self.kept.clear();
                self.filter.finish(&mut self.kept);
                self.deliver_kept();
                break;
            }
            // No room for output, or paused: wait for the caller without reading.
            let deadline = self.processor.sync_timeout().sync_timeout();
            match watch.wait(pty, None, None, deadline).await {
                Ok(TerminalWake::Deadline) => self.stop_sync(),
                Ok(
                    TerminalWake::Read(_)
                    | TerminalWake::OutputEnded
                    | TerminalWake::Wrote(_)
                    | TerminalWake::InputEnded
                    | TerminalWake::ChildEvent
                    | TerminalWake::Woken,
                ) => {}
                Err(error) => {
                    tracing::error!(%error, "the terminal's wait failed after the program exited");
                    break;
                }
            }
        }
        self.control.report_exit(TerminalExit::from_status(status));
    }

    /// Carries out every waiting command: writes join the queue, resizes run and are answered.
    fn take_commands(&mut self, pty: &mut Pty) {
        loop {
            match self.commands.try_recv() {
                Ok(LoopCommand::Write { bytes, answer }) => self.queue.push(bytes, answer),
                Ok(LoopCommand::Resize {
                    rows,
                    columns,
                    answer,
                }) => {
                    let resized = self.resize(pty, rows, columns);
                    // A caller that stopped waiting needs no answer.
                    answer.send(resized).unwrap_or_else(drop);
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return,
            }
        }
    }

    fn resize(&self, pty: &mut Pty, rows: u16, columns: u16) -> io::Result<()> {
        sidekicks_platforms::resize_terminal(pty, rows, columns)?;
        lock_screen(&self.screen).resize(rows, columns);
        Ok(())
    }

    /// Ends the output once the close began (refusing every write too) or an exit was reported.
    fn apply_stops(&mut self) {
        if self.control.is_closing() && !self.has_closed {
            self.has_closed = true;
            self.end_output();
            self.queue.close();
        }
        if self.output.is_some() && self.control.is_exit_reported() {
            self.end_output();
        }
    }

    /// Answers every waiting and later write as ended, unless the close already refused them.
    fn end_input(&mut self) {
        if !self.has_closed {
            self.queue.end();
        }
    }

    /// Takes room for one chunk of output when there is some; a caller that left ends the output.
    fn reserve_output(&mut self) {
        if self.permit.is_some() {
            return;
        }
        let Some(output) = &self.output else {
            return;
        };
        match output.clone().try_reserve_owned() {
            Ok(permit) => self.permit = Some(permit),
            // The caller's next take wakes the loop.
            Err(TrySendError::Full(_output)) => {}
            Err(TrySendError::Closed(_output)) => self.end_output(),
        }
    }

    /// Passes `count` read bytes through the filter to the screen and the caller, or discards
    /// them once the output has ended.
    fn take_read(&mut self, count: usize) {
        if self.output.is_none() {
            return;
        }
        self.kept.clear();
        self.filter
            .filter(&self.read_buffer[..count], &mut self.kept);
        self.deliver_kept();
    }

    /// Draws what the filter kept and sends it to the caller; nothing kept keeps the room.
    fn deliver_kept(&mut self) {
        if self.kept.is_empty() {
            return;
        }
        let permit = self
            .permit
            .take()
            .expect("output is read only while room for it is held");
        lock_screen(&self.screen).take_output(&mut self.processor, &self.kept);
        permit.send(Bytes::copy_from_slice(&self.kept));
    }

    fn stop_sync(&mut self) {
        lock_screen(&self.screen).stop_sync(&mut self.processor);
    }

    /// Drops the output and its room, which closes the channel once the caller drained it.
    fn end_output(&mut self) {
        self.permit = None;
        self.output = None;
    }
}

fn lock_screen<L: EventListener>(
    screen: &Mutex<TerminalScreen<L>>,
) -> MutexGuard<'_, TerminalScreen<L>> {
    screen
        .lock()
        .expect("no panic holds a terminal's lock, since a panic ends the daemon")
}

/// The error a resize gets once the read loop has ended.
fn loop_ended_error() -> io::Error {
    io::Error::other("the terminal's read loop has ended")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use alacritty_terminal::event::VoidListener;
    use bytes::Bytes;
    use tokio::runtime::Handle;
    use tokio::time::timeout;

    use super::{OutputFilter, TerminalEvent, TerminalOutput, start_read_loop};
    use crate::exit::TerminalExit;
    use crate::pty::{SpawnRequest, open_pty};

    /// How many numbered lines the program prints, far more than a terminal's buffer holds.
    const LINE_COUNT: usize = 20_000;

    /// The bound on every wait for output, so a loop that stalls fails the test.
    const OUTPUT_BOUND: Duration = Duration::from_secs(30);

    /// Turns echo off, says it is ready, waits for one input line and prints the numbers.
    #[cfg(unix)]
    const WAITING_PRINTER: (&str, &[&str]) = (
        "/bin/sh",
        &[
            "-c",
            "stty -echo; echo ready; read line; i=0; \
             while [ $i -lt 20000 ]; do echo $i; i=$((i+1)); done",
        ],
    );
    #[cfg(windows)]
    const WAITING_PRINTER: (&str, &[&str]) = (
        "cmd.exe",
        &[
            "/c",
            "echo ready& set /p line=& for /L %i in (0,1,19999) do @echo %i",
        ],
    );

    /// Keeps every byte of the output.
    struct KeepAllOutput;

    impl OutputFilter for KeepAllOutput {
        fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
            kept.extend_from_slice(chunk);
        }

        fn finish(&mut self, _kept: &mut Vec<u8>) {}
    }

    /// Takes output until `text` holds `marker`.
    async fn read_until(output: &mut TerminalOutput, text: &mut String, marker: &str) {
        while !text.contains(marker) {
            match output.next().await {
                Some(TerminalEvent::Output(chunk)) => {
                    text.push_str(&String::from_utf8_lossy(&chunk));
                }
                other => panic!("the output ended before {marker:?}: {other:?}, after {text:?}"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_paused_shell_leaves_its_output_waiting_and_the_resume_delivers_it_in_order() {
        let (program, arguments) = WAITING_PRINTER;
        let request = SpawnRequest {
            program: program.to_owned(),
            arguments: arguments
                .iter()
                .map(|argument| (*argument).to_owned())
                .collect(),
            environment: Vec::new(),
            working_directory: std::env::current_dir().expect("the test runs in a folder"),
            rows: 24,
            columns: 80,
            shell_start: None,
        };
        let pty = open_pty(&request).expect("the shell starts");
        let started = start_read_loop(
            &Handle::current(),
            "paused shell",
            pty,
            24,
            80,
            VoidListener,
            KeepAllOutput,
        )
        .expect("the read loop starts");
        let control = started.control;
        let mut output = started.output;

        let mut text = String::new();
        timeout(
            OUTPUT_BOUND,
            read_until(&mut output, &mut text, "ready\r\n"),
        )
        .await
        .expect("the program says it is ready");
        let ready_end = text.find("ready\r\n").expect("the marker was read") + "ready\r\n".len();
        text.replace_range(..ready_end, "");

        control.pause();
        control
            .write(Bytes::from_static(b"go\r\n"))
            .await
            .expect("the input line is written");
        assert!(
            timeout(Duration::from_millis(500), output.next())
                .await
                .is_err(),
            "output arrived while the shell was paused"
        );

        control.resume();
        let mut events_after_exit = Vec::new();
        let exit = timeout(OUTPUT_BOUND, async {
            loop {
                match output.next().await {
                    Some(TerminalEvent::Output(chunk)) => {
                        text.push_str(&String::from_utf8_lossy(&chunk));
                    }
                    Some(TerminalEvent::Exit(exit)) => {
                        while let Some(event) = output.next().await {
                            events_after_exit.push(event);
                        }
                        return exit;
                    }
                    None => panic!("the output ended with no exit"),
                }
            }
        })
        .await
        .expect("the program prints every line and exits");

        let numbers: Vec<usize> = text
            .split('\n')
            .map(|line| line.trim_end_matches('\r'))
            .filter(|line| !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit()))
            .map(|line| line.parse().expect("a line of digits is a number"))
            .collect();
        assert_eq!(numbers, (0..LINE_COUNT).collect::<Vec<_>>());
        assert_eq!(
            exit,
            TerminalExit {
                exit_code: 0,
                signal_code: None
            }
        );
        assert!(
            events_after_exit.is_empty(),
            "events came after the exit: {events_after_exit:?}"
        );
    }
}
