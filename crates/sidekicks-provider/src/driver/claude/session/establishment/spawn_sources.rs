//! The daemon's services every process the driver starts reads: where a spawn builds its legs and
//! context, and the environment each process composes from them.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{PathRules, Spawner};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use crate::background_work::BackgroundWorkForms;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::delivery::commands::ClaudeCommandChannels;
use crate::driver::claude::session::permission_level::ClaudeCommandSandboxCheck;
use crate::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessEnvironmentRequest, ClaudeProcessHome,
    compose_claude_process_environment,
};
use crate::driver::contract::error::DriverError;
use crate::driver::ports::DriverPorts;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::spawn_environment::{ReservedEnvironmentNames, SessionEnvironment};

/// The daemon's services a spawn reads where it builds its legs and context.
pub(crate) struct ClaudeSpawnSources {
    /// The one thread every child is spawned from, which also checks the command sandbox.
    pub(crate) spawner: Spawner,
    /// How the command sandbox is checked: the descriptor's check in production.
    pub(crate) command_sandbox_check: ClaudeCommandSandboxCheck,
    /// Points the session's binding at the conversation it moved onto.
    pub(crate) runtime_bindings: Arc<dyn RuntimeBindingWriter>,
    /// The read pool, for the session's stored settings.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Each posture's credential list.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The login shell's environment, every process's base.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The names no environment row may set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// Every provider's background work, which a process's settings deny.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// Which process runs each session.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// Every session's command channel.
    pub(crate) command_channels: Arc<ClaudeCommandChannels>,
    /// The handles the daemon registers after the drivers.
    pub(crate) ports: Arc<DriverPorts>,
}

/// The environment every process the driver starts composes from the daemon's services.
impl ClaudeSpawnSources {
    /// The environment a process starts with on `home`, with a session's environment rows where
    /// given. Fails as the environment cannot be composed.
    pub(crate) fn process_environment(
        &self,
        home: ClaudeProcessHome<'_>,
        every_project_rows: &[EnvironmentRow],
        project_rows: &[EnvironmentRow],
    ) -> Result<Vec<(String, String)>, DriverError> {
        let data_folder = self.data_folder.to_string_lossy();
        compose_claude_process_environment(
            ClaudeProcessEnvironmentRequest {
                session: SessionEnvironment {
                    base: &self.base_environment,
                    every_project_rows,
                    project_rows,
                    reserved_names: &self.reserved_names,
                    rules: PathRules::NATIVE,
                },
                deny_env_vars: &[],
                home,
                data_folder: &data_folder,
            },
            &[],
        )
        .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    /// The environment a process on `provider_account_id`'s home starts with, its folders as
    /// `folders` give them. Fails as the environment cannot be composed.
    pub(crate) fn account_process_environment(
        &self,
        folders: &ProviderAccountFolders,
        provider_account_id: &ProviderAccountId,
        every_project_rows: &[EnvironmentRow],
        project_rows: &[EnvironmentRow],
    ) -> Result<Vec<(String, String)>, DriverError> {
        let folders = ClaudeAccountFolders::from(folders);
        self.process_environment(
            ClaudeProcessHome::Account {
                folders: &folders,
                provider_account_id,
            },
            every_project_rows,
            project_rows,
        )
    }

    /// The environment a process that keeps nothing starts with on `provider_account_id`'s home,
    /// its folders read with no session. Fails `provider.account.notFound` or
    /// `provider.account.credentialHome.unavailable` as the account's folders answer, and as they
    /// cannot be read or the environment cannot be composed.
    pub(crate) async fn account_environment(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<Vec<(String, String)>, DriverError> {
        let folders = self
            .ports
            .provider_accounts
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?
            .resolve_account_folders(provider_account_id.clone())
            .await?;
        self.account_process_environment(&folders, provider_account_id, &[], &[])
    }
}
