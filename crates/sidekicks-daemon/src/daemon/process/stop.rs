//! The daemon's stop in its two steps, which the erase also runs one by one: the work ends within
//! the drain bound, then everything that holds a file in the data folder closes. Each step takes
//! the parts it closes, so a step run again skips what is already closed.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::task::JoinError;

use crate::daemon::process::database::{DatabaseFileCloseFailure, close_database_file};
use crate::daemon::process::providers::{ProvidersRegistrationStopFailure, shut_down_drivers};
use crate::daemon::process::{DAEMON_STOP_DRAIN_BOUND, DaemonProcess};
use sidekicks_provider::driver::contract::DriverError;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_session::search::index::live::LiveIndexCloseError;
use sidekicks_workspace::clone::askpass::broker::AskpassBrokerError;

/// Why a step of the stop failed; every other step still ran.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStopFailure {
    /// The crash monitor could not be ended, or its socket stayed.
    #[error(transparent)]
    CrashMonitor(#[from] CrashMonitorEndFailure),
    /// A step of the database file's close failed.
    #[error(transparent)]
    DatabaseFile(#[from] DatabaseFileCloseFailure),
    /// Mutating calls were still running when the drain bound ran out.
    #[error("{0} mutating calls were still running when the stop's drain bound ran out")]
    MutatingCallsRunning(usize),
    /// The capability refresh's task ended abnormally.
    #[error("the capability refresh ended abnormally")]
    CapabilityRefresh(#[source] JoinError),
    /// The providers' registration did not end cleanly.
    #[error(transparent)]
    ProvidersRegistration(#[from] ProvidersRegistrationStopFailure),
    /// The scheduler's task ended abnormally.
    #[error("the scheduler ended abnormally")]
    Scheduler(#[source] JoinError),
    /// The session search index did not close cleanly.
    #[error("the session search index did not close cleanly")]
    SearchIndex(#[source] Arc<LiveIndexCloseError>),
    /// A driver's shutdown failed.
    #[error("a provider's driver did not shut down cleanly")]
    Driver(#[source] DriverError),
    /// A service's background task ended abnormally.
    #[error(transparent)]
    Task(#[from] TaskStopFailure),
    /// The askpass broker's listening task ended abnormally at its close.
    #[error(transparent)]
    Askpass(#[from] AskpassBrokerError),
}

/// A service's background task, a follow of the log among them, that ended abnormally at the stop.
#[derive(Debug, thiserror::Error)]
#[error("the {task} ended abnormally at the stop")]
pub(crate) struct TaskStopFailure {
    /// What the task does, in plain words.
    pub(crate) task: &'static str,
    /// How it ended.
    #[source]
    pub(crate) error: JoinError,
}

/// Why the crash monitor's end failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CrashMonitorEndFailure {
    /// The monitor could not be killed.
    #[error("the crash monitor could not be ended")]
    Kill(#[source] io::Error),
    /// The monitor did not exit within its end's bound.
    #[error("the crash monitor did not end within {0:?}")]
    StillRunning(Duration),
    /// The monitor's socket stayed in the run folder.
    #[error("the crash monitor's socket {} could not be removed", path.display())]
    Socket {
        /// The socket's path.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
}

/// Ends the daemon's work: the stop token, so the work under way ends; the socket, so no new call
/// comes; then, within what is left of `bound`, the mutating calls under way, the capability
/// refresh, the providers' registration, the repository services' background work, the chats'
/// write watch and file recount, the scheduler, the working-folder watch, the askpass broker, the
/// search index, the drivers and the git trees a failed call left. Answers each step's failure,
/// every step having run.
pub(crate) async fn stop_work(
    process: &mut DaemonProcess,
    intent: DaemonStopIntent,
    bound: Duration,
) -> Vec<DaemonStopFailure> {
    let started = *process.stop_started.get_or_insert_with(Instant::now);
    tracing::info!(
        ?intent,
        drain_bound_ms = bound.as_millis(),
        "the background service stops"
    );
    process.process_state.mark_stopping();
    process.work_stop.cancel();
    if let Some(gateway) = process.gateway.take() {
        gateway.stop().await;
    }
    let remaining = || bound.saturating_sub(started.elapsed());
    let mut failures = Vec::new();
    if let Some(in_flight) = process.in_flight.take() {
        let running = in_flight.wait_for_pending_within(None, remaining()).await;
        if running > 0 {
            failures.push(DaemonStopFailure::MutatingCallsRunning(running));
        }
    }
    let drivers = match process.providers.take() {
        Some(providers) => {
            if let Err(failure) = providers.refreshing.stop().await {
                failures.push(DaemonStopFailure::CapabilityRefresh(failure));
            }
            Some(providers.registry)
        }
        None => None,
    };
    if let Some(registration) = process.providers_registration.take()
        && let Err(failure) = registration.stop(remaining()).await
    {
        failures.push(failure.into());
    }
    // Before the scheduler, whose tick wakes the health re-probe.
    if let (Some(repo_attachments), Some(repo)) = (process.repo_attachments.take(), &process.repo)
        && let Some(failure) = repo_attachments.stop(repo).await
    {
        failures.push(failure.into());
    }
    if let Some(repo) = &process.repo
        && let Err(error) = repo.workspaces.stop().await
    {
        failures.push(
            TaskStopFailure {
                task: "chats' file recount",
                error,
            }
            .into(),
        );
    }
    // Before the drivers, since a job it runs may still call into them.
    if let Some(scheduler) = process.scheduler.take()
        && let Err(failure) = scheduler.stop().await
    {
        failures.push(DaemonStopFailure::Scheduler(failure));
    }
    if let Some(repo) = &mut process.repo {
        repo.folder_watch.stop().await;
        if let Some(broker) = repo.askpass.take()
            && let Err(failure) = broker.close().await
        {
            failures.push(failure.into());
        }
    }
    if let Some(search_index) = process.search_index.take()
        && let Err(failure) = search_index.close().await
    {
        failures.push(DaemonStopFailure::SearchIndex(failure));
    }
    if let Some(drivers) = drivers {
        failures.extend(
            shut_down_drivers(&drivers, intent)
                .await
                .into_iter()
                .map(DaemonStopFailure::Driver),
        );
    }
    if let Some(service_inputs) = &process.service_inputs {
        service_inputs.git.wait_for_tree_ends().await;
    }
    // After the drain, so every child it ended is still retired.
    drop(process.orphan_guard.take());
    process.has_stop_failed |= !failures.is_empty();
    failures
}

/// Closes everything that holds a file in the data folder: lets the repository services go, then
/// closes the database file within what is left of the drain bound, ends the crash monitor,
/// waiting for its exit, and removes its socket from the run folder, then lets the data folder's
/// lock go last. Answers each step's failure, every step having run.
pub(crate) async fn close_data_folder(process: &mut DaemonProcess) -> Vec<DaemonStopFailure> {
    let mut failures = Vec::new();
    // Their pools and writer handles go before the file closes.
    drop(process.repo.take());
    if let Some(database) = process.database.take() {
        let remaining = DAEMON_STOP_DRAIN_BOUND.saturating_sub(
            process
                .stop_started
                .map_or(Duration::ZERO, |started| started.elapsed()),
        );
        failures.extend(
            close_database_file(database, remaining, process.has_stop_failed)
                .await
                .into_iter()
                .map(DaemonStopFailure::from),
        );
    }
    // Before the lock goes, so a start that takes the lock next meets no monitor of this one.
    if let Some(crash_monitor) = process.crash_monitor.take() {
        failures.extend(crash_monitor.end().await);
    }
    drop(process.data_folder_lock.take());
    failures
}
