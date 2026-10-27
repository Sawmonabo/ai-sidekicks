//! The online copy of the database on the writer's thread: SQLite's backup steps a bounded count
//! of pages at a time from the writer's own connection, and between steps the thread serves the
//! request waiting, so writes go on while the copy lives and SQLite carries each one into the copy;
//! a write through any other connection would restart it, and the writer's is the only one. A
//! step that meets a lock is stepped again once the thread has served the next request or 250 ms
//! have passed, whichever comes first, on a runtime timer that never sleeps the thread, and a copy
//! whose steps have met a lock for the bound running (ten minutes) ends naming it. A canceled copy
//! stops before its next step. The copy's file opens in SQLite's default rollback mode, since a
//! WAL copy whose page size differs is refused, with no busy timeout, so a step meeting a lock
//! answers at once.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use rusqlite::backup::{Backup, StepResult};
use tokio::runtime::Handle;
use tokio::sync::mpsc::{self, error::TryRecvError};
use tokio_util::sync::CancellationToken;

use crate::database::writer::ThreadStop;
use crate::database::writer::messages::ThreadRequest;
use crate::database::writer::thread::{ThreadCommits, serve_request};
use crate::events::content::codec::BodyEncoder;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::scheduler::budget::{Measured, ThreadProcessorTime};

/// The pages one step copies, rusqlite's own step size.
const PAGES_PER_STEP: i32 = 100;

/// How long the steps may meet a lock before the copy ends.
pub(super) const LOCK_BOUND: Duration = Duration::from_mins(10);

// How long a step that met a lock waits for a request before it steps again, as SQLite's own
// online-backup example waits.
const LOCK_RETRY_AFTER: Duration = Duration::from_millis(250);

const BACKUP_OPERATION: &str = "copying the database";

/// The lock a step met.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupLock {
    /// Another connection held a lock the step needed (`SQLITE_BUSY`).
    Busy,
    /// The source connection was writing to the database (`SQLITE_LOCKED`).
    Locked,
}

impl BackupLock {
    /// The lock in the service's own words, for the run's failure.
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Self::Busy => "another connection held the database's lock for ten minutes",
            Self::Locked => "the database's own writes held its table lock for ten minutes",
        }
    }
}

/// How one copy ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupCopy {
    /// Every page was copied: the database's page count when the copy finished, the steps it took,
    /// which a copy restarted by a write through another connection would multiply, and the
    /// thread's commit count at the step that finished it.
    Copied {
        /// The pages copied.
        page_count: i64,
        /// The steps taken.
        step_count: u64,
        /// The thread's count of the batches that committed a write when the copy finished; the
        /// copy holds every such batch up to it and none after.
        copied_through: u64,
    },
    /// The steps met `lock` for the bound running; the copy is incomplete.
    HeldByLock(BackupLock),
    /// The copy was canceled, or the queue let the thread go, before the copy finished.
    Stopped,
}

/// The thread's answer to one copy: how it ended with the thread's processor time around its
/// steps, or SQLite's failure.
pub(crate) type BackupAnswer = Result<Measured<BackupCopy>, CleanupFailures<rusqlite::Error>>;

/// One copy as the thread runs it.
pub(super) struct CopyOrder<'order> {
    /// The copy's file, which must not exist yet.
    pub(super) destination: &'order Path,
    /// Canceled once the run that asked for the copy stops.
    pub(super) cancel: &'order CancellationToken,
    /// How long the steps may meet a lock before the copy ends.
    pub(super) lock_bound: Duration,
}

/// What the thread serves the copy's waiting requests with.
pub(super) struct ThreadServing<'serving> {
    /// The writer's connection, which the copy reads and the requests write.
    pub(super) connection: &'serving Connection,
    /// The thread's body encoder, for the batches served.
    pub(super) encoder: &'serving mut BodyEncoder,
    /// The requests the queue sends.
    pub(super) requests: &'serving mut mpsc::Receiver<ThreadRequest>,
    /// The writer's stop.
    pub(super) stop: &'serving ThreadStop,
    /// The runtime the thread waits on while a step's lock holds.
    pub(super) runtime: &'serving Handle,
    /// The batches that committed a write.
    pub(super) commits: &'serving mut ThreadCommits,
}

