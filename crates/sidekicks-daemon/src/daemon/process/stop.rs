//! The daemon's stop in its two steps, which the erase also runs one by one: the work ends within
//! the drain bound, then everything that holds a file in the data folder closes. Each step takes
//! the parts it closes, so a step run again skips what is already closed.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use tokio::task::JoinError;

use crate::daemon::process::DaemonProcess;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::workspace::clone::askpass::broker::AskpassBrokerError;

/// Why a step of the stop failed; every other step still ran.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStopFailure {
    /// The crash monitor could not be ended, or its socket stayed.
    #[error(transparent)]
    CrashMonitor(#[from] CrashMonitorEndFailure),
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
/// comes; then the work ending together within `bound`. Answers each step's failure, every step
/// having run.
pub(crate) async fn stop_work(
    process: &mut DaemonProcess,
    intent: DaemonStopIntent,
    bound: Duration,
) -> Vec<DaemonStopFailure> {
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
    // After the drain, so every child it ended is still retired.
    drop(process.orphan_guard.take());
    Vec::new()
}

/// Closes everything that holds a file in the data folder: ends the crash monitor, waiting for its
/// exit, and removes its socket from the run folder, then lets the data folder's lock go last.
/// Answers each step's failure, every step having run.
pub(crate) async fn close_data_folder(process: &mut DaemonProcess) -> Vec<DaemonStopFailure> {
    let mut failures = Vec::new();
    // Before the lock goes, so a start that takes the lock next meets no monitor of this one.
    if let Some(crash_monitor) = process.crash_monitor.take() {
        failures.extend(crash_monitor.end().await);
    }
    drop(process.data_folder_lock.take());
    failures
}
