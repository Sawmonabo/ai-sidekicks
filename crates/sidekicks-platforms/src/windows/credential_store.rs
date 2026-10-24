//! The Windows side of the credential store: the Credential Manager, its entries kept on this
//! machine alone, its search by service, what holds its items, and no locked reading, since the
//! store keeps its error type private.

use std::error::Error;
use std::sync::Arc;

/// What holds the items, for the service log.
pub(crate) const DESCRIPTION: &str =
    "the Credential Manager, each item kept at local-machine persistence";

/// The settings every entry is built with: local persistence, since the store otherwise writes
/// enterprise persistence, which roams with the account to other machines.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[("persistence", "local")];

/// The Credential Manager. Fails only when the store cannot be built.
pub(crate) fn open_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    let store: Arc<keyring_core::CredentialStore> = windows_native_keyring_store::Store::new()?;
    Ok(store)
}

/// The search for the items filed under `service`: a pattern over every credential's target,
/// which the store writes `<account>.<service>`, so it may also match a service that ends in
/// `.<service>`.
pub(crate) fn search_spec(service: &str) -> Vec<(&'static str, String)> {
    vec![("pattern", format!("^.*\\.{}$", regex::escape(service)))]
}

/// Always `false`: the store's errors cannot be read, so each one means the store cannot be used,
/// and only a call that does not answer in time reads as locked.
pub(crate) fn is_locked(_failure: &(dyn Error + 'static)) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::io;

    use rstest::rstest;
    use secrecy::SecretString;

    use crate::credential_store::{CredentialStore, CredentialStoreError};

    /// Every store error reads as the store being unusable, never locked. Mutation: read a
    /// `NoStorageAccess` as locked.
    #[rstest]
    #[case::no_access(keyring_core::Error::NoStorageAccess(Box::new(io::Error::other(
        "denied"
    ))))]
    #[case::failure(keyring_core::Error::PlatformFailure(Box::new(io::Error::other("failed"))))]
    fn a_credential_store_error_never_reads_locked(#[case] error: keyring_core::Error) {
        assert!(!CredentialStoreError::from_store_error(error).is_locked());
    }

    /// An entry is written with local persistence, so it never roams to the account's other
    /// machines. Writes one entry to the Credential Manager and removes it however the test ends.
    /// Mutation: build with no modifiers.
    #[test]
    fn a_credential_store_entry_is_kept_on_this_machine() {
        const SERVICE: &str = "ai-sidekicks-credential-store-test";
        const ACCOUNT: &str = "persistence";

        // Removes the test's entry when it drops, a panic's unwinding included.
        struct EntryRemoval<'store> {
            store: &'store CredentialStore,
        }

        impl Drop for EntryRemoval<'_> {
            fn drop(&mut self) {
                let removed = self.store.remove(SERVICE, ACCOUNT);
                // A second panic while unwinding would abort the run and hide the first.
                if !std::thread::panicking() {
                    assert!(removed.expect("the entry is removed"));
                }
            }
        }

        let store = CredentialStore::open().expect("the Credential Manager opens");
        store
            .write(SERVICE, ACCOUNT, &SecretString::from("value"))
            .expect("the entry is written");
        let removal = EntryRemoval { store: &store };
        let attributes = store
            .entry(SERVICE, ACCOUNT)
            .and_then(|entry| {
                entry
                    .get_attributes()
                    .map_err(CredentialStoreError::from_store_error)
            })
            .expect("the entry's attributes read");
        drop(removal);
        assert_eq!(
            attributes.get("persistence").map(String::as_str),
            Some("Local")
        );
    }
}
