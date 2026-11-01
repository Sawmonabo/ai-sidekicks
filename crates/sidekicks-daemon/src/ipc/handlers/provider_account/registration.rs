//! `provider.account.register`, `provider.account.update` and `provider.account.delete`: an
//! account added, its token re-supplied, its settings changed, and its removal.
//!
//! - A new account's id and home are minted here; a registration that does not end in a row
//!   removes the home it minted.
//! - A re-supply changes the account's name and billing before its token, so a token its provider
//!   refuses leaves the prior token in place.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountDelete, ProviderAccountDeleteRequest, ProviderAccountDeleteResponse,
    ProviderAccountRegister, ProviderAccountUpdate, ProviderAccountUpdateRequest,
    ProviderAccountUpdateResponse,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountRegisterRequest, ProviderAccountRegisterResponse, TokenResupply,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::True;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::account::registry::{
    AccountAdmission, AccountSettingsChange, MintedAccount, RegisteredAccount,
};
use sidekicks_provider::account::resolver::credential_home_folders;
use sidekicks_provider::account::token_custody::TokenAccountRegistration;
use sidekicks_provider::driver::contract::error::DriverError;

use super::ProviderAccountMethodSources;

/// Registers the three verbs. `register` refuses an unknown provider `provider.notFound`, a
/// re-supply naming an account not registered under its provider `provider.account.notFound`, and
/// otherwise as the registry and the token custody refuse; `update` refuses a rename of an account
/// the person did not name `provider.account.renameRefused`; `delete` refuses as the removal does.
/// Fails the start when a verb is already registered.
pub(super) fn register_provider_account_registration(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let registering = Arc::clone(sources);
    registry.register::<ProviderAccountRegister, _>(
        move |request: ProviderAccountRegisterRequest, context: HandlerContext| {
            let sources = Arc::clone(&registering);
            async move {
                let device = context.calling_device(ProviderAccountRegister::DESCRIPTOR.method)?;
                let account = register_account(&sources, request).await?;
                sources.publish_change(
                    ProviderAccountRegister::DESCRIPTOR.method,
                    &device,
                    &account,
                );
                Ok(ProviderAccountRegisterResponse {
                    account: account.to_provider_account(),
                })
            }
            .boxed()
        },
    )?;
    let updating = Arc::clone(sources);
    registry.register::<ProviderAccountUpdate, _>(
        move |request: ProviderAccountUpdateRequest, context: HandlerContext| {
            let sources = Arc::clone(&updating);
            async move {
                let device = context.calling_device(ProviderAccountUpdate::DESCRIPTOR.method)?;
                let account = update_account(&sources, request).await?;
                sources.publish_change(ProviderAccountUpdate::DESCRIPTOR.method, &device, &account);
                Ok(ProviderAccountUpdateResponse {
                    account: account.to_provider_account(),
                    wake_helper: None,
                })
            }
            .boxed()
        },
    )?;
    let deleting = Arc::clone(sources);
    registry.register::<ProviderAccountDelete, _>(
        move |request: ProviderAccountDeleteRequest, context: HandlerContext| {
            let sources = Arc::clone(&deleting);
            async move {
                let device = context.calling_device(ProviderAccountDelete::DESCRIPTOR.method)?;
                sources
                    .accounts
                    .remove_account(
                        &request.account_id,
                        sources.live_turns.as_ref(),
                        &sources.token_custody,
                        &sources.providers,
                    )
                    .await?;
                sources.observer.forget(&request.account_id);
                sources.publish_removal(
                    ProviderAccountDelete::DESCRIPTOR.method,
                    &device,
                    &request.account_id,
                );
                Ok(ProviderAccountDeleteResponse {
                    account_id: request.account_id,
                    removed: True::default(),
                })
            }
            .boxed()
        },
    )
}

