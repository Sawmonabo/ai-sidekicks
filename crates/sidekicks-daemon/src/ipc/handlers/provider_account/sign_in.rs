//! `provider.account.signIn`, `provider.account.signInCode.submit` and
//! `provider.account.signInAttempt.cancel`: the provider's own sign-in brokered for a person, its
//! pasted code and its cancel. The sign-in's progress goes out on the subscription's stream.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountSignIn, ProviderAccountSignInAttemptCancel, ProviderAccountSignInCodeSubmit,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountSignInAttemptCancelRequest, ProviderAccountSignInAttemptCancelResponse,
    ProviderAccountSignInCodeSubmitRequest, ProviderAccountSignInCodeSubmitResponse,
    ProviderAccountSignInRequest,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_provider::account::sign_in::SignInOrigin;

use super::ProviderAccountMethodSources;

/// Registers the three verbs: `signIn` tells the broker whether this machine's own device or
/// another one called, which bounds the arm, and is refused as the broker refuses; a code or a
/// cancel for an attempt not waiting answers `notFound`, no refusal. Fails the start when a verb is
/// already registered.
pub(super) fn register_provider_account_sign_in(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let starting = Arc::clone(sources);
    registry.register::<ProviderAccountSignIn, _>(
        move |request: ProviderAccountSignInRequest, context: HandlerContext| {
            let sources = Arc::clone(&starting);
            async move {
                let device = context.calling_device(ProviderAccountSignIn::DESCRIPTOR.method)?;
                let origin = if device == sources.machine_device_id {
                    SignInOrigin::ThisMachine
                } else {
                    SignInOrigin::AnotherDevice
                };
                Ok(sources.sign_in.start(request, origin).await?)
            }
            .boxed()
        },
    )?;
    let submitting = Arc::clone(sources);
    registry.register::<ProviderAccountSignInCodeSubmit, _>(
        move |request: ProviderAccountSignInCodeSubmitRequest, context: HandlerContext| {
            let sources = Arc::clone(&submitting);
            async move {
                context.calling_device(ProviderAccountSignInCodeSubmit::DESCRIPTOR.method)?;
                let status = sources
                    .sign_in
                    .submit_code(&request.attempt_id, request.code)
                    .await?;
                Ok(ProviderAccountSignInCodeSubmitResponse { status })
            }
            .boxed()
        },
    )?;
    let canceling = Arc::clone(sources);
    registry.register::<ProviderAccountSignInAttemptCancel, _>(
        move |request: ProviderAccountSignInAttemptCancelRequest, context: HandlerContext| {
            let sources = Arc::clone(&canceling);
            async move {
                context.calling_device(ProviderAccountSignInAttemptCancel::DESCRIPTOR.method)?;
                let status = sources.sign_in.cancel(&request.attempt_id).await?;
                Ok(ProviderAccountSignInAttemptCancelResponse { status })
            }
            .boxed()
        },
    )
}
