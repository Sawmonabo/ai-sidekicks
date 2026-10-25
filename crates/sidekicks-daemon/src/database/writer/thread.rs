//! The database writer's thread: it opens the one read-write connection, then runs each request
//! the write queue sends, one at a time: a batch as one transaction, each write in it under a
//! savepoint of its own, so a refused or failed write rolls back alone while the batch commits
//! whole or not at all; or a WAL checkpoint; or the repack; or the online copy, serving the
//! requests that come while it lives. It counts the batches that committed a write, so a copy
//! names exactly the writes it holds. It closes its connection and exits once the queue lets it
//! go.

use rusqlite::config::DbConfig;
use rusqlite::types::Value;
use rusqlite::{
    Connection, DropBehavior, ErrorCode, InterruptHandle, Params, Statement, Transaction,
    TransactionBehavior, params_from_iter,
};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

use crate::cleanup_failures::CleanupFailures;
use crate::daemon::scheduler::budget::{Measured, ThreadProcessorTime};
use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::statement::{
    StatementBindings, StatementResult, WriteStatement, named_bindings,
};
use crate::database::writer::backup::{CopyOrder, LOCK_BOUND, ThreadServing, copy_database};
use crate::database::writer::messages::{
    BatchAnswer, BatchFailure, CheckpointAnswer, CheckpointReport, CommittedBatch, FailedBatch,
    MeasuredCheckpointAnswer, ThreadExit, ThreadRequest, WriteJob, WriteJobFailure,
    WriteJobOutcome,
};
use crate::database::writer::repack::repack;
use crate::database::writer::{CommitRead, ThreadStop, is_interrupt, sqlite_error_code};
use crate::events::content::codec::BodyEncoder;
use crate::events::session::insert::insert_session_event;

/// Prepared statements the connection keeps, least recently used dropped first; bounded, since a
/// caller may build its SQL.
const PREPARED_STATEMENT_CAPACITY: usize = 256;

// One write's savepoint: opened, released once its work is done, or rolled back and released.
const OPEN_JOB_SAVEPOINT_SQL: &str = "SAVEPOINT write_job";
const RELEASE_JOB_SAVEPOINT_SQL: &str = "RELEASE write_job";
const UNDO_JOB_SAVEPOINT_SQL: &str = "ROLLBACK TO write_job; RELEASE write_job";

const BATCH_OPERATION: &str = "running a write batch";
const CHECKPOINT_OPERATION: &str = "running a WAL checkpoint";

// The operation an optimize's failure names.
const OPTIMIZE_OPERATION: &str = "running PRAGMA optimize";
const CLOSE_OPERATION: &str = "closing the writer's connection";

/// The batches that committed a write: the thread's count of them, and the read run after each.
pub(super) struct ThreadCommits {
    /// The thread's count of the batches that committed a write.
    pub(super) count: u64,
    after_commit: Option<CommitRead>,
}

impl ThreadCommits {
    /// No batch counted yet, `after_commit` run after each one that commits a write.
    pub(super) fn new(after_commit: Option<CommitRead>) -> Self {
        Self {
            count: 0,
            after_commit,
        }
    }

    // Counts a batch that committed a write and runs the read after it; answers the read's failure.
    fn count_commit(&mut self, connection: &Connection) -> Option<rusqlite::Error> {
        self.count += 1;
        self.after_commit
            .as_mut()
            .and_then(|read| read(connection).err())
    }
}

