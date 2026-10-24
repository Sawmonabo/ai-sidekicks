//! The write queue: the one task that owns the writer's queue. It takes every message the
//! writer's handles send, in the order they sent them, admits writes up to the queue's cap and
//! keeps the rest waiting in order, sends the thread one batch, checkpoint or repack at a time,
//! beside at most one copy, settles each write from the thread's answer, and closes the writer. A
//! batch holds whatever has been sent when the thread is free, so writes that arrive during a
//! commit form the next one.

use std::collections::VecDeque;
use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::oneshot::error::RecvError;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::cleanup_failures::CleanupFailures;
use crate::database::checkpoint::CheckpointMode;
use crate::database::writer::backpressure::BackpressureAlert;
use crate::database::writer::messages::{
    BatchAnswer, BatchFailure, CommittedBatch, FailedBatch, ThreadExit, ThreadRequest, WriteJob,
    WriteJobOutcome,
};
use crate::database::writer::queue::maintenance::{
    CancelableWork, MaintenanceAnswered, MaintenanceSlots,
};
use crate::database::writer::{
    CloseOutcome, CommitHook, CommittedWrite, DatabaseWriterOptions, EndReason, MaintenanceError,
    QueueMessage, StopKind, ThreadJoinError, WRITE_QUEUE_CAPACITY, WriteError,
    WriteFailureListener, WriteRequest, WriterCloseError, WriterShared, WritesHeldError,
    is_interrupt, join_thread,
};

mod maintenance;

/// The most entries a batch holds; a larger write goes whole and alone.
const BATCH_ENTRY_LIMIT: usize = 50;

const CLOSE_OPERATION: &str = "closing the database writer";

/// The queue's ends of the writer's thread: where its requests go, its exit answer, and its
/// handle to join, absent for a task standing in for the thread.
pub(super) struct ThreadLink {
    /// Where the queue sends the thread its one request at a time.
    pub(super) requests: mpsc::Sender<ThreadRequest>,
    /// The thread's last answer, as it exits.
    pub(super) exit: oneshot::Receiver<ThreadExit>,
    /// The thread, joined once it has answered its exit.
    pub(super) join: Option<std::thread::JoinHandle<()>>,
}

/// The one task that owns the writer's queue; [`WriteQueue::run`] runs it until the writer has
/// closed.
pub(super) struct WriteQueue {
    messages: mpsc::UnboundedReceiver<QueueMessage>,
    /// Whether any handle may still send; once none can, the writer closes.
    is_receiving: bool,
    /// Dropped to let the thread close its connection and exit.
    thread: Option<mpsc::Sender<ThreadRequest>>,
    thread_exit: Option<oneshot::Receiver<ThreadExit>>,
    thread_join: Option<std::thread::JoinHandle<()>>,
    thread_outcome: Option<Result<(), CleanupFailures<WriterCloseError, ThreadJoinError>>>,
    shared: Arc<WriterShared>,
    on_write_failed: Option<WriteFailureListener>,
    commits: watch::Sender<u64>,
    close_outcome: watch::Sender<Option<CloseOutcome>>,
    /// The hold the writer was opened with, until it answers.
    writes_held_until: Option<oneshot::Receiver<Result<(), WritesHeldError>>>,
    /// The ticket the next write takes; tickets follow arrival order, and so does settling.
    next_ticket: u64,
    /// Admitted writes not yet sent, oldest first.
    queued: VecDeque<QueuedWrite>,
    /// Writes past the cap, admitted oldest first as room frees.
    waiting: VecDeque<QueuedWrite>,
    /// Entries admitted, queued or in flight.
    depth: usize,
    /// Entries of the writes waiting past the cap.
    waiting_size: usize,
    /// Entries queued and not yet sent.
    queued_size: usize,
    batch: Option<InFlightBatch>,
    maintenance: MaintenanceSlots,
    backpressure: BackpressureAlert,
    flushes: VecDeque<PendingFlush>,
    pending_holds: VecDeque<PendingHold>,
    active_holds: Vec<u64>,
    closing: Option<Closing>,
}

/// A write's caller as the queue keeps it while the write is queued or in flight.
struct Waiter {
    ticket: u64,
    /// The entries the write counts for against the cap and a batch.
    size: usize,
    on_commit: Option<CommitHook>,
    reply: oneshot::Sender<Result<CommittedWrite, WriteError>>,
}

