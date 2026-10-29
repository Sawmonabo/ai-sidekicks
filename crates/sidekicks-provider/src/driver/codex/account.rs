//! The Codex driver's account legs: Codex's own acts on one account's home, each sent on the
//! service that home's own Codex runs, or on a short-lived one started there for the act.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod auth_file;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod limits;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod sign_out;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

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
    ProviderAccountLegs, ProviderObservation, ProviderObserveLegs,
};
use crate::driver::contract::error::DriverError;

/// The switch that keeps a short-lived service's sign-in in the home's own `auth.json`, as on
/// every Codex process of an account home.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
const CODEX_FILE_CREDENTIAL_STORE: &str = "cli_auth_credentials_store=\"file\"";

/// What Codex's account legs reach a home's Codex through: the driver's services, one per home,
/// what a short-lived service started for one act runs on, the driver's filing of rate limits, the
/// account registry, and each account's dead renewals in a row.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
pub(crate) struct CodexAccountLegs {
    registry: Arc<CodexServiceRegistry>,
    dependencies: Arc<CodexServiceDependencies>,
    rate_limits: CodexRateLimitFiling,
    accounts: Arc<ProviderAccountRegistry>,
    // Each account's limits reads in a row whose needed renewal left its `auth.json` unchanged,
    // kept in memory as the observer's own misses are.
    dead_renewals: Mutex<HashMap<ProviderAccountId, u8>>,
}

impl CodexAccountLegs {
    /// The legs over `registry`, whose short-lived services run on `dependencies`, the ones
    /// `registry`'s own services share; limits read are filed through `rate_limits`, the driver's
    /// own filing, and each account's mode and reset credits read and kept in `accounts`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the driver hands its account legs to the account plane once it is wired"
        )
    )]
    pub(crate) fn new(
        registry: Arc<CodexServiceRegistry>,
        dependencies: Arc<CodexServiceDependencies>,
        rate_limits: CodexRateLimitFiling,
        accounts: Arc<ProviderAccountRegistry>,
    ) -> Self {
        Self {
            registry,
            dependencies,
            rate_limits,
            accounts,
            dead_renewals: Mutex::default(),
        }
    }

    // Runs `act` on the service serving in `codex_home`, else on a short-lived service started
    // there for it as `provider_account_id`'s home and stopped after, whatever `act` answered.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the driver hands its account legs to the account plane once it is wired"
        )
    )]
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
            compose_short_lived_dependencies(&self.dependencies),
        );
        let answer = act(&service).await;
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

// What a short-lived service runs on: the driver's own services' dependencies with the file
// credential store added, and drains of its own, since it is never a lasting service.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
fn compose_short_lived_dependencies(
    shared: &CodexServiceDependencies,
) -> Arc<CodexServiceDependencies> {
    let mut additional_config_overrides = shared.additional_config_overrides.clone();
    additional_config_overrides.push(CODEX_FILE_CREDENTIAL_STORE.to_owned());
    Arc::new(CodexServiceDependencies {
        spawner: shared.spawner.clone(),
        provider_services: Arc::clone(&shared.provider_services),
        processes: Arc::clone(&shared.processes),
        program: Arc::clone(&shared.program),
        data_folder: shared.data_folder.clone(),
        logs_folder: shared.logs_folder.clone(),
        additional_config_overrides,
        startup_timeout: shared.startup_timeout,
        dispatches_hook_mode: shared.dispatches_hook_mode,
        events: Arc::clone(&shared.events),
        release: Arc::clone(&shared.release),
        drains: LastingServiceDrains::default(),
        tasks: shared.tasks.clone(),
        exec_relay: Arc::clone(&shared.exec_relay),
    })
}