/// The thread's body: runs `open`, answers `opened` with the connection's interrupt handle or the
/// open's failure, serves `requests` until the queue drops its sender, waiting on `runtime` only
/// while a copy's step meets a lock and counting `commits`, then closes the connection and answers
/// `exit` as its last act. A failed open ends the thread at once, `exit` unanswered.
pub(super) fn run<OpenError>(
    open: impl FnOnce() -> Result<Connection, OpenError>,
    opened: oneshot::Sender<Result<InterruptHandle, OpenError>>,
    requests: mpsc::Receiver<ThreadRequest>,
    stop: &ThreadStop,
    exit: oneshot::Sender<ThreadExit>,
    runtime: &Handle,
    mut commits: ThreadCommits,
) {
    let connection = match open() {
        Ok(connection) => connection,
        Err(open_failure) => {
            if opened.send(Err(open_failure)).is_err() {
                tracing::debug!("the writer's opener stopped waiting before the open failed");
            }
            return;
        }
    };
    connection.set_prepared_statement_cache_capacity(PREPARED_STATEMENT_CAPACITY);
    // An opener that stopped waiting dropped the request channel with it, so nothing is served and
    // the connection closes at once.
    if opened.send(Ok(connection.get_interrupt_handle())).is_ok() {
        serve(
            &connection,
            &mut BodyEncoder::new(),
            requests,
            stop,
            runtime,
            &mut commits,
        );
    }
    let closed = close(connection, stop.skips_checkpoint());
    if stop.is_cut_at_bound() && !stop.is_ended() {
        tracing::warn!(
            is_checkpoint_skipped = true,
            stop = "drain_bound",
            "the database writer closed without its checkpoint: the stop's bound interrupted a \
             write, and the next open replays the log"
        );
    }
    if exit.send(closed).is_err() {
        tracing::debug!("the database writer's queue stopped waiting before its thread exited");
    }
}

// Runs each request as it comes, until the queue drops its sender or stops waiting for answers.
fn serve(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    mut requests: mpsc::Receiver<ThreadRequest>,
    stop: &ThreadStop,
    runtime: &Handle,
    commits: &mut ThreadCommits,
) {
    while let Some(request) = requests.blocking_recv() {
        let is_served = serve_request(
            connection,
            encoder,
            request,
            &mut requests,
            stop,
            runtime,
            commits,
        );
        if !is_served {
            // The queue is gone, so no request follows.
            break;
        }
    }
}

/// Closes the connection. When `skips_checkpoint`, the close first turns off the checkpoint SQLite
/// makes on the last close, whatever else still holds the file open: an ended writer keeps the
/// files as they were found, and a stop cut at its bound leaves the log for the next open to
/// replay.
fn close(connection: Connection, skips_checkpoint: bool) -> ThreadExit {
    let switch_failure = if skips_checkpoint {
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .err()
    } else {
        None
    };
    // A refused close hands the connection back, and its drop repeats the same refused close:
    // SQLite refuses only while statements or backups stay open, which a retry would still meet.
    let close_failure = connection
        .close()
        .err()
        .map(|(_connection, failure)| failure);
    match (switch_failure, close_failure) {
        (None, None) => Ok(()),
        (Some(switch_failure), close_failure) => Err(CleanupFailures::new(
            switch_failure,
            close_failure.into_iter().collect(),
            CLOSE_OPERATION,
        )),
        (None, Some(close_failure)) => Err(CleanupFailures::new(
            close_failure,
            Vec::new(),
            CLOSE_OPERATION,
        )),
    }
}

// How one write of a batch ended, as the batch sees it.
enum JobEnd {
    /// The write committed into the batch's transaction, or rolled back alone.
    Settled(WriteJobOutcome),
    /// The writer is stopping: the batch rolls back whole.
    Stopped,
    /// SQLite ended the batch's transaction itself while the write ran.
    TransactionEnded(Option<WriteJobFailure>),
    /// The write's savepoint could not be ended while the transaction stayed open.
    SavepointNotEnded {
        failure: Option<WriteJobFailure>,
        savepoint_failure: rusqlite::Error,
    },
}

// Why a write's own work stopped short.
enum JobFault {
    Stopped,
    Unkept(UnkeptWrite),
}

// A write none of which is kept, and why.
enum UnkeptWrite {
    Refused {
        statement_index: usize,
        row_count: usize,
    },
    Failed(WriteJobFailure),
}

