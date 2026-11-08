//! The crash monitor: the `minidump` child the daemon starts first, the handler that asks it for a
//! dump when the daemon crashes, and the watch that starts a new monitor when one ends, so a later
//! crash still leaves a dump.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use crash_handler::CrashHandler;
use sidekicks_platforms::Spawner;
use sidekicks_std::helper_mode::child::start_helper_mode_child;
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::daemon::crash::monitor::{
    CONNECT_BOUND, CRASH_MONITOR_MODE, attach_crash_handler, connect_crash_monitor, is_crashing,
};
use crate::daemon::panic_hook::send_panics_to_monitor;
use crate::daemon::process::start_error::DaemonStartError;
use crate::daemon::process::stop::{CrashMonitorEndFailure, DaemonStopFailure, TaskStopFailure};

// The longest the crash monitor's end waits for the killed monitor to exit, apart from the drain,
// since a kill is sent before the wait begins.
const CRASH_MONITOR_END_BOUND: Duration = Duration::from_secs(1);

// The longest gap the watch leaves between two attempts to start a monitor; the shortest is the
// connect's own bound.
const RESTART_GAP_MAX: Duration = Duration::from_mins(10);

/// The crash monitor: the `minidump` child and, once it is reached, the handler that asks it for a
/// dump on a crash and the watch that replaces it when it ends.
pub(crate) struct CrashMonitor {
    start: MonitorStart,
    // The child between its spawn and its first connect, after which the watch holds it.
    unwatched: Option<Child>,
    watch: Option<MonitorWatch>,
}

// How a monitor starts: the program and the spawner it runs through, and the socket it serves.
#[derive(Clone)]
struct MonitorStart {
    spawner: Spawner,
    program: PathBuf,
    socket_path: PathBuf,
}

// A monitor the service is connected to; its handler is dropped before the next one attaches,
// since one crash handler is attached at a time.
struct ConnectedMonitor {
    child: Child,
    handler: CrashHandler,
}

// The watch's end and its task, which answers the monitor running when it ended.
struct MonitorWatch {
    end: CancellationToken,
    task: JoinHandle<Option<ConnectedMonitor>>,
    // The count of new monitors the watch has connected to.
    #[cfg(test)]
    restarted: watch::Receiver<usize>,
}

// The gap the watch leaves between two attempts to start a monitor: it doubles, up to
// `RESTART_GAP_MAX`, after each monitor that ends before it has lived the gap and after each
// failed attempt, and goes back to `CONNECT_BOUND` once a monitor has lived a full gap.
struct RestartGap {
    gap: Duration,
    attempted_at: Instant,
    connected_at: Instant,
}

impl CrashMonitor {
    /// Starts the monitor through `program` on `spawner`, serving `socket_path`. Fails when the
    /// child cannot start.
    pub(super) async fn spawn(
        spawner: &Spawner,
        program: &Path,
        socket_path: PathBuf,
    ) -> Result<Self, DaemonStartError> {
        let start = MonitorStart {
            spawner: spawner.clone(),
            program: program.to_path_buf(),
            socket_path,
        };
        let child = start
            .spawn_child()
            .await
            .map_err(DaemonStartError::CrashMonitorStart)?;
        Ok(Self {
            start,
            unwatched: Some(child),
            watch: None,
        })
    }

    /// Connects to the monitor within its bound, attaches the crash handler, sends later panics to
    /// it and starts the watch that replaces it when it ends. Fails naming the step.
    pub(super) async fn connect(&mut self) -> Result<(), DaemonStartError> {
        let handler = connect_handler(&self.start.socket_path).await?;
        let child = self
            .unwatched
            .take()
            .expect("the monitor is connected once, after its spawn");
        let end = CancellationToken::new();
        let restarted = watch::Sender::new(0);
        #[cfg(test)]
        let restarted_count = restarted.subscribe();
        let task = tokio::spawn(watch_monitor(
            self.start.clone(),
            ConnectedMonitor { child, handler },
            end.clone(),
            restarted,
        ));
        self.watch = Some(MonitorWatch {
            end,
            task,
            #[cfg(test)]
            restarted: restarted_count,
        });
        Ok(())
    }

    /// The process id of the child spawned and not yet connected to.
    #[cfg(test)]
    pub(super) fn unwatched_child_id(&self) -> Option<u32> {
        self.unwatched.as_ref().and_then(Child::id)
    }

    /// The count of new monitors the watch has connected to, once the first monitor is connected.
    #[cfg(test)]
    pub(super) fn restarted_count(&self) -> Option<watch::Receiver<usize>> {
        self.watch.as_ref().map(|watch| watch.restarted.clone())
    }

