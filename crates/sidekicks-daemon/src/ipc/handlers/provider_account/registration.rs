//! `provider.account.register`, `provider.account.update` and `provider.account.delete`: an
//! account added, its token re-supplied, its settings changed, and its removal.
//!
//! - A new account's id and home are minted here, and none once the sign-in broker has stopped,
//!   as before an erase; a registration that does not end in a row has the home it minted signed
//!   out, where its provider ran there, and removed.
//! - A re-supply replaces the account's token before its name and billing, so a token its
//!   provider or the keychain refuses leaves the account as it was.
//! - An account made current here goes through the same switch as the switch method, which moves
//!   the provider's running sessions onto it.
//! - The first account whose wake switch turns on installs the machine's wake helper, one that did
//!   not install leaving the switch off and its reason in the reply, and the last one turned off
//!   removes it.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountDelete, ProviderAccountDeleteRequest, ProviderAccountDeleteResponse,
    ProviderAccountRegister, ProviderAccountUpdate, ProviderAccountUpdateRequest,
    ProviderAccountUpdateResponse, ProviderWakeHelperState,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountRegisterRequest, ProviderAccountRegisterResponse, TokenResupply,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_platforms::WakeHelperStatus;
use sidekicks_provider::account::registry::{
    AccountAdmission, AccountSettingsChange, MintedAccount, RegisteredAccount,
};
use sidekicks_provider::account::resolver::credential_home_folders;
use sidekicks_provider::account::sign_in::ProviderSignInError;
use sidekicks_provider::account::token_custody::{TokenAccountRegistration, TokenCustodyError};
use sidekicks_provider::account::wake_helper::{MachineWakeHelper, wake_helper_not_installed};
use sidekicks_provider::driver::contract::account::ProviderAccountLegs;
use sidekicks_provider::driver::contract::error::DriverError;

use super::ProviderAccountMethodSources;

