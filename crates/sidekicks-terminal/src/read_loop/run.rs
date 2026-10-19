//! The read loop's run: it reads the terminal's output into the screen copy and to the caller
//! within the output's byte budget, writes the caller's input in order, and reports the program's
//! exit after its last output.

use std::error::Error;
use std::io;
use std::process::ExitStatus;
use std::sync::atomic::{Ordering, fence};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use bytes::Bytes;
use sidekicks_platforms::{TerminalInputRefusal, TerminalWake, TerminalWatch};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use vte::ansi::Processor;

use crate::exit::TerminalExit;
use crate::input::queue::{QueuedWrite, WriteQueue};
use crate::osc_limit::OscPayloadLimit;
use crate::pty::{OpenedPty, ShellHold};
use crate::read_loop::control::{ResizeCommand, SignalKey, TerminalControl};
use crate::read_loop::output::{OutputChunk, OutputFilter};
use crate::read_loop::pause::PausedRead;
use crate::read_loop::{PtySlot, release_off_runtime};
use crate::screen::{ScreenListener, TerminalScreen};

/// The most read after the program's exit, so a process left writing to the terminal cannot hold
/// the exit back.
const EXIT_DRAIN_BYTES: usize = 1024 * 1024;

/// How long the terminal stays quiet after the program's exit before its output counts as ended;
/// each read starts it again, since `ConPTY` reports no end of output.
const EXIT_QUIET_PERIOD: Duration = Duration::from_secs(1);

/// How the loop's watch over the program ended.
pub(super) enum LoopEnd {
    /// The program exited, with the status the system reported.
    ChildExited(Option<ExitStatus>),
    /// A read or the wait failed, so the loop can no longer watch the terminal.
    WaitFailed,
}

/// What one shell's read loop owns besides its watch.
pub(super) struct ReadLoop<L: ScreenListener, F> {
    pub(super) name: String,
    pub(super) control: Arc<TerminalControl>,
    pub(super) screen: Arc<Mutex<TerminalScreen<L>>>,
    pub(super) filter: F,
    pub(super) writes: mpsc::UnboundedReceiver<QueuedWrite>,
    pub(super) signal_keys: mpsc::UnboundedReceiver<SignalKey>,
    /// The keys handed over alone and neither written nor sent as their signals yet.
    pub(super) waiting_keys: Vec<SignalKey>,
    /// Set while the terminal refuses a waiting write, so a waiting key may go as its signal.
    pub(super) input_refusal: TerminalInputRefusal,
    pub(super) resizes: mpsc::Receiver<ResizeCommand>,
    pub(super) processor: Processor,
    pub(super) queue: WriteQueue,
    /// As large as the output's budget, so one read never outgrows the room it found.
    pub(super) read_buffer: Box<[u8]>,
    pub(super) osc_limit: OscPayloadLimit,
    /// What the OSC limit kept of a read it cut.
    pub(super) osc_cut: Vec<u8>,
    /// What the filter kept of the last read.
    pub(super) kept: Vec<u8>,
    /// The caller's output, gone once the close began, an exit was reported or the caller left.
    pub(super) output: Option<mpsc::UnboundedSender<OutputChunk>>,
    /// The bytes read that may wait for the caller, each chunk holding those read for it.
    pub(super) output_budget: Arc<Semaphore>,
    pub(super) is_output_ended: bool,
    pub(super) has_closed: bool,
    pub(super) paused_read: PausedRead,
}

