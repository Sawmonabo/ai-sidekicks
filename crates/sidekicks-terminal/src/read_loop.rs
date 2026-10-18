//! Each shell's read loop: it reads the terminal's output into the screen copy and to the caller,
//! writes the caller's input in order, and reports the program's exit after its last output.

use std::error::Error;
use std::io;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::tty::Pty;
use bytes::Bytes;
use sidekicks_platforms::{TerminalSignal, TerminalWake, TerminalWaker, TerminalWatch};
use tokio::runtime::Handle;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{self, OwnedPermit};
use tokio::sync::{oneshot, watch};
use tracing::Instrument;
use vte::ansi::Processor;

use crate::exit::TerminalExit;
use crate::pty::{QueuedWrite, TerminalAnswers, TerminalWriteError, WriteIntake, WriteQueue};
use crate::screen::{ScreenListener, TerminalScreen};

/// How many of the caller's resizes wait for the loop before a caller waits for room.
const RESIZE_CAPACITY: usize = 4;

/// How many chunks of output wait for the caller before the loop stops reading.
const OUTPUT_CAPACITY: usize = 8;

/// The most one read takes, so at most 64 KiB of output waits for the caller.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// The most read after the program's exit, so a process left writing to the terminal cannot hold
/// the exit back.
const EXIT_DRAIN_BYTES: usize = 1024 * 1024;

/// How long the terminal stays quiet after the program's exit before its output counts as ended;
/// each read starts it again, since `ConPTY` reports no end of output.
const EXIT_QUIET_PERIOD: Duration = Duration::from_secs(1);

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
                if self
                    .control
                    .is_waiting_for_room
                    .swap(false, Ordering::SeqCst)
                {
                    self.control.waker.wake();
                }
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

impl Drop for TerminalOutput {
    fn drop(&mut self) {
        // Closed first, so the woken loop finds the output gone and reads on without it.
        self.chunks.close();
        self.control.waker.wake();
    }
}

/// A caller's resize the loop carries out on the terminal and its screen copy.
struct ResizeCommand {
    rows: u16,
    columns: u16,
    answer: oneshot::Sender<io::Result<()>>,
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
    writes: WriteIntake,
    resizes: mpsc::Sender<ResizeCommand>,
    waker: TerminalWaker,
    is_paused: AtomicBool,
    is_closing: AtomicBool,
    /// Set while the loop finds no room for output, so the caller's next take wakes it.
    is_waiting_for_room: AtomicBool,
    process_id: Option<u32>,
    /// Held across the program's reap and its mark as exited, and across each signal sent to it,
    /// so no signal sent here reaches its process id once the reap has freed it.
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

    /// Writes `bytes` to the terminal's input behind every write handed over before it,
    /// answering once every byte is written. Fails with `Closed` once the close began, `Ended`
    /// once the input or the program ended, and `Failed` for a write the system refused.
    pub(crate) async fn write(&self, bytes: Bytes) -> Result<(), TerminalWriteError> {
        let (answer, answered) = oneshot::channel();
        self.hand_over(QueuedWrite::awaiting_written(bytes, answer))?;
        answered
            .await
            .unwrap_or_else(|_loop_ended| Err(self.ended_write_error()))
    }

    /// Hands `bytes` to the terminal's input behind every write handed over before it, at once
    /// and without waiting; the answer resolves once the terminal's write queue takes it, which it
    /// does while the queue holds fewer than 64 KiB. Fails at once with `Closed` once the close
    /// began and `Ended` once the read loop is gone; the answer fails the same way when the close
    /// or the input's end comes before the take.
    pub(crate) fn queue_write(
        self: &Arc<Self>,
        bytes: Bytes,
    ) -> Result<WriteTaken, TerminalWriteError> {
        let (taken, answer) = oneshot::channel();
        self.hand_over(QueuedWrite::awaiting_take(bytes, taken))?;
        Ok(WriteTaken {
            answer,
            control: Arc::clone(self),
        })
    }

