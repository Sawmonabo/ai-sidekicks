//! The repack after `Delete old data`: on the writer's thread, between batches so no statement of
//! the connection is stepping, it reads the file's page figures, truncates the write-ahead log,
//! runs `VACUUM` and reads the figures again; the job then truncates the log the `VACUUM` wrote,
//! retried until it succeeds, which is when the file shrinks. The job runs only while the data
//! folder's volume has free room of at least twice the file, since a `VACUUM` can need that much;
//! otherwise it is skipped with one service-log line, and the next purge's repack tries again, as
//! it does after a refused `VACUUM`.

use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

use crate::artifacts::admission::VolumeFreeBytesReader;
use crate::cleanup_failures::CleanupFailures;
use crate::daemon::scheduler::ScheduledJobOutcome;
use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::writer::thread::checkpoint;
use crate::database::writer::{DatabaseWriter, MaintenanceError};
use crate::events::session::purge::checkpoint::WriteAheadLogTruncation;

const REPACK_OPERATION: &str = "repacking the database";

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

/// The thread's answer to one repack: its report, or the failure of a step, beside the failure of
/// putting the busy timeout back when that failed too.
pub(crate) type RepackAnswer = Result<RepackReport, CleanupFailures<rusqlite::Error>>;

/// Repacks the file on the writer's connection, between batches. A refused `VACUUM` fails it with
/// SQLite's error and changes nothing.
pub(super) fn repack(connection: &Connection) -> RepackAnswer {
    let alone =
        |failure: rusqlite::Error| CleanupFailures::new(failure, Vec::new(), REPACK_OPERATION);
    let before = read_pages(connection).map_err(alone)?;
    let first_truncation = checkpoint(connection, CheckpointMode::Truncate)?;
    connection.execute_batch("VACUUM").map_err(alone)?;
    let after = read_pages(connection).map_err(alone)?;
    Ok(RepackReport {
        before,
        after,
        first_truncation,
    })
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
}

/// The body of the repack job a purge schedules: skipped with one service-log line unless the
/// volume has free room of at least twice the file; a refused `VACUUM` is written to the service
/// log and tried after the next purge. Fails only when the writer has ended or closed.
pub(crate) fn repack_job(
    deps: Arc<RepackJobDeps>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    move |stop| {
        let deps = Arc::clone(&deps);
        async move {
            if !has_room_to_repack(&deps).await {
                return Ok(());
            }
            let repacked = tokio::select! {
                biased;
                () = stop.cancelled() => return Ok(()),
                repacked = deps.writer.repack() => repacked,
            };
            match repacked {
                Ok(report) => {
                    deps.truncation.request();
                    tracing::info!(
                        size_bytes_before = report.before.size_bytes(),
                        free_pages_before = report.before.freelist_count,
                        size_bytes_after = report.after.size_bytes(),
                        free_pages_after = report.after.freelist_count,
                        "the database was repacked"
                    );
                    Ok(())
                }
                Err(MaintenanceError::Failed(failure)) => {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        "the database's repack was refused; the next purge tries again"
                    );
                    Ok(())
                }
                Err(failure) => Err(failure.into()),
            }
        }
        .boxed()
    }
}

// Whether the volume holds at least twice the file free; a figure that cannot be read is written
// to the service log and skips the repack.
async fn has_room_to_repack(deps: &RepackJobDeps) -> bool {
    let database_path = deps.database_path.clone();
    let read_volume_free_bytes = deps.read_volume_free_bytes;
    let figures = tokio::task::spawn_blocking(move || {
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
