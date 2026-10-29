//! The database writer: every write the daemon makes goes through it to the one read-write
//! connection, which a thread of its own holds, so a commit's disk sync never stalls the runtime.
//! Writes wait in a bounded queue, which one task owns, and go to the thread as soon as it is free:
//! a batch holds whatever is queued then, at most 50 entries, and writes that arrive during a
//! commit form the next batch. Each batch commits as one transaction, each write in it under a
//! savepoint of its own, and a write is never split across batches. At the queue's cap a write
//! waits for room; none is dropped. A writer opened with a hold queues every write and checkpoint
//! and sends none until the hold is let go, and work the writer is held for sees no commit and no
//! checkpoint while it runs; a passive checkpoint asked while either holds is answered at once,
//! without running.

mod backpressure;
pub mod backup;
pub mod jobs;
pub mod messages;
mod queue;
pub mod repack;
#[cfg(any(test, feature = "test-support"))]
pub mod test_file;
#[cfg(test)]
mod tests;
mod thread;

use std::error::Error;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, InterruptHandle};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::scheduler::budget::Measured;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::statement::{StatementResult, WriteStatement};
use crate::database::writer::backup::BackupCopy;
use crate::database::writer::messages::{
    BatchFailure, CheckpointReport, ThreadExit, ThreadRequest, WriteJob, WriteJobFailure,
};
use crate::database::writer::queue::{ThreadLink, WriteQueue};
use crate::database::writer::repack::RepackEnd;
use crate::events::session::insert::SessionEventRow;

/// The most entries the write queue holds; each event is one entry, and a write with none is one.
pub(crate) const WRITE_QUEUE_CAPACITY: usize = 10_000;

/// The writer thread's name, as a debugger or a crash report shows it.
const WRITER_THREAD_NAME: &str = "database-writer";

/// Why the writer was ended; every write it had taken and every later one fails with it.
pub(crate) type EndReason = Arc<dyn Error + Send + Sync + 'static>;

/// Run on the write queue's task right after the write's batch commits, with the sequence of each
/// of its event rows in order, before the next batch is sent and before any caller hears of it.
/// It runs only for a write that committed, whether or not its caller still waits.
pub(crate) type CommitHook = Box<dyn FnOnce(&[SafeInt<0>]) + Send>;

/// Run on the writer's thread, on its connection, right after each batch that committed a write and
/// before any caller of the batch hears, so what it reads follows the commits in their order. Its
/// failure is told to the [`WriteFailureListener`], fails no write and skips no later read.
pub type CommitRead = Box<dyn FnMut(&Connection) -> rusqlite::Result<()> + Send>;