    /// Puts `write` in the intake and wakes the loop to take it.
    fn hand_over(&self, write: QueuedWrite) -> Result<(), TerminalWriteError> {
        if self.is_closing() {
            return Err(TerminalWriteError::Closed);
        }
        if self.writes.send(write).is_err() {
            return Err(self.ended_write_error());
        }
        self.waker.wake();
        Ok(())
    }

    /// Resizes the terminal and its screen copy to `rows` by `columns` cells, ahead of any write
    /// still waiting. Fails when the system refuses the size or the read loop has ended.
    pub(crate) async fn resize(&self, rows: u16, columns: u16) -> io::Result<()> {
        let (answer, answered) = oneshot::channel();
        let resize = ResizeCommand {
            rows,
            columns,
            answer,
        };
        if self.resizes.send(resize).await.is_err() {
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

    /// Whether the program has exited.
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

    /// Resolves once an exit, real or forced, is reported or the program has exited, whichever
    /// comes first; a closing terminal reports no exit, so only the program's exit ends its wait.
    pub(crate) async fn ended(&self) {
        let mut exit_reported = self.exit_reported.subscribe();
        tokio::select! {
            reported = exit_reported.wait_for(|is_reported| *is_reported) => reported
                .map(drop)
                .expect("the control keeps the report's sender while it is borrowed"),
            () = self.child_exited() => {}
        }
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
        self.exit_reported.send_replace(true);
        true
    }

    /// Reaps the program when the watch says it exited, answering the loop's end with its status,
    /// and marks it exited under the signal lock.
    fn take_child_exit(&self, watch: &mut TerminalWatch) -> Option<LoopEnd> {
        let mut child_state = self.lock_child_state();
        let status = watch.take_child_exit()?;
        child_state.has_exited = true;
        drop(child_state);
        self.child_exit.send_replace(true);
        Some(LoopEnd::ChildExited(status))
    }

    /// Marks the program exited under the signal lock, for a release that waited for it.
    fn mark_exited(&self) {
        self.lock_child_state().has_exited = true;
        self.child_exit.send_replace(true);
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

/// A write handed to a terminal, waiting for its write queue to take it; dropping it leaves the
/// write in line.
pub struct WriteTaken {
    answer: oneshot::Receiver<Result<(), TerminalWriteError>>,
    control: Arc<TerminalControl>,
}

impl WriteTaken {
    /// Resolves once the terminal's write queue has taken the write. Fails with `Closed` when the
    /// close began first and `Ended` when the input or the program ended first.
    pub async fn taken(self) -> Result<(), TerminalWriteError> {
        let Self { answer, control } = self;
        answer
            .await
            .unwrap_or_else(|_loop_ended| Err(control.ended_write_error()))
    }
}

/// A shell whose read loop is running: its controls, its screen copy and its output.
pub(crate) struct StartedLoop<L: ScreenListener> {
    /// The controls the terminals drive the shell with.
    pub(crate) control: Arc<TerminalControl>,
    /// The screen copy and the scrollback window, under the lock the loop draws them with.
    pub(crate) screen: Arc<Mutex<TerminalScreen<L>>>,
    /// The shell's output, then its exit.
    pub(crate) output: TerminalOutput,
}

/// Where the loop finds its PTY, so a loop that never starts still hands the PTY back.
type PtySlot = Arc<Mutex<Option<Pty>>>;

/// A PTY's release, which may block until its program exits.
type Release = Box<dyn FnOnce() + Send>;

/// Starts the read loop of the shell in `pty` on `runtime`, its screen copy `rows` by `columns`
/// cells heard by the listener `listen` makes from the shell's answers, every chunk of output
/// passing `filter` first; `name` names the loop in logs and threads. Fails when the loop's waker
/// or thread cannot be made; the PTY is then released off the runtime's workers.
pub(crate) fn start_read_loop<L, F>(
    runtime: &Handle,
    name: &str,
    pty: Pty,
    rows: u16,
    columns: u16,
    listen: impl FnOnce(TerminalAnswers) -> L,
    filter: F,
) -> io::Result<StartedLoop<L>>
where
    L: ScreenListener,
    F: OutputFilter,
{
    let process_id = sidekicks_platforms::child_process_id(&pty);
    let waker = match TerminalWaker::new() {
        Ok(waker) => waker,
        Err(error) => {
            // No control exists yet, so nothing can signal the program before its release.
            release_off_runtime(
                name,
                Box::new(move || sidekicks_platforms::release_terminal(pty, || {})),
            );
            return Err(error);
        }
    };
    let (writes, write_receiver) = mpsc::unbounded_channel();
    let answers = TerminalAnswers::new(writes.clone());
    let (resizes, resize_receiver) = mpsc::channel(RESIZE_CAPACITY);
    let control = Arc::new(TerminalControl {
        writes,
        resizes,
        waker,
        is_paused: AtomicBool::new(false),
        is_closing: AtomicBool::new(false),
        is_waiting_for_room: AtomicBool::new(false),
        process_id,
        child_state: Mutex::new(ChildState { has_exited: false }),
        child_exit: watch::Sender::new(false),
        exit_report: Mutex::new(ExitReport::Pending),
        exit_reported: watch::Sender::new(false),
    });
    let screen = Arc::new(Mutex::new(TerminalScreen::new(
        rows,
        columns,
        listen(answers),
    )));
    let (output_sender, output_receiver) = mpsc::channel(OUTPUT_CAPACITY);
    let read_loop = ReadLoop {
        name: name.to_owned(),
        control: Arc::clone(&control),
        screen: Arc::clone(&screen),
        filter,
        writes: write_receiver,
        resizes: resize_receiver,
        processor: Processor::new(),
        queue: WriteQueue::new(),
        read_buffer: vec![0; READ_CHUNK_BYTES].into_boxed_slice(),
        kept: Vec::with_capacity(READ_CHUNK_BYTES),
        output: Some(output_sender),
        permit: None,
        is_output_ended: false,
        has_closed: false,
    };
    let pty_slot: PtySlot = Arc::new(Mutex::new(Some(pty)));
    let span = tracing::info_span!("terminal read loop", terminal = name);
    let running = read_loop.run(Arc::clone(&pty_slot)).instrument(span);
    if let Err(error) = sidekicks_platforms::run_terminal_loop(runtime, name, running) {
        if let Some(pty) = lock_ignoring_poison(&pty_slot).take() {
            release_off_runtime(
                name,
                Box::new(move || sidekicks_platforms::release_terminal(pty, || {})),
            );
        }
        return Err(error);
    }
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

/// Runs `release` on a thread of its own, since it may wait for a program that has not exited;
/// when no thread can start, the runtime's blocking pool runs it, never one of its workers.
fn release_off_runtime(name: &str, release: Release) {
    let slot = Arc::new(Mutex::new(Some(release)));
    let thread_slot = Arc::clone(&slot);
    let started = thread::Builder::new()
        .name(format!("{name} release"))
        .spawn(move || run_release(&thread_slot));
    if let Err(error) = started {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            terminal = name,
            "a terminal's release thread could not start, so the blocking pool releases it"
        );
        tokio::task::spawn_blocking(move || run_release(&slot));
    }
}

/// Runs the release the slot holds, once.
fn run_release(slot: &Mutex<Option<Release>>) {
    if let Some(release) = lock_ignoring_poison(slot).take() {
        release();
    }
}

/// Locks a slot that holds no invariant a panic could break.
fn lock_ignoring_poison<T>(slot: &Mutex<T>) -> MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How the loop's watch over the program ended.
enum LoopEnd {
    /// The program exited, with the status the system reported.
    ChildExited(Option<ExitStatus>),
    /// A read or the wait failed, so the loop can no longer watch the terminal.
    WaitFailed,
}

/// What one shell's read loop owns besides its watch.
struct ReadLoop<L: ScreenListener, F> {
    name: String,
    control: Arc<TerminalControl>,
    screen: Arc<Mutex<TerminalScreen<L>>>,
    filter: F,
    writes: mpsc::UnboundedReceiver<QueuedWrite>,
    resizes: mpsc::Receiver<ResizeCommand>,
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
    L: ScreenListener,
    F: OutputFilter,
{
    async fn run(mut self, pty_slot: PtySlot) {
        let pty = lock_ignoring_poison(&pty_slot)
            .take()
            .expect("the slot holds the PTY until the loop takes it");
        let mut watch = match TerminalWatch::new(pty, &self.control.waker) {
            Ok(watch) => watch,
            Err((error, pty)) => {
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    "the terminal could not be watched"
                );
                self.control.report_exit(TerminalExit::unconfirmed());
                self.end_output();
                let control = Arc::clone(&self.control);
                release_off_runtime(
                    &self.name,
                    Box::new(move || {
                        sidekicks_platforms::release_terminal(*pty, || control.mark_exited());
                    }),
                );
                return;
            }
        };
        match self.watch_child(&mut watch).await {
            LoopEnd::ChildExited(status) => self.drain_to_exit(&mut watch, status).await,
            LoopEnd::WaitFailed => {
                self.control.report_exit(TerminalExit::unconfirmed());
            }
        }
        // The report comes before the output's end, so the caller reads it once the output ends.
        self.end_output();
        let control = Arc::clone(&self.control);
        if control.has_child_exited() {
            watch.release(|| control.mark_exited());
        } else {
            release_off_runtime(
                &self.name,
                Box::new(move || watch.release(|| control.mark_exited())),
            );
        }
    }

    /// Reads, writes and serves commands until the program exits or a read or the wait fails.
    async fn watch_child(&mut self, watch: &mut TerminalWatch) -> LoopEnd {
        loop {
            self.take_commands(watch);
            self.apply_stops();
            self.reserve_output();
            // Without an output the bytes are read and discarded, so a program that ignores the
            // close's hangup is not blocked on a full terminal.
            let can_read = !self.is_output_ended
                && (self.output.is_none() || (self.permit.is_some() && !self.control.is_paused()));
            // The screen copy draws a synchronized update's held output at each chunk's end, so no
            // update's deadline is waited on.
            let wake = watch
                .wait(
                    can_read.then_some(&mut *self.read_buffer),
                    self.queue.pending_bytes(),
                    None,
                )
                .await;
            match wake {
                Ok(TerminalWake::Read(count)) => self.take_read(count),
                Ok(TerminalWake::OutputEnded) => self.is_output_ended = true,
                Ok(TerminalWake::Wrote(count)) => self.queue.advance(count),
                Ok(TerminalWake::InputEnded) => self.end_input(),
                Ok(TerminalWake::WriteFailed(error)) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a write to the terminal failed"
                    );
                    self.queue.fail(error);
                }
                Ok(TerminalWake::ChildEvent) => {
                    if let Some(end) = self.control.take_child_exit(watch) {
                        return end;
                    }
                }
                Ok(TerminalWake::Woken | TerminalWake::Deadline) => {}
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn Error + 'static),
                        "the terminal's read or wait failed"
                    );
                    return LoopEnd::WaitFailed;
                }
            }
        }
    }

