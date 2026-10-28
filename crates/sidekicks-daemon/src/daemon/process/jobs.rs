//! The background jobs the start schedules once its recovery pass has ended: the writer's passive
//! checkpoint and daily optimize, the hourly diagnostic-log expiry, the crash report pass at once
//! and then hourly, and the daily backup; and the one-shot collect that hands freed memory back
//! once the daemon's work goes quiet.

use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use sidekicks_std::scheduler::{JobCondition, ScheduleError, Scheduler};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::jobs::{OPTIMIZE_INTERVAL, PASSIVE_CHECKPOINT_INTERVAL};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::daemon::backup::run::Backups;
use crate::daemon::crash::reports::{CrashReportDeps, crash_report_job};
use crate::daemon::machine_settings::file::MachineSettingsFile;
use crate::daemon::release_version::this_build_release_version;
use crate::observability::diagnostic_buckets::expiry::{
    DIAGNOSTIC_LOG_EXPIRY_INTERVAL, DiagnosticExpiryDeps, diagnostic_expiry_job,
};

/// How often the crash report pass runs after its first: hourly, as the diagnostic-log expiry, so a
/// dump a crash left is reported within the hour.
const CRASH_REPORT_INTERVAL: Duration = DIAGNOSTIC_LOG_EXPIRY_INTERVAL;

/// What the jobs run on.
pub(crate) struct JobDeps {
    /// The writer whose connection checkpoints and optimizes the file.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// What the diagnostic-log expiry reads.
    pub(crate) diagnostic_expiry: Arc<DiagnosticExpiryDeps>,
    /// The data folder, which holds the crash dumps and their reports.
    pub(crate) data_folder: PathBuf,
    /// The settings file holding `Keep crash reports`.
    pub(crate) settings: Arc<MachineSettingsFile>,
    /// The service's backups, whose daily run is scheduled here.
    pub(crate) backups: Arc<Backups>,
}