impl UnkeptWrite {
    fn into_outcome(self) -> WriteJobOutcome {
        match self {
            Self::Refused {
                statement_index,
                row_count,
            } => WriteJobOutcome::Refused {
                statement_index,
                row_count,
            },
            Self::Failed(failure) => WriteJobOutcome::Failed(failure),
        }
    }

    fn into_failure(self) -> Option<WriteJobFailure> {
        match self {
            Self::Refused { .. } => None,
            Self::Failed(failure) => Some(failure),
        }
    }
}

/// Runs one request and answers it; false once the queue is gone, so no request follows. A copy
/// serves the requests that come while it lives, each through here. A checkpoint's and a repack's
/// answers carry the thread's processor time around their statements; a batch's and a copy's carry
/// the count of `commits`, the thread's count of the batches that committed a write.
pub(super) fn serve_request(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    request: ThreadRequest,
    requests: &mut mpsc::Receiver<ThreadRequest>,
    stop: &ThreadStop,
    runtime: &Handle,
    commits: &mut ThreadCommits,
) -> bool {
    match request {
        ThreadRequest::Batch { jobs, reply } => reply
            .send(run_batch(connection, encoder, &jobs, stop, commits))
            .is_ok(),
        ThreadRequest::Checkpoint { mode, reply } => {
            reply.send(checkpoint_measured(connection, mode)).is_ok()
        }
        ThreadRequest::Optimize { reply } => {
            let mut processor_time = ThreadProcessorTime::default();
            let optimized = processor_time.measure(|| connection.execute_batch("PRAGMA optimize"));
            reply
                .send(
                    optimized
                        .map(|()| Measured {
                            report: (),
                            processor_time,
                        })
                        .map_err(|failure| {
                            CleanupFailures::new(failure, Vec::new(), OPTIMIZE_OPERATION)
                        }),
                )
                .is_ok()
        }
        ThreadRequest::Repack { cancel, reply } => {
            let mut processor_time = ThreadProcessorTime::default();
            let repacked = processor_time.measure(|| repack(connection, &cancel));
            reply
                .send(repacked.map(|report| Measured {
                    report,
                    processor_time,
                }))
                .is_ok()
        }
        ThreadRequest::Backup {
            destination,
            cancel,
            reply,
        } => {
            let order = CopyOrder {
                destination: &destination,
                cancel: &cancel,
                lock_bound: LOCK_BOUND,
            };
            let mut serving = ThreadServing {
                connection,
                encoder,
                requests,
                stop,
                runtime,
                commits,
            };
            let (answer, is_queue_gone) = copy_database(&order, &mut serving);
            reply.send(answer).is_ok() && !is_queue_gone
        }
    }
}

// Runs a requested checkpoint right after a `NOOP` one, whose count of frames already moved
// leaves the frames this one moved, and reads the store's page size, with the thread's processor
// time around them.
fn checkpoint_measured(connection: &Connection, mode: CheckpointMode) -> MeasuredCheckpointAnswer {
    let mut processor_time = ThreadProcessorTime::default();
    let report = processor_time.measure(|| {
        let before = checkpoint(connection, CheckpointMode::Noop)?;
        let result = checkpoint(connection, mode)?;
        let page_size = connection
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .map_err(|failure| CleanupFailures::new(failure, Vec::new(), CHECKPOINT_OPERATION))?;
        Ok(CheckpointReport {
            result,
            moved_frames: result
                .checkpointed_frames
                .saturating_sub(before.checkpointed_frames),
            page_size,
        })
    })?;
    Ok(Measured {
        report,
        processor_time,
    })
}

