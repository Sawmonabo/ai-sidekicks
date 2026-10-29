//! The daemon's stop in its two steps, which the erase also runs one by one: the work ends within
//! the drain bound, then everything that holds a file in the data folder closes. Each step takes
//! the parts it closes, so a step run again skips what is already closed.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_session::search::index::live::LiveIndexCloseError;
use sidekicks_workspace::clone::askpass::broker::AskpassBrokerError;
use sidekicks_workspace::git::worktree::setup::WorktreeSetupError;
use tokio::task::JoinError;

use crate::daemon::process::database::{DatabaseFileCloseFailure, close_database_file};
use crate::daemon::process::providers::{ProvidersRegistrationStopFailure, shut_down_drivers};
use crate::daemon::process::{DAEMON_STOP_DRAIN_BOUND, DaemonProcess};
use crate::daemon::stop_drain::describe_drain;

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
    /// The machine keys' background read was still running when the drain bound ran out; the
    /// next start reads the keys again.
    #[error("the machine keys' read was still running when the stop's drain bound ran out")]
    MachineKeyReadRunning,
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
    /// The clone service's askpass broker ended abnormally at its close.
    #[error(transparent)]
    Askpass(#[from] AskpassBrokerError),
    /// A worktree's setup command could not be ended.
    #[error(transparent)]
    WorktreeSetup(#[from] WorktreeSetupError),
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
/// comes; then, within what is left of `bound`, the mutating calls under way, the machine keys'
/// background read, the capability refresh, the providers' registration, the run queue, the clone
/// service with its askpass broker, the worktrees' setup commands, the repository services'
/// background work, the session services' follows with the chats' write watch and file recount,
/// the renames' name pushes, the highlighter, the terminals, the scheduler, the working-folder
/// watch, the projects list, the search index, the drivers and the git trees a failed call left.
/// Answers each step's failure, every step having run.
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
    // Past the bound, the dropped stop drops the background read's handle, which aborts it.
    if let Some(machine_identity) = process.machine_identity.take()
        && tokio::time::timeout(remaining(), machine_identity.stop())
            .await
            .is_err()
    {
        failures.push(DaemonStopFailure::MachineKeyReadRunning);
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
    // Before the attachments and the drivers, so no run is admitted or delivered past here.
    if let Some(session) = &process.session {
        session.queue.stop().await;
    }
    // Before the session attachments' stop, so a clone that attaches tells sessions still served;
    // taken, so a stop run again finds no broker to close.
    if let Some(clones) = process.clones.take()
        && let Err(failure) = clones.close(remaining()).await
    {
        failures.push(failure.into());
    }
    // Before the working-folder watch, on which a setup's warm step holds its tree.
    if let Some(worktree_setup) = process.worktree_setup.take()
        && let Err(failure) = worktree_setup.stop(remaining()).await
    {
        failures.push(failure.into());
    }
    // Before the scheduler, whose tick wakes the health re-probe.
    if let (Some(repo_attachments), Some(repo)) = (process.repo_attachments.take(), &process.repo)
        && let Some(failure) = repo_attachments.stop(repo).await
    {
        failures.push(failure.into());
    }
    // The session services' follows end with the chats' write watch, which they wait out.
    match (
        process.session_attachments.take(),
        &mut process.session,
        &process.repo,
    ) {
        (Some(attachments), Some(session), Some(repo)) => failures.extend(
            attachments
                .stop(session, &repo.workspaces)
                .await
                .into_iter()
                .map(DaemonStopFailure::from),
        ),
        (_, _, Some(repo)) => {
            if let Err(error) = repo.workspaces.stop().await {
                failures.push(
                    TaskStopFailure {
                        task: "chats' file recount",
                        error,
                    }
                    .into(),
                );
            }
        }
        (_, _, None) => {}
    }
    if let Some(session) = &process.session {
        session.changes.stop().await;
        session.highlighter.stop();
        // Before the orphan guard goes, so every child the drain ended is still retired.
        let drain = session.terminals.drain(remaining()).await;
        tracing::info!("{}", describe_drain(drain));
    }
    // Before the drivers, since a job it runs may still call into them.
    if let Some(scheduler) = process.scheduler.take()
        && let Err(failure) = scheduler.stop().await
    {
        failures.push(DaemonStopFailure::Scheduler(failure));
    }
    if let Some(repo) = &process.repo {
        repo.folder_watch.stop().await;
    }
    if let Some(project_list_feed) = process.project_list_feed.take() {
        project_list_feed.close();
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
    if let Some(git) = &process.git {
        git.wait_for_tree_ends().await;
    }
    // After the drain, so every child it ended is still retired.
    drop(process.orphan_guard.take());
    process.has_stop_failed |= !failures.is_empty();
    failures
}

/// Closes everything that holds a file in the data folder: lets the session and repository
/// services go, then, within what is left of the drain bound, waits for the MCP first-observation
/// drain their going ends, ending it where it stands past the bound, and closes the database file,
/// ends the crash monitor, waiting for its exit, and removes its socket from the run folder, then
/// lets the data folder's lock go last. Answers each step's failure, every step having run.
pub(crate) async fn close_data_folder(process: &mut DaemonProcess) -> Vec<DaemonStopFailure> {
    let mut failures = Vec::new();
    let remaining = || {
        DAEMON_STOP_DRAIN_BOUND.saturating_sub(
            process
                .stop_started
                .map_or(Duration::ZERO, |started| started.elapsed()),
        )
    };
    let mut session = process.session.take();
    let mcp_first_observations = session
        .as_mut()
        .and_then(|session| session.mcp_first_observations.take());
    // Their pools and writer handles go before the file closes; the MCP status tracker's going
    // ends its drain.
    drop(session);
    drop(process.repo.take());
    // Before the file closes, since the drain writes through its writer.
    if let Some(mut drain) = mcp_first_observations {
        let ended = match tokio::time::timeout(remaining(), &mut drain).await {
            Ok(ended) => ended,
            Err(_elapsed) => {
                drain.abort();
                drain.await
            }
        };
        if let Err(error) = ended {
            failures.push(
                TaskStopFailure {
                    task: "MCP first-observation drain",
                    error,
                }
                .into(),
            );
        }
    }
    if let Some(database) = process.database.take() {
        failures.extend(
            close_database_file(database, remaining(), process.has_stop_failed)
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
