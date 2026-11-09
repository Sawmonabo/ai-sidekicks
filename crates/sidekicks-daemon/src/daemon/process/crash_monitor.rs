//! The crash monitor: the `minidump` child the daemon starts beside itself without waiting for it,
//! the handler that asks it for a dump when the daemon crashes, and the watch that reaches it
//! however long its start takes and starts a new one when one ends or cannot be started or
//! reached, so a later crash still leaves a dump.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use crash_handler::CrashHandler;
use sidekicks_platforms::Spawner;
use sidekicks_std::helper_mode::child::start_helper_mode_child;
use tokio::process::{Child, Command};
#[cfg(test)]
use tokio::sync::watch;
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::daemon::crash::monitor::{
    CRASH_MONITOR_MODE, CrashMonitorError, attach_crash_handler, connect_crash_monitor, is_crashing,
};
use crate::daemon::panic_hook::send_panics_to_monitor;
use crate::daemon::process::stop::{CrashMonitorEndFailure, DaemonStopFailure, TaskStopFailure};

// The longest the crash monitor's end waits for the killed monitor to exit, apart from the drain,
// since a kill is sent before the wait begins.
const CRASH_MONITOR_END_BOUND: Duration = Duration::from_secs(1);

/// The shortest gap the watch leaves between two attempts to start a monitor.
pub(super) const RESTART_GAP_MIN: Duration = Duration::from_secs(10);

// The longest gap the watch leaves between two attempts to start a monitor.
const RESTART_GAP_MAX: Duration = Duration::from_mins(10);

/// The crash monitor: the watch that starts the `minidump` child, reaches it, attaches the handler
/// that asks it for a dump on a crash, and replaces it when it ends.
pub(crate) struct CrashMonitor {
    socket_path: PathBuf,
    end: CancellationToken,
    // Answers the child running when the watch ended, connected or still starting, its handler
    // already dropped.
    task: JoinHandle<Option<Child>>,
    #[cfg(test)]
    progress: watch::Receiver<MonitorProgress>,
}

/// What the watch has done so far, as the tests read it.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct MonitorProgress {
    /// The process id of the newest child the watch spawned.
    pub(super) newest_child_id: Option<u32>,
    /// The count of monitors the watch has connected to, the first included.
    pub(super) connected: usize,
}

// How a monitor starts: the program and the spawner it runs through, and the socket it serves.
struct MonitorStart {
    spawner: Spawner,
    program: PathBuf,
    socket_path: PathBuf,
    #[cfg(test)]
    progress: watch::Sender<MonitorProgress>,
}

// A monitor the service is connected to; its handler is dropped before the next one attaches,
// since one crash handler is attached at a time.
struct ConnectedMonitor {
    child: Child,
    handler: CrashHandler,
}

// How an attempt to start and reach a monitor ended, short of a failure.
enum MonitorAttempt {
    // The monitor answered, and the crash handler is attached to it.
    Connected(ConnectedMonitor),
    // The stop came while the monitor was starting; its child, once spawned, is still running.
    Stopped(Option<Child>),
}

