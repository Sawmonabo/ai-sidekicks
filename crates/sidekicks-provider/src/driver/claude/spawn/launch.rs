//! Every Claude Code process the driver starts goes through one launcher, which keeps each one it
//! started so the daemon's stop reaches them all and none starts once that stop began: a session's
//! process brought up with its hooks and settings, the processes that keep nothing (the sign-in
//! probe, the model catalog, the build's version, a session's figures, a resting session's commands
//! and agents) and the one-turn process.
//! A process on a token account is handed that account's token there, on a pipe only it reads, and
//! every process its telemetry switches, in the settings file it reads by path.

pub(crate) mod bring_up;
pub(crate) mod control_only;
pub(crate) mod figures;
pub(crate) mod initialize_reply;
pub(crate) mod installed_build;
pub(crate) mod one_turn;
pub(crate) mod session_listing;

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::time::Instant;

use crate::driver::ProviderAccountReader;
use crate::driver::child_records::DaemonChildRecords;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::process::{
    ClaudeCodeProcess, ClaudeProcessLaunch, ClaudeProcessListener, ClaudeTurnHolds,
};
use crate::driver::claude::session::rules::ClaudeRulesError;
use crate::driver::claude::spawn::settings::private_file::compose_claude_settings_folder;
use crate::driver::contract::error::DriverError;
use crate::port::raw_provider_messages::RawProviderMessages;
use crate::pricing::receiver::TelemetryTarget;
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
    /// The token sealed for the process's account could not be read.
    #[error("the token sealed for the Claude Code process's account could not be read")]
    SealedToken(#[source] Box<dyn Error + Send + Sync>),
    /// The process could not be started.
    #[error("the Claude Code process could not be started")]
    Spawn(#[source] io::Error),
    /// The file the process reads its settings from could not be written.
    #[error("the Claude Code process's settings file could not be written")]
    SettingsFile(#[source] io::Error),
    /// The process's own telemetry token could not be minted.
    #[error("the Claude Code process's telemetry token could not be minted")]
    TelemetryBearer(#[source] getrandom::Error),
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
    /// The `initialize` reply named its account in a shape that could not be read.
    #[error("Claude Code's initialize reply could not be read")]
    InitializeUnreadable(#[source] serde_json::Error),
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
            | ClaudeLaunchError::SealedToken(_)
            | ClaudeLaunchError::Spawn(_)
            | ClaudeLaunchError::SettingsFile(_)
            | ClaudeLaunchError::TelemetryBearer(_)
            | ClaudeLaunchError::ControlOnlyFolder(_)
            | ClaudeLaunchError::Settings(_)
            | ClaudeLaunchError::CommandRanTurn { .. }
            | ClaudeLaunchError::MessageUnwritten(_)
            | ClaudeLaunchError::TurnErrored { .. }
            | ClaudeLaunchError::TurnStopped
            | ClaudeLaunchError::Unanswered { .. }
            | ClaudeLaunchError::InitializeUnreadable(_)) => Self::Internal(Box::new(error)),
        }
    }
}

/// Starts every Claude Code process and keeps the live ones, so the daemon's stop ends them all.
pub(crate) struct ClaudeProcessLauncher {
    spawner: Spawner,
    child_records: Arc<dyn DaemonChildRecords>,
    processes: Arc<ProviderProcessRegistry>,
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    telemetry_target: Arc<PortRegistration<Arc<TelemetryTarget>>>,
    raw_messages: Arc<PortRegistration<Arc<dyn RawProviderMessages>>>,
    control_only_folder: PathBuf,
    settings_folder: PathBuf,
    live: Mutex<LiveProcesses>,
}

// The processes started and not yet exited, and the deadline of the daemon's stop once it began.
#[derive(Default)]
struct LiveProcesses {
    processes: Vec<Weak<ClaudeCodeProcess>>,
    stop_deadline: Option<Instant>,
}

impl ClaudeProcessLauncher {
    /// A launcher spawning on `spawner`'s thread, recording each process in `child_records` and
    /// counting each spawn in `processes`, reading each account's sealed token through
    /// `provider_accounts` and the export's target through `telemetry_target` and handing every
    /// line a process writes to `raw_messages`, whose processes that keep nothing run in a folder
    /// under `data_folder` and whose settings files sit in another.
    pub(crate) fn new(
        spawner: Spawner,
        child_records: Arc<dyn DaemonChildRecords>,
        processes: Arc<ProviderProcessRegistry>,
        provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
        telemetry_target: Arc<PortRegistration<Arc<TelemetryTarget>>>,
        raw_messages: Arc<PortRegistration<Arc<dyn RawProviderMessages>>>,
        data_folder: &Path,
    ) -> Self {
        Self {
            spawner,
            child_records,
            processes,
            provider_accounts,
            telemetry_target,
            raw_messages,
            control_only_folder: CLAUDE_CONTROL_ONLY_FOLDER
                .iter()
                .fold(data_folder.to_path_buf(), |folder, name| folder.join(name)),
            settings_folder: compose_claude_settings_folder(data_folder),
            live: Mutex::new(LiveProcesses::default()),
        }
    }

    /// Starts one process and keeps it until it exits: a launch naming a pasted token's account and
    /// carrying no token is handed the token sealed for that account, so every process on a token
    /// account signs in with it, and it exports to the telemetry target as registered now under a
    /// token of its own. Fails with `Stopping` once the daemon's stop began, a process that
    /// started meanwhile being stopped again, with `SealedToken` when the account's sign-in or its
    /// token cannot be read, with `TelemetryBearer` when its telemetry token cannot be minted,
    /// with `SettingsFile` when its settings file cannot be written, and with `Spawn` when it
    /// could not be started.
    pub(crate) async fn start(
        &self,
        mut launch: ClaudeProcessLaunch,
        listener: Arc<dyn ClaudeProcessListener>,
        turn_holds: Option<ClaudeTurnHolds>,
    ) -> Result<Arc<ClaudeCodeProcess>, ClaudeLaunchError> {
        if self.lock().stop_deadline.is_some() {
            return Err(ClaudeLaunchError::Stopping);
        }
        if launch.token.is_none()
            && let Some(provider_account_id) = launch.account.read()
        {
            launch.token = read_token_account_token(&self.provider_accounts, &provider_account_id)
                .await
                .map_err(ClaudeLaunchError::SealedToken)?;
        }
        launch.telemetry_target = self.telemetry_target.port().cloned();
        let process = Arc::new(
            ClaudeCodeProcess::start(
                &self.spawner,
                &self.child_records,
                &self.processes,
                launch,
                &self.settings_folder,
                listener,
                turn_holds,
                Arc::clone(&self.raw_messages),
            )
            .await?,
        );
        let stop_deadline = {
            let mut live = self.lock();
            live.processes
                .retain(|kept| kept.upgrade().is_some_and(|kept| !kept.is_closed()));
            live.processes.push(Arc::downgrade(&process));
            live.stop_deadline
        };
        // A stop that ran while the process was starting has already gone past it.
        if let Some(deadline) = stop_deadline {
            process
                .stop(half_of_what_is_left(deadline), Some(deadline))
                .await;
            return Err(ClaudeLaunchError::Stopping);
        }
        Ok(process)
    }

    /// Stops every live process together, each given half of what is left before `deadline` to
    /// exit on its input's close and the rest to answer the stop ask, and killed at `deadline`;
    /// refuses every later start, and stops one that was starting against the same deadline.
    pub(crate) async fn stop_every_process(&self, deadline: Instant) {
        let processes: Vec<Arc<ClaudeCodeProcess>> = {
            let mut live = self.lock();
            live.stop_deadline = Some(deadline);
            live.processes
                .drain(..)
                .filter_map(|kept| kept.upgrade())
                .collect()
        };
        futures::future::join_all(
            processes
                .iter()
                .map(|process| process.stop(half_of_what_is_left(deadline), Some(deadline))),
        )
        .await;
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

// The input close's share of a process's stop: half of what is left before `deadline`, the stop
// ask taking the other half.
fn half_of_what_is_left(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now()) / 2
}

/// The token sealed for `provider_account_id`'s account where it signs in with a pasted token, as
/// the account's processes are handed it on their descriptor; `None` for any other account, whose
/// read never reaches the keychain. Fails where the accounts reader is not registered or cannot
/// read the account, and for a token account with no token sealed, whose process could sign in as
/// no one.
pub(crate) async fn read_token_account_token(
    provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
    provider_account_id: &ProviderAccountId,
) -> Result<Option<SecretString>, Box<dyn Error + Send + Sync>> {
    let accounts = provider_accounts.require_port()?;
    let mode = accounts
        .read_observed_auth_mode(provider_account_id.clone())
        .await?;
    if mode != Some(ProviderAuthMode::OauthToken) {
        return Ok(None);
    }
    accounts
        .read_sealed_token(provider_account_id.clone())
        .await?
        .map(Some)
        .ok_or_else(|| "no token is sealed for the token account".into())
}

#[cfg(test)]
mod tests;
