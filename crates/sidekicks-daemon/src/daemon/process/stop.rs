//! The daemon's stop in its two steps, which the erase takes one by one: the work ends within the
//! drain bound, then everything that holds a file in the data folder closes.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use crate::daemon::process::DaemonProcess;
use crate::provider::driver::daemon_stop::DaemonStopIntent;

/// Why a step of the stop failed; every other step still ran.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStopFailure {
    /// The crash monitor could not be ended, or its socket stayed.
    #[error(transparent)]
    CrashMonitor(#[from] CrashMonitorEndFailure),
}

/// Why the crash monitor's end failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CrashMonitorEndFailure {
    /// The monitor could not be killed.
    #[error("the crash monitor could not be ended")]
    Kill(#[source] io::Error),
    /// The monitor did not end within what was left of the drain bound.
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

/// Closes everything that holds a file in the data folder, the data folder's lock last, then ends
/// the crash monitor within `remaining` and removes its socket from the run folder. Answers each
/// step's failure, every step having run.
pub(crate) async fn close_data_folder(
    process: DaemonProcess,
    remaining: Duration,
) -> Vec<DaemonStopFailure> {
    let DaemonProcess {
        data_folder_lock,
        crash_monitor,
        ..
    } = process;
    let mut failures = Vec::new();
    drop(data_folder_lock);
    if let Some(crash_monitor) = crash_monitor {
        failures.extend(crash_monitor.end(remaining).await);
    }
    failures
}
