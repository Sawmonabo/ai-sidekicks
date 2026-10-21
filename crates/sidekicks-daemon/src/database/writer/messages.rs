//! The messages between the database writer's pump and its thread: one write and how it ended,
//! what the pump asks of the thread, and the thread's answers. Each request carries its own reply,
//! answered once; the thread's exit is answered last.

use std::path::PathBuf;

use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;

use crate::cleanup_failures::CleanupFailures;
use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::statement::{StatementResult, WriteStatement};
use crate::database::writer::backup::BackupAnswer;
use crate::database::writer::repack::RepackAnswer;
use crate::events::session::insert::{SessionEventInsertError, SessionEventRow};

/// One write: its statements, then its event rows in order, run as one unit under a savepoint of
/// its own.
#[derive(Debug)]
pub(crate) struct WriteJob {
    /// The statements, run in order before the rows.
    pub(crate) statements: Vec<WriteStatement>,
    /// The event rows, each inserted at its session's next sequence.
    pub(crate) events: Vec<SessionEventRow>,
}

/// How one write of a committed batch ended. A refused or failed write rolled back alone; the
/// batch's other writes are kept.
#[derive(Debug)]
pub(crate) enum WriteJobOutcome {
    /// The write is stored.
    Committed {
        /// What each statement did, in the write's order.
        statement_results: Vec<StatementResult>,
        /// Each event row's sequence, in the order the rows were given.
        sequences: Vec<SafeInt<0>>,
    },
    /// A statement's row count was not the one it expected, so none of the write was kept.
    Refused {
        /// The refused statement's position among the write's statements.
        statement_index: usize,
        /// The rows it changed, or returned when it reads.
        row_count: usize,
    },
    /// SQLite failed the write, so none of it was kept.
    Failed(WriteJobFailure),
}

/// Why one write failed alone, its savepoint rolled back.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WriteJobFailure {
    /// The write's savepoint could not be opened, released or rolled back.
    #[error("the write's savepoint failed")]
    Savepoint(#[source] rusqlite::Error),
    /// SQLite refused one of the write's statements.
    #[error("statement {statement_index} of the write failed")]
    Statement {
        /// The statement's position among the write's statements.
        statement_index: usize,
        /// SQLite's error.
        #[source]
        source: rusqlite::Error,
    },
    /// One of the write's event rows was not stored.
    #[error("an event row of the write was not stored")]
    EventRow(#[source] SessionEventInsertError),
}

/// Why a batch did not commit; none of its writes was kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BatchFailure {
    /// The batch's transaction could not begin.
    #[error("the batch's transaction could not begin")]
    Begin(#[source] rusqlite::Error),
    /// SQLite ended the transaction itself (a full disk, an I/O error, a statement that ended it)
    /// while a write ran, so the writes after it would have committed one by one.
    #[error("SQLite ended the batch's transaction while write {job_index} ran")]
    TransactionEnded {
        /// The position of the write that met it in the batch.
        job_index: usize,
        /// That write's failure; absent when the write was refused.
        #[source]
        source: Option<WriteJobFailure>,
    },
    /// A write's savepoint could not be rolled back or released while the transaction stayed
    /// open, so that write's work could not be kept apart from the batch's; the savepoint's own
    /// failure is beside this one.
    #[error("the savepoint of write {job_index} could not be ended")]
    SavepointNotEnded {
        /// The position of the write in the batch.
        job_index: usize,
        /// That write's failure; absent when the write was refused or ran whole.
        #[source]
        source: Option<WriteJobFailure>,
    },
    /// The commit failed.
    #[error("the batch's commit failed")]
    Commit(#[source] rusqlite::Error),
    /// The writer was closed at its drain bound or ended before the batch committed; SQLite's
    /// interrupt of the batch's work is the stop's own and reads as this.
    #[error("the database writer stopped before the batch committed")]
    Stopped,
}

/// A batch that did not commit: why, beside the failures of ending a write's savepoint and of
/// rolling the batch back when those failed too, and how each write that failed alone before it
/// failed.
#[derive(Debug)]
pub(crate) struct FailedBatch {
    /// Why the batch did not commit.
    pub(crate) failure: CleanupFailures<BatchFailure, rusqlite::Error>,
    /// The failures of the batch's writes that failed alone before it failed or stopped, in order.
    pub(crate) earlier_write_failures: Vec<WriteJobFailure>,
}

/// The thread's answer to one batch: every write's outcome, in the batch's order, once it
/// committed; or why it did not.
pub(crate) type BatchAnswer = Result<Vec<WriteJobOutcome>, Box<FailedBatch>>;

/// The thread's answer to one checkpoint: what SQLite reports of it, or its failure, beside the
/// failure of putting the busy timeout back when that failed too.
pub(crate) type CheckpointAnswer = Result<CheckpointResult, CleanupFailures<rusqlite::Error>>;

/// The thread's last answer, as it exits: its connection's close, or why that failed, beside the
/// close's own failure when turning off an ended writer's closing checkpoint failed first.
pub(crate) type ThreadExit = Result<(), CleanupFailures<rusqlite::Error>>;

/// What the pump asks of the thread, one request at a time. The thread closes its connection and
/// exits once the pump drops its sender.
#[derive(Debug)]
pub(crate) enum ThreadRequest {
    /// Run `jobs` as one transaction, each under a savepoint of its own.
    Batch {
        /// The writes, in the order they were queued.
        jobs: Vec<WriteJob>,
        /// Where the answer goes.
        reply: oneshot::Sender<BatchAnswer>,
    },
    /// Run a WAL checkpoint in `mode`, answering busy at once rather than waiting on a reader.
    Checkpoint {
        /// The checkpoint's mode.
        mode: CheckpointMode,
        /// Where the answer goes.
        reply: oneshot::Sender<CheckpointAnswer>,
    },
    /// Repack the file: truncate the log, then `VACUUM`.
    Repack {
        /// Where the answer goes.
        reply: oneshot::Sender<RepackAnswer>,
    },
    /// Copy the database into the file at `destination`, serving the requests that come meanwhile.
    Backup {
        /// The copy's file, which must not exist yet.
        destination: PathBuf,
        /// Where the answer goes.
        reply: oneshot::Sender<BackupAnswer>,
    },
}
