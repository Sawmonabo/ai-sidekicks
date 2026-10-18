//! A shell's controls, which the terminals drive it with and its read loop serves.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use sidekicks_platforms::{TerminalSignal, TerminalWaker, TerminalWatch};
use tokio::sync::{mpsc, oneshot, watch};

use crate::exit::TerminalExit;
use crate::input::queue::{QueuedWrite, SignalKeyClaim, TerminalWriteError, WriteIntake};
use crate::read_loop::run::LoopEnd;

/// A caller's resize the loop carries out on the terminal and its screen copy.
pub(super) struct ResizeCommand {
    pub(super) rows: u16,
    pub(super) columns: u16,
    pub(super) answer: oneshot::Sender<io::Result<()>>,
}

/// A key handed over alone, sent to the read loop beside its place in line, so the loop may send
/// it as its signal while it waits.
pub(super) struct SignalKey {
    pub(super) key: u8,
    pub(super) claim: Arc<SignalKeyClaim>,
}

/// Whether the program's exit has been reported, and which.
pub(super) enum ExitReport {
    Pending,
    Reported(TerminalExit),
}

/// What the loop knows of the program.
pub(super) struct ChildState {
    pub(super) has_exited: bool,
}

/// One shell's controls, shared by the terminals and the shell's read loop.
pub(crate) struct TerminalControl {
    pub(super) writes: WriteIntake,
    /// The keys handed over alone, each also in line in the intake.
    pub(super) signal_keys: mpsc::UnboundedSender<SignalKey>,
    pub(super) resizes: mpsc::Sender<ResizeCommand>,
    pub(super) waker: TerminalWaker,
    pub(super) is_paused: AtomicBool,
    /// Set by a write handed over while paused, until a read after it finds the output empty: a
    /// paused read that would hold the program's input back reads on meanwhile.
    pub(super) has_write_since_pause: AtomicBool,
    pub(super) is_closing: AtomicBool,
    /// Set while the loop finds no room for output, so the caller's next take wakes it.
    pub(super) is_waiting_for_room: AtomicBool,
    pub(super) process_id: Option<u32>,
    /// Held across the program's reap and its mark as exited, and across each signal sent to it,
    /// so no signal sent here reaches its process id once the reap has freed it.
    pub(super) child_state: Mutex<ChildState>,
    pub(super) child_exit: watch::Sender<bool>,
    /// Held while the closing flag is set, so no exit is reported once the close begins.
    pub(super) exit_report: Mutex<ExitReport>,
    pub(super) exit_reported: watch::Sender<bool>,
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
    /// does while the queue holds fewer than 64 KiB. One key the terminal's settings turn into a
    /// signal (interrupt, quit, suspend), handed over alone and still unwritten while the terminal
    /// refuses input, goes as that signal instead, so it reaches a program that reads none of its
    /// input, and is answered taken once sent; any other key is written in line. Fails at once with
    /// `Closed` once the close began and `Ended` once the read loop is gone; the answer fails the
    /// same way when the close or the input's end comes before the take.
    pub(crate) fn queue_write(
        self: &Arc<Self>,
        bytes: Bytes,
    ) -> Result<WriteTaken, TerminalWriteError> {
        let (taken, answer) = oneshot::channel();
        let write_taken = WriteTaken {
            answer,
            control: Arc::clone(self),
        };
        if self.is_closing() {
            return Err(TerminalWriteError::Closed);
        }
        if let [key] = bytes[..] {
            let claim = SignalKeyClaim::new(taken);
            self.hand_over(QueuedWrite::signal_key(key, Arc::clone(&claim)))?;
            if self.signal_keys.send(SignalKey { key, claim }).is_err() {
                tracing::debug!("a key came as the terminal's read loop ended");
            }
        } else {
            self.hand_over(QueuedWrite::awaiting_take(bytes, taken))?;
        }
        Ok(write_taken)
    }

    /// Puts `write` in the intake and wakes the loop to take it.
    fn hand_over(&self, write: QueuedWrite) -> Result<(), TerminalWriteError> {
        if self.is_closing() {
            return Err(TerminalWriteError::Closed);
        }
        if self.writes.send(write).is_err() {
            return Err(self.ended_write_error());
        }
        if self.is_paused() {
            self.has_write_since_pause.store(true, Ordering::SeqCst);
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
        self.has_write_since_pause.store(false, Ordering::SeqCst);
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

    pub(super) fn is_closing(&self) -> bool {
        self.is_closing.load(Ordering::SeqCst)
    }

    pub(super) fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    pub(super) fn reported_exit(&self) -> Option<TerminalExit> {
        match *self.lock_exit_report() {
            ExitReport::Pending => None,
            ExitReport::Reported(exit) => Some(exit),
        }
    }

    /// Reports `exit` unless the close began or an exit was reported; answers whether it did.
    pub(super) fn report_exit(&self, exit: TerminalExit) -> bool {
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
    pub(super) fn take_child_exit(&self, watch: &mut TerminalWatch) -> Option<LoopEnd> {
        let mut child_state = self.lock_child_state();
        let status = watch.take_child_exit()?;
        child_state.has_exited = true;
        drop(child_state);
        self.child_exit.send_replace(true);
        Some(LoopEnd::ChildExited(status))
    }

    /// Marks the program exited under the signal lock, for a release that waited for it.
    pub(super) fn mark_exited(&self) {
        self.lock_child_state().has_exited = true;
        self.child_exit.send_replace(true);
    }

    /// The error a write gets once the loop is gone: the input ended with the program, or the
    /// terminal closed.
    pub(super) fn ended_write_error(&self) -> TerminalWriteError {
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
    pub(super) answer: oneshot::Receiver<Result<(), TerminalWriteError>>,
    pub(super) control: Arc<TerminalControl>,
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

/// The error a resize gets once the read loop has ended.
pub(super) fn loop_ended_error() -> io::Error {
    io::Error::other("the terminal's read loop has ended")
}
