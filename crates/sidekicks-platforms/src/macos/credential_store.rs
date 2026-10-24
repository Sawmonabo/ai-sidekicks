//! The macOS side of the credential store: the login keychain, its entries built with the store's
//! own settings, its search by service, what holds its items, and a locked keychain read from the
//! Security framework's status code.

use std::error::Error;
use std::sync::Arc;

// The statuses of a locked keychain: a call that would prompt where no prompt can be shown
// (`errSecInteractionNotAllowed`), and an unlock prompt the person dismissed
// (`errSecUserCanceled`), so either way the person is told to unlock it and retry.
const LOCKED_STATUSES: [i32; 2] = [-25308, -128];

/// What holds the items, for the service log.
pub(crate) const DESCRIPTION: &str = "the login keychain";

/// The settings every entry is built with: the login keychain's own.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[];

/// The login keychain. Fails only when the store cannot be built.
pub(crate) fn open_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    let store: Arc<keyring_core::CredentialStore> =
        apple_native_keyring_store::keychain::Store::new()?;
    Ok(store)
}

/// The search for the items filed under `service`: the keychain matches the service exactly and
/// leaves out an item that names no service or account.
pub(crate) fn search_spec(service: &str) -> Vec<(&'static str, String)> {
    vec![("service", service.to_owned())]
}

/// Whether the keychain's `failure` says it is locked or its unlock prompt was dismissed; every
/// other status, -25291 (no keychain available) and -25294 (no such keychain) among them, means it
/// cannot be used.
pub(crate) fn is_locked(failure: &(dyn Error + 'static)) -> bool {
    failure
        .downcast_ref::<security_framework::base::Error>()
        .is_some_and(|status| LOCKED_STATUSES.contains(&status.code()))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use crate::credential_store::CredentialStoreError;

    /// Each keychain status, whichever store error carries it, reads the cause the person is told.
    /// Mutations: map -25308 to `unavailable`; map -128 to `unavailable`.
    #[rstest]
    #[case::locked_as_a_failure(keyring_core::Error::PlatformFailure(status(-25308)), true)]
    #[case::locked_as_no_access(keyring_core::Error::NoStorageAccess(status(-25308)), true)]
    #[case::unlock_dismissed(keyring_core::Error::PlatformFailure(status(-128)), true)]
    #[case::not_available(keyring_core::Error::NoStorageAccess(status(-25291)), false)]
    #[case::no_such_keychain(keyring_core::Error::NoStorageAccess(status(-25294)), false)]
    #[case::other_failure(keyring_core::Error::PlatformFailure(status(-25293)), false)]
    fn a_credential_store_error_reads_its_cause_from_the_keychain_status(
        #[case] error: keyring_core::Error,
        #[case] is_locked: bool,
    ) {
        assert_eq!(
            CredentialStoreError::from_store_error(error).is_locked(),
            is_locked
        );
    }

    fn status(code: i32) -> keyring_core::error::PlatformError {
        Box::new(security_framework::base::Error::from_code(code))
    }
}
