//! The modes that move the daemon's own secrets between the login keychain and the items file of a
//! Mac's service running while the person is logged out, run from the person's login session.
//!
//! - **`secrets move files|keychain`** holds the data folder's lock, so it is refused while a
//!   service runs. It first moves every registered account's provider sign-in kept in the login
//!   keychain the same way, into its sign-in file going to the files and back into its keychain
//!   item going to the keychain, since that step is the likeliest to be refused and a refusal then
//!   leaves every secret where it was. It then moves every item into the place it names, each
//!   written, read back and then deleted from its source, the place record naming the move until
//!   the last delete. A move stopped partway finishes in the same direction at the next start.
//! - **`secrets check keychain`** takes no lock and changes nothing the service keeps: it writes,
//!   reads back and deletes one value under an account of its own, so it runs while the service
//!   that runs while the person is logged out holds the folder.
//!
//! Each installs no log and answers one JSON object on its standard output.

use std::error::Error;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::daemon::secrets_place::SecretsMoveDestination;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{
    KeychainItemRefusal, KeychainSignIn, SignInMoveError, Spawner, sign_in_move,
};
use sidekicks_provider::account::homes::{AccountHome, query_account_homes};
use sidekicks_provider::driver::{HelperModeServices, PROVIDER_REGISTRATIONS, ProviderDescriptor};
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_std::error_description::describe_error;
use sidekicks_store::credential_store::os::KEYCHAIN_CALL_TIMEOUT;
use sidekicks_store::database::connection::setup::open_database_reader;
use sidekicks_store::database::connection::writer_open::DAEMON_DATABASE_FILE_NAME;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::daemon::login_shell_environment::capture_provider_base_environment;
use crate::data_acts::mode_outcome::{
    ModeFolders, hold_data_folder, keychain_unavailable, login_session_secret_items, not_started,
    run_data_folder_mode, store_unavailable, write_mode_outcome,
};

// The one statement the read of the account homes prepares.
const ACCOUNT_HOMES_STATEMENTS: usize = 1;

/// Runs `secrets move <destination>`. Exits 0 once every provider sign-in and every item is in
/// the place `destination` names; exits 1 with `daemon.dataFolder.held` while the data folder is
/// held, `daemon.data.storeUnavailable` when a place refuses, a provider's sign-ins cannot be
/// moved or the secrets sit outside the pair, an internal error for a word no destination has, or,
/// when the outcome cannot be written, that failure on standard error.
pub(crate) fn run_secrets_move_mode(destination: &str) -> ExitCode {
    let Some(destination) = SecretsMoveDestination::from_word(destination) else {
        return write_mode_outcome(
            "move",
            &DaemonModeOutcome::failed(format!("the secrets have no place named {destination}")),
        );
    };
    run_data_folder_mode("move", move |folders| move_secrets(folders, destination))
}

/// Runs `secrets check keychain`, holding no lock. Exits 0 once the login keychain took, gave back
/// and deleted a value; exits 1 with `daemon.data.storeUnavailable` when it refused or kept another
/// value, or, when the outcome cannot be written, that failure on standard error.
pub(crate) fn run_keychain_check_mode() -> ExitCode {
    run_data_folder_mode("check", |folders| async move {
        let secret_items = match login_session_secret_items(folders.data_folder) {
            Ok(secret_items) => secret_items,
            Err(outcome) => return outcome,
        };
        match secret_items
            .check_destination(SecretsMoveDestination::OperatingSystem)
            .await
        {
            Ok(()) => DaemonModeOutcome::Result(()),
            Err(refusal) => store_unavailable(refusal),
        }
    })
}

// Holds the data folder, moves the provider sign-ins and then the secrets into `destination` under
// that hold.
async fn move_secrets(
    folders: ModeFolders,
    destination: SecretsMoveDestination,
) -> DaemonModeOutcome<()> {
    let _lock = match hold_data_folder(&folders.data_folder).await {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };
    if let Err(outcome) = move_sign_ins(&folders, destination).await {
        return outcome;
    }
    let secret_items = match login_session_secret_items(folders.data_folder) {
        Ok(secret_items) => secret_items,
        Err(outcome) => return outcome,
    };
    match secret_items.move_to(destination).await {
        Ok(()) => DaemonModeOutcome::Result(()),
        Err(refusal) => store_unavailable(refusal),
    }
}

