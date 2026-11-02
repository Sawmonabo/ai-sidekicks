//! The `data erase` mode: everything the app keeps on this computer erased with the service
//! stopped. It makes the data folder when it is missing and takes its lock, so it is refused while
//! a service runs, and checks that the keychain can be emptied, refused with nothing changed when
//! it cannot. It then ends what a stopped or crashed service left running, the children the orphan
//! registry names and each provider's recorded services, deletes every credential-store item the
//! app made, and then the data folder but its backups. The mode installs no log, so its answer,
//! one JSON object on its standard output, names every failure.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::data::DaemonDataStoreUnavailableDetails;
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_ipc::domain_error::refusal_fields;
use sidekicks_platforms::{create_private_folder, secret_store_offer};
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_shell::orphan::guard::open_orphan_guard;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::standard_error::write_error_line;
use sidekicks_std::standard_output::write_json_line;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::{KEYCHAIN_CALL_TIMEOUT, SystemCredentialStore};
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::data_folder::lock::{DataFolderLock, DataFolderLockError};

use crate::data_acts::erase::{DataEraseOutcome, erase_data, stop_every_recorded_service};

/// Runs the `data erase` mode. Writes its outcome on standard output and exits 0 once everything
/// is erased; exits 1 with `daemon.dataFolder.held` while the data folder is held,
/// `daemon.data.storeUnavailable` when the keychain cannot be emptied, both with nothing changed,
/// an internal error naming each failure otherwise, or, when the outcome cannot be written, that
/// failure on standard error.
pub(crate) fn run_data_erase_mode() -> ExitCode {
    let outcome = erase_from_home();
    let exit_code = match outcome {
        DaemonModeOutcome::Result(()) => ExitCode::SUCCESS,
        DaemonModeOutcome::Error(_) => ExitCode::FAILURE,
    };
    if let Err(failure) = write_json_line(&outcome) {
        write_error_line(&format!(
            "the erase's outcome could not be written: {}",
            describe_error(&failure)
        ));
        return ExitCode::FAILURE;
    }
    exit_code
}

// The mode's own start: the home folder's data folder, erased on a runtime of the mode's own.
fn erase_from_home() -> DaemonModeOutcome<()> {
    let Some(home) = std::env::home_dir() else {
        return DaemonModeOutcome::failed("the erase found no home folder".to_owned());
    };
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(erase_data_folder(data_folder(&home))),
        Err(failure) => not_started("the erase's runtime did not start", &failure),
    }
}

// Takes `data_folder`, checks the keychain, then runs the erase's steps, answering every failure.
async fn erase_data_folder(data_folder: PathBuf) -> DaemonModeOutcome<()> {
    let locked_folder = data_folder.clone();
    let taken = tokio::task::spawn_blocking(move || {
        create_private_folder(&locked_folder).map_err(|failure| {
            not_started(
                &format!(
                    "the data folder {} could not be made",
                    locked_folder.display()
                ),
                &failure,
            )
        })?;
        DataFolderLock::take(&locked_folder).map_err(|failure| match failure {
            DataFolderLockError::Held(held) => held.mode_refusal(),
            DataFolderLockError::Lock { .. } | DataFolderLockError::RecordProcessId { .. } => {
                not_started("the data folder could not be held", &failure)
            }
        })
    })
    .await
    .unwrap_or_else(|ended| {
        Err(not_started(
            "the data folder's lock was not taken",
            &io::Error::other(ended),
        ))
    });
    let lock = match taken {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };
    let secret_items = match SecretItems::new(SecretItemsStart {
        data_folder: data_folder.clone(),
        // The mode runs from the person's own command line.
        runs_while_logged_out: false,
        access: Arc::new(SystemCredentialStore {
            offer: secret_store_offer(),
        }),
        call_timeout: KEYCHAIN_CALL_TIMEOUT,
    }) {
        Ok(secret_items) => secret_items,
        Err(failure) => return not_started("the secrets could not be reached", &failure),
    };
    if let Err(refusal) = secret_items.check_for_erase().await {
        return store_unavailable(refusal);
    }

    let mut failures = Vec::new();
    let mut not_ended = |failure: &(dyn Error + 'static)| {
        failures.push(format!(
            "a process the erase had to end did not end: {}",
            describe_error(failure)
        ));
    };
    // Opening the guard sweeps and empties the registry a stopped or crashed service left.
    match open_orphan_guard(&data_folder).await {
        Ok(guard) => drop(guard),
        Err(failure) => not_ended(&failure),
    }
    let recorded_stops = PROVIDER_REGISTRATIONS
        .iter()
        .filter_map(|registration| registration.stop_recorded_services);
    for failure in stop_every_recorded_service(recorded_stops, &data_folder).await {
        not_ended(&failure);
    }

    // The lock file sits in the data folder, so it closes before the folder goes.
    let close_data_folder = move || {
        drop(lock);
        async {}.boxed()
    };
    match erase_data(&secret_items, &data_folder, close_data_folder).await {
        DataEraseOutcome::Erased => {}
        DataEraseOutcome::SecretsKept(refusal) => failures.push(format!(
            "the erase kept the data folder, since the keychain refused an item: {}",
            describe_error(&refusal)
        )),
        DataEraseOutcome::FolderNotDeletedWhole(left) => {
            let entries: Vec<String> = left
                .entries
                .iter()
                .map(|entry| describe_error(entry))
                .collect();
            failures.push(format!(
                "the erase deleted the secrets but not all of the data folder: {}",
                entries.join(", ")
            ));
        }
    }
    if failures.is_empty() {
        return DaemonModeOutcome::Result(());
    }
    DaemonModeOutcome::failed(failures.join("; "))
}

// The refusal a keychain that cannot be emptied answers before anything changed: the socket's
// code, with the keychain's cause as its field.
fn store_unavailable(refusal: KeychainRefusal) -> DaemonModeOutcome<()> {
    let message = describe_error(&refusal);
    let (cause, _failure) = refusal.into_cause_and_failure();
    let fields: BTreeMap<String, AnyValue> =
        refusal_fields(DaemonDataStoreUnavailableDetails { cause })
            .into_iter()
            .map(|(name, value)| (name, AnyValue(value)))
            .collect();
    DaemonModeOutcome::refused(RefusalCode::DaemonDataStoreUnavailable, message, fields)
}

// A failure before the erase changed anything, naming the step that failed.
fn not_started(step: &str, failure: &(dyn Error + 'static)) -> DaemonModeOutcome<()> {
    DaemonModeOutcome::failed(format!("{step}: {}", describe_error(failure)))
}