/// Why the helper is not installed once the last account's wake switch turned off, in the words
/// the switch's own line uses for it.
pub(super) const WAKE_HELPER_REMOVED_REASON: &str =
    "Wake this computer for it is off on every account, so the wake helper was removed";

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
                let method = ProviderAccountRegister::DESCRIPTOR.method;
                let device = context.calling_device(method)?;
                let (account, left) = register_account(&sources, request, &device).await?;
                if let Some(left) = &left {
                    sources.publish_change(method, &device, left);
                }
                sources.publish_change(method, &device, &account);
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
                let (account, wake_helper) = update_account(&sources, request).await?;
                sources.publish_change(ProviderAccountUpdate::DESCRIPTOR.method, &device, &account);
                Ok(ProviderAccountUpdateResponse {
                    account: account.to_provider_account(),
                    wake_helper,
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
                        &sources.home_lock,
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

// Registers, or re-supplies, the account `request` names, made current for `device` through the
// switch where it asks, and has the observer watch a new one; answers the account and the one whose
// mark the switch moved off.
async fn register_account(
    sources: &ProviderAccountMethodSources,
    request: ProviderAccountRegisterRequest,
    device: &DeviceId,
) -> Result<(RegisteredAccount, Option<RegisteredAccount>), HandlerError> {
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
            let account = keep_or_abandon(sources, minted, admitted, None).await?;
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
            // A refusal before the status read ran no provider in the home.
            let legs = match &admitted {
                Err(TokenCustodyError::NoStatusRead | TokenCustodyError::Sealing(_)) => None,
                Ok(_) | Err(_) => Some(&sources.account_legs),
            };
            let account = keep_or_abandon(sources, minted, admitted, legs).await?;
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
    // Before the switch, so a new account the switch refuses is still read and announced.
    if is_new && let Err(error) = sources.observer.watch(&account) {
        // The account is registered; its first read waits for the next start's schedule.
        tracing::warn!(
            account_id = account.account_id.as_str(),
            error = &error as &(dyn Error + 'static),
            "a new provider account could not be scheduled for the background observer"
        );
    }
    if make_default != Some(true) {
        return Ok((account, None));
    }
    let made = sources
        .account_switch
        .make_current(account.account_id, device.clone())
        .await?;
    // The moves land on their own, after the answer.
    drop(made.settled);
    Ok((made.account, made.left))
}

// A new account's id and home, for a provider the daemon runs; refused as an ended sign-in start
// once the sign-in broker has stopped, so nothing is minted into a data folder an erase reads.
fn mint(
    sources: &ProviderAccountMethodSources,
    provider: &ProviderId,
) -> Result<MintedAccount, HandlerError> {
    if sources.sign_in.has_stopped() {
        return Err(ProviderSignInError::StartEnded.into());
    }
    sources.providers.lookup(provider)?;
    Ok(sources.accounts.mint(provider.clone())?)
}

// The admitted account, or the admission's refusal with the minted home signed out through its
// provider's entry in `legs`, where its provider ran there, and removed; a home or mark that
// stays is logged, since the refusal is what the caller must know.
async fn keep_or_abandon<Failure: Into<HandlerError>>(
    sources: &ProviderAccountMethodSources,
    minted: MintedAccount,
    admitted: Result<RegisteredAccount, Failure>,
    legs: Option<&HashMap<ProviderId, Arc<dyn ProviderAccountLegs>>>,
) -> Result<RegisteredAccount, HandlerError> {
    let failure = match admitted {
        Ok(account) => return Ok(account),
        Err(failure) => failure,
    };
    let account_id = minted.account_id().clone();
    if let Err(error) = sources.accounts.abandon(minted, legs).await {
        tracing::warn!(
            account_id = account_id.as_str(),
            error = &error as &(dyn Error + 'static),
            "the home of a provider account that was not registered kept its mark; the next start \
             clears it"
        );
    }
    Err(failure.into())
}

// Replaces the sealed token of the account `resupply` names, then writes any new name and billing;
// a rename refused, or to a name another account holds, leaves the token as it was.
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
    let change = AccountSettingsChange {
        display_label: resupply.display_label,
        billing_mode: Some(resupply.billing_mode),
        ..AccountSettingsChange::default()
    };
    // Both refusals before the token is replaced, so a refused change leaves the old token.
    refuse_unnamed_rename(&account, &change)?;
    if let Some(display_label) = &change.display_label {
        sources
            .accounts
            .check_display_label_free(
                account.provider.clone(),
                account.account_id.clone(),
                display_label,
            )
            .await?;
    }
    let folders = sources
        .account_reader
        .resolve_account_folders(account.account_id.clone())
        .await
        .map_err(DriverError::from)?;
    let token: SecretString = resupply.non_interactive_token.into_secret();
    let account = sources
        .token_custody
        .replace(account.account_id, &folders, &token)
        .await?;
    Ok(sources
        .accounts
        .change_settings(account.account_id, change)
        .await?)
}

// Writes `request`'s settings, the wake switch on only once the helper is installed, and has the
// observer look at the account's windows again where a window switch changed; answers the helper's
// state where the request carries the wake switch on a machine with a helper.
async fn update_account(
    sources: &ProviderAccountMethodSources,
    request: ProviderAccountUpdateRequest,
) -> Result<(RegisteredAccount, Option<ProviderWakeHelperState>), HandlerError> {
    let account = sources.accounts.read(request.account_id).await?;
    let helper = sources
        .wake_helper
        .as_deref()
        .filter(|_| request.wake_for_window_start_enabled.is_some());
    let mut wake_for_window_start_enabled = request.wake_for_window_start_enabled;
    let mut wake_helper = None;
    if let Some(helper) = helper
        && request.wake_for_window_start_enabled == Some(true)
    {
        let installed = install_wake_helper(helper).await;
        if matches!(installed, ProviderWakeHelperState::NotInstalled { .. }) {
            wake_for_window_start_enabled = Some(false);
        }
        wake_helper = Some(installed);
    }
    let is_window_change =
        request.window_start_enabled.is_some() || wake_for_window_start_enabled.is_some();
    let account = change_settings(
        sources,
        &account,
        AccountSettingsChange {
            display_label: request.display_label,
            billing_mode: request.billing_mode,
            probe_enabled: request.probe_enabled,
            window_start_enabled: request.window_start_enabled,
            wake_for_window_start_enabled,
        },
    )
    .await?;
    if let Some(helper) = helper
        && request.wake_for_window_start_enabled == Some(false)
    {
        wake_helper = Some(remove_unused_wake_helper(sources, helper).await?);
    }
    if is_window_change {
        sources.observer.look_at_windows(account.account_id.clone());
    }
    Ok((account, wake_helper))
}

// The helper installed where it is not already, behind one administrator prompt; a failed install
// answers its reason.
async fn install_wake_helper(helper: &dyn MachineWakeHelper) -> ProviderWakeHelperState {
    if matches!(helper.status().await, Ok(WakeHelperStatus::Installed)) {
        return ProviderWakeHelperState::Installed {};
    }
    match helper.install().await {
        Ok(()) => ProviderWakeHelperState::Installed {},
        Err(error) => wake_helper_not_installed(&error),
    }
}

// Removes the helper once no account's wake switch is on, answering `notInstalled` with why; while
// another account's switch is on, or when the removal fails, which is logged, it stays installed.
async fn remove_unused_wake_helper(
    sources: &ProviderAccountMethodSources,
    helper: &dyn MachineWakeHelper,
) -> Result<ProviderWakeHelperState, HandlerError> {
    let accounts = sources.accounts.list(None).await?;
    if accounts
        .iter()
        .any(|account| account.wake_for_window_start_enabled)
    {
        return Ok(ProviderWakeHelperState::Installed {});
    }
    match helper.uninstall().await {
        Ok(()) => Ok(ProviderWakeHelperState::NotInstalled {
            reason: FreeFormText::new(WAKE_HELPER_REMOVED_REASON.to_owned())
                .expect("the removal's reason is text"),
        }),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the wake helper no account uses could not be removed"
            );
            Ok(ProviderWakeHelperState::Installed {})
        }
    }
}

// Writes `change` on `account`, a rename refused on an account the person did not name.
async fn change_settings(
    sources: &ProviderAccountMethodSources,
    account: &RegisteredAccount,
    change: AccountSettingsChange,
) -> Result<RegisteredAccount, HandlerError> {
    refuse_unnamed_rename(account, &change)?;
    Ok(sources
        .accounts
        .change_settings(account.account_id.clone(), change)
        .await?)
}

// Refuses `change` where it renames `account`, which the person did not name.
fn refuse_unnamed_rename(
    account: &RegisteredAccount,
    change: &AccountSettingsChange,
) -> Result<(), HandlerError> {
    if change.display_label.is_some() && account.display_label.is_none() {
        return Err(DomainError::new(
            "Only an account added from a pasted token or API key can be renamed",
            RefusalCode::ProviderAccountRenameRefused,
        )
        .into());
    }
    Ok(())
}
