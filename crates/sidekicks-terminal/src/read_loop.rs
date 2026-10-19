//! Each shell's read loop: it reads the terminal's output into the screen copy and to the caller,
//! writes the caller's input in order, and reports the program's exit after its last output.

pub(crate) mod control;
pub(crate) mod output;
mod pause;
mod run;

use std::error::Error;
use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;

use sidekicks_platforms::{DOES_PAUSED_READ_HOLD_INPUT, TerminalInputRefusal, TerminalWaker};
use tokio::runtime::Handle;
use tokio::sync::{Semaphore, mpsc, watch};
use tracing::Instrument;
use vte::ansi::Processor;

use crate::input::answers::{ConsoleInputRead, TerminalAnswers};
use crate::input::queue::WriteQueue;
use crate::osc_limit::OscPayloadLimit;
use crate::pty::OpenedPty;
use crate::read_loop::control::{ChildState, ExitReport, TerminalControl};
use crate::read_loop::output::{OutputFilter, TerminalOutput};
use crate::read_loop::pause::PausedRead;
use crate::read_loop::run::ReadLoop;
use crate::screen::{ScreenListener, TerminalScreen};

/// How many of the caller's resizes wait for the loop before a caller waits for room.
const RESIZE_CAPACITY: usize = 4;

/// The most bytes read that wait for the caller, and the most one read takes: the loop reads only
/// into the room the waiting output leaves, so the screen and the caller see at most this much
/// ahead of the caller's takes.
const OUTPUT_BYTES: usize = 64 * 1024;

/// A shell whose read loop is running: its controls, its screen copy and its output.
pub(crate) struct StartedLoop<L: ScreenListener> {
    /// The controls the terminals drive the shell with.
    pub(crate) control: Arc<TerminalControl>,
    /// The screen copy and the scrollback window, under the lock the loop draws them with.
    pub(crate) screen: Arc<Mutex<TerminalScreen<L>>>,
    /// The shell's output, then its exit.
    pub(crate) output: TerminalOutput,
}

/// The shell's PTY until the loop takes it: a loop dropped before its first poll, or never run,
/// releases the PTY off the runtime's workers as the slot drops, so the drop never blocks a worker
/// on the program.
pub(super) struct PtySlot {
    opened: Option<OpenedPty>,
    name: String,
    control: Arc<TerminalControl>,
}

impl PtySlot {
    /// Takes the PTY, which the loop does once, at its first poll.
    pub(super) fn take(&mut self) -> OpenedPty {
        self.opened
            .take()
            .expect("the slot holds the PTY until the loop takes it")
    }
}

impl Drop for PtySlot {
    fn drop(&mut self) {
        let Some(opened) = self.opened.take() else {
            return;
        };
        let control = Arc::clone(&self.control);
        release_off_runtime(
            &self.name,
            Box::new(move || opened.release(|| control.mark_exited())),
        );
    }
}

/// A PTY's release, which may block until its program exits.
type Release = Box<dyn FnOnce() + Send>;

/// Starts the read loop of the shell in `opened` on `runtime`, its screen copy the one `screen`
/// makes from the shell's answers, every chunk of output passing `filter` first; `name` names the
/// loop in logs and threads, and `console_read`, where the system counts a console's waiting
/// input, reads the shell's console for its answers' rule.
/// Fails when the loop's waker or thread cannot be made; the PTY is then released off the
/// runtime's workers.
pub(crate) fn start_read_loop<L, F>(
    runtime: &Handle,
    name: &str,
    opened: OpenedPty,
    console_read: Option<ConsoleInputRead>,
    screen: impl FnOnce(TerminalAnswers) -> TerminalScreen<L>,
    filter: F,
) -> io::Result<StartedLoop<L>>
where
    L: ScreenListener,
    F: OutputFilter,
{
    let process_id = sidekicks_platforms::child_process_id(&opened.pty);
    let waker = match TerminalWaker::new() {
        Ok(waker) => waker,
        Err(error) => {
            // No control exists yet, so nothing can signal the program before its release.
            release_off_runtime(name, Box::new(move || opened.release(|| {})));
            return Err(error);
        }
    };
    let (writes, write_receiver) = mpsc::unbounded_channel();
    let answers = TerminalAnswers::new(writes.clone(), console_read, runtime);
    let (signal_keys, signal_key_receiver) = mpsc::unbounded_channel();
    let (resizes, resize_receiver) = mpsc::channel(RESIZE_CAPACITY);
    let control = Arc::new(TerminalControl {
        writes,
        signal_keys,
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
    let screen = Arc::new(Mutex::new(screen(answers)));
    let (output_sender, output_receiver) = mpsc::unbounded_channel();
    let read_loop = ReadLoop {
        name: name.to_owned(),
        control: Arc::clone(&control),
        screen: Arc::clone(&screen),
        filter,
        writes: write_receiver,
        signal_keys: signal_key_receiver,
        waiting_keys: Vec::new(),
        input_refusal: TerminalInputRefusal::new(),
        resizes: resize_receiver,
        processor: Processor::new(),
        queue: WriteQueue::new(),
        read_buffer: vec![0; OUTPUT_BYTES].into_boxed_slice(),
        osc_limit: OscPayloadLimit::new(),
        osc_cut: Vec::new(),
        kept: Vec::with_capacity(OUTPUT_BYTES),
        output: Some(output_sender),
        output_budget: Arc::new(Semaphore::new(OUTPUT_BYTES)),
        is_output_ended: false,
        has_closed: false,
        paused_read: PausedRead::new(DOES_PAUSED_READ_HOLD_INPUT),
    };
    let pty_slot = PtySlot {
        opened: Some(opened),
        name: name.to_owned(),
        control: Arc::clone(&control),
    };
    let span = tracing::info_span!("terminal read loop", terminal = name);
    // A loop that cannot start is dropped unpolled, and its slot releases the PTY.
    sidekicks_platforms::run_terminal_loop(
        runtime,
        name,
        read_loop.run(pty_slot).instrument(span),
    )?;
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
/// when no thread can start, it runs here, its wait bounded by the release's own grace and kill,
/// so the program still ends and nothing is left held.
pub(crate) fn release_off_runtime(name: &str, release: Release) {
    let slot = Arc::new(Mutex::new(Some(release)));
    let thread_slot = Arc::clone(&slot);
    let started = thread::Builder::new()
        .name(format!("{name} release"))
        .spawn(move || run_release(&thread_slot));
    if let Err(error) = started {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            terminal = name,
            "a terminal's release thread could not start, so the release runs in place"
        );
        run_release(&slot);
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
