//! The Codex driver's account legs: Codex's own acts on one account's home, each sent on the
//! service that home's own Codex runs, or on a short-lived one started there for the act; the
//! status read of a pasted API key, on a service of its own apart from every home; and where its
//! memory import reads and lands.

pub(crate) mod api_key;
pub(crate) mod auth_file;
pub(super) mod helper_mode;
mod limits;
pub(crate) mod login;
mod memory;
mod sign_in;
mod sign_out;
pub(crate) mod switch;
pub(crate) mod token_refresh;
mod token_status;
mod window_start;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use futures::FutureExt;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::account::sign_in::ProviderSignInArm;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::task::JoinHandle;

use crate::account::credential_home::CredentialHome;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::ProviderAccountRegistry;
use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::token_refresh::{CodexRenewalFlights, CodexTokenRenewer};
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::{
    CodexServiceRegistry, home_config_overrides, home_socket_path,
};
use crate::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::contract::account::{
    MemoryImportStore, ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObservation,
    ProviderObserveLegs, ProviderSignInHandle, ProviderSignInLegs, ProviderSignInObservation,
    ProviderSwitchLegs, ProviderTokenLimitsLegs, ProviderTokenStatusLegs, ProviderWindowTurnLegs,
    SessionAccountMove, SessionToMove,
};
use crate::driver::contract::error::DriverError;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// The switch every Codex process of an account home carries, which keeps its sign-in in the
/// home's own `auth.json`.
pub(crate) const CODEX_FILE_CREDENTIAL_STORE: &str = "cli_auth_credentials_store=\"file\"";

/// The switch that keeps a service's sign-in in its process's memory alone, so it writes no
/// `auth.json`: the switching service's, which runs on tokens the daemon hands it, and an API-key
/// home's and a pasted key's status read's, which run on the key they are handed.
pub(crate) const CODEX_EPHEMERAL_CREDENTIAL_STORE: &str =
    "cli_auth_credentials_store=\"ephemeral\"";

/// What Codex's account legs reach a home's Codex through: the driver's services, one per home,
/// what a short-lived service started for one act runs on, the driver's filing of rate limits, the
/// account registry, the binding store a switch moves bindings in, each account's dead renewals in
/// a row, and the renewals the switching service's token refresh runs in account homes.
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
    // The daemon's lock on account homes, which each renewal holds.
    account_home_lock: Arc<PortRegistration<Arc<AccountHomeLock>>>,
    // The renewals in flight, one per account, made at the first once the lock is registered.
    token_renewals: OnceLock<CodexRenewalFlights>,
}

