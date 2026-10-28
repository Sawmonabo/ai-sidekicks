//! Every Claude Code process the driver starts goes through one launcher, which keeps each one it
//! started so the daemon's stop reaches them all and none starts once that stop began: a session's
//! process brought up with its hooks and settings, the processes that keep nothing (the sign-in
//! probe, the model catalog, the build's version, a session's figures) and the one-turn process.

pub(crate) mod bring_up;
pub(crate) mod control_only;
pub(crate) mod figures;
pub(crate) mod initialize_reply;
pub(crate) mod installed_build;
pub(crate) mod one_turn;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_TERMINAL_DRAIN_MS;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::process::{
    ClaudeCodeProcess, ClaudeProcessLaunch, ClaudeProcessListener, ClaudeTurnHolds,
};
use crate::driver::claude::session::rules::ClaudeRulesError;
use crate::driver::contract::DriverError;
use crate::process_registry::ProviderProcessRegistry;

/// The data folder's folder a process that keeps nothing runs in: empty, so Claude Code reads no
/// project there, and never the system's temporary folder or the daemon's own.
const CLAUDE_CONTROL_ONLY_FOLDER: [&str; 2] = ["claude", "control-only"];

/// Why a Claude Code process could not be started or brought up.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeLaunchError {
    /// The daemon is stopping, so no process starts.
    #[error("the daemon is stopping, so no Claude Code process starts")]
    Stopping,
    /// The process could not be started.
    #[error("the Claude Code process could not be started")]
    Spawn(#[source] io::Error),
    /// The empty folder a process that keeps nothing runs in could not be made.
    #[error("the folder Claude Code's control-only process runs in could not be made")]
    ControlOnlyFolder(#[source] io::Error),
    /// The session's settings could not be composed.
    #[error("the Claude Code process's settings could not be composed")]
    Settings(#[from] ClaudeRulesError),
    /// A request bringing the process up failed or was refused.
    #[error(transparent)]
    Session(#[from] ClaudeSessionError),
    /// Claude Code ran a model turn for a command it was to answer itself.
    #[error("Claude Code ran a model turn for /{command} instead of answering it")]
    CommandRanTurn {
        /// The command, without its `/`.
        command: &'static str,
    },
    /// The one-turn message could not be written.
    #[error("the one-turn message could not be written to Claude Code")]
    MessageUnwritten(#[source] io::Error),
    /// The one-turn process ended its turn in an error that carries no refusal.
    #[error("the one-turn Claude Code process ended in an error: {text}")]
    TurnErrored {
        /// The `result` text.
        text: String,
    },
    /// The one-turn turn was stopped.
    #[error("the one-turn Claude Code turn was stopped")]
    TurnStopped,
    /// The process ended, or passed its deadline, before it answered.
    #[error("Claude Code did not answer {what}")]
    Unanswered {
        /// What it did not answer.
        what: String,
    },
    /// The build the command names could not be resolved, or its version not read.
    #[error(transparent)]
    Build(#[from] DriverError),
}

impl From<ClaudeLaunchError> for DriverError {
    /// A failure of the build or of a request keeps its own answer; every other start failure is
    /// internal.
    fn from(error: ClaudeLaunchError) -> Self {
        match error {
            ClaudeLaunchError::Build(error) => error,
            ClaudeLaunchError::Session(error) => error.into(),
            error @ (ClaudeLaunchError::Stopping
            | ClaudeLaunchError::Spawn(_)
            | ClaudeLaunchError::ControlOnlyFolder(_)
            | ClaudeLaunchError::Settings(_)
            | ClaudeLaunchError::CommandRanTurn { .. }
            | ClaudeLaunchError::MessageUnwritten(_)
            | ClaudeLaunchError::TurnErrored { .. }
            | ClaudeLaunchError::TurnStopped
            | ClaudeLaunchError::Unanswered { .. }) => Self::Internal(Box::new(error)),
        }
    }
}

/// Starts every Claude Code process and keeps the live ones, so the daemon's stop ends them all.
pub(crate) struct ClaudeProcessLauncher {
    spawner: Spawner,
    processes: Arc<ProviderProcessRegistry>,
    control_only_folder: PathBuf,
    live: Mutex<LiveProcesses>,
}

// The processes started and not yet exited, and whether the daemon's stop began.
#[derive(Default)]
struct LiveProcesses {
    processes: Vec<Weak<ClaudeCodeProcess>>,
    is_stopped: bool,
}

impl ClaudeProcessLauncher {
    /// A launcher spawning on `spawner`'s thread, counting each spawn in `processes`, whose
    /// processes that keep nothing run in a folder under `data_folder`.
    pub(crate) fn new(
        spawner: Spawner,
        processes: Arc<ProviderProcessRegistry>,
        data_folder: &Path,
    ) -> Self {
        Self {
            spawner,
            processes,
            control_only_folder: CLAUDE_CONTROL_ONLY_FOLDER
                .iter()
                .fold(data_folder.to_path_buf(), |folder, name| folder.join(name)),
            live: Mutex::new(LiveProcesses::default()),
        }
    }

    /// Starts one process and keeps it until it exits. Fails with `Stopping` once the daemon's
    /// stop began, a process that started meanwhile being stopped again, and with `Spawn` when it
    /// could not be started.
    pub(crate) async fn start(
        &self,
        launch: ClaudeProcessLaunch,
        listener: Arc<dyn ClaudeProcessListener>,
        turn_holds: Option<ClaudeTurnHolds>,
    ) -> Result<Arc<ClaudeCodeProcess>, ClaudeLaunchError> {
        if self.lock().is_stopped {
            return Err(ClaudeLaunchError::Stopping);
        }
        let process = Arc::new(
            ClaudeCodeProcess::start(&self.spawner, &self.processes, launch, listener, turn_holds)
                .await
                .map_err(ClaudeLaunchError::Spawn)?,
        );
        let is_stopped = {
            let mut live = self.lock();
            live.processes
                .retain(|kept| kept.upgrade().is_some_and(|kept| !kept.is_closed()));
            live.processes.push(Arc::downgrade(&process));
            live.is_stopped
        };
        // A stop that ran while the process was starting has already gone past it.
        if is_stopped {
            process.stop(drain()).await;
            return Err(ClaudeLaunchError::Stopping);
        }
        Ok(process)
    }

    /// Stops every live process together, each given the daemon's stop drain to exit on its own,
    /// and refuses every later start.
    pub(crate) async fn stop_every_process(&self) {
        let processes: Vec<Arc<ClaudeCodeProcess>> = {
            let mut live = self.lock();
            live.is_stopped = true;
            live.processes
                .drain(..)
                .filter_map(|kept| kept.upgrade())
                .collect()
        };
        futures::future::join_all(processes.iter().map(|process| process.stop(drain()))).await;
    }

    /// The empty folder a process that keeps nothing runs in, made at first use. Fails with
    /// `ControlOnlyFolder` when it cannot be made.
    pub(crate) async fn control_only_folder(&self) -> Result<PathBuf, ClaudeLaunchError> {
        tokio::fs::create_dir_all(&self.control_only_folder)
            .await
            .map_err(ClaudeLaunchError::ControlOnlyFolder)?;
        Ok(self.control_only_folder.clone())
    }

    fn lock(&self) -> MutexGuard<'_, LiveProcesses> {
        lock(&self.live)
    }
}

fn drain() -> Duration {
    Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS)
}
