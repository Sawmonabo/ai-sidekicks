//! The operating system's credential store, as one interface: the macOS login keychain, the
//! Secret Service on Linux and the Windows Credential Manager, each platform's module supplying its
//! store, the settings an entry is built with, how its search names a service, the name of what
//! holds the items, and the reading of a locked store from the store's own error. Whether the store
//! can be reached and whether it takes items without a prompt are the watch's, which holds the one
//! session-bus connection that asks.
//!
//! Every call on a store blocks until the store answers, which on a locked store is when the person
//! answers its unlock prompt, so a caller runs it on a blocking thread under its own time limit.

#[cfg(any(test, feature = "test-support"))]
pub(crate) mod blocking;
pub(crate) mod watch;

use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use keyring_core::Entry;
use keyring_core::error::PlatformError;
use secrecy::zeroize::Zeroize;
use secrecy::{ExposeSecret, SecretString};

#[cfg(target_os = "linux")]
use crate::linux::credential_store as native;
#[cfg(target_os = "macos")]
use crate::macos::credential_store as native;
#[cfg(target_os = "windows")]
use crate::windows::credential_store as native;

/// The operating system's credential store, each value filed under a service and an account. Every
/// call blocks; see the module doc.
#[derive(Clone, Debug)]
pub struct CredentialStore {
    store: Arc<keyring_core::CredentialStore>,
    // The settings every entry is built with: the platform's own, none on a test's store.
    modifiers: &'static [(&'static str, &'static str)],
    // The search that finds the items filed under a service, before the exact filter.
    search_spec: fn(&str) -> Vec<(&'static str, String)>,
}

impl CredentialStore {
    /// How long the store is given for an answer that must never wait on the person: the Secret
    /// Service's reachability and lock reads, and each store call of a move into it.
    pub const QUICK_ANSWER_LIMIT: Duration = Duration::from_secs(2);

    /// Opens this system's credential store. Blocks: on Linux it connects to the Secret Service
    /// over the session bus. Fails with [`CredentialStoreError`] when the store cannot be built or
    /// reached, as on Linux when no Secret Service answers.
    pub fn open() -> Result<Self, CredentialStoreError> {
        let store = native::open_store().map_err(CredentialStoreError::from_store_error)?;
        Ok(Self {
            store,
            modifiers: native::ENTRY_MODIFIERS,
            search_spec: native::search_spec,
        })
    }

    /// A credential store over `store`, which a test supplies in place of the system's, its entries
    /// built with no settings and its search naming the service.
    #[cfg(any(test, feature = "test-support"))]
    pub fn from_store(store: Arc<keyring_core::CredentialStore>) -> Self {
        Self {
            store,
            modifiers: &[],
            search_spec: service_search_spec,
        }
    }

    /// A credential store held in this process's memory alone, for a test: it keeps values until it
    /// drops, and lists every entry ever built on it, those never written included.
    #[cfg(any(test, feature = "test-support"))]
    pub fn in_memory() -> Self {
        let store: Arc<keyring_core::CredentialStore> =
            keyring_core::mock::Store::new().expect("the in-memory store builds without a failure");
        Self::from_store(store)
    }

    /// Makes the next call on the entry under `service` and `account` of an in-memory store fail as
    /// a store that cannot be used, the entry's value left as it is.
    #[cfg(any(test, feature = "test-support"))]
    pub fn refuse_next_call(&self, service: &str, account: &str) {
        let entry = self
            .entry(service, account)
            .expect("an in-memory store builds every entry");
        entry
            .as_any()
            .downcast_ref::<keyring_core::mock::Cred>()
            .expect("only an in-memory store's entries take a refusal")
            .set_error(keyring_core::Error::PlatformFailure(Box::new(
                std::io::Error::other("the test refuses this call"),
            )));
    }

    /// Writes `value` under `service` and `account`, replacing any value held there. Fails with
    /// [`CredentialStoreError`] when the store is locked or cannot be used.
    pub fn write(
        &self,
        service: &str,
        account: &str,
        value: &SecretString,
    ) -> Result<(), CredentialStoreError> {
        self.entry(service, account)?
            .set_password(value.expose_secret())
            .map_err(CredentialStoreError::from_store_error)
    }

    /// The value held under `service` and `account`, or `None` when none is. Fails with
    /// [`CredentialStoreError`] when the store is locked or cannot be used.
    pub fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<SecretString>, CredentialStoreError> {
        match self.entry(service, account)?.get_password() {
            Ok(mut value) => {
                // Built from the text, so the store's own copy is wiped here, not left behind.
                let secret = SecretString::from(value.as_str());
                value.zeroize();
                Ok(Some(secret))
            }
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(failure) => Err(CredentialStoreError::from_store_error(failure)),
        }
    }

