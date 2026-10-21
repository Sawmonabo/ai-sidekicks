//! The Secret Service's signals on the session bus: the bus's `NameOwnerChanged` for the Secret
//! Service's name, when a program takes it, and the Secret Service's own `CollectionChanged`, which
//! it sends when a collection's lock state changes. One match rule each, so nothing polls.

use futures_util::stream::Fuse;
use futures_util::{FutureExt as _, StreamExt as _};
use zbus::fdo::{DBusProxy, NameOwnerChangedStream};
use zbus::message::Type;
use zbus::{MatchRule, MessageStream};

use crate::credential_store::watch::CredentialStoreWatchError;
use crate::linux::credential_store::{SECRET_SERVICE_NAME, is_session_bus_named};

// The Secret Service's interface and the signal it sends when a collection changes.
const SECRET_SERVICE_INTERFACE: &str = "org.freedesktop.Secret.Service";
const COLLECTION_CHANGED_SIGNAL: &str = "CollectionChanged";

/// The Secret Service's name taken and its collections changed, heard on the session bus.
pub(crate) struct SecretServiceWatch {
    // Fused, so once the bus closes every later read sees it closed too.
    owner_changes: Fuse<NameOwnerChangedStream>,
    collection_changes: Fuse<MessageStream>,
}

impl SecretServiceWatch {
    /// Starts listening on the session bus, or `None` when no session bus is named. Fails with
    /// [`CredentialStoreWatchError`] when the named bus does not connect or refuses either match.
    pub(crate) async fn start() -> Result<Option<Self>, CredentialStoreWatchError> {
        if !is_session_bus_named() {
            return Ok(None);
        }
        let connection = zbus::Connection::session().await.map_err(watch_failure)?;
        let bus = DBusProxy::new(&connection).await.map_err(watch_failure)?;
        let owner_changes = bus
            .receive_name_owner_changed_with_args(&[(0, SECRET_SERVICE_NAME)])
            .await
            .map_err(watch_failure)?;
        let collection_rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .interface(SECRET_SERVICE_INTERFACE)
            .map_err(watch_failure)?
            .member(COLLECTION_CHANGED_SIGNAL)
            .map_err(watch_failure)?
            .build();
        let collection_changes = MessageStream::for_match_rule(collection_rule, &connection, None)
            .await
            .map_err(watch_failure)?;
        Ok(Some(Self {
            owner_changes: owner_changes.fuse(),
            collection_changes: collection_changes.fuse(),
        }))
    }

    /// Waits for a program to take the Secret Service's name or a collection to change; signals
    /// already queued are read with it, so a run of them counts as one. Cancel-safe. Fails with
    /// [`CredentialStoreWatchError`] when the bus closes.
    pub(crate) async fn changed(&mut self) -> Result<(), CredentialStoreWatchError> {
        loop {
            let is_change = tokio::select! {
                owner_change = self.owner_changes.next() => {
                    let owner_change = owner_change.ok_or_else(bus_closed)?;
                    // A name given up names no new owner and makes nothing usable.
                    owner_change
                        .args()
                        .map_err(watch_failure)?
                        .new_owner()
                        .is_some()
                }
                collection_change = self.collection_changes.next() => {
                    collection_change.ok_or_else(bus_closed)?.map_err(watch_failure)?;
                    true
                }
            };
            if is_change {
                break;
            }
        }
        while let Some(Some(_)) = self.owner_changes.next().now_or_never() {}
        while let Some(Some(_)) = self.collection_changes.next().now_or_never() {}
        Ok(())
    }
}

fn bus_closed() -> CredentialStoreWatchError {
    watch_failure(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "the session bus closed",
    ))
}

fn watch_failure(
    failure: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> CredentialStoreWatchError {
    CredentialStoreWatchError {
        source: failure.into(),
    }
}
