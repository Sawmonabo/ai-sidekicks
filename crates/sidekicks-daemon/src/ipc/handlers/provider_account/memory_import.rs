//! `provider.account.memory.import`: the person's own provider memory copied into an account's
//! home once, under its home lock, its outcome kept on the account and published with it.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountMemoryImport, ProviderAccountMemoryImportRequest,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::account::memory_import::import_memory;

use super::ProviderAccountMethodSources;

/// Registers `provider.account.memory.import`: refused as the registry and the import refuse, a
/// repeat `provider.account.memory.alreadyImported`; a provider the daemon runs with no memory
/// import legs is the daemon's own failure. Fails the start when the method is already registered.
pub(super) fn register_provider_account_memory_import(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let sources = Arc::clone(sources);
    registry.register::<ProviderAccountMemoryImport, _>(
        move |request: ProviderAccountMemoryImportRequest, context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move {
                let method = ProviderAccountMemoryImport::DESCRIPTOR.method;
                let device = context.calling_device(method)?;
                let account = sources.accounts.read(request.account_id).await?;
                let legs = sources
                    .memory_import_legs
                    .get(&account.provider)
                    .ok_or_else(|| {
                        HandlerError::Internal(Box::new(MemoryImportLegsMissing {
                            provider: account.provider.clone(),
                        }))
                    })?;
                let outcome = import_memory(
                    &sources.accounts,
                    &sources.home_lock,
                    Arc::clone(legs),
                    account.account_id.clone(),
                )
                .await?;
                let imported = sources.accounts.read(account.account_id).await?;
                sources.publish_change(method, &device, &imported);
                Ok(outcome)
            }
            .boxed()
        },
    )
}

// Every provider the daemon runs is built with its memory import legs, so an import that finds
// none is the daemon's own fault.
#[derive(Debug, thiserror::Error)]
#[error("the provider {} has no memory import legs", provider.as_str())]
struct MemoryImportLegsMissing {
    provider: ProviderId,
}