struct QueuedWrite {
    job: WriteJob,
    waiter: Waiter,
}

struct InFlightBatch {
    waiters: Vec<Waiter>,
    answer: oneshot::Receiver<BatchAnswer>,
}

/// A flush, answered once every write before `ticket` has settled.
struct PendingFlush {
    ticket: u64,
    reply: oneshot::Sender<()>,
}

/// A hold, started once every write before `ticket` has settled and nothing is in flight.
struct PendingHold {
    id: u64,
    ticket: u64,
    started: oneshot::Sender<()>,
}

struct Closing {
    /// When the drain gives up, for a close given a bound.
    deadline: Option<Instant>,
    is_past_bound: bool,
    /// The writes the close itself failed: held, unsent at the bound, or in flight and not
    /// committed at the bound.
    unfinished: usize,
}

/// What woke the queue.
enum Wake {
    BatchAnswered(Result<BatchAnswer, RecvError>),
    MaintenanceAnswered(MaintenanceAnswered),
    RepackCanceled,
    ThreadExited(Result<ThreadExit, RecvError>),
    DrainBoundPassed,
    HoldEnded(Result<Result<(), WritesHeldError>, RecvError>),
    Message(Option<QueueMessage>),
}

/// The writer's thread stopped while the queue still had it serving.
#[derive(Debug, thiserror::Error)]
#[error("the database writer's thread stopped on its own")]
struct ThreadStopped;

impl WriteQueue {
    /// A queue over `messages` and the writer's `thread`, publishing on `commits` the thread's
    /// count of the batches that committed a write and its close on `close_outcome`.
    pub(super) fn new(
        messages: mpsc::UnboundedReceiver<QueueMessage>,
        thread: ThreadLink,
        shared: Arc<WriterShared>,
        options: DatabaseWriterOptions,
        commits: watch::Sender<u64>,
        close_outcome: watch::Sender<Option<CloseOutcome>>,
    ) -> Self {
        Self {
            messages,
            is_receiving: true,
            thread: Some(thread.requests),
            thread_exit: Some(thread.exit),
            thread_join: thread.join,
            thread_outcome: None,
            shared,
            on_write_failed: options.on_write_failed,
            commits,
            close_outcome,
            writes_held_until: options.writes_held_until,
            next_ticket: 0,
            queued: VecDeque::new(),
            waiting: VecDeque::new(),
            depth: 0,
            waiting_size: 0,
            queued_size: 0,
            batch: None,
            maintenance: MaintenanceSlots::default(),
            backpressure: BackpressureAlert::default(),
            flushes: VecDeque::new(),
            pending_holds: VecDeque::new(),
            active_holds: Vec::new(),
            closing: None,
        }
    }

    /// Serves the writer until it has closed and its thread has exited and been joined, then
    /// answers what is still sent with the writer closed.
    pub(super) async fn run(mut self) {
        let thread_outcome = loop {
            self.advance();
            if self.closing.is_some()
                && let Some(thread_outcome) = self.thread_outcome.take()
            {
                break thread_outcome;
            }
            let wake = self.next_wake().await;
            self.handle(wake).await;
        };
        self.finish_close(thread_outcome).await;
    }

    async fn next_wake(&mut self) -> Wake {
        let drain_bound = self.drain_bound();
        let repack_cancel = self.maintenance.uninterrupted_repack_cancel();
        // The thread's answers come first, so a batch settles before its thread's exit is read,
        // and a repack that answered is never interrupted.
        tokio::select! {
            biased;
            answer = output_of(self.batch.as_mut().map(|batch| &mut batch.answer)) => {
                Wake::BatchAnswered(answer)
            }
            answered = self.maintenance.answered(), if self.maintenance.is_running() => {
                Wake::MaintenanceAnswered(answered)
            }
            () = output_of(repack_cancel.as_ref().map(CancellationToken::cancelled)) => {
                Wake::RepackCanceled
            }
            exit = output_of(self.thread_exit.as_mut()) => Wake::ThreadExited(exit),
            () = output_of(drain_bound.map(tokio::time::sleep_until)) => Wake::DrainBoundPassed,
            held = output_of(self.writes_held_until.as_mut()) => Wake::HoldEnded(held),
            message = self.messages.recv(), if self.is_receiving => Wake::Message(message),
        }
    }