/// Runs `jobs` as one immediate transaction and answers every write's outcome once it committed,
/// with `commits` counted and read after when one of them committed, or the batch's failure beside
/// the failures of the writes that failed alone before it.
fn run_batch(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    jobs: &[WriteJob],
    stop: &ThreadStop,
    commits: &mut ThreadCommits,
) -> BatchAnswer {
    let mut outcomes = Vec::with_capacity(jobs.len());
    match run_transaction(connection, encoder, jobs, stop, &mut outcomes) {
        Ok(()) => {
            let after_commit_failure = outcomes
                .iter()
                .any(|outcome| matches!(outcome, WriteJobOutcome::Committed { .. }))
                .then(|| commits.count_commit(connection))
                .flatten();
            Ok(CommittedBatch {
                outcomes,
                commit_count: commits.count,
                after_commit_failure,
            })
        }
        Err(failure) => Err(Box::new(FailedBatch {
            failure: *failure,
            earlier_write_failures: outcomes
                .into_iter()
                .filter_map(|outcome| match outcome {
                    WriteJobOutcome::Failed(failure) => Some(failure),
                    WriteJobOutcome::Committed { .. } | WriteJobOutcome::Refused { .. } => None,
                })
                .collect(),
        })),
    }
}

/// Runs `jobs` in one transaction, pushing each write's outcome onto `outcomes`, and commits. The
/// stop is read before each write, each statement and the commit, so a stop that lands between
/// statements, where SQLite's interrupt does not reach, still keeps the batch from committing. It
/// opens through the shared connection, which a copy borrows while it lives.
fn run_transaction(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    jobs: &[WriteJob],
    stop: &ThreadStop,
    outcomes: &mut Vec<WriteJobOutcome>,
) -> Result<(), Box<CleanupFailures<BatchFailure, rusqlite::Error>>> {
    if stop.is_stopped() {
        return Err(Box::new(batch_failure(
            BatchFailure::Stopped,
            Vec::new(),
            stop,
        )));
    }
    let mut transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|failure| {
            Box::new(batch_failure(
                BatchFailure::Begin(failure),
                Vec::new(),
                stop,
            ))
        })?;
    // Every end below is explicit, so no drop runs SQL whose failure no one sees.
    transaction.set_drop_behavior(DropBehavior::Ignore);
    for (job_index, job) in jobs.iter().enumerate() {
        if stop.is_stopped() {
            return Err(Box::new(roll_back(
                transaction,
                BatchFailure::Stopped,
                Vec::new(),
                stop,
            )));
        }
        match run_job(&transaction, encoder, job, stop) {
            JobEnd::Settled(outcome) => outcomes.push(outcome),
            JobEnd::Stopped => {
                return Err(Box::new(roll_back(
                    transaction,
                    BatchFailure::Stopped,
                    Vec::new(),
                    stop,
                )));
            }
            JobEnd::TransactionEnded(source) => {
                let failure = BatchFailure::TransactionEnded { job_index, source };
                return Err(Box::new(roll_back(transaction, failure, Vec::new(), stop)));
            }
            JobEnd::SavepointNotEnded {
                failure,
                savepoint_failure,
            } => {
                let failure = BatchFailure::SavepointNotEnded {
                    job_index,
                    source: failure,
                };
                return Err(Box::new(roll_back(
                    transaction,
                    failure,
                    vec![savepoint_failure],
                    stop,
                )));
            }
        }
    }
    if stop.is_stopped() {
        return Err(Box::new(roll_back(
            transaction,
            BatchFailure::Stopped,
            Vec::new(),
            stop,
        )));
    }
    // COMMIT runs through the transaction rather than `commit`, which consumes it, so a failed
    // commit that left the transaction open is still rolled back below.
    match transaction.execute_batch("COMMIT") {
        Ok(()) => Ok(()),
        Err(commit_failure) => Err(Box::new(roll_back(
            transaction,
            BatchFailure::Commit(commit_failure),
            Vec::new(),
            stop,
        ))),
    }
}

/// Rolls the batch back unless SQLite has already ended its transaction, and returns `failure`
/// beside `cleanup_failures` and the rollback's own failure.
fn roll_back(
    transaction: Transaction<'_>,
    failure: BatchFailure,
    mut cleanup_failures: Vec<rusqlite::Error>,
    stop: &ThreadStop,
) -> CleanupFailures<BatchFailure, rusqlite::Error> {
    if !transaction.is_autocommit()
        && let Err(rollback_failure) = transaction.rollback()
    {
        cleanup_failures.push(rollback_failure);
    }
    batch_failure(failure, cleanup_failures, stop)
}

