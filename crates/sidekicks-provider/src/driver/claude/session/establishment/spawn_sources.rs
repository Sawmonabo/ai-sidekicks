//! The daemon's services every process the driver starts reads: where a spawn builds its legs and
//! context, and the environment each process composes from them.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{PathRules, Spawner};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use crate::background_work::BackgroundWorkForms;
use crate::command_search::ProviderCommandSearch;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeCommandChannels;
use crate::driver::claude::delivery::requests::answers::{
    claude_project_folder, read_claude_repository,
};
use crate::driver::claude::session::permission_level::ClaudeCommandSandboxCheck;
use crate::driver::claude::session::rules::CLAUDE_USER_SETTINGS_FILE;
use crate::driver::claude::session::settings_file::ClaudeSettingsSources;
use crate::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessEnvironmentRequest, ClaudeProcessHome, claude_config_folder,
    compose_claude_environment_without_home, compose_claude_process_environment,
};
use crate::driver::contract::error::DriverError;
use crate::driver::ports::DriverPorts;
use crate::port::repository_reader::RepositoryReading;
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
    /// Finds the Claude Code build a command the driver runs once names.
    pub(crate) command_search: Arc<ProviderCommandSearch>,
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
                session: self.session_environment(every_project_rows, project_rows),
                deny_env_vars: &[],
                home,
                data_folder: &data_folder,
            },
            &[],
        )
        .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    /// The environment a Claude Code process would start with on no home of the daemon's, with
    /// the environment rows given, which a read of a server's address fills its variables from.
    /// Fails as the environment cannot be composed.
    pub(crate) fn environment_without_home(
        &self,
        every_project_rows: &[EnvironmentRow],
        project_rows: &[EnvironmentRow],
    ) -> Result<Vec<(String, String)>, DriverError> {
        compose_claude_environment_without_home(
            self.session_environment(every_project_rows, project_rows),
        )
        .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    // The base environment with the rows given, under the native path rules.
    fn session_environment<'rows>(
        &'rows self,
        every_project_rows: &'rows [EnvironmentRow],
        project_rows: &'rows [EnvironmentRow],
    ) -> SessionEnvironment<'rows> {
        SessionEnvironment {
            base: &self.base_environment,
            every_project_rows,
            project_rows,
            reserved_names: &self.reserved_names,
            rules: PathRules::NATIVE,
        }
    }

    /// The environment a process on an account's folders starts with, as `folders` give them.
    /// Fails as the environment cannot be composed.
    pub(crate) fn account_process_environment(
        &self,
        folders: &ProviderAccountFolders,
        every_project_rows: &[EnvironmentRow],
        project_rows: &[EnvironmentRow],
    ) -> Result<Vec<(String, String)>, DriverError> {
        let folders = ClaudeAccountFolders::from(folders);
        self.process_environment(
            ClaudeProcessHome::Account { folders: &folders },
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
        self.account_process_environment(&folders, &[], &[])
    }

    /// The repository of `working_folder` as Claude Code places its project settings; `None`
    /// outside git, or where the daemon's repository read cannot place the folder.
    pub(crate) async fn read_repository(
        &self,
        working_folder: &Path,
    ) -> Option<(RepositoryReading, bool)> {
        let repositories = self.ports.repositories.port()?;
        read_claude_repository(&**repositories, working_folder).await
    }

    /// Where the settings of a Claude Code process started with `environment` in
    /// `working_folder` are read from. It fails nothing; a folder outside git, or one whose
    /// repository cannot be read, reads with no repository.
    pub(crate) async fn read_settings_sources(
        &self,
        environment: &[(String, String)],
        working_folder: &Path,
    ) -> ClaudeSettingsSourcesReading {
        ClaudeSettingsSourcesReading {
            managed_settings_folder: DESCRIPTOR.managed_settings_folder(),
            working_folder: working_folder.to_path_buf(),
            repository: self.read_repository(working_folder).await,
            home_folder: self.home_folder.clone(),
            account_settings_file: claude_account_settings_file(environment),
        }
    }
}

/// Where a session's Claude Code settings are read from, read once for one process's environment
/// and working folder; `sources` lends them.
pub(crate) struct ClaudeSettingsSourcesReading {
    managed_settings_folder: Option<PathBuf>,
    working_folder: PathBuf,
    repository: Option<(RepositoryReading, bool)>,
    home_folder: PathBuf,
    account_settings_file: PathBuf,
}

impl ClaudeSettingsSourcesReading {
    /// The settings sources this reading holds, spelled by the running system's path rules.
    pub(crate) fn sources(&self) -> ClaudeSettingsSources<'_> {
        ClaudeSettingsSources {
            managed_settings_folder: self.managed_settings_folder.as_deref(),
            project_folder: claude_project_folder(&self.working_folder, self.repository.as_ref()),
            home_folder: &self.home_folder,
            account_settings_file: &self.account_settings_file,
            path_rules: PathRules::NATIVE,
        }
    }
}

/// The config folder a Claude Code process started with `environment` reads, which every home the
/// driver starts a process on names.
pub(crate) fn claude_account_config_folder(environment: &[(String, String)]) -> PathBuf {
    claude_config_folder(environment, PathRules::NATIVE)
        .expect("every Claude Code home names its config folder")
}

/// The account home's own settings file a Claude Code process started with `environment` reads,
/// in its config folder.
pub(crate) fn claude_account_settings_file(environment: &[(String, String)]) -> PathBuf {
    claude_account_config_folder(environment).join(CLAUDE_USER_SETTINGS_FILE)
}
