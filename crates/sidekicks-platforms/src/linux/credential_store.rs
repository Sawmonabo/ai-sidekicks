//! The Linux side of the credential store: the Secret Service on the session bus, its entries built
//! with the store's own settings, and a locked store read from the Secret Service's error.

use std::error::Error;
use std::sync::Arc;

/// The settings every entry is built with: the Secret Service store's own.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[];

/// The Secret Service, connected over the session bus; blocks while it connects. Fails when the
/// session has no Secret Service, which sends the daemon to its items file.
pub(crate) fn open_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    let store: Arc<keyring_core::CredentialStore> =
        zbus_secret_service_keyring_store::Store::new()?;
    Ok(store)
}

/// Whether the Secret Service's `failure` says it is locked: the collection is locked, its unlock
/// prompt was dismissed, or the bus closed while the prompt waited. No Secret Service, or no
/// answer, means it cannot be used.
pub(crate) fn is_locked(failure: &(dyn Error + 'static)) -> bool {
    matches!(
        failure.downcast_ref::<secret_service::Error>(),
        Some(
            secret_service::Error::Locked
                | secret_service::Error::Prompt
                | secret_service::Error::PromptDisconnected
        )
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use crate::credential_store::CredentialStoreError;

    /// Each Secret Service error, whichever store error carries it, reads the cause the person is
    /// told. Mutation: drop the `Prompt` arm.
    #[rstest]
    #[case::locked(
        keyring_core::Error::NoStorageAccess(Box::new(secret_service::Error::Locked)),
        true
    )]
    #[case::prompt_dismissed(
        keyring_core::Error::NoStorageAccess(Box::new(secret_service::Error::Prompt)),
        true
    )]
    #[case::prompt_disconnected(
        keyring_core::Error::PlatformFailure(Box::new(secret_service::Error::PromptDisconnected)),
        true
    )]
    #[case::unavailable(
        keyring_core::Error::PlatformFailure(Box::new(secret_service::Error::Unavailable)),
        false
    )]
    #[case::no_result(
        keyring_core::Error::NoStorageAccess(Box::new(secret_service::Error::NoResult)),
        false
    )]
    fn a_credential_store_error_reads_its_cause_from_the_secret_service_error(
        #[case] error: keyring_core::Error,
        #[case] is_locked: bool,
    ) {
        assert_eq!(
            CredentialStoreError::from_store_error(error).is_locked(),
            is_locked
        );
    }
}