    /// Removes the value under `service` and `account`; `false` when none was held. Fails with
    /// [`CredentialStoreError`] when the store is locked or cannot be used.
    pub fn remove(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError> {
        remove_entry(&self.entry(service, account)?)
    }

    /// Every item filed under exactly `service`, each with the handle that removes it: the
    /// platform's search, which may match more than the service, kept to the items whose service is
    /// `service`. An item the Secret Service cannot name, as one it could not unlock, comes with no
    /// account, since its search matched the service exactly. Fails with [`CredentialStoreError`]
    /// when the store is locked or cannot be used; on Linux the search raises the unlock prompt.
    pub fn accounts(&self, service: &str) -> Result<Vec<StoreAccount>, CredentialStoreError> {
        let spec = (self.search_spec)(service);
        let spec: HashMap<&str, &str> = spec
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let entries = self
            .store
            .search(&spec)
            .map_err(CredentialStoreError::from_store_error)?;
        Ok(entries
            .into_iter()
            .filter_map(|entry| match entry.get_specifiers() {
                Some((entry_service, account)) => {
                    (entry_service == service).then_some(StoreAccount {
                        account: Some(account),
                        entry,
                    })
                }
                None => Some(StoreAccount {
                    account: None,
                    entry,
                }),
            })
            .collect())
    }

    /// The entry for `service` and `account`, built through this store with its settings, never
    /// through a process-wide default store. Fails when the store refuses the entry's names.
    pub(crate) fn entry(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Entry, CredentialStoreError> {
        let modifiers: HashMap<&str, &str> = self.modifiers.iter().copied().collect();
        self.store
            .build(
                service,
                account,
                (!modifiers.is_empty()).then_some(&modifiers),
            )
            .map_err(CredentialStoreError::from_store_error)
    }
}

/// One item a store's listing found, with the handle that removes it.
#[derive(Debug)]
pub struct StoreAccount {
    account: Option<String>,
    entry: Entry,
}

impl StoreAccount {
    /// The account the item is filed under, or `None` for an item the Secret Service cannot name.
    pub fn account(&self) -> Option<&str> {
        self.account.as_deref()
    }

    /// Removes the item through its own handle, whether or not it has a name; `false` when it was
    /// already gone. Blocks as every store call does. Fails with [`CredentialStoreError`] when the
    /// store is locked or cannot be used.
    pub fn remove(&self) -> Result<bool, CredentialStoreError> {
        remove_entry(&self.entry)
    }
}

/// Why this system's credential store cannot be reached now; each says which condition failed and
/// what makes it hold.
#[derive(Clone, Debug, thiserror::Error)]
pub enum CredentialStoreUnreachable {
    /// `DBUS_SESSION_BUS_ADDRESS` is not set, so the service runs outside any session bus.
    #[error(
        "DBUS_SESSION_BUS_ADDRESS is not set, so no Secret Service can be reached; start the \
         service inside a desktop session, or set the variable to the session bus's address"
    )]
    NoSessionBus,
    /// The session bus failed: it did not connect at the variable's address, or refused the
    /// question.
    #[error(
        "the session bus at DBUS_SESSION_BUS_ADDRESS failed; check that the variable names the \
         running session bus"
    )]
    SessionBusFailed(#[source] Arc<dyn Error + Send + Sync>),
    /// No program owns the Secret Service's name on the session bus.
    #[error(
        "no Secret Service is running: nothing owns org.freedesktop.secrets on the session bus; \
         start one, such as GNOME Keyring, KDE Wallet or KeePassXC"
    )]
    NoSecretService,
    /// The Secret Service refused a question about its default collection.
    #[error(
        "the Secret Service refused to say whether its default collection is unlocked; check that \
         it runs and is not stuck"
    )]
    SecretServiceFailed(#[source] Arc<dyn Error + Send + Sync>),
    /// The session bus gave no answer within [`CredentialStore::QUICK_ANSWER_LIMIT`].
    #[error(
        "the session bus gave no answer within {limit} s; check that the session bus is not stuck",
        limit = CredentialStore::QUICK_ANSWER_LIMIT.as_secs()
    )]
    NoAnswer,
}

/// A credential store call the store refused or could not answer. It says whether the store is
/// locked, read from the store's own error, and never carries a stored value.
#[derive(Debug, thiserror::Error)]
pub struct CredentialStoreError {
    is_locked: bool,
    #[source]
    failure: StoreFailure,
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(if self.is_locked {
            "the credential store is locked"
        } else {
            "the credential store cannot be used"
        })
    }
}

impl CredentialStoreError {
    /// Whether the store is locked, waiting for the person to unlock it, rather than missing or
    /// broken.
    pub fn is_locked(&self) -> bool {
        self.is_locked
    }

    /// The refusal of a store that cannot be used, which a test's store answers with `reason`.
    #[cfg(any(test, feature = "test-support"))]
    pub fn unusable(reason: &str) -> Self {
        Self {
            is_locked: false,
            failure: StoreFailure::Refused {
                message: reason.to_owned(),
            },
        }
    }

