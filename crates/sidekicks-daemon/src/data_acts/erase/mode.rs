//! The `data erase` mode: everything the app keeps on this computer erased with the service
//! stopped. It makes the data folder when it is missing and takes its lock, so it is refused while
//! a service runs, and checks that the keychain can be emptied, refused with nothing changed when
//! it cannot. It then ends what a stopped or crashed service left running, the children the orphan
//! registry names and each provider's recorded services, deletes every credential-store item the
//! app made, and then the data folder but its backups. The mode installs no log, so its answer,
//! one JSON object on its standard output, names every failure.

use std::error::Error;
use std::path::PathBuf;
use std::process::ExitCode;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_shell::orphan::guard::open_orphan_guard;
use sidekicks_std::error_description::describe_error;

use crate::data_acts::erase::{DataEraseOutcome, erase_data, stop_every_recorded_service};
use crate::data_acts::mode_outcome::{
    hold_data_folder, login_session_secret_items, run_data_folder_mode, store_unavailable,
};

/// Runs the `data erase` mode. Writes its outcome on standard output and exits 0 once everything
/// is erased; exits 1 with `daemon.dataFolder.held` while the data folder is held,
/// `daemon.data.storeUnavailable` when the keychain cannot be emptied, both with nothing changed,
/// an internal error naming each failure otherwise, or, when the outcome cannot be written, that
/// failure on standard error.
pub(crate) fn run_data_erase_mode() -> ExitCode {
    run_data_folder_mode("erase", erase_data_folder)
}

// Takes `data_folder`, checks the keychain, then runs the erase's steps, answering every failure.
async fn erase_data_folder(data_folder: PathBuf) -> DaemonModeOutcome<()> {
    let lock = match hold_data_folder(&data_folder).await {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };
    let secret_items = match login_session_secret_items(data_folder.clone()) {
        Ok(secret_items) => secret_items,
        Err(outcome) => return outcome,
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