    async fn handle(&mut self, wake: Wake) {
        match wake {
            Wake::BatchAnswered(answer) => {
                let batch = self
                    .batch
                    .take()
                    .expect("a batch is answered only while it is in flight");
                self.settle_batch(batch.waiters, answer);
            }
            Wake::MaintenanceAnswered(answered) => self.settle_maintenance_answer(answered),
            Wake::RepackCanceled => {
                // Nothing but the repack runs on the thread while it is in flight.
                if self.maintenance.mark_repack_interrupted() {
                    self.shared.interrupt_thread();
                }
            }
            Wake::ThreadExited(exit) => self.thread_exited(exit).await,
            Wake::DrainBoundPassed => self.stop_at_drain_bound(),
            Wake::HoldEnded(held) => self.hold_ended(held),
            Wake::Message(Some(message)) => {
                self.receive(message);
                // The messages already sent are taken before the next batch goes, so writes sent
                // back to back go out together; only those, so a flood never holds off an answer.
                for _ in 0..self.messages.len() {
                    let Ok(message) = self.messages.try_recv() else {
                        break;
                    };
                    self.receive(message);
                }
            }
            Wake::Message(None) => {
                // Every handle is gone: the writer closes as an unbounded close does.
                self.is_receiving = false;
                self.start_close(None);
            }
        }
    }

    fn receive(&mut self, message: QueueMessage) {
        match message {
            QueueMessage::Write(request) => self.take_write(request),
            QueueMessage::Flush(reply) => self.flushes.push_back(PendingFlush {
                ticket: self.next_ticket,
                reply,
            }),
            QueueMessage::Hold { id, started } => self.pending_holds.push_back(PendingHold {
                id,
                ticket: self.next_ticket,
                started,
            }),
            QueueMessage::Release(id) => {
                self.pending_holds.retain(|hold| hold.id != id);
                self.active_holds.retain(|held| *held != id);
            }
            QueueMessage::Checkpoint { mode, reply } => match self.maintenance_refusal() {
                Some(refusal) => send_answer(reply, Err(refusal)),
                None if mode == CheckpointMode::Passive
                    && (self.writes_held_until.is_some() || !self.active_holds.is_empty()) =>
                {
                    send_answer(reply, Err(MaintenanceError::Held));
                }
                None => self.maintenance.take_checkpoint(mode, reply),
            },
            QueueMessage::Repack { cancel, reply } => match self.maintenance_refusal() {
                Some(refusal) => send_answer(reply, Err(refusal)),
                None => self
                    .maintenance
                    .take_repack(CancelableWork { cancel, reply }),
            },
            QueueMessage::Backup {
                destination,
                cancel,
                reply,
            } => match self.maintenance_refusal() {
                Some(refusal) => send_answer(reply, Err(refusal)),
                None => self
                    .maintenance
                    .take_backup(destination, CancelableWork { cancel, reply }),
            },
            QueueMessage::End => self.end_writes(),
            QueueMessage::Close { drain_within } => self.start_close(drain_within),
        }
    }

    /// Admits a write when nothing waits ahead of it and it fits under the cap; otherwise it waits
    /// in order. Either way the queue's depth is checked for the backpressure warning.
    fn take_write(&mut self, request: WriteRequest) {
        let WriteRequest {
            job,
            size,
            on_commit,
            reply,
        } = request;
        if let Some(reason) = self.shared.end_reason() {
            send_answer(reply, Err(WriteError::Ended(reason)));
            return;
        }
        if self.closing.is_some() {
            send_answer(reply, Err(WriteError::Closed));
            return;
        }
        self.backpressure
            .check_admission(self.depth + self.waiting_size, size, &job);
        let write = QueuedWrite {
            job,
            waiter: Waiter {
                ticket: self.next_ticket,
                size,
                on_commit,
                reply,
            },
        };
        self.next_ticket += 1;
        if self.waiting.is_empty() && self.depth + size <= WRITE_QUEUE_CAPACITY {
            self.admit(write);
        } else {
            self.waiting_size += size;
            self.waiting.push_back(write);
        }
    }

