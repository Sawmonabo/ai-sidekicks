//! The Claude Code driver's account legs: Claude Code's own acts on one account's home, each run
//! on the folders the caller names, and where its memory import reads and lands.

pub(super) mod credentials;
pub(super) mod helper_mode;
mod limits;
mod sign_in;
mod sign_in_move;
mod sign_out;
mod switch;
mod token_resupply;
mod token_status;
mod window_start;

mod memory;

use std::io;
use std::sync::{Arc, OnceLock, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::account::sign_in::ProviderSignInArm;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_platforms::PathRules;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use crate::account::credential_home::CredentialHome;
use crate::account::registry::ProviderAccountRegistry;
use crate::driver::claude::rate_limit_windows::ClaudeUsageProbeModels;
use crate::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::driver::claude::spawn::environment::{
    ClaudeProcessEnvironmentRequest, ClaudeProcessHome, compose_claude_process_environment,
};
use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
use crate::driver::claude::spawn::launch::installed_build::resolve_claude_build;
use crate::driver::contract::account::{
    MemoryImportStore, ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObserveLegs,
    ProviderSignInHandle, ProviderSignInLegs, ProviderSignInObservation, ProviderSwitchLegs,
    ProviderTokenLimitsLegs, ProviderTokenStatusLegs, ProviderWindowTurnLegs, SessionAccountMove,
    SessionToMove, SwitchMovesAccepted,
};
use crate::driver::contract::error::DriverError;
use crate::driver::ports::DriverPorts;
use crate::driver::{
    DriverServices, HelperModeServices, ProviderAccountFolders, helper_mode_services_over,
};
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::spawn_environment::SessionEnvironment;
use crate::spawned_version::ResolvedProviderExecutable;

/// What every Claude Code process on an account's home starts from, which the running daemon's
/// account legs and a helper mode's both hold: a helper mode's bundle, which a driver's services
/// also build, with the spawner, the installed build's search, found as a session's is, and what
/// the process's environment is composed over.
struct ClaudeAccountProcessSources(HelperModeServices);

impl ClaudeAccountProcessSources {
    // The environment a process on `home` starts with, `deny_env_vars` removed, and the build it
    // names. Fails as the environment cannot be composed or the build resolved.
    async fn resolve_build_on(
        &self,
        home: ClaudeProcessHome<'_>,
        deny_env_vars: &[&str],
    ) -> Result<ResolvedProviderExecutable, DriverError> {
        let environment = self.compose_environment_on(home, deny_env_vars)?;
        resolve_claude_build(&self.0.command_search, &self.0.home_folder, environment).await
    }

    // The environment a process on `home` starts with over the base environment, with no
    // environment row, `deny_env_vars` removed. Fails as it cannot be composed.
    fn compose_environment_on(
        &self,
        home: ClaudeProcessHome<'_>,
        deny_env_vars: &[&str],
    ) -> Result<Vec<(String, String)>, DriverError> {
        let data_folder = self.0.data_folder.to_string_lossy();
        compose_claude_process_environment(
            ClaudeProcessEnvironmentRequest {
                session: SessionEnvironment {
                    base: &self.0.base_environment,
                    every_project_rows: &[],
                    project_rows: &[],
                    reserved_names: &self.0.reserved_names,
                    rules: PathRules::NATIVE,
                },
                deny_env_vars,
                home,
                data_folder: &data_folder,
            },
            &[],
        )
        .map_err(|error| DriverError::Internal(Box::new(error)))
    }
}

/// What Claude Code's account legs start their processes from: the sources every Claude Code
/// process on an account's home starts from, and the driver's launcher, which every Claude Code
/// process the driver keeps starts through; the driver's models each account's limits read
/// names, which its sessions' events read their windows by; and what a switch moves: the
/// driver's sessions, their bindings, the stored bindings it reads and the accounts they read.
pub(crate) struct ClaudeAccountLegs {
    sources: ClaudeAccountProcessSources,
    launcher: Arc<ClaudeProcessLauncher>,
    usage_probe_models: Arc<ClaudeUsageProbeModels>,
    sessions: OnceLock<Weak<ClaudeSessionEstablishment>>,
    bindings: Arc<dyn RuntimeBindingWriter>,
    pool: Arc<DatabaseReadPool>,
    ports: Arc<DriverPorts>,
}

impl ClaudeAccountLegs {
    /// The legs over the shared services, starting their kept processes through `launcher` and
    /// noting each limits read's models in `usage_probe_models`; the sessions a switch moves are
    /// attached once the driver composes them. They hold handles and do no I/O.
    pub(crate) fn new(
        services: &DriverServices,
        launcher: Arc<ClaudeProcessLauncher>,
        usage_probe_models: Arc<ClaudeUsageProbeModels>,
    ) -> Self {
        Self {
            sources: ClaudeAccountProcessSources(helper_mode_services_over(services)),
            launcher,
            usage_probe_models,
            sessions: OnceLock::new(),
            bindings: Arc::clone(&services.runtime_bindings),
            pool: Arc::clone(&services.pool),
            ports: Arc::clone(&services.ports),
        }
    }

    /// Attaches the sessions a switch moves, once the driver has composed them; a second attach
    /// is ignored, since a driver composes its sessions once.
    pub(crate) fn attach_sessions(&self, sessions: Weak<ClaudeSessionEstablishment>) {
        drop(self.sessions.set(sessions));
    }
}

impl ProviderAccountLegs for ClaudeAccountLegs {
    fn sign_out_home(
        &self,
        _provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        sign_out::sign_out_claude_home(&self.sources, folders).boxed()
    }

    fn remove_sign_in_move_leftovers<'call>(
        &'call self,
        registry: &'call ProviderAccountRegistry,
    ) -> BoxFuture<'call, Result<Vec<io::Error>, DriverError>> {
        async move {
            sign_in_move::remove_claude_sign_in_move_leftovers(registry)
                .await
                .map_err(|error| DriverError::Internal(Box::new(error)))
        }
        .boxed()
    }

    fn observe_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderObserveLegs>> {
        Some(self)
    }

    fn memory_import_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderMemoryImportLegs>> {
        Some(self)
    }

    fn switch_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderSwitchLegs>> {
        Some(self)
    }

    fn window_turn_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderWindowTurnLegs>> {
        Some(self)
    }

    fn token_limits_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenLimitsLegs>> {
        Some(self)
    }

    fn sign_in_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderSignInLegs>> {
        Some(self)
    }

    fn token_status_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenStatusLegs>> {
        Some(self)
    }
}