    /// Ends the watch, detaches the crash handler, ends the monitor, waiting at most its own bound
    /// for its exit, and removes its socket from the run folder. Answers each step's failure.
    pub(super) async fn end(mut self) -> Vec<DaemonStopFailure> {
        let mut failures = Vec::new();
        let mut child = self.unwatched.take();
        if let Some(watch) = self.watch.take() {
            watch.end.cancel();
            match watch.task.await {
                Ok(Some(monitor)) => {
                    drop(monitor.handler);
                    child = Some(monitor.child);
                }
                Ok(None) => {}
                Err(error) => failures.push(
                    TaskStopFailure {
                        task: "crash monitor's watch",
                        error,
                    }
                    .into(),
                ),
            }
        }
        if let Some(mut child) = child {
            match tokio::time::timeout(CRASH_MONITOR_END_BOUND, child.kill()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(CrashMonitorEndFailure::Kill(error).into()),
                Err(_elapsed) => {
                    failures
                        .push(CrashMonitorEndFailure::StillRunning(CRASH_MONITOR_END_BOUND).into());
                }
            }
        }
        match tokio::fs::remove_file(&self.start.socket_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => failures.push(
                CrashMonitorEndFailure::Socket {
                    path: self.start.socket_path,
                    source,
                }
                .into(),
            ),
        }
        failures
    }
}

impl MonitorStart {
    // Starts a monitor's child, which is killed if its handle drops. Fails with the spawn's error.
    async fn spawn_child(&self) -> io::Result<Child> {
        let mut command = Command::new(&self.program);
        command
            .arg(CRASH_MONITOR_MODE)
            .arg(&self.socket_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        start_helper_mode_child(&self.spawner, command).await
    }

    // Starts a new monitor on the same socket, which its server takes over from the ended one, and
    // connects to it. Fails naming the step.
    async fn start_connected(&self) -> Result<ConnectedMonitor, DaemonStartError> {
        let child = self
            .spawn_child()
            .await
            .map_err(DaemonStartError::CrashMonitorStart)?;
        let handler = connect_handler(&self.socket_path).await?;
        Ok(ConnectedMonitor { child, handler })
    }
}

// Connects to the monitor at `socket_path` within its bound, attaches the crash handler to it and
// sends later panics to it. Fails naming the step.
async fn connect_handler(socket_path: &Path) -> Result<CrashHandler, DaemonStartError> {
    let connect_path = socket_path.to_path_buf();
    let client = Arc::new(
        tokio::task::spawn_blocking(move || connect_crash_monitor(&connect_path))
            .await
            .map_err(DaemonStartError::CrashMonitorConnectEnded)??,
    );
    let handler =
        attach_crash_handler(Arc::clone(&client)).map_err(DaemonStartError::CrashHandler)?;
    send_panics_to_monitor(client);
    Ok(handler)
}

impl RestartGap {
    // A gap of `CONNECT_BOUND` from a monitor attempted and connected now.
    fn new() -> Self {
        let now = Instant::now();
        Self {
            gap: CONNECT_BOUND,
            attempted_at: now,
            connected_at: now,
        }
    }

    // When the next attempt starts, after the connected monitor ended (`has_failed` false) or the
    // last attempt failed: at once for a monitor that lived a full gap, which resets the gap, and
    // otherwise a gap after the last attempt, which doubles the gap for the attempt after it.
    fn next_attempt_at(&mut self, has_failed: bool) -> Instant {
        if !has_failed && self.connected_at.elapsed() >= self.gap {
            self.gap = CONNECT_BOUND;
            return Instant::now();
        }
        let next_attempt_at = self.attempted_at + self.gap;
        self.gap = self.gap.saturating_mul(2).min(RESTART_GAP_MAX);
        next_attempt_at
    }
}

// Waits for `monitor` to end and starts a new one in its place, until `end` fires, answering the
// monitor running then. The attempts never stop: each waits the `RestartGap` after the last, and a
// stop ends any wait at once. Each monitor the watch connects to is counted on `restarted`. Once
// the service is going down after a panic it starts none, answering none.
async fn watch_monitor(
    start: MonitorStart,
    mut monitor: ConnectedMonitor,
    end: CancellationToken,
    restarted: watch::Sender<usize>,
) -> Option<ConnectedMonitor> {
    let mut gap = RestartGap::new();
    loop {
        let exit = tokio::select! {
            biased;
            () = end.cancelled() => return Some(monitor),
            exit = monitor.child.wait() => exit,
        };
        drop(monitor);
        let mut next_attempt_at = gap.next_attempt_at(false);
        let next_attempt_seconds = next_attempt_at
            .saturating_duration_since(Instant::now())
            .as_secs();
        match exit {
            Ok(status) => tracing::warn!(%status, next_attempt_seconds, "the crash monitor ended"),
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                next_attempt_seconds,
                "the wait for the crash monitor failed"
            ),
        }
        monitor = loop {
            tokio::select! {
                biased;
                () = end.cancelled() => return None,
                () = tokio::time::sleep_until(next_attempt_at) => {}
            }
            // A panic's abort ends the monitor once it has written the dump; the process is ending.
            if is_crashing() {
                return None;
            }
            gap.attempted_at = Instant::now();
            let started = tokio::select! {
                biased;
                () = end.cancelled() => return None,
                started = start.start_connected() => started,
            };
            match started {
                Ok(started) => {
                    gap.connected_at = Instant::now();
                    restarted.send_modify(|count| *count += 1);
                    tracing::info!("the crash monitor was restarted");
                    break started;
                }
                Err(error) => {
                    next_attempt_at = gap.next_attempt_at(true);
                    tracing::error!(
                        error = &error as &(dyn Error + 'static),
                        next_attempt_seconds = next_attempt_at
                            .saturating_duration_since(Instant::now())
                            .as_secs(),
                        "the crash monitor could not be restarted"
                    );
                }
            }
        };
    }
}