    fn admit(&mut self, write: QueuedWrite) {
        self.depth += write.waiter.size;
        self.queued_size += write.waiter.size;
        self.queued.push_back(write);
    }

    fn admit_waiting(&mut self) {
        while let Some(write) = self.waiting.pop_front() {
            if self.depth + write.waiter.size > WRITE_QUEUE_CAPACITY {
                self.waiting.push_front(write);
                break;
            }
            self.waiting_size -= write.waiter.size;
            self.admit(write);
        }
    }

    /// The oldest ticket not yet settled: in flight, then queued, then waiting, which hold their
    /// tickets in that order; the next ticket when every write has settled.
    fn oldest_unsettled_ticket(&self) -> u64 {
        self.batch
            .as_ref()
            .and_then(|batch| batch.waiters.first())
            .or_else(|| self.queued.front().map(|write| &write.waiter))
            .or_else(|| self.waiting.front().map(|write| &write.waiter))
            .map_or(self.next_ticket, |waiter| waiter.ticket)
    }

    /// Answers what has come due and sends the thread its next request when none is in flight: a
    /// hold whose writes have settled starts first, then a checkpoint, then a repack, then
    /// whatever is queued, and none of them goes while the writer holds its writes. A close whose
    /// writes have all settled lets the thread go.
    fn advance(&mut self) {
        self.answer_settled_flushes();
        if self.is_thread_busy() {
            return;
        }
        self.start_ready_holds();
        if !self.active_holds.is_empty() {
            return;
        }
        // An end read inside a settle has not reached the queue yet, but sends nothing more.
        if self.thread.is_none() || self.shared.end_reason().is_some() {
            return;
        }
        if self.closing.is_some() && self.queued.is_empty() && self.waiting.is_empty() {
            self.release_thread();
            return;
        }
        if self.writes_held_until.is_some() {
            return;
        }
        let thread = self.thread.as_ref();
        if self
            .maintenance
            .send_next(|request| send_to_thread(thread, request))
        {
            return;
        }
        if !self.queued.is_empty() {
            self.send_batch();
        }
    }

    fn answer_settled_flushes(&mut self) {
        let oldest = self.oldest_unsettled_ticket();
        while let Some(flush) = self.flushes.pop_front() {
            if flush.ticket > oldest {
                self.flushes.push_front(flush);
                break;
            }
            send_answer(flush.reply, ());
        }
    }

    /// Starts each hold whose writes have settled; a passive checkpoint queued then fails at once
    /// rather than wait the hold out.
    fn start_ready_holds(&mut self) {
        let oldest = self.oldest_unsettled_ticket();
        while let Some(hold) = self.pending_holds.pop_front() {
            if hold.ticket > oldest {
                self.pending_holds.push_front(hold);
                break;
            }
            self.active_holds.push(hold.id);
            send_answer(hold.started, ());
        }
        if !self.active_holds.is_empty() {
            self.maintenance.refuse_passive_checkpoints();
        }
    }

    /// Sends the oldest queued writes up to the batch limit, and always at least one, so a write
    /// larger than the limit goes whole and alone.
    fn send_batch(&mut self) {
        let mut batch_size = 0;
        let mut jobs = Vec::new();
        let mut waiters = Vec::new();
        while let Some(write) = self.queued.pop_front() {
            if !waiters.is_empty() && batch_size + write.waiter.size > BATCH_ENTRY_LIMIT {
                self.queued.push_front(write);
                break;
            }
            batch_size += write.waiter.size;
            jobs.push(write.job);
            waiters.push(write.waiter);
        }
        self.queued_size -= batch_size;
        let (reply, answer) = oneshot::channel();
        send_to_thread(self.thread.as_ref(), ThreadRequest::Batch { jobs, reply });
        self.batch = Some(InFlightBatch { waiters, answer });
    }

    /// Whether the thread runs a request it serves nothing beside: a batch, a checkpoint or a
    /// repack; a copy serves the requests that come while it lives.
    fn is_thread_busy(&self) -> bool {
        self.batch.is_some() || self.maintenance.holds_thread()
    }

