//! The pasted API key of an account that signs in with one: read from where the daemon seals its
//! secrets and handed to the service of the account's home with Codex's
//! `account/login/start {type: "apiKey"}`, which keeps it in that service's memory alone.

use std::sync::Arc;

use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::ProviderAccountReader;
use crate::driver::codex::account::login::{CODEX_LOGIN_START_METHOD, CodexLoginAccountParams};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::error::DriverError;

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

#[cfg(test)]
mod tests;
