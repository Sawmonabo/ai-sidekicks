//! `provider.account.probe`: `Check now` on one account through the background observer, which
//! answers its last read while under a minute old and writes a new one as the probe.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountProbe, ProviderAccountProbeRequest, ProviderAccountProbeResponse,
};
use sidekicks_contracts::provider::account::record::ProviderAccountHealthState;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

use super::ProviderAccountMethodSources;

/// Registers `provider.account.probe`: the health the account holds once the observer's read is
/// stored, `indeterminate` before any was observed, refused as the observer and the registry
/// refuse. Fails the start when the method is already registered.
pub(super) fn register_provider_account_probe(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let sources = Arc::clone(sources);
    registry.register::<ProviderAccountProbe, _>(
        move |request: ProviderAccountProbeRequest, context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move {
                let device = context.calling_device(ProviderAccountProbe::DESCRIPTOR.method)?;
                sources
                    .observer
                    .check_now(request.account_id.clone())
                    .await?;
                let account = sources.accounts.read(request.account_id).await?;
                sources.publish_change(ProviderAccountProbe::DESCRIPTOR.method, &device, &account);
                Ok(ProviderAccountProbeResponse {
                    health_state: account
                        .health
                        .as_ref()
                        .map_or(ProviderAccountHealthState::Indeterminate, |health| {
                            health.state
                        }),
                    credential_generation: account.credential_generation,
                    account_id: account.account_id,
                })
            }
            .boxed()
        },
    )
}
