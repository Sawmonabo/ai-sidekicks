//! The Codex driver's account legs: Codex's own acts on one account's home, each sent on the
//! service that home's own Codex runs, or on a short-lived one started there for the act.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod sign_out;

use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::CodexServiceDependencies;
use crate::driver::contract::account::ProviderAccountLegs;
use crate::driver::contract::error::DriverError;

/// What Codex's account legs reach a home's Codex through: the driver's services, one per home,
/// and what a short-lived service started for one act runs on.
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
}

impl CodexAccountLegs {
    /// The legs over `registry`, whose short-lived services run on `dependencies`, the ones
    /// `registry`'s own services share.
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
    ) -> Self {
        Self {
            registry,
            dependencies,
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
}
