//! The live drivers, one per registered provider in the table's order, and the capability gate. A
//! provider id a request or a provider message brings in is checked here: one no driver answers is
//! refused `provider.notFound`. The gate and the contract version read the capability snapshot the
//! start or a refresh recorded, never the driver or the database, and the gate fails closed: a flag
//! is supported only when a recorded snapshot declares it. A steer is not gated here, since it is
//! how the run queue delivers a held message.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::capabilities::{DriverCapabilities, DriverCapabilityFlag};
use crate::driver::contract::{PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE, ProviderDriver};
use crate::driver::{DriverServices, ProviderDescriptor, ProviderRegistration};
use sidekicks_ipc::domain_error::DomainError;

/// The refusal for a call naming a provider no registered driver answers; its detail carries only
/// the id, so nothing internal leaks.
pub(crate) fn provider_not_found(provider: &ProviderId) -> DomainError {
    DomainError::new(
        "No provider driver answers that provider id",
        RefusalCode::ProviderNotFound,
    )
    .with_detail(json!({ "providerId": provider.as_str() }))
}

/// The refusal for a call gated on `flag` that the driver does not declare; its detail carries only
/// the provider's id and the flag.
pub(crate) fn provider_capability_unsupported(
    provider: &ProviderId,
    flag: DriverCapabilityFlag,
) -> DomainError {
    DomainError::new(
        PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE,
        RefusalCode::ProviderCapabilityUnsupported,
    )
    .with_detail(json!({ "providerId": provider.as_str(), "flag": flag }))
}

/// The refusal for a call the provider itself refused for want of `flag`'s capability, beyond what
/// the static flag shows: [`provider_capability_unsupported`]'s detail with the provider's own
/// words as `providerFailureDetail`.
pub(crate) fn provider_capability_refused(
    provider: &ProviderId,
    flag: DriverCapabilityFlag,
    provider_failure_detail: &FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
) -> DomainError {
    DomainError::new(
        PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE,
        RefusalCode::ProviderCapabilityUnsupported,
    )
    .with_detail(json!({
        "providerId": provider.as_str(),
        "flag": flag,
        "providerFailureDetail": provider_failure_detail.as_str(),
    }))
}

/// A driver, its provider's fixed facts and the capability snapshot recorded for it.
struct RegisteredDriver {
    /// The provider the driver answers.
    provider: ProviderId,
    /// The provider's fixed facts.
    descriptor: &'static ProviderDescriptor,
    /// The live driver.
    driver: Arc<dyn ProviderDriver>,
    /// The capabilities its last read reported, `None` until the provider check records one; the
    /// lock is held only for a read or a write of the snapshot.
    capabilities: RwLock<Option<DriverCapabilities>>,
}

/// Holds the registered drivers in the table's order and gates capability-bound calls on their
/// recorded flags.
pub struct ProviderRegistry {
    /// The drivers in table order; a short list, scanned.
    drivers: Vec<RegisteredDriver>,
}

impl ProviderRegistry {
    /// Builds every provider in `table`, in its order, from the one bundle of shared services. A
    /// build does no I/O and starts no process, so it cannot fail.
    pub fn register_from(table: &[ProviderRegistration], services: &DriverServices) -> Self {
        Self {
            drivers: table
                .iter()
                .map(|registration| RegisteredDriver {
                    provider: registration.descriptor.provider_id(),
                    descriptor: registration.descriptor,
                    driver: (registration.build)(services),
                    capabilities: RwLock::new(None),
                })
                .collect(),
        }
    }

    /// The registered entry for `provider`, refused `provider.notFound` when no driver answers it.
    fn entry(&self, provider: &ProviderId) -> Result<&RegisteredDriver, DomainError> {
        self.drivers
            .iter()
            .find(|registered| registered.provider == *provider)
            .ok_or_else(|| provider_not_found(provider))
    }

    /// Records the capabilities `provider`'s read reported, replacing the earlier snapshot. Refused
    /// `provider.notFound` when no driver answers it.
    pub fn record_capabilities(
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

    /// The contract version `provider`'s recorded snapshot declares, `None` until a snapshot is
    /// recorded; refused `provider.notFound` when no driver answers it.
    pub fn contract_version(
        &self,
        provider: &ProviderId,
    ) -> Result<Option<FreeFormText<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>>, DomainError> {
        Ok(self
            .entry(provider)?
            .capabilities
            .read()
            .expect("no snapshot writer panics holding the lock")
            .as_ref()
            .map(|capabilities| capabilities.contract_version.clone()))
    }

    /// The driver for `provider`, refused `provider.notFound` when no driver answers it.
    pub fn lookup(&self, provider: &ProviderId) -> Result<Arc<dyn ProviderDriver>, DomainError> {
        self.entry(provider)
            .map(|registered| Arc::clone(&registered.driver))
    }

    /// The fixed facts `provider`'s driver declares, refused `provider.notFound` when no driver
    /// answers it.
    pub fn descriptor(
        &self,
        provider: &ProviderId,
    ) -> Result<&'static ProviderDescriptor, DomainError> {
        self.entry(provider).map(|registered| registered.descriptor)
    }

    /// Passes when `provider`'s recorded snapshot declares `flag`. Refuses with
    /// [`provider_not_found`] when no driver answers it, and [`provider_capability_unsupported`]
    /// when the flag is off or no snapshot is recorded yet.
    pub fn check_capability(
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
            Err(provider_capability_unsupported(provider, flag))
        }
    }

    /// The logs the registered providers' running services write, which the diagnostic-log expiry
    /// never deletes; blocking. Fails with the first driver's failure to name its services' logs.
    pub fn running_service_log_files(&self) -> io::Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        for registered in &self.drivers {
            files.extend(registered.driver.running_service_log_files()?);
        }
        Ok(files)
    }

    /// Each registered provider with its driver, in the table's order.
    pub fn drivers(&self) -> impl Iterator<Item = (&ProviderId, &Arc<dyn ProviderDriver>)> {
        self.drivers
            .iter()
            .map(|registered| (&registered.provider, &registered.driver))
    }
}

/// A provider id for a test that needs any provider; no table holds it.
#[cfg(any(test, feature = "test-support"))]
pub fn test_provider() -> ProviderId {
    ProviderId::new("test-provider".to_owned()).expect("the id matches the pattern")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

    use super::{ProviderRegistry, test_provider};
    use crate::driver::capabilities::DriverCapabilityFlag;
    use crate::driver::contract::MockProviderDriver;
    use crate::driver::test_registry::test_driver_services;
    use crate::driver::{PROVIDERS, ProviderRegistration};

    #[tokio::test]
    async fn the_registry_keeps_the_table_order_and_refuses_an_unknown_id() {
        let services = test_driver_services();
        let table: Vec<ProviderRegistration> = PROVIDERS
            .iter()
            .map(|descriptor| ProviderRegistration {
                descriptor,
                build: |_| Arc::new(MockProviderDriver::new()),
            })
            .collect();
        let registry = ProviderRegistry::register_from(&table, &services);

        let registered: Vec<&str> = registry
            .drivers()
            .map(|(provider, _)| provider.as_str())
            .collect();
        let listed: Vec<&str> = PROVIDERS.iter().map(|descriptor| descriptor.id).collect();
        assert!(listed.len() >= 2, "the table holds two providers or more");
        assert_eq!(registered, listed);
        for (provider, _) in registry.drivers() {
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
        assert_eq!(lookup.code, RefusalCode::ProviderNotFound);
        assert_eq!(gate.code, RefusalCode::ProviderNotFound);
    }
}