/// Why a job could not be scheduled.
#[derive(Debug, thiserror::Error)]
pub(crate) enum JobScheduleError {
    /// The scheduler refused a job.
    #[error(transparent)]
    Schedule(#[from] ScheduleError),
    /// The daily backup could not be scheduled: its last run did not read, or the scheduler
    /// refused it.
    #[error("the daily backup could not be scheduled")]
    DailyBackup(#[source] Box<dyn Error + Send + Sync>),
}

/// Schedules every background job on `scheduler`, each run whenever it falls due: the passive
/// checkpoint every five minutes, the optimize a day after the start and daily after, the
/// diagnostic-log expiry and the crash report pass at once and then hourly, and the daily backup.
/// Fails with the first job the scheduler refuses.
pub(crate) async fn schedule_jobs(
    scheduler: &Arc<Scheduler>,
    deps: JobDeps,
) -> Result<(), JobScheduleError> {
    let JobDeps {
        writer,
        diagnostic_expiry,
        data_folder,
        settings,
        backups,
    } = deps;
    scheduler.schedule_repeating(
        "passive checkpoint",
        JobCondition::Always,
        PASSIVE_CHECKPOINT_INTERVAL,
        PASSIVE_CHECKPOINT_INTERVAL,
        DatabaseWriter::passive_checkpoint_job(Arc::clone(&writer)),
    )?;
    // The writer's open ran the optimize, so the first scheduled one waits a day.
    scheduler.schedule_repeating(
        "database optimize",
        JobCondition::Always,
        OPTIMIZE_INTERVAL,
        OPTIMIZE_INTERVAL,
        DatabaseWriter::optimize_job(writer),
    )?;
    scheduler.schedule_repeating(
        "diagnostic log expiry",
        JobCondition::Always,
        DIAGNOSTIC_LOG_EXPIRY_INTERVAL,
        Duration::ZERO,
        diagnostic_expiry_job(diagnostic_expiry),
    )?;
    // One release ships the app and the service, so both carry this build's version; a dump that
    // names its own version keeps it.
    let version = this_build_release_version().as_str().to_owned();
    scheduler.schedule_repeating(
        "crash reports",
        JobCondition::Always,
        CRASH_REPORT_INTERVAL,
        Duration::ZERO,
        crash_report_job(Arc::new(CrashReportDeps {
            data_folder,
            settings,
            app_version: version.clone(),
            service_version: version,
        })),
    )?;
    backups
        .schedule_daily(scheduler)
        .await
        .map_err(JobScheduleError::DailyBackup)?;
    Ok(())
}

/// How long the daemon's work stays quiet before its freed memory is handed back: past the
/// allocator's own purge delay, so a burst's frees settle first.
const IDLE_COLLECT_DELAY: Duration = Duration::from_secs(10);

/// Hands the memory the daemon freed back to the system once, when no run is live and no call is
/// in flight for [`IDLE_COLLECT_DELAY`]; new work resets the wait, and the next quiet arms it
/// again. Dropping it ends the collect's task.
pub(crate) struct IdleMemoryCollect {
    calls: Arc<CallsInFlight>,
    _collect: AbortOnDropHandle<()>,
}

/// One call the daemon is serving; while any is held the collect waits.
pub(crate) struct CallInFlight {
    calls: Arc<CallsInFlight>,
}

// The calls in flight, and the wake-up for the collect's task when the count leaves or reaches 0.
#[derive(Default)]
struct CallsInFlight {
    count: AtomicU32,
    moved: Notify,
}

impl IdleMemoryCollect {
    /// Starts the collect over `live_runs`, the writer's count of live runs; it ends with `stop`.
    pub(crate) fn start(live_runs: watch::Receiver<u32>, stop: CancellationToken) -> Self {
        let calls = Arc::new(CallsInFlight::default());
        let collect = tokio::spawn(collect_when_quiet(live_runs, Arc::clone(&calls), stop));
        Self {
            calls,
            _collect: AbortOnDropHandle::new(collect),
        }
    }

    /// Marks a call in flight until the answer is dropped, so the collect waits for it.
    pub(crate) fn touch(&self) -> CallInFlight {
        if self.calls.count.fetch_add(1, Ordering::AcqRel) == 0 {
            self.calls.moved.notify_one();
        }
        CallInFlight {
            calls: Arc::clone(&self.calls),
        }
    }
}

impl Drop for CallInFlight {
    fn drop(&mut self) {
        if self.calls.count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.calls.moved.notify_one();
        }
    }
}

// Waits for the work to go quiet, then for it to stay quiet for the delay, any new work starting
// the wait again; collects once, then waits for any movement of the work, however brief, before it
// arms again. Ends with `stop`, or once the writer that counts the live runs is gone.
async fn collect_when_quiet(
    mut live_runs: watch::Receiver<u32>,
    calls: Arc<CallsInFlight>,
    stop: CancellationToken,
) {
    let is_quiet = |live_runs: &mut watch::Receiver<u32>| {
        *live_runs.borrow_and_update() == 0 && calls.count.load(Ordering::Acquire) == 0
    };
    loop {
        while !is_quiet(&mut live_runs) {
            if !wait_for_work_moved(&mut live_runs, &calls, &stop).await {
                return;
            }
        }
        let is_moved = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            moved = live_runs.changed() => {
                if moved.is_err() {
                    return;
                }
                true
            }
            () = calls.moved.notified() => true,
            () = tokio::time::sleep(IDLE_COLLECT_DELAY) => false,
        };
        if is_moved {
            continue;
        }
        if let Err(failure) =
            tokio::task::spawn_blocking(sidekicks_platforms::collect_freed_memory).await
        {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "handing freed memory back to the system ended before it finished"
            );
        }
        // A call that came and went before this task woke still moved the count, so it re-arms.
        if !wait_for_work_moved(&mut live_runs, &calls, &stop).await {
            return;
        }
    }
}

// Waits until the live-run count or the calls in flight move; false once `stop` fires or the
// writer is gone.
async fn wait_for_work_moved(
    live_runs: &mut watch::Receiver<u32>,
    calls: &CallsInFlight,
    stop: &CancellationToken,
) -> bool {
    tokio::select! {
        biased;
        () = stop.cancelled() => false,
        moved = live_runs.changed() => moved.is_ok(),
        () = calls.moved.notified() => true,
    }
}
