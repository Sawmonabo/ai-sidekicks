//! `provider.account.current.update`: an account made its provider's current one through the
//! switch, which answers once the mark has moved and moves the provider's running sessions after.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountCurrentUpdate, ProviderAccountCurrentUpdateRequest,
    ProviderAccountCurrentUpdateResponse, ProviderAccountMovingSession,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

use super::ProviderAccountMethodSources;

/// Registers `provider.account.current.update`: the account now current and the sessions being
/// moved onto it, refused as the switch refuses, the mark unmoved. Publishes the account made
/// current and the one it left. Fails the start when the method is already registered.
pub(super) fn register_provider_account_current_update(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let sources = Arc::clone(sources);
    registry.register::<ProviderAccountCurrentUpdate, _>(
        move |request: ProviderAccountCurrentUpdateRequest, context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move {
                let method = ProviderAccountCurrentUpdate::DESCRIPTOR.method;
                let device = context.calling_device(method)?;
                let made = sources
                    .account_switch
                    .make_current(request.account_id, device.clone())
                    .await?;
                // The moves land on their own, after the answer.
                drop(made.settled);
                // The account made current goes out even where none was current before it.
                if let Some(left) = &made.left {
                    sources.publish_change(method, &device, left);
                }
                sources.publish_change(method, &device, &made.account);
                Ok(ProviderAccountCurrentUpdateResponse {
                    account: made.account.to_provider_account(),
                    moving_sessions: made
                        .moving_sessions
                        .into_iter()
                        .map(|session_id| ProviderAccountMovingSession { session_id })
                        .collect(),
                })
            }
            .boxed()
        },
    )
}