impl ProviderMemoryImportLegs for ClaudeAccountLegs {
    fn memory_import_stores(&self, home: &CredentialHome) -> io::Result<Vec<MemoryImportStore>> {
        memory::claude_memory_import_stores(self, home)
    }
}

impl ProviderSignInLegs for ClaudeAccountLegs {
    fn start_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        home: CredentialHome,
        arm: ProviderSignInArm,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        sign_in::start_claude_sign_in(self, home, arm).boxed()
    }

    fn observe_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        sign_in::observe_claude_sign_in(self, home).boxed()
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

    // The new token is read from where it is sealed at each start, so it is never handed here.
    fn hand_resupplied_token<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), DriverError>> {
        let relaunched = token_resupply::relaunch_on_resupplied_token(self, provider_account_id);
        async move { relaunched }.boxed()
    }
}

impl ProviderSwitchLegs for ClaudeAccountLegs {
    fn move_sessions(
        &self,
        from: ProviderAccountId,
        to: ProviderAccountId,
        sessions: Vec<SessionToMove>,
        // Each session moves on its own process, so every one moved is named and none reported.
        _actor: DeviceId,
        accepted: SwitchMovesAccepted,
    ) -> BoxFuture<'_, Vec<Result<SessionAccountMove, (SessionId, DriverError)>>> {
        switch::move_claude_sessions(self, from, to, sessions, accepted).boxed()
    }
}

/// The legs over `services`, starting their kept processes through a launcher of their own that
/// reads tokens through `services`' accounts port, noting models in a map of their own and
/// moving the sessions `sessions` brings up.
#[cfg(test)]
pub(crate) fn test_account_legs(
    services: &DriverServices,
    sessions: Weak<ClaudeSessionEstablishment>,
) -> ClaudeAccountLegs {
    let legs = ClaudeAccountLegs::new(
        services,
        crate::driver::claude::lifecycle::compose_claude_launcher(services),
        Arc::default(),
    );
    legs.attach_sessions(sessions);
    legs
}
