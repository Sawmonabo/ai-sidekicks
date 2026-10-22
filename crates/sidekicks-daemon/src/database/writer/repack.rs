//! The repack after `Delete old data`: on the writer's thread, between batches so no statement of
//! the connection is stepping, it reads the file's page figures, truncates the write-ahead log,
//! runs `VACUUM` and reads the figures again; the job then truncates the log the `VACUUM` wrote,
//! retried until it succeeds, which is when the file shrinks. The job runs only while the data
//! folder's volume has free room of at least twice the file, since a `VACUUM` can need that much;
//! otherwise it is skipped with one service-log line, and the next purge's repack tries again, as
//! it does after a refused `VACUUM`. A run going live while it repacks cancels it: the `VACUUM`
//! checks the cancel every thousand instructions and the queue interrupts it, so it rolls back
//! whether the cancel came before it began or while it ran, and the next purge's repack tries
//! again. It is metered against the backup's budget, since a `VACUUM` copies the store.

use std::convert::Infallible;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::Connection;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::artifacts::admission::VolumeFreeBytesReader;
use crate::cleanup_failures::CleanupFailures;
use crate::daemon::backup::run::BACKUP_BUDGET;
use crate::daemon::scheduler::ScheduledJobOutcome;
use crate::daemon::scheduler::budget::{
    JobWorkload, Measured, MeteredJobOutcome, ProcessorMeter, WorkUnit, metered_job,
};
use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::writer::thread::checkpoint;
use crate::database::writer::{DatabaseWriter, MaintenanceError, is_interrupt};
use crate::events::session::purge::checkpoint::WriteAheadLogTruncation;

const REPACK_OPERATION: &str = "repacking the database";

// The virtual-machine instructions the `VACUUM` runs between reads of its cancel: a few rows of its
// copy, so a cancel ends it within milliseconds while each read, a lock taken, stays rare.
const CANCEL_CHECK_INSTRUCTIONS: i32 = 1_000;

/// The database file's page figures, as SQLite reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DatabasePages {
    /// The pages the database holds.
    pub(crate) page_count: i64,
    /// Each page's size in bytes.
    pub(crate) page_size: i64,
    /// The pages that hold nothing.
    pub(crate) freelist_count: i64,
}

impl DatabasePages {
    /// The database's size in bytes, `page_count × page_size`.
    pub(crate) fn size_bytes(self) -> i64 {
        self.page_count.saturating_mul(self.page_size)
    }
}

/// How one repack ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RepackEnd {
    /// The `VACUUM` committed.
    Repacked(RepackReport),
    /// It was canceled before it started, or interrupted, its `VACUUM` rolled back.
    Interrupted,
}

/// What one repack did: the figures before and after its `VACUUM`, and its first truncation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RepackReport {
    /// The figures before the repack.
    pub(crate) before: DatabasePages,
    /// The figures once the `VACUUM` committed.
    pub(crate) after: DatabasePages,
    /// The truncation before the `VACUUM`; busy while a reader held an older snapshot.
    pub(crate) first_truncation: CheckpointResult,
}

/// The thread's answer to one repack: how it ended with the thread's processor time around its
/// statements, or the failure of a step, beside the failure of putting the busy timeout back when
/// that failed too.
pub(crate) type RepackAnswer = Result<Measured<RepackEnd>, CleanupFailures<rusqlite::Error>>;

/// Repacks the file on the writer's connection, between batches, unless `cancel` is canceled
/// already; a `VACUUM` the cancel or SQLite's interrupt stopped reads as
/// [`RepackEnd::Interrupted`]. A refused `VACUUM` fails it with SQLite's error and changes nothing.
pub(super) fn repack(
    connection: &Connection,
    cancel: &CancellationToken,
) -> Result<RepackEnd, CleanupFailures<rusqlite::Error>> {
    if cancel.is_cancelled() {
        return Ok(RepackEnd::Interrupted);
    }
    match repack_now(connection, cancel) {
        Err(failure) if cancel.is_cancelled() && is_interrupt(failure.original()) => {
            Ok(RepackEnd::Interrupted)
        }
        repacked => repacked.map(RepackEnd::Repacked),
    }
}

fn repack_now(
    connection: &Connection,
    cancel: &CancellationToken,
) -> Result<RepackReport, CleanupFailures<rusqlite::Error>> {
    let alone =
        |failure: rusqlite::Error| CleanupFailures::new(failure, Vec::new(), REPACK_OPERATION);
    let before = read_pages(connection).map_err(alone)?;
    let first_truncation = checkpoint(connection, CheckpointMode::Truncate)?;
    vacuum(connection, cancel)?;
    let after = read_pages(connection).map_err(alone)?;
    Ok(RepackReport {
        before,
        after,
        first_truncation,
    })
}