impl<L, F> ReadLoop<L, F>
where
    L: ScreenListener,
    F: OutputFilter,
{
    pub(super) async fn run(mut self, mut pty_slot: PtySlot) {
        let OpenedPty { pty, hold } = pty_slot.take();
        let watch = match TerminalWatch::new(pty, &self.control.waker, &self.input_refusal) {
            Ok(watch) => watch,
            Err((error, pty)) => {
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    "the terminal could not be watched"
                );
                self.control.report_exit(TerminalExit::unconfirmed());
                self.end_output();
                let control = Arc::clone(&self.control);
                let opened = OpenedPty { pty: *pty, hold };
                release_off_runtime(
                    &self.name,
                    Box::new(move || opened.release(|| control.mark_exited())),
                );
                return;
            }
        };
        // Released as it drops, at the loop's end or when the runtime drops the loop midway.
        let mut held = HeldWatch {
            watch: Some(watch),
            hold: Some(hold),
            name: self.name.clone(),
            control: Arc::clone(&self.control),
        };
        let watch = held
            .watch
            .as_mut()
            .expect("the watch is held until the loop ends");
        match self.watch_child(watch).await {
            LoopEnd::ChildExited(status) => self.drain_to_exit(watch, status).await,
            LoopEnd::WaitFailed => {
                self.control.report_exit(TerminalExit::unconfirmed());
            }
        }
        // The report comes before the output's end, so the caller reads it once the output ends.
        self.end_output();
    }

    /// Reads, writes and serves commands until the program exits or a read or the wait fails.
    async fn watch_child(&mut self, watch: &mut TerminalWatch) -> LoopEnd {
        loop {
            self.take_commands(watch);
            self.apply_stops();
            let room = self.output_room();
            // Without an output the bytes are read and discarded, so a program that ignores the
            // close's hangup is not blocked on a full terminal.
            let can_read = !self.is_output_ended
                && room > 0
                && (self.output.is_none()
                    || !self.paused_read.is_read_held(
                        self.control.is_paused(),
                        self.queue.pending_bytes().is_some(),
                    ));
            // The screen copy draws a synchronized update's held output at each chunk's end, so no
            // update's deadline is waited on.
            let wake = watch
                .wait(
                    can_read.then(|| &mut self.read_buffer[..room]),
                    self.queue.pending_bytes(),
                    None,
                )
                .await;
            match wake {
                Ok(TerminalWake::Read(count)) => {
                    let (_, read) = self.take_burst(watch, count, room);
                    if let Err(error) = read {
                        return wait_failed(&error);
                    }
                }
                Ok(TerminalWake::OutputEnded) => self.is_output_ended = true,
                Ok(TerminalWake::Wrote(count)) => {
                    self.queue.advance(count);
                    self.paused_read.wrote();
                }
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
                Ok(TerminalWake::Woken | TerminalWake::Deadline | TerminalWake::InputRefused) => {}
                Err(error) => return wait_failed(&error),
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
            let room = self.output_room();
            if self.output.is_none() {
                break;
            }
            let has_room = room > 0 && !self.control.is_paused();
            let is_reading_done = self.is_output_ended || drained >= EXIT_DRAIN_BYTES;
            if has_room && is_reading_done {
                self.kept.clear();
                self.filter.finish(&mut self.kept);
                let room = self.take_room(0);
                self.deliver_kept(room);
                break;
            }
            // The quiet period runs only while the loop reads, so a pause does not end the output.
            let is_reading = has_room && !is_reading_done;
            quiet_until = is_reading
                .then(|| quiet_until.unwrap_or_else(|| Instant::now() + EXIT_QUIET_PERIOD));
            let read_limit = room.min(EXIT_DRAIN_BYTES.saturating_sub(drained));
            let read_into = is_reading.then(|| &mut self.read_buffer[..read_limit]);
            match watch.wait(read_into, None, quiet_until).await {
                Ok(TerminalWake::Read(count)) => {
                    let (count, read) = self.take_burst(watch, count, read_limit);
                    drained += count;
                    quiet_until = Some(Instant::now() + EXIT_QUIET_PERIOD);
                    if let Err(error) = read {
                        tracing::error!(
                            error = &error as &(dyn Error + 'static),
                            "the terminal's output could not be drained"
                        );
                        self.is_output_ended = true;
                    }
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
                    | TerminalWake::Woken
                    | TerminalWake::InputRefused,
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

    /// Carries out every waiting resize, sends each waiting key as its signal while the terminal
    /// refuses input, then takes waiting writes and answers while the queue has room, so a resize
    /// never waits behind writes and a signal key never waits behind refused input.
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
        while let Ok(key) = self.signal_keys.try_recv() {
            self.waiting_keys.push(key);
        }
        if self.input_refusal.is_refused() {
            for SignalKey { key, claim } in &self.waiting_keys {
                claim.send_as_signal(|| watch.send_signal_key(*key));
            }
            self.queue.drop_signaled_keys();
        }
        self.waiting_keys.retain(|key| !key.claim.is_settled());
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

    /// How many bytes the loop may read now: the room left in the output's budget, or the whole
    /// buffer without an output, whose bytes are discarded; a caller that left ends the output.
    fn output_room(&mut self) -> usize {
        let Some(output) = &self.output else {
            return self.read_buffer.len();
        };
        if output.is_closed() {
            self.end_output();
            return self.read_buffer.len();
        }
        // Set before the count, so a take between the count and the wait still wakes the loop: the
        // fence here and the one after the caller gives its room back are both sequentially
        // consistent, so either the count here sees the room or the caller sees the flag.
        self.control
            .is_waiting_for_room
            .store(true, Ordering::SeqCst);
        fence(Ordering::SeqCst);
        let room = self.output_budget.available_permits();
        if room > 0 {
            self.control
                .is_waiting_for_room
                .store(false, Ordering::SeqCst);
        }
        room
    }

    /// Reads on after a read of `count` bytes until a read would block or `limit` bytes are read,
    /// then delivers the burst once: the count delivered, and a failed read's error after it. A
    /// burst that finds the output empty confirms the writes the terminal took before it.
    fn take_burst(
        &mut self,
        watch: &mut TerminalWatch,
        count: usize,
        limit: usize,
    ) -> (usize, io::Result<()>) {
        let mut filled = count;
        let mut read = Ok(());
        while filled < limit {
            match watch.read_now(&mut self.read_buffer[filled..limit]) {
                Ok(0) => {
                    self.paused_read.found_output_empty();
                    break;
                }
                Ok(count) => filled += count,
                Err(error) => {
                    read = Err(error);
                    break;
                }
            }
        }
        self.take_read(filled);
        (filled, read)
    }

    /// Passes `count` read bytes through the OSC limit and the filter to the screen and the
    /// caller, holding their room in the budget, or discards them once the output has ended.
    fn take_read(&mut self, count: usize) {
        if self.output.is_none() {
            return;
        }
        let read = self
            .osc_limit
            .limit(&self.read_buffer[..count], &mut self.osc_cut);
        self.kept.clear();
        self.filter.filter(read, &mut self.kept);
        let room = self.take_room(count);
        self.deliver_kept(room);
    }

    /// Takes `count` bytes of the budget's room, which the loop found free before reading them.
    fn take_room(&self, count: usize) -> OwnedSemaphorePermit {
        let count = u32::try_from(count).expect("a read is never larger than the read buffer");
        Arc::clone(&self.output_budget)
            .try_acquire_many_owned(count)
            .expect("only the loop takes room, and it reads no more than it found free")
    }

    /// Draws what the filter kept and sends it to the caller with its `room`, one buffer shared
    /// by the scrollback and the channel; nothing kept gives the room back at once.
    fn deliver_kept(&mut self, room: OwnedSemaphorePermit) {
        if self.kept.is_empty() {
            return;
        }
        let Some(output) = &self.output else {
            return;
        };
        let bytes = Bytes::copy_from_slice(&self.kept);
        lock_screen(&self.screen).take_output(&mut self.processor, bytes.clone());
        if output.send(OutputChunk { bytes, room }).is_err() {
            self.end_output();
        }
    }

    /// Drops the output, which closes the channel once the caller drained it.
    fn end_output(&mut self) {
        self.output = None;
        self.control
            .is_waiting_for_room
            .store(false, Ordering::SeqCst);
    }
}

/// The loop's watch, released as it drops with its hold on the shell dropped after it: in
/// place once the program was reaped, otherwise on a thread of its own, since the release waits
/// for the program; so a loop the runtime drops midway still ends its program without blocking a
/// worker.
struct HeldWatch {
    watch: Option<TerminalWatch>,
    hold: Option<ShellHold>,
    name: String,
    control: Arc<TerminalControl>,
}

impl Drop for HeldWatch {
    fn drop(&mut self) {
        let Some(watch) = self.watch.take() else {
            return;
        };
        let hold = self.hold.take();
        let control = Arc::clone(&self.control);
        let release = move || {
            watch.release(|| control.mark_exited());
            drop(hold);
        };
        if self.control.has_child_exited() {
            release();
        } else {
            release_off_runtime(&self.name, Box::new(release));
        }
    }
}

fn lock_screen<L: ScreenListener>(
    screen: &Mutex<TerminalScreen<L>>,
) -> MutexGuard<'_, TerminalScreen<L>> {
    screen
        .lock()
        .expect("no panic holds a terminal's lock, since a panic ends the daemon")
}

/// Logs the read or wait that failed and ends the loop's watch.
fn wait_failed(error: &io::Error) -> LoopEnd {
    tracing::error!(
        error = error as &(dyn Error + 'static),
        "the terminal's read or wait failed"
    );
    LoopEnd::WaitFailed
}
