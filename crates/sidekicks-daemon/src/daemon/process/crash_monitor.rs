//! The crash monitor: the `minidump` child the daemon starts first, and the handler that asks it
//! for a dump when the daemon crashes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use crash_handler::CrashHandler;
use sidekicks_platforms::Spawner;
use sidekicks_std::helper_mode::child::start_helper_mode_child;
use tokio::process::{Child, Command};

use crate::daemon::crash::monitor::{
    CRASH_MONITOR_MODE, attach_crash_handler, connect_crash_monitor,
};
use crate::daemon::panic_hook::send_panics_to_monitor;
use crate::daemon::process::DaemonStartError;
use crate::daemon::process::stop::{CrashMonitorEndFailure, DaemonStopFailure};

// The longest the crash monitor's end waits for the killed monitor to exit, apart from the drain,
// since a kill is sent before the wait begins.
const CRASH_MONITOR_END_BOUND: Duration = Duration::from_secs(1);

/// The crash monitor: the `minidump` child and, once it is reached, the handler that asks it for a
/// dump on a crash.
pub(crate) struct CrashMonitor {
    child: Child,
    handler: Option<CrashHandler>,
    socket_path: PathBuf,
}

impl CrashMonitor {
    /// Starts the monitor through `program` on `spawner`, serving `socket_path`. Fails when the
    /// child cannot start.
    pub(super) async fn spawn(
        spawner: &Spawner,
        program: &Path,
        socket_path: PathBuf,
    ) -> Result<Self, DaemonStartError> {
        let mut command = Command::new(program);
        command
            .arg(CRASH_MONITOR_MODE)
            .arg(&socket_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        let child = start_helper_mode_child(spawner, command)
            .await
            .map_err(DaemonStartError::CrashMonitorStart)?;
        Ok(Self {
            child,
            handler: None,
            socket_path,
        })
    }

    /// Connects to the monitor within its bound, attaches the crash handler and sends later panics
    /// to it. Fails naming the step.
    pub(super) async fn connect(&mut self) -> Result<(), DaemonStartError> {
        let connect_path = self.socket_path.clone();
        let client = Arc::new(
            tokio::task::spawn_blocking(move || connect_crash_monitor(&connect_path))
                .await
                .map_err(DaemonStartError::CrashMonitorConnectEnded)??,
        );
        self.handler = Some(
            attach_crash_handler(Arc::clone(&client)).map_err(DaemonStartError::CrashHandler)?,
        );
        send_panics_to_monitor(client);
        Ok(())
    }

    /// Detaches the crash handler, ends the monitor, waiting at most its own bound for its exit,
    /// and removes its socket from the run folder. Answers each step's failure.
    pub(super) async fn end(mut self) -> Vec<DaemonStopFailure> {
        drop(self.handler.take());
        let mut failures = Vec::new();
        match tokio::time::timeout(CRASH_MONITOR_END_BOUND, self.child.kill()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(CrashMonitorEndFailure::Kill(error).into()),
            Err(_elapsed) => {
                failures.push(CrashMonitorEndFailure::StillRunning(CRASH_MONITOR_END_BOUND).into());
            }
        }
        match tokio::fs::remove_file(&self.socket_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => failures.push(
                CrashMonitorEndFailure::Socket {
                    path: self.socket_path,
                    source,
                }
                .into(),
            ),
        }
        failures
    }
}