/// Copies the writer's database into `order`'s file, serving each request that waits between
/// steps. Answers how the copy ended and whether the queue is gone, so the thread stops serving.
/// Fails with SQLite's error when the copy's file cannot open or a step fails.
pub(super) fn copy_database(
    order: &CopyOrder<'_>,
    serving: &mut ThreadServing<'_>,
) -> (BackupAnswer, bool) {
    let alone =
        |failure: rusqlite::Error| CleanupFailures::new(failure, Vec::new(), BACKUP_OPERATION);
    let mut processor_time = ThreadProcessorTime::default();
    let measured = |report, processor_time| {
        Ok(Measured {
            report,
            processor_time,
        })
    };
    if order.cancel.is_cancelled() {
        return (measured(BackupCopy::Stopped, processor_time), false);
    }
    let mut copy = match Connection::open(order.destination) {
        Ok(copy) => copy,
        Err(failure) => return (Err(alone(failure)), false),
    };
    let stepped = match copy.busy_timeout(Duration::ZERO) {
        Ok(()) => step_until_done(order, serving, &mut copy, &mut processor_time),
        Err(failure) => (Err(failure), false),
    };
    let closed = copy.close().map_err(|(_copy, failure)| failure);
    match (stepped, closed) {
        ((Ok(copy_end), is_queue_gone), Ok(())) => {
            (measured(copy_end, processor_time), is_queue_gone)
        }
        ((Ok(_copy_end), is_queue_gone), Err(close_failure)) => {
            (Err(alone(close_failure)), is_queue_gone)
        }
        ((Err(failure), is_queue_gone), Ok(())) => (Err(alone(failure)), is_queue_gone),
        ((Err(failure), is_queue_gone), Err(close_failure)) => (
            Err(CleanupFailures::new(
                failure,
                vec![close_failure],
                BACKUP_OPERATION,
            )),
            is_queue_gone,
        ),
    }
}

// What ended the wait after a step that met a lock.
enum LockWait {
    Request(ThreadRequest),
    Canceled,
    BoundReached,
    RetryDue,
    QueueGone,
}

// Steps the copy until it is done, serving one waiting request after each step, and after a step
// that met a lock waiting for the next request, the cancel, the bound's end or the retry's time;
// each step's processor time is added to `processor_time`.
fn step_until_done(
    order: &CopyOrder<'_>,
    serving: &mut ThreadServing<'_>,
    copy: &mut Connection,
    processor_time: &mut ThreadProcessorTime,
) -> (rusqlite::Result<BackupCopy>, bool) {
    let backup = match Backup::new(serving.connection, copy) {
        Ok(backup) => backup,
        Err(failure) => return (Err(failure), false),
    };
    let mut held_since: Option<Instant> = None;
    let mut step_count = 0_u64;
    loop {
        if order.cancel.is_cancelled() || serving.stop.is_stopped() {
            return (Ok(BackupCopy::Stopped), false);
        }
        step_count += 1;
        let held = match processor_time.measure(|| backup.step(PAGES_PER_STEP)) {
            Ok(StepResult::Done) => {
                let page_count = i64::from(backup.progress().pagecount);
                return (
                    Ok(BackupCopy::Copied {
                        page_count,
                        step_count,
                        copied_through: serving.commits.count,
                    }),
                    false,
                );
            }
            Ok(StepResult::Busy) => Some(BackupLock::Busy),
            Ok(StepResult::Locked) => Some(BackupLock::Locked),
            Ok(_more) => None,
            Err(failure) => return (Err(failure), false),
        };
        let bound_end = if let Some(lock) = held {
            let since = *held_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= order.lock_bound {
                return (Ok(BackupCopy::HeldByLock(lock)), false);
            }
            Some(since + order.lock_bound)
        } else {
            held_since = None;
            None
        };
        let next = match (serving.requests.try_recv(), bound_end) {
            (Ok(request), _) => Some(request),
            (Err(TryRecvError::Disconnected), _) => return (Ok(BackupCopy::Stopped), true),
            (Err(TryRecvError::Empty), None) => None,
            (Err(TryRecvError::Empty), Some(bound_end)) => {
                match wait_past_lock(order.cancel, bound_end, serving) {
                    LockWait::Request(request) => Some(request),
                    LockWait::Canceled | LockWait::BoundReached | LockWait::RetryDue => None,
                    LockWait::QueueGone => return (Ok(BackupCopy::Stopped), true),
                }
            }
        };
        if let Some(request) = next
            && !serve_request(
                serving.connection,
                serving.encoder,
                request,
                serving.requests,
                serving.stop,
                serving.runtime,
                serving.commits,
            )
        {
            return (Ok(BackupCopy::Stopped), true);
        }
    }
}

// Waits on the runtime for the next request, the copy's cancel, `bound_end` or the retry's time,
// whichever comes first, so a step that met a lock is stepped again without a sleep of the thread,
// and a lock another connection lets go is passed with no request to wake the copy.
fn wait_past_lock(
    cancel: &CancellationToken,
    bound_end: Instant,
    serving: &mut ThreadServing<'_>,
) -> LockWait {
    let requests = &mut *serving.requests;
    let retry_at = Instant::now() + LOCK_RETRY_AFTER;
    serving.runtime.block_on(async {
        tokio::select! {
            biased;
            () = cancel.cancelled() => LockWait::Canceled,
            request = requests.recv() => request.map_or(LockWait::QueueGone, LockWait::Request),
            () = tokio::time::sleep_until(bound_end.into()) => LockWait::BoundReached,
            () = tokio::time::sleep_until(retry_at.into()) => LockWait::RetryDue,
        }
    })
}

#[cfg(test)]
mod tests;