// Moves each registered account's provider sign-in that sits in the login keychain into its file,
// or back into its item, one provider after another, each step held to the keychain's call bound.
// Moves nothing on a system with no such move or with no account.
async fn move_sign_ins(
    folders: &ModeFolders,
    destination: SecretsMoveDestination,
) -> Result<(), DaemonModeOutcome<()>> {
    let Some(sign_in_move) = sign_in_move() else {
        return Ok(());
    };
    let homes = read_account_homes(&folders.data_folder).await?;
    if homes.is_empty() {
        return Ok(());
    }
    let spawner = Spawner::new(Handle::current())
        .map_err(|failure| not_started("the sign-ins' spawner did not start", &failure))?;
    let services = helper_mode_services(&spawner, folders).await?;
    for registration in PROVIDER_REGISTRATIONS {
        let legs = (registration.helper_mode_account_legs)(&services);
        let mut sign_ins: Vec<KeychainSignIn> = Vec::new();
        for home in homes
            .iter()
            .filter(|home| home.provider == registration.descriptor.id)
        {
            let account_folders = home
                .folders()
                .map_err(|failure| not_started("an account's folders are not known", &failure))?;
            let sign_in = legs.keychain_sign_in(&account_folders).map_err(|failure| {
                not_started("an account's sign-in could not be named", &failure)
            })?;
            sign_ins.extend(sign_in);
        }
        if sign_ins.is_empty() {
            continue;
        }
        let moved = match destination {
            SecretsMoveDestination::LoggedOutServiceFile => {
                sign_in_move
                    .move_into_files(&spawner, &sign_ins, KEYCHAIN_CALL_TIMEOUT)
                    .await
            }
            SecretsMoveDestination::OperatingSystem => {
                sign_in_move
                    .move_into_keychain(&spawner, &sign_ins, KEYCHAIN_CALL_TIMEOUT)
                    .await
            }
        };
        moved.map_err(|refusal| sign_ins_refused(registration.descriptor, &refusal))?;
    }
    Ok(())
}

// Every account home the accounts table lists, read on a connection of the mode's own; none when
// the daemon never made its database.
async fn read_account_homes(data_folder: &Path) -> Result<Vec<AccountHome>, DaemonModeOutcome<()>> {
    let database_path = data_folder.join(DAEMON_DATABASE_FILE_NAME);
    let read = tokio::task::spawn_blocking(
        move || -> Result<Vec<AccountHome>, Box<dyn Error + Send + Sync>> {
            if !database_path.try_exists()? {
                return Ok(Vec::new());
            }
            let connection = open_database_reader(&database_path, ACCOUNT_HOMES_STATEMENTS)?;
            Ok(query_account_homes(&connection)?)
        },
    )
    .await;
    match read {
        Ok(Ok(homes)) => Ok(homes),
        Ok(Err(failure)) => Err(not_started(
            "the provider accounts could not be read",
            failure.as_ref(),
        )),
        Err(ended) => Err(not_started("the provider accounts were not read", &ended)),
    }
}

// What the providers' helper-mode legs read: the data folder, the base environment every provider
// process starts from, captured from the login shell as a start captures it, and the names every
// provider sets, so each sign-in is named as a session's process on that home names it.
async fn helper_mode_services(
    spawner: &Spawner,
    folders: &ModeFolders,
) -> Result<HelperModeServices, DaemonModeOutcome<()>> {
    let base_environment =
        capture_provider_base_environment(spawner, &folders.home_folder, &CancellationToken::new())
            .await
            .map_err(|failure| {
                not_started("the providers' environment could not be read", &failure)
            })?;
    let descriptors: Vec<&'static ProviderDescriptor> = PROVIDER_REGISTRATIONS
        .iter()
        .map(|registration| registration.descriptor)
        .collect();
    Ok(HelperModeServices {
        data_folder: folders.data_folder.clone(),
        base_environment: Arc::from(base_environment),
        reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(&descriptors)),
    })
}

// `daemon.data.storeUnavailable` naming the provider whose sign-ins did not move and why; the
// cause is `locked` only for a locked keychain.
fn sign_ins_refused(
    provider: &ProviderDescriptor,
    refusal: &SignInMoveError,
) -> DaemonModeOutcome<()> {
    let cause = match refusal {
        SignInMoveError::Keychain {
            refusal: KeychainItemRefusal::Locked,
            ..
        } => KeychainRefusalCause::Locked,
        SignInMoveError::Keychain { .. }
        | SignInMoveError::File(_)
        | SignInMoveError::Write(_)
        | SignInMoveError::CopyDiffers { .. }
        | SignInMoveError::Overran => KeychainRefusalCause::Unavailable,
    };
    keychain_unavailable(
        cause,
        format!(
            "the {} sign-ins could not be moved: {}",
            provider.name(),
            describe_error(refusal)
        ),
    )
}