    /// Why maintenance asked for now is refused: the writer ended or closing; `None` to queue it.
    fn maintenance_refusal(&self) -> Option<MaintenanceError> {
        if let Some(reason) = self.shared.end_reason() {
            Some(MaintenanceError::Ended(reason))
        } else if self.closing.is_some() {
            Some(MaintenanceError::Closed)
        } else {
            None
        }
    }

    /// Settles a batch from the thread's answer: committed writes run their hooks in order first,
    /// then the thread's commit count is published, then every caller hears; then waiting writes
    /// take the room.
    fn settle_batch(&mut self, waiters: Vec<Waiter>, answer: Result<BatchAnswer, RecvError>) {
        self.depth -= waiters.iter().map(|waiter| waiter.size).sum::<usize>();
        match answer {
            Ok(Ok(committed)) => self.settle_committed_batch(waiters, committed),
            Ok(Err(failure)) => self.settle_failed_batch(waiters, *failure),
            Err(_unanswered) => {
                let reason = self.end_writer(Arc::new(ThreadStopped));
                self.count_unfinished_at_bound(waiters.len());
                for waiter in waiters {
                    send_answer(waiter.reply, Err(WriteError::Ended(Arc::clone(&reason))));
                }
            }
        }
        self.admit_waiting();
    }

    fn settle_committed_batch(&mut self, waiters: Vec<Waiter>, committed: CommittedBatch) {
        let CommittedBatch {
            outcomes,
            commit_count,
            after_commit_failure,
        } = committed;
        if let Some(failure) = &after_commit_failure {
            self.report_failure(failure);
        }
        let mut outcomes = outcomes.into_iter();
        let mut settled: Vec<(Waiter, WriteJobOutcome)> = waiters
            .into_iter()
            .map(|waiter| {
                let outcome = outcomes
                    .next()
                    .expect("the thread answers one outcome per write");
                (waiter, outcome)
            })
            .collect();
        for (waiter, outcome) in &mut settled {
            if let WriteJobOutcome::Committed { sequences, .. } = outcome
                && let Some(on_commit) = waiter.on_commit.take()
            {
                on_commit(sequences.as_slice());
            }
        }
        self.commits.send_if_modified(|count| {
            let is_raised = *count != commit_count;
            *count = commit_count;
            is_raised
        });
        for (waiter, outcome) in settled {
            let result = match outcome {
                WriteJobOutcome::Committed {
                    statement_results,
                    sequences,
                } => Ok(CommittedWrite {
                    statement_results,
                    sequences,
                }),
                WriteJobOutcome::Refused {
                    statement_index,
                    row_count,
                } => Err(WriteError::Refused {
                    statement_index,
                    row_count,
                }),
                WriteJobOutcome::Failed(failure) => {
                    self.report_failure(&failure);
                    Err(WriteError::Failed(failure))
                }
            };
            send_answer(waiter.reply, result);
        }
    }

    /// Settles a batch that did not commit: each failure SQLite raised in it is reported first,
    /// the writes that failed alone before it among them, then every caller hears.
    fn settle_failed_batch(&mut self, waiters: Vec<Waiter>, failed: FailedBatch) {
        self.count_unfinished_at_bound(waiters.len());
        let FailedBatch {
            failure,
            earlier_write_failures,
        } = failed;
        for earlier_write_failure in &earlier_write_failures {
            self.report_unless_interrupted(earlier_write_failure);
        }
        let is_stopped = match failure.original() {
            BatchFailure::Stopped => true,
            BatchFailure::Begin(_)
            | BatchFailure::TransactionEnded { .. }
            | BatchFailure::SavepointNotEnded { .. }
            | BatchFailure::Commit(_) => false,
        };
        if is_stopped {
            // The writer's own stop rolled the batch back, so each write fails as the stop's do;
            // a rollback that failed is still reported.
            for cleanup_failure in failure.cleanup_failures() {
                self.report_unless_interrupted(cleanup_failure);
            }
            let reason = self.shared.end_reason();
            for waiter in waiters {
                let error = match &reason {
                    Some(reason) => WriteError::Ended(Arc::clone(reason)),
                    None => WriteError::ClosedAtDrainBound,
                };
                send_answer(waiter.reply, Err(error));
            }
            return;
        }
        let failure = Arc::new(failure);
        self.report_failure(failure.as_ref());
        for waiter in waiters {
            send_answer(
                waiter.reply,
                Err(WriteError::BatchFailed(Arc::clone(&failure))),
            );
        }
    }

