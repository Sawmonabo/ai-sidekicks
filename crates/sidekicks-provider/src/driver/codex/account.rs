//! The Codex driver's account legs: Codex's own acts on one account's home, each sent on the
//! service that home's own Codex runs, or on a short-lived one started there for the act, and
//! where its memory import reads and lands.

pub(crate) mod auth_file;
mod limits;
pub(crate) mod login;
mod memory;
mod sign_out;
mod switch;
mod window_start;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::account::credential_home::CredentialHome;
use crate::account::registry::ProviderAccountRegistry;
use crate::driver::ProviderAccountFolders;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::{CodexServiceRegistry, home_socket_path};
use crate::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::contract::account::{
    MemoryImportStore, ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObservation,
    ProviderObserveLegs, ProviderSignInLegs, ProviderSwitchLegs, ProviderTokenStatusLegs,
    ProviderWindowTurnLegs, SessionAccountMove, SessionToMove,
};
use crate::driver::contract::error::DriverError;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// The switch that keeps a short-lived service's sign-in in the home's own `auth.json`, as on
/// every Codex process of an account home.
const CODEX_FILE_CREDENTIAL_STORE: &str = "cli_auth_credentials_store=\"file\"";

/// The switch that keeps a service's sign-in in its process's memory alone, so it writes no
/// `auth.json`: the switching service's, which runs on tokens the daemon hands it.
pub(crate) const CODEX_EPHEMERAL_CREDENTIAL_STORE: &str =
    "cli_auth_credentials_store=\"ephemeral\"";

/// What Codex's account legs reach a home's Codex through: the driver's services, one per home,
/// what a short-lived service started for one act runs on, the driver's filing of rate limits, the
/// account registry, the binding store a switch moves bindings in, and each account's dead
/// renewals in a row.
pub(crate) struct CodexAccountLegs {
    registry: Arc<CodexServiceRegistry>,
    dependencies: Arc<CodexServiceDependencies>,
    rate_limits: CodexRateLimitFiling,
    accounts: Arc<PortRegistration<Arc<ProviderAccountRegistry>>>,
    // The binding store, which a switch moves each session's binding in.
    bindings: Arc<dyn RuntimeBindingWriter>,
    // What every short-lived service runs on, whatever its home.
    short_lived_dependencies: Arc<CodexServiceDependencies>,
    // Each account's limits reads in a row whose needed renewal left its `auth.json` unchanged,
    // kept in memory as the observer's own misses are.
    dead_renewals: Mutex<HashMap<ProviderAccountId, u8>>,
}

impl CodexAccountLegs {
    /// The legs over `registry`, whose short-lived services run on `dependencies`, the ones
    /// `registry`'s own services share; limits read are filed through `rate_limits`, the driver's
    /// own filing, each account's mode and reset credits read and kept in the registry `accounts`
    /// registers, and a switch's bindings moved in `bindings`.
    pub(crate) fn new(
        registry: Arc<CodexServiceRegistry>,
        dependencies: Arc<CodexServiceDependencies>,
        rate_limits: CodexRateLimitFiling,
        accounts: Arc<PortRegistration<Arc<ProviderAccountRegistry>>>,
        bindings: Arc<dyn RuntimeBindingWriter>,
    ) -> Self {
        Self {
            registry,
            short_lived_dependencies: compose_short_lived_dependencies(&dependencies),
            dependencies,
            rate_limits,
            accounts,
            bindings,
            dead_renewals: Mutex::default(),
        }
    }

    /// Drops the dead renewals counted for `provider_account_id`'s account, which was removed.
    pub(crate) fn forget_account(&self, provider_account_id: &ProviderAccountId) {
        lock(&self.dead_renewals).remove(provider_account_id);
    }

