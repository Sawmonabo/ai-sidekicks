//! The installed Codex build every service starts from: the command resolved again at each start,
//! in the environment the home's processes take, so a restart runs what the command names now.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_platforms::PathRules;

use crate::provider::command_search::{ProviderCommandSearch, list_command_folders};
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::service::home::CodexServiceHome;
use crate::provider::driver::codex::service::supervisor::CodexProgramResolver;
use crate::provider::driver::contract::DriverError;
use crate::provider::spawn_environment::{
    ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
    build_provider_process_environment,
};
use crate::provider::spawned_version::{ResolvedProviderExecutable, resolve_provider_executable};

/// The build the configured Codex command names, resolved at every start in the home's
/// environment: the login shell's, with the home as `CODEX_HOME`.
pub(crate) struct CodexInstalledProgram {
    command_search: Arc<ProviderCommandSearch>,
    home_folder: PathBuf,
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
}

impl CodexInstalledProgram {
    /// The build `command_search` finds below `home_folder` when the environment's `PATH` holds
    /// none, each start's environment composed from `base_environment`.
    pub(crate) fn new(
        command_search: Arc<ProviderCommandSearch>,
        home_folder: PathBuf,
        base_environment: Arc<[(String, String)]>,
        reserved_names: Arc<ReservedEnvironmentNames>,
    ) -> Self {
        Self {
            command_search,
            home_folder,
            base_environment,
            reserved_names,
        }
    }
}

impl CodexProgramResolver for CodexInstalledProgram {
    fn resolve<'call>(
        &'call self,
        home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        async move {
            let credential_homes: Vec<(String, String)> = DESCRIPTOR
                .credential_home_environment_names
                .iter()
                .map(|name| {
                    (
                        (*name).to_owned(),
                        home.codex_home.to_string_lossy().into_owned(),
                    )
                })
                .collect();
            let environment = build_provider_process_environment(
                &ProviderEnvironmentRequest {
                    session: SessionEnvironment {
                        base: &self.base_environment,
                        every_project_rows: &[],
                        project_rows: &[],
                        reserved_names: &self.reserved_names,
                        rules: PathRules::NATIVE,
                    },
                    descriptor: &DESCRIPTOR,
                    deny_env_vars: &[],
                    credential_homes: &credential_homes,
                },
                &[],
            )
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
            let command = DESCRIPTOR
                .command_lookup(PathRules::NATIVE)
                .and_then(|lookup| lookup.names.first())
                .map_or_else(String::new, |name| (*name).to_owned());
            let search_folders = list_command_folders(&DESCRIPTOR, &self.home_folder, &environment);
            resolve_provider_executable(
                &self.command_search,
                &DESCRIPTOR.provider_id(),
                command,
                environment,
                search_folders,
            )
            .await
        }
        .boxed()
    }
}
