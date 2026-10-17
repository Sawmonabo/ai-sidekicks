//! The live drivers, one per registered provider in the table's order, and the capability gate. A
//! provider id a request or a provider message brings in is checked here: one no driver answers is
//! refused `provider.unavailable`. The gate reads the capability snapshot the start-time provider
//! check recorded, never the driver or the database, and fails closed: a flag is supported only
//! when a recorded snapshot declares it. A steer is not gated here, since it is how the run queue
//! delivers a held message.

use std::sync::{Arc, RwLock};

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;

use crate::ipc::domain_error::DomainError;
use crate::provider::driver::capabilities::{DriverCapabilities, DriverCapabilityFlag};
use crate::provider::driver::contract::{DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE, ProviderDriver};
use crate::provider::driver::{DriverServices, ProviderRegistration};

/// The refusal for a call naming a provider no registered driver answers; its detail carries only
/// the id, so nothing internal leaks.
pub(crate) fn driver_unavailable(provider: &ProviderId) -> DomainError {
    DomainError::new(
        "Provider driver is currently unavailable",
        RefusalCode::ProviderUnavailable,
    )
    .with_detail(json!({ "driverId": provider.as_str() }))
}

/// The refusal for a call gated on `flag` that the driver does not declare; its detail carries only
/// the driver's id and the flag.
pub(crate) fn driver_capability_unsupported(
    provider: &ProviderId,
    flag: DriverCapabilityFlag,
) -> DomainError {
    DomainError::new(
        DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE,
        RefusalCode::ProviderCapabilityUnsupported,
    )
    .with_detail(json!({ "driverId": provider.as_str(), "flag": flag }))
}

/// A driver, its provider and the capability snapshot recorded for it.
struct RegisteredDriver {
    /// The provider the driver answers.
    provider: ProviderId,
    /// The live driver.
    driver: Arc<dyn ProviderDriver>,
    /// The capabilities its last read reported, `None` until the provider check records one; the
    /// lock is held only for a read or a write of the snapshot.
    capabilities: RwLock<Option<DriverCapabilities>>,
}

/// Holds the registered drivers in the table's order and gates capability-bound calls on their
/// recorded flags.
pub(crate) struct ProviderRegistry {
    /// The drivers in table order; a short list, scanned.
    drivers: Vec<RegisteredDriver>,
}

impl ProviderRegistry {
    /// Builds every provider in `table`, in its order, from the one bundle of shared services. A
    /// build does no I/O and starts no process, so it cannot fail.
    pub(crate) fn register_from(table: &[ProviderRegistration], services: &DriverServices) -> Self {
        Self {
            drivers: table
                .iter()
                .map(|registration| RegisteredDriver {
                    provider: ProviderId::new(registration.descriptor.id.to_owned())
                        .expect("a table id matches the provider id pattern"),
                    driver: (registration.build)(services),
                    capabilities: RwLock::new(None),
                })
                .collect(),
        }
    }

    /// The registered entry for `provider`, refused `provider.unavailable` when no driver answers
    /// it.
    fn entry(&self, provider: &ProviderId) -> Result<&RegisteredDriver, DomainError> {
        self.drivers
            .iter()
            .find(|registered| registered.provider == *provider)
            .ok_or_else(|| driver_unavailable(provider))
    }

    /// Records the capabilities `provider`'s read reported, replacing the earlier snapshot. Refused
    /// `provider.unavailable` when no driver answers it.
    pub(crate) fn record_capabilities(
        &self,
        provider: &ProviderId,
        capabilities: DriverCapabilities,
    ) -> Result<(), DomainError> {
        *self
            .entry(provider)?
            .capabilities
            .write()
            .expect("no snapshot writer panics holding the lock") = Some(capabilities);
        Ok(())
    }

    /// The driver for `provider`, refused `provider.unavailable` when no driver answers it.
    pub(crate) fn lookup(
        &self,
        provider: &ProviderId,
    ) -> Result<Arc<dyn ProviderDriver>, DomainError> {
        self.entry(provider)
            .map(|registered| Arc::clone(&registered.driver))
    }

    /// Passes when `provider`'s recorded snapshot declares `flag`. Refuses with
    /// [`driverUnavailable`] when no driver answers it, and [`driver_capability_unsupported`] when
    /// the flag is off or no snapshot is recorded yet.
    pub(crate) fn check_capability(
        &self,
        provider: &ProviderId,
        flag: DriverCapabilityFlag,
    ) -> Result<(), DomainError> {
        let is_on = self
            .entry(provider)?
            .capabilities
            .read()
            .expect("no snapshot writer panics holding the lock")
            .as_ref()
            .is_some_and(|capabilities| capabilities.flags.is_on(flag));
        if is_on {
            Ok(())
        } else {
            Err(driver_capability_unsupported(provider, flag))
        }
    }

    /// The registered providers, in the table's order.
    pub(crate) fn providers(&self) -> impl Iterator<Item = &ProviderId> {
        self.drivers.iter().map(|registered| &registered.provider)
    }
}

/// A provider id for a test that needs any provider; no table holds it.
#[cfg(test)]
pub(crate) fn test_provider() -> ProviderId {
    ProviderId::new("test-provider".to_owned()).expect("the id matches the pattern")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_platforms::Spawner;
    use tokio::runtime::Handle;

    use super::{ProviderRegistry, test_provider};
    use crate::provider::driver::capabilities::DriverCapabilityFlag;
    use crate::provider::driver::contract::MockProviderDriver;
    use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};

    #[tokio::test]
    async fn the_registry_keeps_the_table_order_and_refuses_an_unknown_id() {
        let services = DriverServices {
            spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
            data_folder: PathBuf::from("data"),
        };
        let table: Vec<ProviderRegistration> = PROVIDERS
            .iter()
            .map(|descriptor| ProviderRegistration {
                descriptor,
                build: |_| Arc::new(MockProviderDriver::new()),
            })
            .collect();
        let registry = ProviderRegistry::register_from(&table, &services);

        let registered: Vec<&str> = registry.providers().map(ProviderId::as_str).collect();
        let listed: Vec<&str> = PROVIDERS.iter().map(|descriptor| descriptor.id).collect();
        assert!(listed.len() >= 2, "the table holds two providers or more");
        assert_eq!(registered, listed);
        for provider in registry.providers() {
            assert!(registry.lookup(provider).is_ok(), "{provider:?}");
        }

        let unknown = test_provider();
        let lookup = registry
            .lookup(&unknown)
            .err()
            .expect("no driver answers the id");
        let gate = registry
            .check_capability(&unknown, DriverCapabilityFlag::Steer)
            .expect_err("no driver answers the id");
        assert_eq!(lookup.code, RefusalCode::ProviderUnavailable);
        assert_eq!(gate.code, RefusalCode::ProviderUnavailable);
    }
}