/// `failure` beside `cleanup_failures`, read as [`BatchFailure::Stopped`] when the stop's own
/// interrupt caused it: once stopped, SQLite interrupted the batch's work, or, where that work
/// failed with no SQLite error of its own, a cleanup. Any other SQLite error is kept, so a damaged
/// file met past the drain bound is still reported.
fn batch_failure(
    failure: BatchFailure,
    cleanup_failures: Vec<rusqlite::Error>,
    stop: &ThreadStop,
) -> CleanupFailures<BatchFailure, rusqlite::Error> {
    let is_stops_own = stop.is_stopped()
        && match sqlite_error_code(&failure) {
            Some(code) => code == ErrorCode::OperationInterrupted,
            None => cleanup_failures
                .iter()
                .any(|cleanup_failure| is_interrupt(cleanup_failure)),
        };
    let failure = if is_stops_own {
        BatchFailure::Stopped
    } else {
        failure
    };
    CleanupFailures::new(failure, cleanup_failures, BATCH_OPERATION)
}

/// Runs one write under a savepoint of its own: released once its work is done, rolled back when
/// a statement refuses or fails it. The savepoint's statements run on the connection itself, so
/// each end is explicit and its failure seen.
fn run_job(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    job: &WriteJob,
    stop: &ThreadStop,
) -> JobEnd {
    if let Err(failure) = connection.execute_batch(OPEN_JOB_SAVEPOINT_SQL) {
        return settle_unkept(
            connection,
            false,
            UnkeptWrite::Failed(WriteJobFailure::Savepoint(failure)),
        );
    }
    match run_job_work(connection, encoder, job, stop) {
        Ok(outcome) => match connection.execute_batch(RELEASE_JOB_SAVEPOINT_SQL) {
            Ok(()) => JobEnd::Settled(outcome),
            Err(release_failure) if connection.is_autocommit() => {
                JobEnd::TransactionEnded(Some(WriteJobFailure::Savepoint(release_failure)))
            }
            Err(release_failure) => JobEnd::SavepointNotEnded {
                failure: None,
                savepoint_failure: release_failure,
            },
        },
        // The batch rolls back whole, taking the savepoint with it.
        Err(JobFault::Stopped) => JobEnd::Stopped,
        Err(JobFault::Unkept(unkept)) => settle_unkept(connection, true, unkept),
    }
}

/// Ends a write none of which is kept: its savepoint, when it opened one, rolls back and is
/// released. When SQLite has ended the whole transaction itself (a full disk, an I/O error, a
/// statement that ended it), the writes after this one would commit one by one, so the batch
/// fails instead.
fn settle_unkept(connection: &Connection, has_savepoint: bool, unkept: UnkeptWrite) -> JobEnd {
    if connection.is_autocommit() {
        return JobEnd::TransactionEnded(unkept.into_failure());
    }
    if !has_savepoint {
        return JobEnd::Settled(unkept.into_outcome());
    }
    match connection.execute_batch(UNDO_JOB_SAVEPOINT_SQL) {
        Ok(()) => JobEnd::Settled(unkept.into_outcome()),
        Err(savepoint_failure) => JobEnd::SavepointNotEnded {
            failure: unkept.into_failure(),
            savepoint_failure,
        },
    }
}

