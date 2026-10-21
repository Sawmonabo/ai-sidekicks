//! The Linux side of the credential store: the Secret Service on the session bus, its entries built
//! with the store's own settings, its search by service, this account's login state, and a locked
//! store read from the Secret Service's error. Whether a Secret Service runs, which program holds
//! it, its default collection's lock and its signals are the watch's.

pub(crate) mod watch;

use std::error::Error;
use std::sync::Arc;

use crate::credential_store::CredentialStore;

/// The settings every entry is built with: the Secret Service store's own.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[];

/// The Secret Service's well-known name on the session bus.
pub(crate) const SECRET_SERVICE_NAME: &str = "org.freedesktop.secrets";

// The variable naming the session bus; without it zbus would try `$XDG_RUNTIME_DIR/bus` instead.
const SESSION_BUS_VARIABLE: &str = "DBUS_SESSION_BUS_ADDRESS";

// logind on the system bus: the object of the account that asks, and the property naming its
// state (`offline`, `lingering`, `online`, `active` or `closing`).
const LOGIN_SERVICE: &str = "org.freedesktop.login1";
const LOGIN_OWN_USER_OBJECT: &str = "/org/freedesktop/login1/user/self";
const LOGIN_USER_INTERFACE: &str = "org.freedesktop.login1.User";
const LOGIN_STATE_PROPERTY: &str = "State";

/// The Secret Service, connected over the session bus; blocks while it connects. Fails when no
/// Secret Service answers, which the caller reads as a store that cannot be used.
pub(crate) fn open_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    let store: Arc<keyring_core::CredentialStore> =
        zbus_secret_service_keyring_store::Store::new()?;
    Ok(store)
}

/// The search for the items filed under `service`: the Secret Service matches the `service`
/// attribute exactly.
pub(crate) fn search_spec(service: &str) -> Vec<(&'static str, String)> {
    vec![("service", service.to_owned())]
}

/// Whether the Secret Service's `failure` says it is locked: the collection is locked, its unlock
/// prompt was dismissed, or the bus closed while the prompt waited. Every other failure, no Secret
/// Service or no answer among them, means it cannot be used.
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

/// Whether the variable names a session bus, which the store's calls and its signals need.
pub(crate) fn is_session_bus_named() -> bool {
    std::env::var_os(SESSION_BUS_VARIABLE).is_some_and(|address| !address.is_empty())
}

/// This account's state as logind names it on the system bus, read within 2 s, in words for the
/// service log.
pub(crate) async fn login_state() -> String {
    match tokio::time::timeout(CredentialStore::QUICK_ANSWER_LIMIT, read_login_state()).await {
        Ok(Ok(state)) => state,
        Ok(Err(failure)) => format!("unread: {failure}"),
        Err(_elapsed) => format!(
            "unread: no answer within {} s",
            CredentialStore::QUICK_ANSWER_LIMIT.as_secs()
        ),
    }
}

async fn read_login_state() -> zbus::Result<String> {
    let connection = zbus::Connection::system().await?;
    let user = zbus::Proxy::new(
        &connection,
        LOGIN_SERVICE,
        LOGIN_OWN_USER_OBJECT,
        LOGIN_USER_INTERFACE,
    )
    .await?;
    user.get_property::<String>(LOGIN_STATE_PROPERTY).await
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