// Runs `VACUUM` with a progress handler that stops it once `cancel` is canceled, which catches a
// cancel that came after the repack's first check, where an interrupt between statements is lost;
// the handler is removed after, on the failure's path too, so no batch pays for it.
fn vacuum(
    connection: &Connection,
    cancel: &CancellationToken,
) -> Result<(), CleanupFailures<rusqlite::Error>> {
    let alone =
        |failure: rusqlite::Error| CleanupFailures::new(failure, Vec::new(), REPACK_OPERATION);
    let watched = cancel.clone();
    connection
        .progress_handler(
            CANCEL_CHECK_INSTRUCTIONS,
            Some(move || watched.is_cancelled()),
        )
        .map_err(alone)?;
    let vacuumed = connection.execute_batch("VACUUM");
    let removed = connection.progress_handler(0, None::<fn() -> bool>);
    match (vacuumed, removed) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(removal_failure)) => Err(alone(removal_failure)),
        (Err(failure), Ok(())) => Err(alone(failure)),
        (Err(failure), Err(removal_failure)) => Err(CleanupFailures::new(
            failure,
            vec![removal_failure],
            REPACK_OPERATION,
        )),
    }
}

fn read_pages(connection: &Connection) -> rusqlite::Result<DatabasePages> {
    let read = |pragma: &str| connection.pragma_query_value(None, pragma, |row| row.get(0));
    Ok(DatabasePages {
        page_count: read("page_count")?,
        page_size: read("page_size")?,
        freelist_count: read("freelist_count")?,
    })
}

/// What the repack job reads and runs through.
pub(crate) struct RepackJobDeps {
    /// The writer whose connection repacks.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The write-ahead log's truncation, which reclaims the log the `VACUUM` wrote.
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    /// The database file.
    pub(crate) database_path: PathBuf,
    /// Reads the free room on the volume holding the database.
    pub(crate) read_volume_free_bytes: VolumeFreeBytesReader,
    /// The count of live runs; one going live cancels the repack.
    pub(crate) live_runs: watch::Receiver<u32>,
}

/// The repack job a purge schedules, metered against [`BACKUP_BUDGET`]: skipped with one
/// service-log line unless the volume has free room of at least twice the file; a refused
/// `VACUUM`, and one a run going live or the scheduler's stop interrupted, is written to the
/// service log and tried after the next purge. Fails only when the writer has ended or closed.
pub(crate) fn repack_job(
    deps: Arc<RepackJobDeps>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    metered_job(
        BACKUP_BUDGET,
        Box::new(move |stop, meter| run_repack(Arc::clone(&deps), stop, meter).boxed()),
    )
}

async fn run_repack(
    deps: Arc<RepackJobDeps>,
    stop: CancellationToken,
    meter: ProcessorMeter,
) -> MeteredJobOutcome {
    if !has_room_to_repack(&deps, &meter).await {
        return Ok(None);
    }
    let cancel = CancellationToken::new();
    let mut live_runs = deps.live_runs.clone();
    // Cancels the repack once a run goes live or the scheduler stops, then waits for its answer,
    // which always comes, so the repack is never dropped while it runs.
    let gives_way = async {
        tokio::select! {
            () = stop.cancelled() => {}
            Ok(_) = live_runs.wait_for(|count| *count > 0) => {}
        }
        cancel.cancel();
        std::future::pending::<Infallible>().await
    };
    let repacked = tokio::select! {
        repacked = deps.writer.repack(cancel.clone()) => repacked,
        never = gives_way => match never {},
    };
    match repacked {
        Ok(measured) => {
            meter.add(measured.processor_time);
            let RepackEnd::Repacked(report) = measured.report else {
                tracing::info!(
                    "the database's repack gave way to a run or the stop; the next purge tries \
                     again"
                );
                return Ok(None);
            };
            deps.truncation.request();
            tracing::info!(
                size_bytes_before = report.before.size_bytes(),
                free_pages_before = report.before.freelist_count,
                size_bytes_after = report.after.size_bytes(),
                free_pages_after = report.after.freelist_count,
                "the database was repacked"
            );
            let store_bytes = u64::try_from(report.before.size_bytes()).unwrap_or(0);
            Ok(Some(JobWorkload::of(WorkUnit::StoreBytes, store_bytes)))
        }
        Err(MaintenanceError::Failed(failure)) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the database's repack was refused; the next purge tries again"
            );
            Ok(None)
        }
        Err(failure) => Err(failure.into()),
    }
}

// Whether the volume holds at least twice the file free; a figure that cannot be read is written
// to the service log and skips the repack.
async fn has_room_to_repack(deps: &RepackJobDeps, meter: &ProcessorMeter) -> bool {
    let database_path = deps.database_path.clone();
    let read_volume_free_bytes = deps.read_volume_free_bytes;
    let figures = meter
        .run_blocking(move || {
            let file_bytes = std::fs::metadata(&database_path)?.len();
            let folder = database_path.parent().unwrap_or(&database_path);
            Ok::<_, std::io::Error>((file_bytes, read_volume_free_bytes(folder)?))
        })
        .await;
    match figures {
        Ok(Ok((file_bytes, free_bytes))) if free_bytes >= file_bytes.saturating_mul(2) => true,
        Ok(Ok((file_bytes, free_bytes))) => {
            tracing::info!(
                file_bytes,
                free_bytes,
                "the database's repack was skipped: the volume has less than twice the file free; \
                 the next purge tries again"
            );
            false
        }
        Ok(Err(failure)) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the database's repack was skipped: the file or its volume could not be measured"
            );
            false
        }
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the database's repack was skipped: its measure did not finish"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests;