/// Runs a write's statements in order, then inserts its event rows in order, each at its
/// session's next sequence with its body encoded by `encoder`.
fn run_job_work(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    job: &WriteJob,
    stop: &ThreadStop,
) -> Result<WriteJobOutcome, JobFault> {
    let mut statement_results = Vec::with_capacity(job.statements.len());
    for (statement_index, statement) in job.statements.iter().enumerate() {
        if stop.is_stopped() {
            return Err(JobFault::Stopped);
        }
        let result = run_statement(connection, statement).map_err(|source| {
            JobFault::Unkept(UnkeptWrite::Failed(WriteJobFailure::Statement {
                statement_index,
                source,
            }))
        })?;
        if statement
            .expected_row_count
            .is_some_and(|expected| expected != result.row_count)
        {
            return Err(JobFault::Unkept(UnkeptWrite::Refused {
                statement_index,
                row_count: result.row_count,
            }));
        }
        statement_results.push(result);
    }
    let mut sequences = Vec::with_capacity(job.events.len());
    for event in &job.events {
        if stop.is_stopped() {
            return Err(JobFault::Stopped);
        }
        let sequence = insert_session_event(connection, encoder, event).map_err(|failure| {
            JobFault::Unkept(UnkeptWrite::Failed(WriteJobFailure::EventRow(failure)))
        })?;
        sequences.push(sequence);
    }
    Ok(WriteJobOutcome::Committed {
        statement_results,
        sequences,
    })
}

/// Runs one statement through the connection's statement cache with its bindings.
fn run_statement(
    connection: &Connection,
    statement: &WriteStatement,
) -> rusqlite::Result<StatementResult> {
    let mut prepared = connection.prepare_cached(&statement.sql)?;
    match &statement.bindings {
        StatementBindings::None => run_bound(&mut prepared, ()),
        StatementBindings::Positional(values) => run_bound(&mut prepared, params_from_iter(values)),
        StatementBindings::Named(values) => {
            run_bound(&mut prepared, named_bindings(values).as_slice())
        }
    }
}

/// Runs `prepared` with `params`: a statement that returns columns has its rows collected and
/// counted; any other reports the rows it changed.
fn run_bound(
    prepared: &mut Statement<'_>,
    params: impl Params,
) -> rusqlite::Result<StatementResult> {
    let column_count = prepared.column_count();
    if column_count == 0 {
        return Ok(StatementResult {
            row_count: prepared.execute(params)?,
            ..StatementResult::default()
        });
    }
    let column_names = prepared
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut rows = Vec::new();
    let mut returned = prepared.query(params)?;
    while let Some(row) = returned.next()? {
        rows.push(
            (0..column_count)
                .map(|column| row.get::<_, Value>(column))
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    Ok(StatementResult {
        row_count: rows.len(),
        column_names,
        rows,
    })
}

/// Runs a WAL checkpoint in `mode`. A checkpoint calls the busy handler while a reader holds an
/// older snapshot, which would hold the connection, and every write behind it, for the whole busy
/// timeout; with none it answers busy at once. The timeout is put back whatever the checkpoint
/// does.
pub(super) fn checkpoint(connection: &Connection, mode: CheckpointMode) -> CheckpointAnswer {
    let alone = |failure: rusqlite::Error| -> CleanupFailures<rusqlite::Error> {
        CleanupFailures::new(failure, Vec::new(), CHECKPOINT_OPERATION)
    };
    let busy_timeout: i64 = connection
        .pragma_query_value(None, "busy_timeout", |row| row.get(0))
        .map_err(alone)?;
    connection
        .pragma_update(None, "busy_timeout", 0)
        .map_err(alone)?;
    let checkpointed = connection
        .prepare_cached(&format!("PRAGMA wal_checkpoint({})", mode.as_sql()))
        .and_then(|mut statement| {
            statement.query_row([], |row| {
                Ok(CheckpointResult {
                    is_busy: row.get::<_, i64>(0)? != 0,
                    log_frames: row.get(1)?,
                    checkpointed_frames: row.get(2)?,
                })
            })
        });
    let restored = connection.pragma_update(None, "busy_timeout", busy_timeout);
    match (checkpointed, restored) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(_result), Err(restore_failure)) => Err(alone(restore_failure)),
        (Err(failure), Ok(())) => Err(alone(failure)),
        (Err(failure), Err(restore_failure)) => Err(CleanupFailures::new(
            failure,
            vec![restore_failure],
            CHECKPOINT_OPERATION,
        )),
    }
}