    fn report_failure(&self, failure: &(dyn Error + 'static)) {
        if let Some(on_write_failed) = &self.on_write_failed {
            on_write_failed(failure);
        }
    }

    /// Reports `failure` unless it is the stop's own interrupt, which says nothing of the file.
    fn report_unless_interrupted(&self, failure: &(dyn Error + 'static)) {
        if !(self.shared.stop.is_stopped() && is_interrupt(failure)) {
            self.report_failure(failure);
        }
    }

    /// A close past its bound counts the in-flight writes its stop kept from committing.
    fn count_unfinished_at_bound(&mut self, count: usize) {
        if let Some(closing) = &mut self.closing
            && closing.is_past_bound
        {
            closing.unfinished += count;
        }
    }

    /// Ends the writer with `reason` unless it was ended already, and returns the reason it
    /// ended with.
    fn end_writer(&mut self, reason: EndReason) -> EndReason {
        self.shared.end(Arc::clone(&reason));
        self.end_writes();
        self.shared.end_reason().unwrap_or(reason)
    }

    /// Fails every write, checkpoint and repack not yet sent with the end's reason and lets the
    /// thread go; the batch in flight settles from the thread's answer.
    fn end_writes(&mut self) {
        let Some(reason) = self.shared.end_reason() else {
            return;
        };
        self.writes_held_until = None;
        self.fail_unsent(|| WriteError::Ended(Arc::clone(&reason)));
        self.maintenance
            .fail_unsent(|| MaintenanceError::Ended(Arc::clone(&reason)));
        self.release_thread();
    }

    /// Lets the thread go: it wakes from its wait, or finishes its request, then closes its
    /// connection and exits. A stop after this no longer interrupts it.
    fn release_thread(&mut self) {
        self.shared
            .is_thread_released
            .store(true, Ordering::Release);
        self.thread = None;
    }

    /// Fails every queued and waiting write with `error` and returns how many there were.
    fn fail_unsent(&mut self, error: impl Fn() -> WriteError) -> usize {
        let mut count = 0;
        for write in self.queued.drain(..) {
            self.depth -= write.waiter.size;
            send_answer(write.waiter.reply, Err(error()));
            count += 1;
        }
        for write in self.waiting.drain(..) {
            send_answer(write.waiter.reply, Err(error()));
            count += 1;
        }
        self.waiting_size = 0;
        self.queued_size = 0;
        count
    }

    fn hold_ended(&mut self, held: Result<Result<(), WritesHeldError>, RecvError>) {
        self.writes_held_until = None;
        let refusal = match held {
            Ok(Ok(())) => return,
            Ok(Err(refusal)) => refusal,
            Err(_dropped) => WritesHeldError::Dropped,
        };
        // No held write is sent to a file whose holder did not let them go.
        self.end_writer(Arc::new(refusal));
    }

    /// Starts the close: no new write is taken, held writes fail at once, and the queued ones
    /// drain as fast as the thread takes them.
    fn start_close(&mut self, drain_within: Option<Duration>) {
        if self.closing.is_some() {
            return;
        }
        let mut unfinished = 0;
        if self.writes_held_until.take().is_some() {
            // No one lets held writes go once the writer closes.
            unfinished = self.fail_unsent(|| WriteError::ClosedWhileHeld);
        }
        self.maintenance.fail_unsent(|| MaintenanceError::Closed);
        self.closing = Some(Closing {
            deadline: drain_within.map(|bound| Instant::now() + bound),
            is_past_bound: false,
            unfinished,
        });
    }

    /// When a bounded close gives up its drain; none once it has, or once the thread is gone.
    fn drain_bound(&self) -> Option<Instant> {
        self.closing
            .as_ref()
            .filter(|closing| !closing.is_past_bound && self.thread.is_some())
            .and_then(|closing| closing.deadline)
    }

    /// The drain bound passed: the thread stops the batch it runs, which rolls back unless its
    /// commit already ran, the unsent writes fail, and the thread is let go.
    fn stop_at_drain_bound(&mut self) {
        self.shared.stop.stop(StopKind::DrainBound);
        // With nothing running, an interrupt would stay pending and cut the closing checkpoint
        // short.
        if self.batch.is_some() || self.maintenance.is_running() {
            self.shared.stop.cut_at_bound();
            self.shared.interrupt_thread();
        }
        let unsent = self.fail_unsent(|| WriteError::ClosedAtDrainBound);
        if let Some(closing) = &mut self.closing {
            closing.is_past_bound = true;
            closing.unfinished += unsent;
        }
        self.release_thread();
    }

    /// The thread answered its exit: it is joined, and what its close and join reported is kept
    /// for the close to return.
    async fn thread_exited(&mut self, exit: Result<ThreadExit, RecvError>) {
        self.thread_exit = None;
        if self.thread.is_some() {
            // The queue had not let the thread go: it stopped on its own.
            self.end_writer(Arc::new(ThreadStopped));
        }
        let exit = match exit {
            Ok(Ok(())) => Ok(()),
            Ok(Err(failure)) => Err(WriterCloseError::Connection(failure)),
            Err(_unanswered) => Err(WriterCloseError::ThreadLost),
        };
        let joined = match self.thread_join.take() {
            Some(thread) => join_thread(thread).await,
            None => Ok(()),
        };
        self.thread_outcome = Some(match (exit, joined) {
            (Ok(()), Ok(())) => Ok(()),
            (Ok(()), Err(join_failure)) => Err(CleanupFailures::new(
                WriterCloseError::Join(join_failure),
                Vec::new(),
                CLOSE_OPERATION,
            )),
            (Err(failure), joined) => Err(CleanupFailures::new(
                failure,
                joined.err().into_iter().collect(),
                CLOSE_OPERATION,
            )),
        });
    }

    /// Publishes the close's outcome, then stops taking messages and answers each one still sent
    /// with the writer closed.
    async fn finish_close(
        mut self,
        thread_outcome: Result<(), CleanupFailures<WriterCloseError, ThreadJoinError>>,
    ) {
        let unfinished = self
            .closing
            .as_ref()
            .map_or(0, |closing| closing.unfinished);
        let outcome = thread_outcome.map(|()| unfinished).map_err(Arc::new);
        self.close_outcome
            .send_modify(|close_outcome| *close_outcome = Some(outcome));
        self.messages.close();
        while let Some(message) = self.messages.recv().await {
            match message {
                QueueMessage::Write(request) => {
                    send_answer(request.reply, Err(WriteError::Closed));
                }
                QueueMessage::Flush(reply) => send_answer(reply, ()),
                // Nothing reaches the file any more, so a hold holds at once.
                QueueMessage::Hold { started, .. } => send_answer(started, ()),
                QueueMessage::Checkpoint { reply, .. } => {
                    send_answer(reply, Err(MaintenanceError::Closed));
                }
                QueueMessage::Repack { reply, .. } => {
                    send_answer(reply, Err(MaintenanceError::Closed));
                }
                QueueMessage::Backup { reply, .. } => {
                    send_answer(reply, Err(MaintenanceError::Closed));
                }
                QueueMessage::Release(_) | QueueMessage::End | QueueMessage::Close { .. } => {}
            }
        }
    }
}

/// Sends the thread a request. The channel holds two, a copy and the one request it serves beside
/// it, and the queue sends no more than that, so a slot is always free. A request the thread
/// cannot take drops with its reply, and its answer reads as the thread gone.
fn send_to_thread(thread: Option<&mpsc::Sender<ThreadRequest>>, request: ThreadRequest) {
    let Some(thread) = thread else {
        return;
    };
    if let Err(refused) = thread.try_send(request) {
        tracing::error!(
            error = &refused as &(dyn Error + 'static),
            "the database writer's thread did not take a request"
        );
    }
}

/// `future`'s output, or never when there is none.
async fn output_of<Pending: Future>(future: Option<Pending>) -> Pending::Output {
    match future {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

/// Answers a caller. A caller that stopped waiting needs no answer: its write is stored and its
/// hook run either way.
fn send_answer<Answer>(reply: oneshot::Sender<Answer>, answer: Answer) {
    if reply.send(answer).is_err() {
        tracing::trace!("a database writer's caller stopped waiting before its answer");
    }
}
