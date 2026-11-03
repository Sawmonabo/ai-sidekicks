//! Codex's status read of a pasted API key: a service of the daemon's own, started for the one
//! read in a folder made for it under the data folder, handed the key with
//! `account/login/start {type: "apiKey"}` on the ephemeral store and asked `account/read`, so no
//! file in the account's home is opened or written.

use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::ProviderAuthMode;

use crate::account::read_folder::run_in_read_folder;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::api_key::log_in_with_api_key;
use crate::driver::codex::account::sign_in::read_signed_in_mode;
use crate::driver::contract::error::DriverError;

/// The data folder's folder of the status reads' own folders, one per read.
const CODEX_TOKEN_STATUS_FOLDER: [&str; 2] = ["codex", "token-status"];

/// Reads how Codex signs in with the pasted API key `token`, on a service started for the read in
/// a folder made for it and removed after it: the mode `account/read` reports once the key is
/// handed, else `None`. The service is stopped whatever the read answered, and a read its caller's
/// bound drops ends the service's process and removes the folder. Fails as the folder cannot be
/// made, the service cannot start, a request fails or Codex refuses the key, and where the reply
/// cannot be read.
pub(super) async fn read_codex_token_status(
    legs: &CodexAccountLegs,
    token: &SecretString,
) -> Result<Option<ProviderAuthMode>, DriverError> {
    run_in_read_folder(
        &legs.dependencies.data_folder,
        &CODEX_TOKEN_STATUS_FOLDER,
        async |folder| {
            let service = legs.registry.token_status_service(folder.to_path_buf());
            let read = async {
                service
                    .ensure_started(service.dependencies().startup_timeout)
                    .await?;
                let connection = service.connection()?;
                log_in_with_api_key(&connection, token.clone()).await?;
                read_signed_in_mode(&connection).await
            }
            .await;
            service.stop().await;
            Ok(read?.map(|(mode, _is_named)| mode))
        },
    )
    .await
}

#[cfg(test)]
mod tests;