    /// Delivers what the terminal still holds once the program exited, until it stays quiet for
    /// `EXIT_QUIET_PERIOD` or `EXIT_DRAIN_BYTES` were read, then what the filter held, then
    /// reports the exit.
    async fn drain_to_exit(&mut self, watch: &mut TerminalWatch, status: Option<ExitStatus>) {
        self.end_input();
        let mut drained = 0;
        let mut quiet_until: Option<Instant> = None;
        loop {
            self.take_commands(watch);
            self.apply_stops();
            self.reserve_output();
            if self.output.is_none() {
                break;
            }
            let has_room = self.permit.is_some() && !self.control.is_paused();
            let is_reading_done = self.is_output_ended || drained >= EXIT_DRAIN_BYTES;
            if has_room && is_reading_done {
                self.kept.clear();
                self.filter.finish(&mut self.kept);
                self.deliver_kept();
                break;
            }
            // The quiet period runs only while the loop reads, so a pause does not end the output.
            let is_reading = has_room && !is_reading_done;
            quiet_until = is_reading
                .then(|| quiet_until.unwrap_or_else(|| Instant::now() + EXIT_QUIET_PERIOD));
            let read_limit = self
                .read_buffer
                .len()
                .min(EXIT_DRAIN_BYTES.saturating_sub(drained));
            let read_into = is_reading.then(|| &mut self.read_buffer[..read_limit]);
            match watch.wait(read_into, None, quiet_until).await {
                Ok(TerminalWake::Read(count)) => {
                    drained += count;
                    quiet_until = Some(Instant::now() + EXIT_QUIET_PERIOD);
                    self.take_read(count);
                }
                Ok(TerminalWake::OutputEnded) => self.is_output_ended = true,
                Ok(TerminalWake::Deadline) => {
                    if quiet_until.is_some_and(|quiet| Instant::now() >= quiet) {
                        self.is_output_ended = true;
                    }
                }
                Ok(
                    TerminalWake::Wrote(_)
                    | TerminalWake::InputEnded
                    | TerminalWake::WriteFailed(_)
                    | TerminalWake::ChildEvent
                    | TerminalWake::Woken,
                ) => {}
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn Error + 'static),
                        "the terminal's output could not be drained"
                    );
                    self.is_output_ended = true;
                }
            }
        }
        self.control.report_exit(TerminalExit::from_status(status));
    }

    /// Carries out every waiting resize, then takes waiting writes and answers while the queue has
    /// room, so a resize never waits behind writes.
    fn take_commands(&mut self, watch: &mut TerminalWatch) {
        while let Ok(ResizeCommand {
            rows,
            columns,
            answer,
        }) = self.resizes.try_recv()
        {
            let resized = self.resize(watch, rows, columns);
            if answer.send(resized).is_err() {
                tracing::debug!("a terminal resize's caller stopped waiting for its answer");
            }
        }
        self.queue.take_from(&mut self.writes);
    }

    fn resize(&self, watch: &mut TerminalWatch, rows: u16, columns: u16) -> io::Result<()> {
        watch.resize(rows, columns)?;
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
        // Set before the attempt, so a take between a full attempt and the wait still wakes it.
        self.control
            .is_waiting_for_room
            .store(true, Ordering::SeqCst);
        match output.clone().try_reserve_owned() {
            Ok(permit) => {
                self.control
                    .is_waiting_for_room
                    .store(false, Ordering::SeqCst);
                self.permit = Some(permit);
            }
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

    /// Draws what the filter kept and sends it to the caller, one buffer shared by the scrollback
    /// and the channel; nothing kept keeps the room.
    fn deliver_kept(&mut self) {
        if self.kept.is_empty() {
            return;
        }
        let permit = self
            .permit
            .take()
            .expect("output is read only while room for it is held");
        let chunk = Bytes::copy_from_slice(&self.kept);
        lock_screen(&self.screen).take_output(&mut self.processor, chunk.clone());
        permit.send(chunk);
    }

    /// Drops the output and its room, which closes the channel once the caller drained it.
    fn end_output(&mut self) {
        self.permit = None;
        self.output = None;
        self.control
            .is_waiting_for_room
            .store(false, Ordering::SeqCst);
    }
}

fn lock_screen<L: ScreenListener>(
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