// Registers, or re-supplies, the account `request` names, made current where it asks, and has
// the observer watch a new one.
async fn register_account(
    sources: &ProviderAccountMethodSources,
    request: ProviderAccountRegisterRequest,
) -> Result<RegisteredAccount, HandlerError> {
    let (account, make_default, is_new) = match request {
        ProviderAccountRegisterRequest::SignIn(registration) => {
            let minted = mint(sources, &registration.provider)?;
            let admission = AccountAdmission {
                display_label: None,
                billing_mode: registration.billing_mode,
                health: None,
                observed_auth_mode: None,
            };
            let admitted = sources.accounts.admit(&minted, &admission).await;
            let account = keep_or_abandon(sources, minted, admitted)?;
            (account, registration.make_default, true)
        }
        ProviderAccountRegisterRequest::Token(registration) => {
            let minted = mint(sources, &registration.provider)?;
            let folders = credential_home_folders(minted.provider(), minted.home());
            let token = registration.non_interactive_token.into_secret();
            let admitted = sources
                .token_custody
                .register(
                    &minted,
                    &folders,
                    TokenAccountRegistration {
                        display_label: registration.display_label,
                        billing_mode: registration.billing_mode,
                    },
                    &token,
                )
                .await;
            let account = keep_or_abandon(sources, minted, admitted)?;
            (account, registration.make_default, true)
        }
        ProviderAccountRegisterRequest::Resupply(resupply) => {
            let make_default = resupply.make_default;
            (
                resupply_token(sources, resupply).await?,
                make_default,
                false,
            )
        }
    };
    let account = if make_default == Some(true) {
        sources.accounts.make_current(account.account_id).await?
    } else {
        account
    };
    if is_new && let Err(error) = sources.observer.watch(&account) {
        // The account is registered; its first read waits for the next start's schedule.
        tracing::warn!(
            account_id = account.account_id.as_str(),
            error = &error as &(dyn Error + 'static),
            "a new provider account could not be scheduled for the background observer"
        );
    }
    Ok(account)
}

// A new account's id and home, for a provider the daemon runs.
fn mint(
    sources: &ProviderAccountMethodSources,
    provider: &ProviderId,
) -> Result<MintedAccount, HandlerError> {
    sources.providers.lookup(provider)?;
    Ok(sources.accounts.mint(provider.clone())?)
}

// The admitted account, or the admission's refusal with the minted home removed; a home that
// cannot be removed is logged, since the refusal is what the caller must know.
fn keep_or_abandon<Failure: Into<HandlerError>>(
    sources: &ProviderAccountMethodSources,
    minted: MintedAccount,
    admitted: Result<RegisteredAccount, Failure>,
) -> Result<RegisteredAccount, HandlerError> {
    admitted.map_err(|failure| {
        let account_id = minted.account_id().clone();
        if let Err(error) = sources.accounts.abandon(minted) {
            tracing::warn!(
                account_id = account_id.as_str(),
                error = &error as &(dyn Error + 'static),
                "the home of a provider account that was not registered could not be removed"
            );
        }
        failure.into()
    })
}

// Replaces the sealed token of the account `resupply` names, after any new name and billing.
async fn resupply_token(
    sources: &ProviderAccountMethodSources,
    resupply: TokenResupply,
) -> Result<RegisteredAccount, HandlerError> {
    let account = sources.accounts.read(resupply.account_id).await?;
    if account.provider != resupply.provider {
        return Err(DomainError::new(
            "The provider account is not registered",
            RefusalCode::ProviderAccountNotFound,
        )
        .into());
    }
    let account_id = account.account_id.clone();
    change_settings(
        sources,
        &account,
        AccountSettingsChange {
            display_label: resupply.display_label,
            billing_mode: Some(resupply.billing_mode),
            ..AccountSettingsChange::default()
        },
    )
    .await?;
    let folders = sources
        .account_reader
        .resolve_account_folders(account_id.clone())
        .await
        .map_err(DriverError::from)?;
    let token: SecretString = resupply.non_interactive_token.into_secret();
    Ok(sources
        .token_custody
        .replace(account_id, &folders, &token)
        .await?)
}

async fn update_account(
    sources: &ProviderAccountMethodSources,
    request: ProviderAccountUpdateRequest,
) -> Result<RegisteredAccount, HandlerError> {
    let account = sources.accounts.read(request.account_id).await?;
    change_settings(
        sources,
        &account,
        AccountSettingsChange {
            display_label: request.display_label,
            billing_mode: request.billing_mode,
            probe_enabled: request.probe_enabled,
            window_start_enabled: request.window_start_enabled,
            wake_for_window_start_enabled: request.wake_for_window_start_enabled,
        },
    )
    .await
}

// Writes `change` on `account`, a rename refused on an account the person did not name.
async fn change_settings(
    sources: &ProviderAccountMethodSources,
    account: &RegisteredAccount,
    change: AccountSettingsChange,
) -> Result<RegisteredAccount, HandlerError> {
    if change.display_label.is_some() && account.display_label.is_none() {
        return Err(DomainError::new(
            "Only an account added from a pasted token or API key can be renamed",
            RefusalCode::ProviderAccountRenameRefused,
        )
        .into());
    }
    Ok(sources
        .accounts
        .change_settings(account.account_id.clone(), change)
        .await?)
}