    /// The refusal for the store's `error`: the cause read from the platform error underneath,
    /// whichever variant carries it, and every stored value the store's error holds dropped.
    pub(crate) fn from_store_error(error: keyring_core::Error) -> Self {
        let failure = StoreFailure::from(error);
        let is_locked = failure.platform_error().is_some_and(|platform_error| {
            let platform_error: &(dyn Error + 'static) = platform_error.as_ref();
            native::is_locked(platform_error)
        });
        Self { is_locked, failure }
    }
}

// What went wrong in the store, without the stored bytes or the matching entries its own error
// carries.
#[derive(Debug, thiserror::Error)]
enum StoreFailure {
    #[error("the store failed")]
    Platform(#[source] PlatformError),
    #[error("the store refused access")]
    NoAccess(#[source] PlatformError),
    #[error("the stored value is not UTF-8 text")]
    BadEncoding,
    #[error("the stored value is malformed")]
    BadDataFormat(#[source] PlatformError),
    #[error("{count} stored values match the entry")]
    Ambiguous { count: usize },
    #[error("{message}")]
    Refused { message: String },
    #[error("the store failed in a way this build does not know")]
    Unknown,
}

impl StoreFailure {
    fn platform_error(&self) -> Option<&PlatformError> {
        match self {
            Self::Platform(platform_error)
            | Self::NoAccess(platform_error)
            | Self::BadDataFormat(platform_error) => Some(platform_error),
            Self::BadEncoding | Self::Ambiguous { .. } | Self::Refused { .. } | Self::Unknown => {
                None
            }
        }
    }
}

impl From<keyring_core::Error> for StoreFailure {
    fn from(error: keyring_core::Error) -> Self {
        match error {
            keyring_core::Error::PlatformFailure(platform_error) => Self::Platform(platform_error),
            keyring_core::Error::NoStorageAccess(platform_error) => Self::NoAccess(platform_error),
            keyring_core::Error::BadEncoding(mut stored_bytes) => {
                stored_bytes.zeroize();
                Self::BadEncoding
            }
            keyring_core::Error::BadDataFormat(mut stored_bytes, platform_error) => {
                stored_bytes.zeroize();
                Self::BadDataFormat(platform_error)
            }
            keyring_core::Error::Ambiguous(entries) => Self::Ambiguous {
                count: entries.len(),
            },
            // Their messages name the entry's settings and the store's limits, never a value.
            keyring_core::Error::NoEntry
            | keyring_core::Error::BadStoreFormat(_)
            | keyring_core::Error::TooLong(_, _)
            | keyring_core::Error::Invalid(_, _)
            | keyring_core::Error::NoDefaultStore
            | keyring_core::Error::NotSupportedByStore(_) => Self::Refused {
                message: error.to_string(),
            },
            // A variant a later release adds may carry a stored value, so its message is not kept;
            // no listed variant reaches here.
            _ => Self::Unknown,
        }
    }
}

// Removes `entry`'s value; `false` when none was held.
fn remove_entry(entry: &Entry) -> Result<bool, CredentialStoreError> {
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring_core::Error::NoEntry) => Ok(false),
        Err(failure) => Err(CredentialStoreError::from_store_error(failure)),
    }
}

// The search a test's store reads: the service, which it matches as a substring.
#[cfg(any(test, feature = "test-support"))]
fn service_search_spec(service: &str) -> Vec<(&'static str, String)> {
    vec![("service", service.to_owned())]
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::io;

    use super::CredentialStoreError;

    const STORED_VALUE: &[u8] = b"hunter2-do-not-print";

    /// A store error over a stored value never carries it, in its text, its debug form or any
    /// source under it. Mutation: keep the store's error whole.
    #[test]
    fn a_credential_store_error_drops_the_stored_bytes() {
        let refusals = [
            keyring_core::Error::BadEncoding(STORED_VALUE.to_vec()),
            keyring_core::Error::BadDataFormat(
                STORED_VALUE.to_vec(),
                Box::new(io::Error::other("not the expected form")),
            ),
        ];
        let stored_text = String::from_utf8_lossy(STORED_VALUE);
        let stored_numbers = format!("{STORED_VALUE:?}");
        let stored_numbers = stored_numbers.trim_matches(['[', ']']);
        for refusal in refusals {
            let refusal = CredentialStoreError::from_store_error(refusal);
            let mut written = vec![refusal.to_string(), format!("{refusal:?}")];
            let mut source = refusal.source();
            while let Some(failure) = source {
                written.push(failure.to_string());
                written.push(format!("{failure:?}"));
                source = failure.source();
            }
            for text in written {
                assert!(!text.contains(stored_text.as_ref()), "{text}");
                assert!(!text.contains(stored_numbers), "{text}");
            }
        }
    }
}