// Why an attempt to start and reach a crash monitor failed; the watch tries again after its gap.
#[derive(Debug, thiserror::Error)]
enum MonitorAttemptError {
    #[error("the crash monitor could not start")]
    Start(#[source] io::Error),
    #[error(transparent)]
    Connect(#[from] CrashMonitorError),
    #[error("the connect to the crash monitor ended before it finished")]
    ConnectEnded(#[source] JoinError),
    #[error("the crash handler could not be attached")]
    Handler(#[source] crash_handler::Error),
    #[error("the crash monitor ended before it answered, {0}")]
    Ended(ExitStatus),
    #[error("the wait for the crash monitor failed")]
    Wait(#[source] io::Error),
}

// The gap the watch leaves between two attempts to start a monitor: it doubles, up to
// `RESTART_GAP_MAX`, after each monitor that ends before it has lived the gap and after each
// failed attempt, and goes back to `RESTART_GAP_MIN` once a monitor has lived a full gap.
struct RestartGap {
    gap: Duration,
    attempted_at: Instant,
    connected_at: Instant,
}

impl CrashMonitor {
    /// Starts the watch, which starts the monitor through `program` on `spawner`, serving
    /// `socket_path`, and reaches it in the background; returns at once.
    pub(super) fn start(spawner: &Spawner, program: &Path, socket_path: PathBuf) -> Self {
        #[cfg(test)]
        let (progress_sender, progress) = watch::channel(MonitorProgress::default());
        let start = MonitorStart {
            spawner: spawner.clone(),
            program: program.to_path_buf(),
            socket_path: socket_path.clone(),
            #[cfg(test)]
            progress: progress_sender,
        };
        let end = CancellationToken::new();
        let task = tokio::spawn(watch_monitor(start, end.clone()));
        Self {
            socket_path,
            end,
            task,
            #[cfg(test)]
            progress,
        }
    }

    /// What the watch has done so far.
    #[cfg(test)]
    pub(super) fn progress(&self) -> watch::Receiver<MonitorProgress> {
        self.progress.clone()
    }

    /// Ends the watch, which detaches the crash handler, ends the monitor, connected or still
    /// starting, waiting at most its own bound for its exit, and removes its socket from the run
    /// folder. Answers each step's failure.
    pub(super) async fn end(self) -> Vec<DaemonStopFailure> {
        let mut failures = Vec::new();
        self.end.cancel();
        let child = match self.task.await {
            Ok(child) => child,
            Err(error) => {
                failures.push(
                    TaskStopFailure {
                        task: "crash monitor's watch",
                        error,
                    }
                    .into(),
                );
                None
            }
        };
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
        match tokio::fs::remove_file(&self.socket_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
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

    // Starts a monitor on the socket, which its server takes over from an ended one, and connects
    // to it until it answers, its child ends or `end` fires; a failed attempt drops, and so kills,
    // a child still running. Fails naming the step.
    async fn start_connected(
        &self,
        end: &CancellationToken,
    ) -> Result<MonitorAttempt, MonitorAttemptError> {
        // A spawn the stop cuts short drops, and so kills, the child it may still start.
        let spawned = tokio::select! {
            biased;
            () = end.cancelled() => return Ok(MonitorAttempt::Stopped(None)),
            spawned = self.spawn_child() => spawned,
        };
        let mut child = spawned.map_err(MonitorAttemptError::Start)?;
        let spawned_at = Instant::now();
        #[cfg(test)]
        self.progress
            .send_modify(|progress| progress.newest_child_id = child.id());
        // Canceled however the attempt ends, so the blocking connect stops trying.
        let connect_stop = end.child_token();
        let _connect_stop_on_drop = connect_stop.clone().drop_guard();
        let reached = tokio::select! {
            biased;
            () = end.cancelled() => return Ok(MonitorAttempt::Stopped(Some(child))),
            exit = child.wait() => Err(match exit {
                Ok(status) => MonitorAttemptError::Ended(status),
                Err(error) => MonitorAttemptError::Wait(error),
            }),
            handler = connect_handler(&self.socket_path, &connect_stop) => handler,
        };
        let handler = reached?;
        tracing::info!(
            elapsed_milliseconds =
                u64::try_from(spawned_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            "the crash monitor was reached"
        );
        Ok(MonitorAttempt::Connected(ConnectedMonitor {
            child,
            handler,
        }))
    }
}

// Connects to the monitor at `socket_path` until it answers or `stop` fires, attaches the crash
// handler to it and sends later panics to it. Fails naming the step.
async fn connect_handler(
    socket_path: &Path,
    stop: &CancellationToken,
) -> Result<CrashHandler, MonitorAttemptError> {
    let connect_path = socket_path.to_path_buf();
    let connect_stop = stop.clone();
    let client = Arc::new(
        tokio::task::spawn_blocking(move || connect_crash_monitor(&connect_path, &connect_stop))
            .await
            .map_err(MonitorAttemptError::ConnectEnded)??,
    );
    let handler =
        attach_crash_handler(Arc::clone(&client)).map_err(MonitorAttemptError::Handler)?;
    send_panics_to_monitor(client);
    Ok(handler)
}

impl RestartGap {
    // A gap of `RESTART_GAP_MIN` from now.
    fn new() -> Self {
        let now = Instant::now();
        Self {
            gap: RESTART_GAP_MIN,
            attempted_at: now,
            connected_at: now,
        }
    }

    // When the next attempt starts, after the connected monitor ended (`has_failed` false) or the
    // last attempt failed: at once for a monitor that lived a full gap, which resets the gap, and
    // otherwise a gap after the last attempt, which doubles the gap for the attempt after it.
    fn next_attempt_at(&mut self, has_failed: bool) -> Instant {
        if !has_failed && self.connected_at.elapsed() >= self.gap {
            self.gap = RESTART_GAP_MIN;
            return Instant::now();
        }
        let next_attempt_at = self.attempted_at + self.gap;
        self.gap = self.gap.saturating_mul(2).min(RESTART_GAP_MAX);
        next_attempt_at
    }
}

// Starts a monitor at once and, whenever one ends or an attempt fails, a new one in its place,
// until `end` fires, answering the child running then, its handler dropped. The attempts never
// stop: each after the first waits the `RestartGap` after the last, and a stop ends any wait at
// once. Once the service is going down after a panic it starts none, answering none.
async fn watch_monitor(start: MonitorStart, end: CancellationToken) -> Option<Child> {
    let mut gap = RestartGap::new();
    let mut next_attempt_at = Instant::now();
    loop {
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
        let mut monitor = match start.start_connected(&end).await {
            Ok(MonitorAttempt::Connected(monitor)) => monitor,
            Ok(MonitorAttempt::Stopped(child)) => return child,
            Err(error) => {
                next_attempt_at = gap.next_attempt_at(true);
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    next_attempt_seconds = next_attempt_at
                        .saturating_duration_since(Instant::now())
                        .as_secs(),
                    "the crash monitor could not be started or reached"
                );
                continue;
            }
        };
        gap.connected_at = Instant::now();
        #[cfg(test)]
        start
            .progress
            .send_modify(|progress| progress.connected += 1);
        let exit = tokio::select! {
            biased;
            () = end.cancelled() => {
                drop(monitor.handler);
                return Some(monitor.child);
            }
            exit = monitor.child.wait() => exit,
        };
        drop(monitor);
        next_attempt_at = gap.next_attempt_at(false);
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
    }
}
