//! The Linux side of the credential store: the Secret Service on the session bus, its entries built
//! with the store's own settings, its search by service, whether a Secret Service runs, which
//! program holds it and this account's login state, its signals, and a locked store read from the
//! Secret Service's error.

pub(crate) mod watch;

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use zbus::fdo::DBusProxy;
use zbus::names::{BusName, OwnedUniqueName};

use crate::credential_store::CredentialStoreUnreachable;
use crate::linux::read_process_file;

/// The settings every entry is built with: the Secret Service store's own.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[];

/// The Secret Service's well-known name on the session bus.
pub(crate) const SECRET_SERVICE_NAME: &str = "org.freedesktop.secrets";

// The variable naming the session bus; without it zbus would try `$XDG_RUNTIME_DIR/bus` instead.
const SESSION_BUS_VARIABLE: &str = "DBUS_SESSION_BUS_ADDRESS";

// How long the session bus may take to connect and name the Secret Service's owner, and logind to
// name this account's state.
const PROBE_LIMIT: Duration = Duration::from_secs(2);

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

/// Whether a Secret Service runs on the session bus: the variable names the bus, the bus connects
/// and a program owns the Secret Service's name, all within 2 s. Fails with
/// [`CredentialStoreUnreachable`] naming the condition that failed.
pub(crate) async fn check_reachable() -> Result<(), CredentialStoreUnreachable> {
    if !is_session_bus_named() {
        return Err(CredentialStoreUnreachable::NoSessionBus);
    }
    match tokio::time::timeout(PROBE_LIMIT, secret_service_owner()).await {
        Ok(Ok(Some(_owner))) => Ok(()),
        Ok(Ok(None)) => Err(CredentialStoreUnreachable::NoSecretService),
        Ok(Err(failure)) => Err(CredentialStoreUnreachable::SessionBusFailed(Box::new(
            failure,
        ))),
        Err(_elapsed) => Err(CredentialStoreUnreachable::NoAnswer),
    }
}

/// The program holding the Secret Service and this account's login state, as far as each reads
/// within 2 s, for the service log.
pub(crate) async fn description() -> String {
    let holder = if is_session_bus_named() {
        match tokio::time::timeout(PROBE_LIMIT, secret_service_program()).await {
            Ok(Ok(Some(program))) => format!("the Secret Service, held by {program}"),
            Ok(Ok(None)) => format!("no Secret Service: nothing owns {SECRET_SERVICE_NAME}"),
            Ok(Err(failure)) => format!("the Secret Service, its holder unread: {failure}"),
            Err(_elapsed) => {
                "the Secret Service, its holder unread: no answer within 2 s".to_owned()
            }
        }
    } else {
        format!("no Secret Service: {SESSION_BUS_VARIABLE} is not set")
    };
    let login_state = match tokio::time::timeout(PROBE_LIMIT, login_state()).await {
        Ok(Ok(state)) => state,
        Ok(Err(failure)) => format!("unread: {failure}"),
        Err(_elapsed) => "unread: no answer within 2 s".to_owned(),
    };
    format!("{holder}; this account's login state: {login_state}")
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

// The session bus and the unique name of the connection owning the Secret Service's name, or
// `None` when nothing owns it.
async fn secret_service_owner() -> zbus::Result<Option<(DBusProxy<'static>, OwnedUniqueName)>> {
    let connection = zbus::Connection::session().await?;
    let bus = DBusProxy::new(&connection).await?;
    match bus
        .get_name_owner(BusName::try_from(SECRET_SERVICE_NAME)?)
        .await
    {
        Ok(owner) => Ok(Some((bus, owner))),
        Err(zbus::fdo::Error::NameHasNoOwner(_)) => Ok(None),
        Err(failure) => Err(failure.into()),
    }
}

// The program holding the Secret Service, by its process's name and id, or `None` when nothing
// does; a process whose name cannot be read is named by its id.
async fn secret_service_program() -> zbus::Result<Option<String>> {
    let Some((bus, owner)) = secret_service_owner().await? else {
        return Ok(None);
    };
    let process_id = bus
        .get_connection_unix_process_id(BusName::from(owner.into_inner()))
        .await?;
    let name = match read_process_file(process_id, "comm") {
        Ok(Some(name)) => String::from_utf8_lossy(&name).trim().to_owned(),
        Ok(None) => "a process that has ended".to_owned(),
        Err(failure) => format!("a process whose name does not read ({failure})"),
    };
    Ok(Some(format!("{name} (process {process_id})")))
}

// This account's state as logind names it on the system bus.
async fn login_state() -> zbus::Result<String> {
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
