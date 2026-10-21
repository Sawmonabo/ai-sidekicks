//! Whether this system's credential store can be reached and takes items without a prompt, what
//! holds its items, and the moments it may have become usable: on Linux a program taking the Secret
//! Service's name on the session bus, and a Secret Service collection changing, as its unlock does,
//! all heard and asked over one session-bus connection. On macOS and Windows the store is always
//! there and no moment comes.

#[cfg(target_os = "linux")]
use std::sync::Arc;

use crate::credential_store::CredentialStoreUnreachable;
#[cfg(not(target_os = "linux"))]
use crate::credential_store::native;
#[cfg(target_os = "linux")]
use crate::linux::credential_store::watch::SecretServiceWatch;

/// This system's credential store as one connection sees it; see the module doc. Each clone waits
/// for its own moments and shares the connection.
#[derive(Clone)]
pub struct CredentialStoreWatch {
    #[cfg(target_os = "linux")]
    secret_service: Arc<SecretServiceWatch>,
    #[cfg(target_os = "linux")]
    moments: tokio::sync::watch::Receiver<()>,
}

impl CredentialStoreWatch {
    /// Starts listening. On Linux it connects to the session bus named and asks once who owns the
    /// Secret Service's name, within 2 s; a bus that does not answer is asked again at the next
    /// read, and with no session bus named there is nothing to hear.
    #[cfg_attr(
        not(target_os = "linux"),
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "one signature with Linux's, which connects to the session bus"
        )
    )]
    pub async fn start() -> Self {
        #[cfg(target_os = "linux")]
        {
            let secret_service = SecretServiceWatch::start().await;
            let moments = secret_service.moments();
            Self {
                secret_service,
                moments,
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self {}
        }
    }

    /// Whether the store can be reached now, without opening it: on Linux the session bus is named
    /// and a program owns the Secret Service's name, as the watch last heard; a bus that closed is
    /// connected again first, within 2 s. Always on macOS and Windows. Fails with
    /// [`CredentialStoreUnreachable`] naming the condition that failed and its remedy.
    #[cfg_attr(
        not(target_os = "linux"),
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "one signature with Linux's, which may connect to the session bus again"
        )
    )]
    pub async fn check_reachable(&self) -> Result<(), CredentialStoreUnreachable> {
        #[cfg(target_os = "linux")]
        {
            self.secret_service.check_reachable().await
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(())
        }
    }

    /// Whether the store takes items now without raising an unlock prompt: on Linux whether the
    /// Secret Service's default collection exists and is unlocked, read within 2 s without starting
    /// a Secret Service; always on macOS and Windows. Fails with [`CredentialStoreUnreachable`]
    /// when that cannot be read.
    #[cfg_attr(
        not(target_os = "linux"),
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "one signature with Linux's, which asks the Secret Service"
        )
    )]
    pub async fn is_unlocked(&self) -> Result<bool, CredentialStoreUnreachable> {
        #[cfg(target_os = "linux")]
        {
            self.secret_service.is_unlocked().await
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(true)
        }
    }

    /// What holds this system's items, in words for the service log: on Linux the Secret Service's
    /// owning program and this account's login state, as far as each reads within 2 s.
    #[cfg_attr(
        not(target_os = "linux"),
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "one signature with Linux's, which asks the session bus and logind"
        )
    )]
    pub async fn description(&self) -> String {
        #[cfg(target_os = "linux")]
        {
            self.secret_service.description().await
        }
        #[cfg(not(target_os = "linux"))]
        {
            native::DESCRIPTION.to_owned()
        }
    }

    /// Waits for the next moment the store may have become usable; moments that came while this
    /// clone did not wait count as one. Cancel-safe. Never ends on macOS and Windows, nor on Linux
    /// with no session bus named.
    pub async fn changed(&mut self) {
        #[cfg(target_os = "linux")]
        if self.moments.changed().await.is_ok() {
            return;
        }
        std::future::pending::<()>().await;
    }
}
