//! The `provider.account.*` methods over the account registry, the sign-in broker, the token
//! custody and the background observer: the list, register, update and delete, the probe, the
//! home's reset, and the brokered sign-in with its code and its cancel. Who may call them is the
//! gateway's admission and nothing here; each mutation reads its calling device, which the sign-in
//! takes as its origin and every other names in the service log, and publishes the account it
//! changed on the subscription's stream.

use std::collections::HashMap;
use std::sync::Arc;

use sidekicks_contracts::provider::account::record::{
    ProviderAccountId, ProviderAccountNotification,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::registry::{MethodRegistryBuilder, RegistrationError};
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::observer::{AccountLiveTurns, ProviderAccountObserver};
use sidekicks_provider::account::registry::{ProviderAccountRegistry, RegisteredAccount};
use sidekicks_provider::account::sign_in::{
    ProviderAccountNotificationPublisher, ProviderSignInBroker,
};
use sidekicks_provider::account::token_custody::ProviderTokenCustody;
use sidekicks_provider::driver::ProviderAccountReader;
use sidekicks_provider::driver::contract::account::ProviderAccountLegs;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

mod credential_home;
mod list;
pub(crate) mod notifications;
mod probe;
mod registration;
mod sign_in;
#[cfg(test)]
mod tests;

/// What the `provider.account.*` methods act through.
pub(crate) struct ProviderAccountMethodSources {
    /// The accounts this machine runs providers on.
    pub(crate) accounts: Arc<ProviderAccountRegistry>,
    /// The registered providers, whose ids a readiness read covers and whose drivers forget a
    /// removed account.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The broker of each provider's own sign-in.
    pub(crate) sign_in: Arc<ProviderSignInBroker>,
    /// The custody of each pasted token.
    pub(crate) token_custody: Arc<ProviderTokenCustody>,
    /// The background observer, which the probe asks and a new or removed account joins or
    /// leaves.
    pub(crate) observer: Arc<ProviderAccountObserver>,
    /// Resolves a registered account's folders, refusing one whose home is gone.
    pub(crate) account_reader: Arc<dyn ProviderAccountReader>,
    /// Each provider's own acts on an account's home, the reset's sign-out among them.
    pub(crate) account_legs: HashMap<ProviderId, Arc<dyn ProviderAccountLegs>>,
    /// The lock every act in an account's home takes.
    pub(crate) home_lock: Arc<AccountHomeLock>,
    /// The sessions with a turn live on an account, which hold its removal.
    pub(crate) live_turns: Arc<dyn AccountLiveTurns>,
    /// Where an account's change goes out on `provider.account.subscribe`.
    pub(crate) publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    /// The daemon's read connections, over the stored quota readings.
    pub(crate) database_reads: Arc<DatabaseReadPool>,
    /// This machine's own device, whose sign-in may take the provider's callback here.
    pub(crate) machine_device_id: DeviceId,
}

/// Registers every `provider.account.*` method but the current-account switch, the memory import,
/// the usage read and the subscription, over `sources`. Fails the start when a method is already
/// registered.
pub(crate) fn register_provider_account_methods(
    registry: &mut MethodRegistryBuilder,
    sources: ProviderAccountMethodSources,
) -> Result<(), RegistrationError> {
    let sources = Arc::new(sources);
    list::register_provider_account_list(registry, &sources)?;
    registration::register_provider_account_registration(registry, &sources)?;
    probe::register_provider_account_probe(registry, &sources)?;
    credential_home::register_provider_account_credential_home_reset(registry, &sources)?;
    sign_in::register_provider_account_sign_in(registry, &sources)
}

impl ProviderAccountMethodSources {
    /// Publishes `account` as it now is, and names in the service log the device whose `method`
    /// changed it.
    fn publish_change(&self, method: &'static str, device: &DeviceId, account: &RegisteredAccount) {
        tracing::info!(
            method,
            device_id = device.as_str(),
            account_id = account.account_id.as_str(),
            "a provider account changed"
        );
        self.publisher
            .publish(ProviderAccountNotification::AccountChanged {
                account: account.to_provider_account(),
            });
    }

    /// Publishes `account_id`'s removal, and names in the service log the device that removed it.
    fn publish_removal(
        &self,
        method: &'static str,
        device: &DeviceId,
        account_id: &ProviderAccountId,
    ) {
        tracing::info!(
            method,
            device_id = device.as_str(),
            account_id = account_id.as_str(),
            "a provider account was removed"
        );
        self.publisher
            .publish(ProviderAccountNotification::AccountRemoved {
                account_id: account_id.clone(),
            });
    }
}