/// Told of each failure SQLite raised for a write, a batch or a checkpoint, before its caller. It
/// runs on the write queue's task, so it does only quick work, and one that ends the writer holds
/// it through a `Weak`: an `Arc` would keep the writer open once every other handle dropped.
pub type WriteFailureListener = Box<dyn Fn(&(dyn Error + 'static)) + Send + Sync>;

/// What every call of `DatabaseWriter::close` answers: the number of writes the close left
/// unfinished, or why the connection or its thread did not end cleanly.
pub(crate) type CloseOutcome =
    Result<usize, Arc<CleanupFailures<WriterCloseError, ThreadJoinError>>>;

/// What the writer takes from the daemon besides its opener.
#[derive(Default)]
pub struct DatabaseWriterOptions {
    /// Holds every write and checkpoint in the queue until it answers `Ok`; an error, or the sender
    /// dropped, ends the writer with it, so no held write and no checkpoint is ever sent.
    pub writes_held_until: Option<oneshot::Receiver<Result<(), WritesHeldError>>>,
    /// Told of each failure SQLite raised for a write, a batch or a checkpoint, before its caller.
    pub on_write_failed: Option<WriteFailureListener>,
    /// Read on the writer's connection, in order, after each batch that committed a write.
    pub after_commits: Vec<CommitRead>,
}

/// A committed write: what each statement did and each event row's sequence, in the write's order.
#[derive(Debug)]
pub struct CommittedWrite {
    /// What each statement did.
    pub(crate) statement_results: Vec<StatementResult>,
    /// Each event row's sequence.
    pub(crate) sequences: Vec<SafeInt<0>>,
}

/// Why a write was not kept; none of it is stored.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    /// A statement's row count was not the one it expected.
    #[error(
        "the write was refused: statement {statement_index} matched {row_count} rows, not the \
         count it expected, so none of the write was kept"
    )]
    Refused {
        /// The refused statement's position among the write's statements.
        statement_index: usize,
        /// The rows it changed, or returned when it reads.
        row_count: usize,
    },
    /// SQLite failed the write alone; the rest of its batch is kept.
    #[error("SQLite failed the write, so none of it was kept")]
    Failed(#[source] WriteJobFailure),
    /// The write's batch did not commit, so none of its writes was kept.
    #[error("the write's batch did not commit")]
    BatchFailed(#[source] Arc<CleanupFailures<BatchFailure, rusqlite::Error>>),
    /// The write carries more events than the queue holds; it was not taken.
    #[error(
        "a write of {size} entries is larger than the write queue's {WRITE_QUEUE_CAPACITY}; it \
         was not taken"
    )]
    TooLarge {
        /// The entries the write counts for.
        size: usize,
    },
    /// The writer was ended before the write committed.
    #[error("the database writer was ended; this write was not committed")]
    Ended(#[source] EndReason),
    /// The writer closed while its writes were held.
    #[error("the database writer closed while its writes were held; this write was not committed")]
    ClosedWhileHeld,
    /// The writer closed at its drain bound before the write committed.
    #[error("the database writer closed at its drain bound; this write was not committed")]
    ClosedAtDrainBound,
    /// The writer is closed; the write was not taken.
    #[error("the database writer is closed; the write was not taken")]
    Closed,
}

impl WriteError {
    /// The position of the statement whose row count refused the write, `None` for any other
    /// failure.
    pub fn refused_statement_index(&self) -> Option<usize> {
        match self {
            Self::Refused {
                statement_index, ..
            } => Some(*statement_index),
            Self::Failed(_)
            | Self::BatchFailed(_)
            | Self::TooLarge { .. }
            | Self::Ended(_)
            | Self::ClosedWhileHeld
            | Self::ClosedAtDrainBound
            | Self::Closed => None,
        }
    }

    /// The position of the statement SQLite failed and SQLite's error, for a write SQLite failed
    /// alone at a statement; `None` for any other failure.
    pub fn failed_statement(&self) -> Option<(usize, &rusqlite::Error)> {
        match self {
            Self::Failed(WriteJobFailure::Statement {
                statement_index,
                source,
            }) => Some((*statement_index, source)),
            Self::Failed(WriteJobFailure::Savepoint(_) | WriteJobFailure::EventRow(_))
            | Self::Refused { .. }
            | Self::BatchFailed(_)
            | Self::TooLarge { .. }
            | Self::Ended(_)
            | Self::ClosedWhileHeld
            | Self::ClosedAtDrainBound
            | Self::Closed => None,
        }
    }
}

