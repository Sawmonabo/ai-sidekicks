//! The live drivers and the capability gate. Registering a driver keeps the capability snapshot its
//! read reported; the gate reads that snapshot alone, never the driver or the database, and fails
//! closed: a flag is supported only when the snapshot declares it. A steer is not gated here,
//! since it is how the run queue delivers a held message.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};
use crate::provider::driver::capabilities::{DriverCapabilities, DriverCapabilityFlag};
use crate::provider::driver::contract::{DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE, ProviderDriver};

/// The refusal for a call to a driver that is not registered; its detail carries only the
/// driver's name, so nothing internal leaks.
pub(crate) fn driver_unavailable(provider: &ProviderId) -> DomainError {
    DomainError::new(
        "Provider driver is currently unavailable",
        RefusalCode::DriverUnavailable,
        DomainErrorJsonRpcCode::InternalError,
    )
    .with_detail(json!({ "driverId": provider.as_str() }))
}

/// The refusal for a call gated on `flag` that the driver does not declare; its detail carries only
/// the driver's name and the flag. The params resolve and a protocol-state rule fails, so it
/// answers as an invalid request.
pub(crate) fn driver_capability_unsupported(
    provider: &ProviderId,
    flag: DriverCapabilityFlag,
) -> DomainError {
    DomainError::new(
        DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE,
        RefusalCode::DriverCapabilityUnsupported,
        DomainErrorJsonRpcCode::InvalidRequest,
    )
    .with_detail(json!({ "driverId": provider.as_str(), "flag": flag }))
}

/// A driver and the capability snapshot it was registered with.
struct RegisteredDriver {
    /// The live driver.
    driver: Arc<dyn ProviderDriver>,
    /// The capabilities its read reported.
    capabilities: DriverCapabilities,
}

/// Holds the registered drivers, one per provider, and gates capability-bound calls on their
/// cached flags.
#[derive(Default)]
pub(crate) struct ProviderRegistry {
    /// The registered drivers by provider; each lock is held only for a map read or write.
    drivers: RwLock<BTreeMap<ProviderId, RegisteredDriver>>,
}

impl ProviderRegistry {
    /// Registers `driver` for `provider` with the capabilities its read reported, replacing any
    /// earlier registration and its snapshot.
    pub(crate) fn register(
        &self,
        provider: ProviderId,
        driver: Arc<dyn ProviderDriver>,
        capabilities: DriverCapabilities,
    ) {
        self.drivers
            .write()
            .expect("no registry writer panics holding the lock")
            .insert(
                provider,
                RegisteredDriver {
                    driver,
                    capabilities,
                },
            );
    }

    /// The driver registered for `provider`, or `None` when none is.
    pub(crate) fn lookup(&self, provider: &ProviderId) -> Option<Arc<dyn ProviderDriver>> {
        self.drivers
            .read()
            .expect("no registry writer panics holding the lock")
            .get(provider)
            .map(|registered| Arc::clone(&registered.driver))
    }

    /// Passes when `provider`'s snapshot declares `flag`. Refuses with [`driver_unavailable`] when
    /// no driver is registered for it, and [`driver_capability_unsupported`] otherwise.
    pub(crate) fn check_capability(
        &self,
        provider: &ProviderId,
        flag: DriverCapabilityFlag,
    ) -> Result<(), DomainError> {
        let drivers = self
            .drivers
            .read()
            .expect("no registry writer panics holding the lock");
        let registered = drivers
            .get(provider)
            .ok_or_else(|| driver_unavailable(provider))?;
        if registered.capabilities.flags.is_on(flag) {
            Ok(())
        } else {
            Err(driver_capability_unsupported(provider, flag))
        }
    }

    /// The providers with a registered driver, in the providers' order.
    pub(crate) fn list_available(&self) -> Vec<ProviderId> {
        self.drivers
            .read()
            .expect("no registry writer panics holding the lock")
            .keys()
            .cloned()
            .collect()
    }
}
