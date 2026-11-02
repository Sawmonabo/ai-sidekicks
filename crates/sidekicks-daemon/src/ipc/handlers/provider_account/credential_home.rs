//! `provider.account.credentialHome.reset`: an account's home rebuilt from empty under its home
//! lock, after its provider's own sign-out, leaving the account to sign in again; refused while a
//! sign-in is in flight on the account, as a second sign-in is.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::ProviderAccountCredentialHomeReset;
use sidekicks_contracts::provider::account::record::ProviderAccountHealthState;
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountCredentialHomeResetRequest, ProviderAccountCredentialHomeResetResponse,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::account::credential_home::reset_credential_home;
use sidekicks_provider::account::resolver::credential_home_folders;
use sidekicks_provider::account::sign_in::ProviderSignInError;

use super::ProviderAccountMethodSources;

/// Registers `provider.account.credentialHome.reset`: refused as the registry and the reset refuse,
/// and `provider.account.signInInFlight` while the account has a sign-in in flight; a provider the
/// daemon runs with no account legs is the daemon's own failure. Fails the start
/// when the method is already registered.
pub(super) fn register_provider_account_credential_home_reset(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let sources = Arc::clone(sources);
    registry.register::<ProviderAccountCredentialHomeReset, _>(
        move |request: ProviderAccountCredentialHomeResetRequest, context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move {
                let method = ProviderAccountCredentialHomeReset::DESCRIPTOR.method;
                let device = context.calling_device(method)?;
                let account = sources.accounts.read(request.account_id).await?;
                if sources.signing_in.is_signing_in(&account.account_id) {
                    return Err(ProviderSignInError::InFlight.into());
                }
                let legs = sources.account_legs.get(&account.provider).ok_or_else(|| {
                    HandlerError::Internal(Box::new(AccountLegsMissing {
                        provider: account.provider.clone(),
                    }))
                })?;
                let folders = credential_home_folders(&account.provider, &account.credential_home);
                let credential_generation = reset_credential_home(
                    &sources.accounts,
                    &sources.home_lock,
                    legs.as_ref(),
                    account.account_id.clone(),
                    folders,
                )
                .await?;
                let reset = sources.accounts.read(account.account_id).await?;
                sources.publish_change(method, &device, &reset);
                Ok(ProviderAccountCredentialHomeResetResponse {
                    account_id: reset.account_id,
                    credential_generation,
                    health_state: ProviderAccountHealthState::ReauthRequired,
                })
            }
            .boxed()
        },
    )
}

// Every provider the daemon runs is built with its account legs, so a reset that finds none is
// the daemon's own fault.
#[derive(Debug, thiserror::Error)]
#[error("the provider {} has no account legs", provider.as_str())]
struct AccountLegsMissing {
    provider: ProviderId,
}
