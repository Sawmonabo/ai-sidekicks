//! The daemon's stop in its two steps, which the erase also runs one by one: the work ends within
//! the drain bound, then everything that holds a file in the data folder closes. Each step takes
//! the parts it closes, so a step run again skips what is already closed.

use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::daemon::process::database::{DatabaseFileCloseFailure, close_database_file};
use crate::daemon::process::{DAEMON_STOP_DRAIN_BOUND, DaemonProcess};
use crate::provider::driver::daemon_stop::DaemonStopIntent;

/// Why a step of the stop failed; every other step still ran.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStopFailure {
    /// The crash monitor could not be ended, or its socket stayed.
    #[error(transparent)]
    CrashMonitor(#[from] CrashMonitorEndFailure),
    /// A step of the database file's close failed.
    #[error(transparent)]
    DatabaseFile(#[from] DatabaseFileCloseFailure),
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
    process.stop_started.get_or_insert_with(Instant::now);
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
    let failures = Vec::new();
    process.has_stop_failed |= !failures.is_empty();
    failures
}

/// Closes everything that holds a file in the data folder: closes the database file within what is
/// left of the drain bound, ends the crash monitor, waiting for its exit, and removes its socket
/// from the run folder, then lets the data folder's lock go last. Answers each step's failure,
/// every step having run.
pub(crate) async fn close_data_folder(process: &mut DaemonProcess) -> Vec<DaemonStopFailure> {
    let mut failures = Vec::new();
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