    // The account registry. Fails while it is not registered.
    fn accounts(&self) -> Result<&Arc<ProviderAccountRegistry>, DriverError> {
        self.accounts
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    // Runs `act` on the service serving in `codex_home`, else on a short-lived service started
    // there for it as `provider_account_id`'s home and ended after, whatever `act` answered, by
    // Codex's own drain: it finishes what it was writing and exits by itself, waited for within
    // the grace a stop gives and killed after it, so the act never holds the home for longer.
    async fn act_on_home_service<Answer>(
        &self,
        provider_account_id: ProviderAccountId,
        codex_home: PathBuf,
        act: impl AsyncFnOnce(&CodexService) -> Answer,
    ) -> Answer {
        let running = self
            .registry
            .service_on(&codex_home)
            .filter(|service| service.is_serving());
        if let Some(service) = running {
            return act(&service).await;
        }
        let home_socket = home_socket_path(&codex_home);
        let service = CodexService::new(
            CodexServiceHome {
                codex_home,
                kind: CodexHomeKind::Account(provider_account_id),
            },
            CodexServiceSocket {
                path: home_socket.clone(),
                home_socket,
            },
            CodexServiceKind::Account,
            Arc::clone(&self.short_lived_dependencies),
            Vec::new(),
        );
        let answer = act(&service).await;
        // Taken off its home as a replaced service is, so its stop asks Codex to drain rather
        // than signaling it to end at once.
        service.mark_replaced();
        service.stop().await;
        answer
    }
}

impl ProviderAccountLegs for CodexAccountLegs {
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        sign_out::sign_out_codex_home(self, provider_account_id, folders).boxed()
    }

    // Codex keeps each sign-in in its home's own file and never moves it, so nothing is left.
    fn remove_sign_in_move_leftovers<'call>(
        &'call self,
        _registry: &'call ProviderAccountRegistry,
    ) -> BoxFuture<'call, Result<Vec<io::Error>, DriverError>> {
        async { Ok(Vec::new()) }.boxed()
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

    fn sign_in_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderSignInLegs>> {
        None
    }

    fn token_status_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenStatusLegs>> {
        None
    }
}

impl ProviderObserveLegs for CodexAccountLegs {
    fn observe(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<ProviderObservation, DriverError>> {
        limits::observe_codex_limits(self, provider_account_id, folders).boxed()
    }

    /// No: each read runs on its own home's service, so no two reads share a process.
    fn reads_one_at_a_time(&self) -> bool {
        false
    }

    /// No: a Codex turn pushes the account's own `account/rateLimits/updated` with it, so the
    /// turn's end brings its reading and needs no read.
    fn reads_at_turn_end(&self) -> bool {
        false
    }
}

impl ProviderSwitchLegs for CodexAccountLegs {
    fn move_sessions(
        &self,
        _from: ProviderAccountId,
        to: ProviderAccountId,
        sessions: Vec<SessionToMove>,
        actor: DeviceId,
    ) -> BoxFuture<'_, Vec<Result<SessionAccountMove, (SessionId, DriverError)>>> {
        switch::move_codex_sessions(self, to, sessions, actor).boxed()
    }
}

impl ProviderMemoryImportLegs for CodexAccountLegs {
    fn memory_import_stores(&self, home: &CredentialHome) -> io::Result<Vec<MemoryImportStore>> {
        memory::codex_memory_import_stores(self, home)
    }
}

// What every short-lived service runs on, composed once, since nothing in it names a home: the
// driver's own services' dependencies with the file credential store added, and drains of their
// own, shared by every short-lived service, each killing its service once a stop's grace passes
// and called off with the driver's own drains.
fn compose_short_lived_dependencies(
    shared: &CodexServiceDependencies,
) -> Arc<CodexServiceDependencies> {
    let mut additional_config_overrides = shared.additional_config_overrides.clone();
    additional_config_overrides.push(CODEX_FILE_CREDENTIAL_STORE.to_owned());
    Arc::new(CodexServiceDependencies {
        spawner: shared.spawner.clone(),
        provider_services: Arc::clone(&shared.provider_services),
        processes: Arc::clone(&shared.processes),
        child_records: Arc::clone(&shared.child_records),
        program: Arc::clone(&shared.program),
        data_folder: shared.data_folder.clone(),
        logs_folder: shared.logs_folder.clone(),
        personal_home: shared.personal_home.clone(),
        additional_config_overrides,
        startup_timeout: shared.startup_timeout,
        dispatches_hook_mode: shared.dispatches_hook_mode,
        session_shell_kind: shared.session_shell_kind,
        events: Arc::clone(&shared.events),
        release: Arc::clone(&shared.release),
        drains: LastingServiceDrains::short_lived_beside(&shared.drains),
        tasks: shared.tasks.clone(),
        exec_relay: Arc::clone(&shared.exec_relay),
        switching: Arc::clone(&shared.switching),
    })
}

#[cfg(test)]
mod tests;
