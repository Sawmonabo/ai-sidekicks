//! `provider.account.list`: the accounts, their stored quota readings and one readiness entry per
//! provider read, every one from stored rows, so the read starts nothing and opens no file.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::methods::ProviderAccountList;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountListRequest, ProviderAccountListResponse,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::account::observer::window_store::read_usage_windows;
use sidekicks_provider::account::readiness::{derive_account_readiness, derive_provider_readiness};
use sidekicks_provider::account::registry::RegisteredAccount;

use super::ProviderAccountMethodSources;

/// Registers `provider.account.list`: an unknown provider refuses `provider.notFound`, and a named
/// account not registered, or not the named provider's, `provider.account.notFound`. With an
/// account named, the one readiness entry is that account's own. Fails the start when the method
/// is already registered.
pub(super) fn register_provider_account_list(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let sources = Arc::clone(sources);
    registry.register::<ProviderAccountList, _>(
        move |request: ProviderAccountListRequest, _context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move { list_accounts(&sources, request).await }.boxed()
        },
    )
}

async fn list_accounts(
    sources: &ProviderAccountMethodSources,
    request: ProviderAccountListRequest,
) -> Result<ProviderAccountListResponse, HandlerError> {
    if let Some(provider) = &request.provider {
        sources.providers.lookup(provider)?;
    }
    let pinned = match request.account_id {
        Some(account_id) => {
            let account = sources.accounts.read(account_id).await?;
            if request
                .provider
                .as_ref()
                .is_some_and(|provider| *provider != account.provider)
            {
                return Err(DomainError::new(
                    "The provider account is not registered",
                    RefusalCode::ProviderAccountNotFound,
                )
                .into());
            }
            Some(account)
        }
        None => None,
    };
    let provider = pinned
        .as_ref()
        .map(|account| account.provider.clone())
        .or(request.provider);
    let accounts = sources.accounts.list(provider.clone()).await?;
    let readiness = if let Some(account) = &pinned {
        vec![derive_account_readiness(account)]
    } else {
        let providers: Vec<ProviderId> = match &provider {
            Some(provider) => vec![provider.clone()],
            None => sources
                .providers
                .drivers()
                .map(|(provider, _)| provider.clone())
                .collect(),
        };
        derive_provider_readiness(&providers, &accounts)
    };
    let usage_windows = read_usage_windows(&sources.database_reads, provider).await?;
    Ok(ProviderAccountListResponse {
        accounts: accounts
            .iter()
            .map(RegisteredAccount::to_provider_account)
            .collect(),
        usage_windows,
        readiness,
    })
}
