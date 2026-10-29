//! Where this machine keeps the daemon's secrets, and the operating system's credential store as
//! one interface. macOS and Windows offer their store, the login keychain and the Credential
//! Manager, each platform's module supplying its store, the settings an entry is built with, how
//! its search names a service, the name of what holds the items, and the reading of a locked store
//! from the store's own error. Linux offers systemd's credential service, which seals each secret
//! to this computer (`seal`); the store itself stays on every system for the tests' stores.
//!
//! A store whose entries hold a capped number of bytes keeps a larger value as a head and numbered
//! pieces under the same service (`pieces`); its listings and calls hide that from callers but for
//! the erase, which lists the pieces too.
//!
//! Every call on a store blocks until the store answers, which on a locked store is when the person
//! answers its unlock prompt, so a caller runs it on a blocking thread under its own time limit.

#[cfg(any(test, feature = "test-support"))]
pub(crate) mod blocking;
mod pieces;
pub(crate) mod seal;

use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;

use keyring_core::Entry;
use keyring_core::error::PlatformError;
use secrecy::zeroize::{Zeroize, Zeroizing};
use secrecy::{ExposeSecret, SecretString};

use crate::credential_store::seal::CredentialSeal;
#[cfg(target_os = "macos")]
use crate::macos::credential_store as native;
#[cfg(target_os = "windows")]
use crate::windows::credential_store as native;

// The socket systemd's credential service listens on.
#[cfg(target_os = "linux")]
const SYSTEMD_CREDENTIALS_SOCKET: &str = "/run/systemd/io.systemd.Credentials";

/// What this machine offers for the daemon's secrets.
#[derive(Clone, Debug)]
pub enum SecretStoreOffer {
    /// The operating system's credential store, on macOS and Windows.
    OperatingSystem(StoreOpener),
    /// systemd's credential service, on Linux. A computer whose systemd does not serve it is found
    /// by the first call's [`seal::SealFailure::NoService`].
    SealService(CredentialSeal),
}

/// What this machine offers for the daemon's secrets: its credential store on macOS and Windows,
/// systemd's credential service on Linux.
pub fn secret_store_offer() -> SecretStoreOffer {
    #[cfg(target_os = "linux")]
    {
        SecretStoreOffer::SealService(CredentialSeal::at(SYSTEMD_CREDENTIALS_SOCKET))
    }
    #[cfg(not(target_os = "linux"))]
    {
        SecretStoreOffer::OperatingSystem(StoreOpener {
            open: CredentialStore::open,
            description: native::DESCRIPTION,
        })
    }
}

