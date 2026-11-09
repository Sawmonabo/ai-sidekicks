//! The pasted API key of an account that signs in with one: read from where the daemon seals its
//! secrets and handed to the service of the account's home with Codex's
//! `account/login/start {type: "apiKey"}`, which keeps it in that service's memory alone. A key
//! re-supplied while that service runs is handed to it in place, Codex reloading the sign-in its
//! running conversations use, and to the switching service while it carries the account.

use std::sync::Arc;

use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::account::login::{CODEX_LOGIN_START_METHOD, CodexLoginAccountParams};
use crate::driver::codex::service::home::CodexHomeKind;
use crate::driver::codex::service::registry::{CodexServiceRegistry, switching_home};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceDependencies};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::error::DriverError;
use crate::driver::{ProviderAccountFolders, ProviderAccountReader};

/// The API key sealed for `provider_account_id`'s account, read through `provider_accounts`.
/// Refuses `provider.account.notAuthenticated` where none is sealed, and fails as the driver's own
/// error while no accounts reader is registered or the keychain refuses the read.
pub(crate) async fn read_codex_api_key(
    provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
    provider_account_id: &ProviderAccountId,
) -> Result<SecretString, CodexError> {
    provider_accounts
        .require_port()
        .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?
        .read_sealed_token(provider_account_id.clone())
        .await
        .map_err(|error| CodexError::Driver(DriverError::Internal(error)))?
        .ok_or_else(|| {
            CodexError::Driver(DriverError::from(DomainError::new(
                "The Codex account holds no API key to hand over",
                RefusalCode::ProviderAccountNotAuthenticated,
            )))
        })
}

/// Signs the service on `connection` in with `api_key`. Fails as the request does, Codex's
/// refusal of the key among them.
pub(crate) async fn log_in_with_api_key(
    connection: &CodexAppServerConnection,
    api_key: SecretString,
) -> Result<(), CodexError> {
    connection
        .request(
            CODEX_LOGIN_START_METHOD,
            &CodexLoginAccountParams::ApiKey { api_key },
        )
        .await?;
    Ok(())
}

/// Hands `api_key`, just sealed for `provider_account_id`'s account in place of its earlier key,
/// to the services of `registry`, which share `dependencies`, running on that earlier key: the
/// key service of the account's home in `folders`, and the switching service where it carries the
/// account on its key. A service on its way back up is waited for, since its start may have read
/// the earlier key; one stopped or ended is not started, its next start reading the sealed key,
/// and neither is one whose connection closed under the login. Fails with Codex's refusal of the
/// login, and as the switching service's hand fails.
pub(crate) async fn hand_resupplied_codex_key(
    registry: &CodexServiceRegistry,
    dependencies: &CodexServiceDependencies,
    provider_account_id: &ProviderAccountId,
    folders: &ProviderAccountFolders,
    api_key: &SecretString,
) -> Result<(), CodexError> {
    let key_service = registry
        .service_on(&folders.configuration_folder)
        .filter(|service| {
            matches!(
                &service.home().kind,
                CodexHomeKind::ApiKeyAccount(owner) if owner == provider_account_id
            )
        });
    if let Some(service) = key_service
        && let Some(connection) = connection_once_back(&service).await
    {
        settle_closed(log_in_with_api_key(&connection, api_key.clone()).await)?;
    }
    let switching = registry.service_on(&switching_home(&dependencies.data_folder));
    if let Some(service) = switching
        && connection_once_back(&service).await.is_some()
    {
        settle_closed(
            dependencies
                .switching
                .hand_resupplied_key(&service, provider_account_id, api_key.clone())
                .await,
        )?;
    }
    Ok(())
}

// The connection of `service` once it is no longer on its way back up; `None` where it is then not
// up, a service stopped or ended having no connection to hand anything on.
async fn connection_once_back(service: &CodexService) -> Option<Arc<CodexAppServerConnection>> {
    if service.is_coming_back() {
        service.when_back().await;
    }
    if !service.is_serving() {
        return None;
    }
    // Fails only once the service is down again, which leaves it as stopped.
    service.connection().ok()
}

// A hand's answer, where a connection that closed before the answer is no failure: the service's
// restart reads the sealed key.
fn settle_closed(handed: Result<(), CodexError>) -> Result<(), CodexError> {
    match handed {
        Err(error) if error.is_connection_closed() => Ok(()),
        handed => handed,
    }
}

#[cfg(test)]
mod tests;