/// Why a checkpoint or a repack, the writer's work on its connection between batches, did not run
/// or did not finish.
#[derive(Debug, thiserror::Error)]
pub enum MaintenanceError {
    /// SQLite failed the work, or putting the busy timeout back after it.
    #[error("the database's maintenance failed")]
    Failed(#[source] CleanupFailures<rusqlite::Error>),
    /// The writer was ended; the work did not run.
    #[error("the database writer was ended; its maintenance did not run")]
    Ended(#[source] EndReason),
    /// The writer is closed; the work did not run.
    #[error("the database writer is closed; its maintenance did not run")]
    Closed,
    /// The writer holds its writes, so a passive checkpoint did not run rather than wait.
    #[error("the database writer holds its writes; the passive checkpoint did not run")]
    Held,
}

/// Why the hold a writer was opened with ended without letting its writes go.
#[derive(Debug, thiserror::Error)]
pub enum WritesHeldError {
    /// The holder refused to let the writes go.
    #[error("the hold on the database writer's writes was refused")]
    Refused(#[source] Box<dyn Error + Send + Sync>),
    /// The holder went away without an answer.
    #[error("the hold on the database writer's writes ended without an answer")]
    Dropped,
}

/// Why [`DatabaseWriter::open`] failed; no writer thread is left running.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseWriterOpenError<OpenError> {
    /// The opener failed, beside the failure of joining its thread when that failed too.
    #[error("the database writer could not open the database")]
    Open(#[source] CleanupFailures<OpenError, ThreadJoinError>),
    /// The thread could not be started.
    #[error("the database writer's thread could not start")]
    Spawn(#[source] std::io::Error),
    /// The thread stopped before it answered its open; the join's failure says why.
    #[error("the database writer's thread stopped before it answered its open")]
    ThreadLost(#[source] Option<ThreadJoinError>),
}

/// Why a writer's close did not end cleanly.
#[derive(Debug, thiserror::Error)]
pub enum WriterCloseError {
    /// The connection did not close cleanly.
    #[error("the database writer's connection did not close cleanly")]
    Connection(#[source] CleanupFailures<rusqlite::Error>),
    /// The thread stopped without answering its exit.
    #[error("the database writer's thread stopped without answering its exit")]
    ThreadLost,
    /// The thread answered its exit but could not be joined.
    #[error("the database writer's thread could not be joined")]
    Join(#[source] ThreadJoinError),
    /// The write queue's task stopped without reporting the close.
    #[error("the database writer stopped without reporting its close")]
    QueueLost,
}

/// Why the writer's thread could not be joined.
#[derive(Debug, thiserror::Error)]
pub enum ThreadJoinError {
    /// The thread panicked; the panic hook has reported the panic itself.
    #[error("the database writer's thread panicked")]
    Panicked,
    /// The blocking task that joins it did not finish.
    #[error("joining the database writer's thread did not finish")]
    Join(#[source] tokio::task::JoinError),
}

/// A write the queue has taken: it resolves once the write committed, or with why it was not
/// kept. Dropping it does not withdraw the write, which is still stored and its hook still run.
pub struct PendingWrite {
    answer: oneshot::Receiver<Result<CommittedWrite, WriteError>>,
}

impl Future for PendingWrite {
    type Output = Result<CommittedWrite, WriteError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        // A queue gone without an answer has closed.
        Pin::new(&mut self.answer)
            .poll(context)
            .map(|answer| answer.unwrap_or_else(|_closed| Err(WriteError::Closed)))
    }
}

/// The daemon's one way to write its database. Open it with [`DatabaseWriter::open`]; share it as
/// an `Arc`. Dropping every handle without a close closes it as `DatabaseWriter::close` does
/// with no bound.
pub struct DatabaseWriter {
    messages: mpsc::UnboundedSender<QueueMessage>,
    shared: Arc<WriterShared>,
    commits: watch::Receiver<u64>,
    closed: watch::Receiver<Option<CloseOutcome>>,
    next_hold: AtomicU64,
}

impl DatabaseWriter {
    /// Starts the writer's thread, which runs `open` and then holds its connection, and returns
    /// once it has. Fails with the open's error, the thread already joined. A canceled open
    /// joins its thread on the blocking pool while the runtime runs; at the runtime's shutdown the
    /// thread ends on its own.
    pub async fn open<OpenError>(
        open: impl FnOnce() -> Result<Connection, OpenError> + Send + 'static,
        mut options: DatabaseWriterOptions,
    ) -> Result<Self, DatabaseWriterOpenError<OpenError>>
    where
        OpenError: Error + Send + Sync + 'static,
    {
        let after_commits = std::mem::take(&mut options.after_commits);
        // A copy and the one request it serves beside it.
        let (requests, thread_requests) = mpsc::channel(2);
        let (opened, has_opened) = oneshot::channel();
        let (exit, exited) = oneshot::channel();
        let stop = Arc::new(ThreadStop::new());
        let thread_stop = Arc::clone(&stop);
        let runtime = tokio::runtime::Handle::current();
        let thread = UnjoinedThread(Some(
            std::thread::Builder::new()
                .name(WRITER_THREAD_NAME.to_owned())
                .spawn(move || {
                    let commits = thread::ThreadCommits::new(after_commits);
                    thread::run(
                        open,
                        opened,
                        thread_requests,
                        &thread_stop,
                        exit,
                        &runtime,
                        commits,
                    );
                })
                .map_err(DatabaseWriterOpenError::Spawn)?,
        ));
        match has_opened.await {
            Ok(Ok(interrupt)) => Ok(Self::serve(
                WriterThread {
                    requests,
                    interrupt,
                    stop,
                    exit: exited,
                    join: Some(thread.into_handle()),
                },
                options,
            )),
            Ok(Err(open_failure)) => {
                let join_failures = join_thread(thread.into_handle())
                    .await
                    .err()
                    .into_iter()
                    .collect();
                Err(DatabaseWriterOpenError::Open(CleanupFailures::new(
                    open_failure,
                    join_failures,
                    "opening the database writer",
                )))
            }
            Err(_unanswered) => Err(DatabaseWriterOpenError::ThreadLost(
                join_thread(thread.into_handle()).await.err(),
            )),
        }
    }

    /// Serves writes over a thread already holding its connection; [`DatabaseWriter::open`] starts
    /// one, a test stands a task in.
    fn serve(thread: WriterThread, options: DatabaseWriterOptions) -> Self {
        let (messages, queue_messages) = mpsc::unbounded_channel();
        let (failure, _no_failure_yet) = watch::channel(None);
        let shared = Arc::new(WriterShared {
            stop: thread.stop,
            interrupt: thread.interrupt,
            is_thread_released: AtomicBool::new(false),
            failure,
        });
        let (commit_count, commits) = watch::channel(0);
        let (close_outcome, closed) = watch::channel(None);
        let link = ThreadLink {
            requests: thread.requests,
            exit: thread.exit,
            join: thread.join,
        };
        let queue = WriteQueue::new(
            queue_messages,
            link,
            Arc::clone(&shared),
            options,
            commit_count,
            close_outcome,
        );
        tokio::spawn(queue.run());
        Self {
            messages,
            shared,
            commits,
            closed,
            next_hold: AtomicU64::new(0),
        }
    }

    /// Queues `job` and returns at once, with no await before the send, so a caller can queue
    /// inside a lock and await the write outside it. `on_commit` runs once the write commits.
    /// Fails at once for an ended writer and for a write larger than the queue.
    pub fn enqueue(
        &self,
        job: WriteJob,
        on_commit: Option<CommitHook>,
    ) -> Result<PendingWrite, WriteError> {
        if let Some(reason) = self.shared.end_reason() {
            return Err(WriteError::Ended(reason));
        }
        let size = job.events.len().max(1);
        if size > WRITE_QUEUE_CAPACITY {
            return Err(WriteError::TooLarge { size });
        }
        let (reply, answer) = oneshot::channel();
        self.messages
            .send(QueueMessage::Write(WriteRequest {
                job,
                size,
                on_commit,
                reply,
            }))
            .map_err(|_unsent| WriteError::Closed)?;
        Ok(PendingWrite { answer })
    }

    /// Runs `statements` in order as one write and returns what each did once it committed. Fails
    /// with [`WriteError::Refused`] when a statement's row count is not the one it expected, and as
    /// [`DatabaseWriter::enqueue`] does; either way none of it is kept.
    pub async fn write(
        &self,
        statements: Vec<WriteStatement>,
    ) -> Result<Vec<StatementResult>, WriteError> {
        let job = WriteJob {
            statements,
            events: Vec::new(),
        };
        Ok(self.enqueue(job, None)?.await?.statement_results)
    }

    /// Appends `events` in order, each at its session's next sequence, after `statements`, all as
    /// one write that never splits across batches, and returns each event's sequence once it
    /// committed. Fails as [`DatabaseWriter::write`] does.
    pub async fn append_events(
        &self,
        events: Vec<SessionEventRow>,
        statements: Vec<WriteStatement>,
    ) -> Result<Vec<SafeInt<0>>, WriteError> {
        let job = WriteJob { statements, events };
        Ok(self.enqueue(job, None)?.await?.sequences)
    }

    /// The writer thread's count of the batches that committed a write, raised once after each; a
    /// reader that sees it change can read what the batch wrote, and a copy names the count it
    /// holds every batch up to. Drop the receiver to stop following.
    pub fn follow_commits(&self) -> watch::Receiver<u64> {
        self.commits.clone()
    }

    /// Returns once every write sent before this call has committed or failed, the writes waiting
    /// at the cap among them; a write sent afterward does not extend the wait.
    pub async fn flush(&self) {
        let (reply, answer) = oneshot::channel();
        if self.messages.send(QueueMessage::Flush(reply)).is_err() {
            // The queue has stopped, so every write it took has settled.
            return;
        }
        if answer.await.is_err() {
            tracing::debug!("the database writer stopped before the flush answered");
        }
    }

    /// Runs `work` once every write sent before this call has committed or failed, with no commit
    /// and no checkpoint reaching the file while it runs: the writes and truncating checkpoints
    /// asked for meanwhile wait until it ends, and a passive one fails with
    /// [`MaintenanceError::Held`]. Returns what `work` returns. Dropping the future mid-hold, or
    /// before the hold started, still lets the writes go.
    pub async fn hold_while<Work: Future>(&self, work: impl FnOnce() -> Work) -> Work::Output {
        let hold = HoldGuard {
            messages: self.messages.clone(),
            id: self.next_hold.fetch_add(1, Ordering::Relaxed),
        };
        let (started, has_started) = oneshot::channel();
        // A queue gone sends nothing more to the file, so the work is held either way.
        match self.messages.send(QueueMessage::Hold {
            id: hold.id,
            started,
        }) {
            Ok(()) => {
                if has_started.await.is_err() {
                    tracing::debug!("the database writer stopped before the hold started");
                }
            }
            Err(_unsent) => tracing::debug!("the database writer stopped before the hold was sent"),
        }
        let output = work().await;
        drop(hold);
        output
    }

    /// Runs a WAL checkpoint in `mode` on the writer's connection, between batches and never
    /// while the writer holds its writes: a truncating one waits the hold out, and a passive one
    /// fails at once with [`MaintenanceError::Held`]. It never waits for a reader holding an older
    /// snapshot: it answers busy at once. Fails with SQLite's error, or once the writer is ended
    /// or closed.
    pub(crate) async fn checkpoint(
        &self,
        mode: CheckpointMode,
    ) -> Result<CheckpointResult, MaintenanceError> {
        Ok(self.checkpoint_measured(mode).await?.report.result)
    }

    // A checkpoint as `checkpoint` runs it, with the store's page size and the thread's processor
    // time around it.
    async fn checkpoint_measured(
        &self,
        mode: CheckpointMode,
    ) -> Result<Measured<CheckpointReport>, MaintenanceError> {
        let (reply, answer) = oneshot::channel();
        self.messages
            .send(QueueMessage::Checkpoint { mode, reply })
            .map_err(|_unsent| MaintenanceError::Closed)?;
        answer
            .await
            .unwrap_or_else(|_closed| Err(MaintenanceError::Closed))
    }

    /// Runs `PRAGMA optimize` on the writer's connection between batches, which analyzes the tables
    /// whose statistics have gone stale, waiting out a hold as a truncating checkpoint does. The
    /// answer carries the thread's processor time around it. Fails with SQLite's error, or once
    /// the writer is ended or closed.
    pub(crate) async fn optimize(&self) -> Result<Measured<()>, MaintenanceError> {
        let (reply, answer) = oneshot::channel();
        self.messages
            .send(QueueMessage::Optimize(reply))
            .map_err(|_unsent| MaintenanceError::Closed)?;
        answer
            .await
            .unwrap_or_else(|_closed| Err(MaintenanceError::Closed))
    }

    /// Repacks the file on the writer's connection between batches, as
    /// [`repack`](crate::database::writer::repack) describes, waiting out a hold as a truncating
    /// checkpoint does; once `cancel` is canceled a repack not yet begun is not run and one running
    /// is interrupted, either answering [`RepackEnd::Interrupted`]. The answer carries the
    /// thread's processor time around the repack. Fails with SQLite's error, or once the writer
    /// is ended or closed.
    pub(crate) async fn repack(
        &self,
        cancel: CancellationToken,
    ) -> Result<Measured<RepackEnd>, MaintenanceError> {
        let (reply, answer) = oneshot::channel();
        self.messages
            .send(QueueMessage::Repack { cancel, reply })
            .map_err(|_unsent| MaintenanceError::Closed)?;
        answer
            .await
            .unwrap_or_else(|_closed| Err(MaintenanceError::Closed))
    }

    /// Copies the database into the new file at `destination` through SQLite's online backup on
    /// the writer's connection, as [`backup`] describes, while
    /// writes go on; it waits out a hold before it starts, and once `cancel` is canceled it stops
    /// before its next step, answering [`BackupCopy::Stopped`]. The answer carries the thread's
    /// processor time around the copy's steps. Fails with SQLite's error, or once the writer is
    /// ended or closed.
    pub async fn backup(
        &self,
        destination: PathBuf,
        cancel: CancellationToken,
    ) -> Result<Measured<BackupCopy>, MaintenanceError> {
        let (reply, answer) = oneshot::channel();
        self.messages
            .send(QueueMessage::Backup {
                destination,
                cancel,
                reply,
            })
            .map_err(|_unsent| MaintenanceError::Closed)?;
        answer
            .await
            .unwrap_or_else(|_closed| Err(MaintenanceError::Closed))
    }

    /// Whether the writer was ended: by [`DatabaseWriter::end`], by its hold's refusal, or by a
    /// close at its drain bound.
    pub fn is_ended(&self) -> bool {
        self.shared.stop.is_stopped()
    }

    /// The reason the writer was ended, once it is; `None` until then and after a close at the
    /// drain bound.
    pub fn when_failed(&self) -> watch::Receiver<Option<EndReason>> {
        self.shared.failure.subscribe()
    }

    /// Ends the writer at once: every write taken and every later one fails with `reason`, the
    /// batch in flight rolls back unless its commit already ran, and the thread closes its
    /// connection without the checkpoint a close makes, so the files stay as they were found. A
    /// call racing the queue's release of the thread may still wait out the thread's close.
    pub fn end(&self, reason: EndReason) {
        if !self.shared.end(reason) {
            return;
        }
        if self.messages.send(QueueMessage::End).is_err() {
            tracing::debug!("the database writer had already stopped when it was ended");
        }
    }

    /// Takes no new write, fails held writes at once, waits for every write taken to settle
    /// (within `drain_within` when given), then lets the thread close its connection and exit.
    /// Returns the number of writes left unfinished; past the bound the unsent writes fail and the
    /// batch in flight rolls back unless its commit already ran. Repeated calls share the first.
    pub async fn close(&self, drain_within: Option<Duration>) -> CloseOutcome {
        let mut closed = self.closed.clone();
        if self
            .messages
            .send(QueueMessage::Close { drain_within })
            .is_err()
        {
            tracing::debug!("the database writer's queue had stopped before the close");
        }
        let outcome = match closed.wait_for(Option::is_some).await {
            Ok(outcome) => Option::clone(&outcome),
            Err(_queue_gone) => None,
        };
        outcome.unwrap_or_else(|| {
            Err(Arc::new(CleanupFailures::new(
                WriterCloseError::QueueLost,
                Vec::new(),
                "closing the database writer",
            )))
        })
    }
}

/// Lets the writes go once the work it guards ends or its future is dropped.
struct HoldGuard {
    messages: mpsc::UnboundedSender<QueueMessage>,
    id: u64,
}

impl Drop for HoldGuard {
    fn drop(&mut self) {
        if self.messages.send(QueueMessage::Release(self.id)).is_err() {
            tracing::debug!("the database writer had stopped, so its hold had nothing to let go");
        }
    }
}

/// What a writer's handles ask of its write queue, in the order they asked.
enum QueueMessage {
    /// A write to queue.
    Write(WriteRequest),
    /// Answer once every write sent before this has settled.
    Flush(oneshot::Sender<()>),
    /// Hold the writes once every write sent before this has settled, and answer then.
    Hold {
        id: u64,
        started: oneshot::Sender<()>,
    },
    /// Let the hold `id` go, or withdraw it if it has not started.
    Release(u64),
    /// Run a checkpoint between batches.
    Checkpoint {
        mode: CheckpointMode,
        reply: oneshot::Sender<Result<Measured<CheckpointReport>, MaintenanceError>>,
    },
    /// Run `PRAGMA optimize` between batches.
    Optimize(oneshot::Sender<Result<Measured<()>, MaintenanceError>>),
    /// Repack the file between batches, unless `cancel` is canceled first.
    Repack {
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Measured<RepackEnd>, MaintenanceError>>,
    },
    /// Copy the database into a new file, beside the writes, until `cancel` is canceled.
    Backup {
        destination: PathBuf,
        cancel: CancellationToken,
        reply: oneshot::Sender<Result<Measured<BackupCopy>, MaintenanceError>>,
    },
    /// The writer was ended: fail what is queued and let the thread go.
    End,
    /// Close, within a bound when one is given.
    Close { drain_within: Option<Duration> },
}

/// A write as its caller sends it.
struct WriteRequest {
    job: WriteJob,
    size: usize,
    on_commit: Option<CommitHook>,
    reply: oneshot::Sender<Result<CommittedWrite, WriteError>>,
}

/// What the writer's handles and its write queue share: the thread's stop and interrupt, whether
/// the queue has let the thread go, and the reason the writer was ended.
struct WriterShared {
    stop: Arc<ThreadStop>,
    interrupt: InterruptHandle,
    is_thread_released: AtomicBool,
    failure: watch::Sender<Option<EndReason>>,
}

impl WriterShared {
    /// Tells the thread to stop what it runs: the flag for the next statement, write or commit,
    /// the interrupt for the statement running now, which the flag alone would not reach.
    fn stop_thread(&self, kind: StopKind) {
        self.stop.stop(kind);
        self.interrupt_thread();
    }

    /// Interrupts the statement the thread runs, unless the queue has let the thread go: the
    /// interrupt would wait on the thread's close, and one left pending cuts its checkpoint short.
    fn interrupt_thread(&self) {
        if !self.is_thread_released.load(Ordering::Acquire) {
            self.interrupt.interrupt();
        }
    }

    /// Marks the writer ended with `reason` and stops its thread; `false` when it was already
    /// ended, keeping the first reason.
    fn end(&self, reason: EndReason) -> bool {
        let is_first = self.failure.send_if_modified(|failure| {
            if failure.is_some() {
                return false;
            }
            *failure = Some(reason);
            true
        });
        if is_first {
            self.stop_thread(StopKind::Ended);
        }
        is_first
    }

    fn end_reason(&self) -> Option<EndReason> {
        self.failure.borrow().clone()
    }
}

/// Why the writer's thread stops what it runs, read before each statement, each write and the
/// commit, and whether its close skips the closing checkpoint.
struct ThreadStop {
    state: AtomicU8,
    /// Whether the drain bound's stop interrupted a batch or checkpoint in flight.
    is_cut_at_bound: AtomicBool,
}

/// How the writer's thread was stopped; a later, stronger stop replaces an earlier one.
#[derive(Clone, Copy)]
enum StopKind {
    /// A close's drain bound passed.
    DrainBound = 1,
    /// The writer was ended.
    Ended = 2,
}

impl ThreadStop {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(0),
            is_cut_at_bound: AtomicBool::new(false),
        }
    }

    fn stop(&self, kind: StopKind) {
        self.state.fetch_max(kind as u8, Ordering::AcqRel);
    }

    fn is_stopped(&self) -> bool {
        self.state.load(Ordering::Acquire) != 0
    }

    fn is_ended(&self) -> bool {
        self.state.load(Ordering::Acquire) == StopKind::Ended as u8
    }

    /// Records that the drain bound's stop interrupted a batch or checkpoint in flight.
    fn cut_at_bound(&self) {
        self.is_cut_at_bound.store(true, Ordering::Release);
    }

    fn is_cut_at_bound(&self) -> bool {
        self.is_cut_at_bound.load(Ordering::Acquire)
    }

    /// Whether the close skips its checkpoint: an ended writer keeps the files as they were found,
    /// and a stop cut at its bound leaves the log for the next open to replay, since its pending
    /// interrupt would stop that checkpoint at once.
    fn skips_checkpoint(&self) -> bool {
        self.is_ended() || self.is_cut_at_bound()
    }
}

/// The SQLite result code `error` or the first of its sources to carry one holds; `None` when
/// none does.
pub fn sqlite_error_code(error: &(dyn Error + 'static)) -> Option<ErrorCode> {
    std::iter::successors(Some(error), |&error| error.source())
        .find_map(|error| error.downcast_ref::<rusqlite::Error>()?.sqlite_error_code())
}

/// Whether `error` carries SQLite's interrupt, which the writer's stop and a canceled repack raise.
fn is_interrupt(error: &(dyn Error + 'static)) -> bool {
    sqlite_error_code(error) == Some(ErrorCode::OperationInterrupted)
}

/// The writer's thread as its write queue reaches it.
struct WriterThread {
    requests: mpsc::Sender<ThreadRequest>,
    interrupt: InterruptHandle,
    stop: Arc<ThreadStop>,
    exit: oneshot::Receiver<ThreadExit>,
    /// `None` for a task standing in for the thread in a test.
    join: Option<std::thread::JoinHandle<()>>,
}

/// The writer's thread until it is handed on to be joined. Dropped before that, as when `open`'s
/// future is dropped mid-open, it joins the thread on the blocking pool while a runtime runs.
struct UnjoinedThread(Option<std::thread::JoinHandle<()>>);

impl UnjoinedThread {
    fn into_handle(mut self) -> std::thread::JoinHandle<()> {
        self.0.take().expect("the thread is handed on once")
    }
}

impl Drop for UnjoinedThread {
    fn drop(&mut self) {
        let Some(thread) = self.0.take() else {
            return;
        };
        // Outside a runtime the thread ends on its own; `spawn_blocking` would panic there.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(move || {
                if thread.join().is_err() {
                    tracing::debug!("the database writer's thread panicked; the hook reported it");
                }
            })),
            Err(_no_runtime) => {
                tracing::debug!("no runtime runs to join the database writer's thread");
            }
        }
    }
}

/// Joins the writer's thread on a blocking thread, once it has answered its last message, so the
/// join never waits on a thread still running.
async fn join_thread(thread: std::thread::JoinHandle<()>) -> Result<(), ThreadJoinError> {
    match tokio::task::spawn_blocking(move || thread.join()).await {
        Ok(Ok(())) => Ok(()),
        // The panic hook has reported the panic itself.
        Ok(Err(_panic)) => Err(ThreadJoinError::Panicked),
        Err(join_failure) => Err(ThreadJoinError::Join(join_failure)),
    }
}
