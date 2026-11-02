//! The Claude Code driver's account legs: Claude Code's own acts on one account's home, each run
//! on the folders the caller names.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod sign_out;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod throwaway_folder;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod token_status;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod window_start;

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_platforms::{PathRules, Spawner};

use crate::command_search::ProviderCommandSearch;
use crate::driver::claude::spawn::environment::{
    ClaudeProcessEnvironmentRequest, ClaudeProcessHome, compose_claude_process_environment,
};
use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
use crate::driver::claude::spawn::launch::installed_build::resolve_claude_build;
use crate::driver::contract::account::{ProviderAccountLegs, ProviderTokenStatusLegs};
use crate::driver::contract::error::DriverError;
use crate::driver::{DriverServices, ProviderAccountFolders};
use crate::spawn_environment::{ReservedEnvironmentNames, SessionEnvironment};
use crate::spawned_version::ResolvedProviderExecutable;

/// What Claude Code's account legs start their processes from: the installed build, found as a
/// session's is, the environment every Claude Code process is composed over, and the driver's
/// launcher, which every Claude Code process the driver keeps starts through.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
pub(crate) struct ClaudeAccountLegs {
    spawner: Spawner,
    launcher: Arc<ClaudeProcessLauncher>,
    command_search: Arc<ProviderCommandSearch>,
    home_folder: PathBuf,
    data_folder: PathBuf,
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
impl ClaudeAccountLegs {
    /// The legs over the shared services, starting their kept processes through `launcher`; they
    /// hold handles and do no I/O.
    pub(crate) fn new(services: &DriverServices, launcher: Arc<ClaudeProcessLauncher>) -> Self {
        Self {
            spawner: services.spawner.clone(),
            launcher,
            command_search: Arc::clone(&services.command_search),
            home_folder: services.home_folder.clone(),
            data_folder: services.data_folder.clone(),
            base_environment: Arc::clone(&services.base_environment),
            reserved_names: Arc::clone(&services.reserved_names),
        }
    }

    // The environment a process on `home` starts with, and the build it names. Fails as the
    // environment cannot be composed or the build resolved.
    async fn resolve_build_on(
        &self,
        home: ClaudeProcessHome<'_>,
    ) -> Result<ResolvedProviderExecutable, DriverError> {
        let data_folder = self.data_folder.to_string_lossy();
        let environment = compose_claude_process_environment(
            ClaudeProcessEnvironmentRequest {
                session: SessionEnvironment {
                    base: &self.base_environment,
                    every_project_rows: &[],
                    project_rows: &[],
                    reserved_names: &self.reserved_names,
                    rules: PathRules::NATIVE,
                },
                deny_env_vars: &[],
                home,
                data_folder: &data_folder,
            },
            &[],
        )
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
        resolve_claude_build(&self.command_search, &self.home_folder, environment).await
    }
}

impl ProviderAccountLegs for ClaudeAccountLegs {
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        sign_out::sign_out_claude_home(self, provider_account_id, folders).boxed()
    }
}

impl ProviderTokenStatusLegs for ClaudeAccountLegs {
    fn read_token_status<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>> {
        token_status::read_claude_token_status(self, provider_account_id, folders, token).boxed()
    }
}

/// The legs over `services`, starting their kept processes through a launcher of their own that
/// reads tokens through `services`' accounts port.
#[cfg(test)]
pub(crate) fn test_account_legs(services: &DriverServices) -> ClaudeAccountLegs {
    let launcher = ClaudeProcessLauncher::new(
        services.spawner.clone(),
        Arc::clone(&services.child_records),
        Arc::clone(&services.processes),
        Arc::clone(&services.ports.provider_accounts),
        &services.data_folder,
    );
    ClaudeAccountLegs::new(services, Arc::new(launcher))
}
