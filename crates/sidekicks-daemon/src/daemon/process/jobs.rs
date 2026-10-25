//! The background jobs the start schedules once its recovery pass has ended: the writer's passive
//! checkpoint and daily optimize, the hourly diagnostic-log expiry, the crash report pass at once
//! and then on the expiry's tick, and the daily backup.

use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::daemon::backup::run::Backups;
use crate::daemon::crash::reports::{CrashReportDeps, crash_report_job};
use crate::daemon::machine::settings::file::MachineSettingsFile;
use crate::daemon::release_version::this_build_release_version;
use crate::daemon::scheduler::{JobCondition, ScheduleError, Scheduler};
use crate::database::writer::DatabaseWriter;
use crate::database::writer::jobs::{OPTIMIZE_INTERVAL, PASSIVE_CHECKPOINT_INTERVAL};
use crate::observability::diagnostic_buckets::expiry::{
    DIAGNOSTIC_LOG_EXPIRY_INTERVAL, DiagnosticExpiryDeps, diagnostic_expiry_job,
};

/// How often the crash report pass runs after its first: on the diagnostic-log expiry's tick, so a
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
#[expect(
    dead_code,
    reason = "the daemon's start, which schedules the jobs once its recovery pass has ended"
)]
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