/// The macOS login keychain, where a provider's program files its own sign-in; `None` on Windows
/// and Linux, where a provider keeps its sign-in in a file.
pub fn login_keychain() -> Option<StoreOpener> {
    #[cfg(target_os = "macos")]
    {
        Some(StoreOpener {
            open: CredentialStore::open,
            description: native::DESCRIPTION,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Opens the operating system's credential store and names it for the service log.
#[derive(Clone, Copy, Debug)]
pub struct StoreOpener {
    open: fn() -> Result<CredentialStore, CredentialStoreError>,
    description: &'static str,
}

impl StoreOpener {
    /// Opens the store. Blocks while it does. Fails with [`CredentialStoreError`] when the store
    /// cannot be built.
    pub fn open(&self) -> Result<CredentialStore, CredentialStoreError> {
        (self.open)()
    }

    /// What holds the store's items, in words for the service log.
    pub fn description(&self) -> &'static str {
        self.description
    }
}

/// The operating system's credential store, each value filed under a service and an account. Every
/// call blocks; see the module doc.
#[derive(Clone, Debug)]
pub struct CredentialStore {
    store: Arc<keyring_core::CredentialStore>,
    // The settings every entry is built with: the platform's own, none on a test's store.
    modifiers: &'static [(&'static str, &'static str)],
    // The search that finds the items filed under a service, before the exact filter.
    search_spec: fn(&str) -> Vec<(&'static str, String)>,
    // The most bytes one entry holds, none when the store sets no cap.
    entry_capacity: Option<usize>,
}

impl CredentialStore {
    /// Opens this system's credential store. Fails with [`CredentialStoreError`] when the store
    /// cannot be built.
    #[cfg(not(target_os = "linux"))]
    pub fn open() -> Result<Self, CredentialStoreError> {
        let store = native::open_store().map_err(CredentialStoreError::from_store_error)?;
        Ok(Self {
            store,
            modifiers: native::ENTRY_MODIFIERS,
            search_spec: native::search_spec,
            entry_capacity: native::ENTRY_CAPACITY,
        })
    }

    /// A credential store over `store`, which a test supplies in place of the system's, its entries
    /// built with no settings and no cap and its search naming the service.
    #[cfg(any(test, feature = "test-support"))]
    pub fn from_store(store: Arc<keyring_core::CredentialStore>) -> Self {
        Self {
            store,
            modifiers: &[],
            search_spec: service_search_spec,
            entry_capacity: None,
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

    /// Writes `value` under `service` and `account`, replacing any value held there, as its UTF-8
    /// bytes. A value larger than one entry is written as pieces under a fresh generation first and
    /// its head last, so a write cut short leaves the old value whole; then every other
    /// generation's pieces of the item are removed. Fails with [`CredentialStoreError`] when the
    /// store is locked or cannot be used, the value possibly landed when the removal is what fails.
    pub fn write(
        &self,
        service: &str,
        account: &str,
        value: &SecretString,
    ) -> Result<(), CredentialStoreError> {
        let value = value.expose_secret().as_bytes();
        if !pieces::is_pieced(value, self.entry_capacity) {
            self.entry(service, account)?
                .set_secret(value)
                .map_err(CredentialStoreError::from_store_error)?;
            return self.remove_pieces(service, account, None);
        }
        let generation = pieces::fresh_generation().map_err(CredentialStoreError::no_generation)?;
        let (head, item_pieces) = pieces::lay_out(value, self.entry_capacity, generation);
        for (number, piece) in (1..).zip(item_pieces) {
            let piece_account = pieces::piece_account(account, &generation, number);
            self.entry(service, &piece_account)?
                .set_secret(piece)
                .map_err(CredentialStoreError::from_store_error)?;
        }
        self.entry(service, account)?
            .set_secret(&head)
            .map_err(CredentialStoreError::from_store_error)?;
        self.remove_pieces(service, account, Some(&generation))
    }

    /// The value held under `service` and `account`, or `None` when none is: a head's pieces read
    /// and joined. Fails with [`CredentialStoreError`] when the store is locked or cannot be used,
    /// and when a head's pieces are missing or do not match its digest, never answering part of
    /// the value.
    pub fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<SecretString>, CredentialStoreError> {
        let Some(stored) = self.stored_bytes(service, account)? else {
            return Ok(None);
        };
        let value = if pieces::is_head(&stored) {
            let head = pieces::Head::read(&stored)
                .ok_or_else(|| CredentialStoreError::torn(service, account))?;
            let mut item_pieces = Vec::new();
            for piece_account in head.piece_accounts(account) {
                item_pieces.push(
                    self.stored_bytes(service, &piece_account)?
                        .ok_or_else(|| CredentialStoreError::torn(service, account))?,
                );
            }
            head.join(&item_pieces)
                .ok_or_else(|| CredentialStoreError::torn(service, account))?
        } else {
            stored
        };
        match std::str::from_utf8(&value) {
            Ok(text) => Ok(Some(SecretString::from(text))),
            Err(_) => Err(CredentialStoreError::from_store_error(
                keyring_core::Error::BadEncoding(value.to_vec()),
            )),
        }
    }

    /// Removes the value under `service` and `account`, its head and every piece; `false` when
    /// none was held. Fails with [`CredentialStoreError`] when the store is locked or cannot be
    /// used.
    pub fn remove(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError> {
        let is_removed = remove_entry(&self.entry(service, account)?)?;
        self.remove_pieces(service, account, None)?;
        Ok(is_removed)
    }

    /// Every item filed under exactly `service`, each with the handle that removes it, the pieces
    /// of a value larger than one entry left out. Fails with [`CredentialStoreError`] when the
    /// store is locked or cannot be used.
    pub fn accounts(&self, service: &str) -> Result<Vec<StoreAccount>, CredentialStoreError> {
        let mut items = self.entries(service)?;
        items.retain(|item| pieces::piece_of(&item.account).is_none());
        Ok(items)
    }

    /// Every entry filed under exactly `service`, the pieces of a value larger than one entry
    /// included, each with the handle that removes it: the platform's search, which may match more
    /// than the service, kept to the entries whose service is `service`. Fails with
    /// [`CredentialStoreError`] when the store is locked or cannot be used.
    pub fn entries(&self, service: &str) -> Result<Vec<StoreAccount>, CredentialStoreError> {
        let spec = (self.search_spec)(service);
        let spec: HashMap<&str, &str> = spec
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let entries = self
            .store
            .search(&spec)
            .map_err(CredentialStoreError::from_store_error)?;
        // Each store names every item it lists: the keychain and the in-memory store always, the
        // Credential Manager every target its pattern matches.
        Ok(entries
            .into_iter()
            .filter_map(|entry| {
                let (entry_service, account) = entry.get_specifiers()?;
                (entry_service == service).then_some(StoreAccount { account, entry })
            })
            .collect())
    }

    // The bytes the entry under `service` and `account` holds, or `None` when it holds none.
    fn stored_bytes(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialStoreError> {
        match self.entry(service, account)?.get_secret() {
            Ok(stored) => Ok(Some(Zeroizing::new(stored))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(failure) => Err(CredentialStoreError::from_store_error(failure)),
        }
    }

    // Removes every piece of the item under `account` but those of `kept`. The service is listed
    // rather than the old head read, so pieces a write cut short left behind go too. A store with
    // no cap never holds a piece, so it is not listed.
    fn remove_pieces(
        &self,
        service: &str,
        account: &str,
        kept: Option<&pieces::Generation>,
    ) -> Result<(), CredentialStoreError> {
        if self.entry_capacity.is_none() {
            return Ok(());
        }
        for item in self.entries(service)? {
            if let Some((item_account, generation)) = pieces::piece_of(&item.account)
                && item_account == account
                && kept != Some(&generation)
            {
                item.remove()?;
            }
        }
        Ok(())
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
    account: String,
    entry: Entry,
}

impl StoreAccount {
    /// The account the item is filed under.
    pub fn account(&self) -> &str {
        &self.account
    }

    /// Removes the item through its own handle; `false` when it was already gone. Blocks as every
    /// store call does. Fails with [`CredentialStoreError`] when the store is locked or cannot be
    /// used.
    pub fn remove(&self) -> Result<bool, CredentialStoreError> {
        remove_entry(&self.entry)
    }
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

    // The refusal of the item under `service` and `account` whose head's pieces are missing or do
    // not match its digest: a write was cut short.
    fn torn(service: &str, account: &str) -> Self {
        Self {
            is_locked: false,
            failure: StoreFailure::Refused {
                message: format!(
                    "the item under {service} and {account} does not match its head: \
                     a write was cut short"
                ),
            },
        }
    }

    // The refusal of a write that found no randomness to name its pieces.
    fn no_generation(error: getrandom::Error) -> Self {
        Self {
            is_locked: false,
            failure: StoreFailure::Refused {
                message: format!("no randomness to name the item's pieces: {error}"),
            },
        }
    }

    /// The refusal for the store's `error`: the cause read from the platform error underneath,
    /// whichever variant carries it, and every stored value the store's error holds dropped.
    pub(crate) fn from_store_error(error: keyring_core::Error) -> Self {
        let failure = StoreFailure::from(error);
        let is_locked = failure.platform_error().is_some_and(|platform_error| {
            let platform_error: &(dyn Error + 'static) = platform_error.as_ref();
            is_locked_failure(platform_error)
        });
        Self { is_locked, failure }
    }
}

// Whether the platform store's `failure` says it is locked, as the platform's module reads it.
#[cfg(not(target_os = "linux"))]
fn is_locked_failure(failure: &(dyn Error + 'static)) -> bool {
    native::is_locked(failure)
}

// Linux keeps no credential store of its own: only a test's store answers there, and it is never
// locked.
#[cfg(target_os = "linux")]
fn is_locked_failure(_failure: &(dyn Error + 'static)) -> bool {
    false
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
