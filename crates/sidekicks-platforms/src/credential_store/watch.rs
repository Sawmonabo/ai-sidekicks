//! The moments this system's credential store may have become usable: on Linux a program taking
//! the Secret Service's name on the session bus, and a Secret Service collection changing, as its
//! unlock does. Neither comes on macOS or Windows, whose store is always there.

use std::error::Error;

#[cfg(target_os = "linux")]
use crate::linux::credential_store::watch::SecretServiceWatch;

/// The signals after which a credential store that could not be reached, or was locked, may answer;
/// see the module doc. Heard only on Linux; elsewhere the wait never ends.
pub struct CredentialStoreWatch {
    #[cfg(target_os = "linux")]
    secret_service: Option<SecretServiceWatch>,
}

impl CredentialStoreWatch {
    /// Starts listening. On Linux with no session bus named there is nothing to hear, so the watch
    /// waits forever. Fails with [`CredentialStoreWatchError`] when the session bus named cannot be
    /// listened to.
    #[cfg_attr(
        not(target_os = "linux"),
        expect(
            clippy::unused_async,
            reason = "one signature with Linux's, which connects to the session bus"
        )
    )]
    pub async fn start() -> Result<Self, CredentialStoreWatchError> {
        Ok(Self {
            #[cfg(target_os = "linux")]
            secret_service: SecretServiceWatch::start().await?,
        })
    }

    /// Waits for the next moment the store may have become usable; moments that came while no one
    /// waited count as one. Cancel-safe. Fails with [`CredentialStoreWatchError`] when the session
    /// bus closes, after which nothing is heard.
    pub async fn changed(&mut self) -> Result<(), CredentialStoreWatchError> {
        #[cfg(target_os = "linux")]
        if let Some(secret_service) = &mut self.secret_service {
            return secret_service.changed().await;
        }
        std::future::pending().await
    }
}

/// Why the credential store's signals cannot be heard, or stopped being heard.
#[derive(Debug, thiserror::Error)]
#[error("the credential store's signals cannot be heard on the session bus")]
pub struct CredentialStoreWatchError {
    /// The bus's failure.
    #[source]
    pub source: Box<dyn Error + Send + Sync>,
}
