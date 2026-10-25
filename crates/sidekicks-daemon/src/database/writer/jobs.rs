//! The writer's scheduled maintenance: the passive WAL checkpoint every five minutes, and the
//! daily `PRAGMA optimize` a long-lived connection runs to keep its query planner's statistics
//! current. Each run is metered against its processor budget.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::daemon::scheduler::ScheduledJobOutcome;
use crate::daemon::scheduler::budget::{
    BudgetTerm, JobBudget, JobWorkload, Measured, WorkUnit, metered_job,
};
use crate::database::checkpoint::CheckpointMode;
use crate::database::writer::{DatabaseWriter, MaintenanceError};

/// How often the passive WAL checkpoint job runs on the scheduler.
pub(crate) const PASSIVE_CHECKPOINT_INTERVAL: Duration = Duration::from_mins(5);

/// The passive checkpoint's processor budget: 250 ms per 64 MiB of log it moves into the store.
const PASSIVE_CHECKPOINT_BUDGET: JobBudget = JobBudget::new(&[BudgetTerm {
    figure: Duration::from_millis(250),
    per: 64 * 1024 * 1024,
    unit: WorkUnit::CheckpointedLogBytes,
}]);

/// How often the writer runs `PRAGMA optimize`: once a day, as SQLite advises for a long-lived
/// connection, the first a day after the start, whose open already ran it.
pub(crate) const OPTIMIZE_INTERVAL: Duration = Duration::from_hours(24);

/// The optimize's processor budget: 100 ms a run. It is usually a no-op, and where it analyzes a
/// table its temporary analysis limit bounds the scan, so a run's cost does not grow with the file.
const OPTIMIZE_BUDGET: JobBudget = JobBudget::new(&[BudgetTerm {
    figure: Duration::from_millis(100),
    per: 1,
    unit: WorkUnit::Runs,
}]);

impl DatabaseWriter {
    /// The scheduler's passive WAL checkpoint job, run every [`PASSIVE_CHECKPOINT_INTERVAL`] and
    /// metered against its budget; each run fails as [`DatabaseWriter::checkpoint`] does.
    pub(crate) fn passive_checkpoint_job(
        writer: Arc<Self>,
    ) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static
    {
        // The checkpoint waits for the batch in flight, so the scheduler's stop ends the wait; a
        // hold answers it at once, so the scheduler never waits a hold out.
        metered_job(
            PASSIVE_CHECKPOINT_BUDGET,
            Box::new(move |stop, meter| {
                let writer = Arc::clone(&writer);
                async move {
                    let checkpointed = tokio::select! {
                        biased;
                        () = stop.cancelled() => return Ok(None),
                        checkpointed = writer.checkpoint_measured(CheckpointMode::Passive) => {
                            checkpointed
                        }
                    };
                    match checkpointed {
                        Ok(Measured {
                            report,
                            processor_time,
                        }) => {
                            meter.add(processor_time);
                            tracing::debug!(
                                is_busy = report.result.is_busy,
                                log_frames = report.result.log_frames,
                                checkpointed_frames = report.result.checkpointed_frames,
                                moved_frames = report.moved_frames,
                                "the passive WAL checkpoint ran"
                            );
                            Ok(Some(JobWorkload::of(
                                WorkUnit::CheckpointedLogBytes,
                                report.checkpointed_bytes(),
                            )))
                        }
                        Err(MaintenanceError::Held) => {
                            tracing::debug!(
                                "the passive WAL checkpoint did not run: the writer holds its \
                                 writes"
                            );
                            Ok(None)
                        }
                        Err(failure) => Err(failure.into()),
                    }
                }
                .boxed()
            }),
        )
    }

    /// The scheduler's daily optimize job, run every [`OPTIMIZE_INTERVAL`] and metered against its
    /// budget; each run fails as [`DatabaseWriter::optimize`] does.
    pub(crate) fn optimize_job(
        writer: Arc<Self>,
    ) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static
    {
        // The optimize waits for the batch in flight and any hold, so the scheduler's stop ends
        // the wait.
        metered_job(
            OPTIMIZE_BUDGET,
            Box::new(move |stop, meter| {
                let writer = Arc::clone(&writer);
                async move {
                    let optimized = tokio::select! {
                        biased;
                        () = stop.cancelled() => return Ok(None),
                        optimized = writer.optimize() => optimized?,
                    };
                    meter.add(optimized.processor_time);
                    Ok(Some(JobWorkload::of(WorkUnit::Runs, 1)))
                }
                .boxed()
            }),
        )
    }
}