impl CodexAccountLegs {
    /// The legs over `registry`, whose short-lived services run on `dependencies`, the ones
    /// `registry`'s own services share; limits read are filed through `rate_limits`, the driver's
    /// own filing, each account's mode and reset credits read and kept in the registry `accounts`
    /// registers, a switch's bindings moved in `bindings`, and each renewal held under the lock
    /// `account_home_lock` registers. The switching service's token refresh is answered through
    /// these legs, which hold no strong reference to it.
    pub(crate) fn new(
        registry: Arc<CodexServiceRegistry>,
        dependencies: Arc<CodexServiceDependencies>,
        rate_limits: CodexRateLimitFiling,
        accounts: Arc<PortRegistration<Arc<ProviderAccountRegistry>>>,
        bindings: Arc<dyn RuntimeBindingWriter>,
        account_home_lock: Arc<PortRegistration<Arc<AccountHomeLock>>>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|legs| {
            dependencies
                .switching
                .attach_renewer(CodexTokenRenewer::new(legs.clone()));
            Self {
                registry,
                short_lived_dependencies: compose_short_lived_dependencies(&dependencies),
                dependencies,
                rate_limits,
                accounts,
                bindings,
                dead_renewals: Mutex::default(),
                account_home_lock,
                token_renewals: OnceLock::new(),
            }
        })
    }

    /// Drops the dead renewals counted for `provider_account_id`'s account, which was removed,
    /// and stops the service on its home, answering that stop's task where one ran there.
    pub(crate) fn forget_account(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Option<JoinHandle<()>> {
        lock(&self.dead_renewals).remove(provider_account_id);
        self.registry.stop_account_service(provider_account_id)
    }

    // The account registry. Fails while it is not registered.
    fn accounts(&self) -> Result<&Arc<ProviderAccountRegistry>, DriverError> {
        self.accounts
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    // Runs `act` on the service of `provider_account_id`'s home, `codex_home`, released after
    // whatever `act` answered.
    async fn act_on_home_service<Answer>(
        &self,
        provider_account_id: ProviderAccountId,
        codex_home: PathBuf,
        act: impl AsyncFnOnce(&CodexService) -> Answer,
    ) -> Answer {
        let home_service = self.take_home_service(provider_account_id, codex_home);
        let answer = act(home_service.service().as_ref()).await;
        home_service.release().await;
        answer
    }

    // The service serving in `codex_home`, else a short-lived service on it as
    // `provider_account_id`'s home, which its release stops.
    fn take_home_service(
        &self,
        provider_account_id: ProviderAccountId,
        codex_home: PathBuf,
    ) -> HomeService {
        let running = self
            .registry
            .service_on(&codex_home)
            .filter(|service| service.is_serving());
        if let Some(service) = running {
            return HomeService {
                service,
                is_short_lived: false,
            };
        }
        let home_socket = home_socket_path(&codex_home);
        let kind = CodexHomeKind::Account(provider_account_id);
        let config_overrides = home_config_overrides(&kind);
        let service = CodexService::new(
            CodexServiceHome { codex_home, kind },
            CodexServiceSocket {
                path: home_socket.clone(),
                home_socket,
            },
            CodexServiceKind::Account,
            Arc::clone(&self.short_lived_dependencies),
            config_overrides,
        );
        HomeService {
            service,
            is_short_lived: true,
        }
    }
}

/// The service an act on an account's home runs on: the one serving there, or a short-lived one
/// started for the act, which its release ends.
pub(super) struct HomeService {
    service: Arc<CodexService>,
    is_short_lived: bool,
}

impl HomeService {
    /// The service.
    pub(super) fn service(&self) -> &Arc<CodexService> {
        &self.service
    }

    /// Lets the service go: a short-lived one ends by Codex's own drain, which finishes what it
    /// was writing and exits by itself, waited for within the grace a stop gives and killed after
    /// it, so the act never holds the home for longer; a serving one runs on.
    pub(super) async fn release(self) {
        if self.is_short_lived {
            // Taken off its home as a replaced service is, so its stop asks Codex to drain rather
            // than signaling it to end at once.
            self.service.mark_replaced();
            self.service.stop().await;
        }
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

    fn token_limits_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenLimitsLegs>> {
        None
    }

    fn sign_in_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderSignInLegs>> {
        Some(self)
    }

    fn token_status_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenStatusLegs>> {
        Some(self)
    }
}

impl ProviderTokenStatusLegs for CodexAccountLegs {
    // The read runs in a folder of its own, so neither the account nor its folders are read.
    fn read_token_status<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>> {
        token_status::read_codex_token_status(self, token).boxed()
    }

    fn hand_resupplied_token<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), DriverError>> {
        async move {
            api_key::hand_resupplied_codex_key(
                &self.registry,
                &self.dependencies,
                provider_account_id,
                folders,
                token,
            )
            .await
            .map_err(DriverError::from)
        }
        .boxed()
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

impl ProviderSignInLegs for CodexAccountLegs {
    fn start_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
        arm: ProviderSignInArm,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        sign_in::start_codex_sign_in(self, provider_account_id, home, arm).boxed()
    }

    fn observe_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        sign_in::observe_codex_sign_in(self, provider_account_id, home).boxed()
    }

    /// Yes for the browser arm: Codex's browser sign-in calls back on one fixed port the whole
    /// machine shares, and a second one would end the first's listener.
    fn is_one_per_machine(&self, arm: ProviderSignInArm) -> bool {
        arm == ProviderSignInArm::Browser
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
// driver's own services' dependencies, and drains of their own, shared by every short-lived
// service, each killing its service once a stop's grace passes and called off with the driver's
// own drains.
fn compose_short_lived_dependencies(
    shared: &CodexServiceDependencies,
) -> Arc<CodexServiceDependencies> {
    Arc::new(CodexServiceDependencies {
        spawner: shared.spawner.clone(),
        provider_services: Arc::clone(&shared.provider_services),
        processes: Arc::clone(&shared.processes),
        child_records: Arc::clone(&shared.child_records),
        program: Arc::clone(&shared.program),
        data_folder: shared.data_folder.clone(),
        logs_folder: shared.logs_folder.clone(),
        personal_home: shared.personal_home.clone(),
        additional_config_overrides: shared.additional_config_overrides.clone(),
        startup_timeout: shared.startup_timeout,
        dispatches_hook_mode: shared.dispatches_hook_mode,
        session_shell_kind: shared.session_shell_kind,
        events: Arc::clone(&shared.events),
        release: Arc::clone(&shared.release),
        drains: LastingServiceDrains::short_lived_beside(&shared.drains),
        tasks: shared.tasks.clone(),
        exec_relay: Arc::clone(&shared.exec_relay),
        switching: Arc::clone(&shared.switching),
        provider_accounts: Arc::clone(&shared.provider_accounts),
        telemetry_target: Arc::clone(&shared.telemetry_target),
        exports: Arc::clone(&shared.exports),
        raw_messages: Arc::clone(&shared.raw_messages),
    })
}

#[cfg(test)]
mod tests;
