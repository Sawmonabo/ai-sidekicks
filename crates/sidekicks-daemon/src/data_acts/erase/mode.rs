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
use sidekicks_shell::orphan::guard::sweep_left_orphans;
use sidekicks_shell::orphan::sweep::OrphanSweepResult;
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
    let not_ended = |failure: &(dyn Error + 'static)| {
        format!(
            "a process the erase had to end did not end: {}",
            describe_error(failure)
        )
    };
    // The sweep empties the registry a stopped or crashed service left.
    match sweep_left_orphans(&data_folder).await {
        Ok(sweep) => failures.extend(describe_sweep_failures(sweep)),
        Err(failure) => failures.push(not_ended(&failure)),
    }
    let recorded_stops = PROVIDER_REGISTRATIONS
        .iter()
        .filter_map(|registration| registration.stop_recorded_services);
    for failure in stop_every_recorded_service(recorded_stops, &data_folder).await {
        failures.push(not_ended(&failure));
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

// What the sweep of the orphan registry could not do, each as one of the erase's failures: the
// registry it discarded unread, and each process it could not read or kill.
fn describe_sweep_failures(sweep: OrphanSweepResult) -> impl Iterator<Item = String> {
    let unread = sweep.unreadable_cause.map(|cause| {
        format!(
            "the children a stopped service left were not ended: their registry was discarded \
             unread because {cause}"
        )
    });
    let skipped = sweep.skipped.into_iter().map(|process| {
        format!(
            "a process the erase had to end did not end: {}",
            describe_error(&process)
        )
    });
    unread.into_iter().chain(skipped)
}

#[cfg(test)]
mod tests {
    use std::io;

    use sidekicks_platforms::UnendedProcess;
    use sidekicks_shell::orphan::sweep::OrphanSweepResult;

    use super::describe_sweep_failures;

    // Fails when the erase drops the orphan registry's unread cause or a process the sweep could
    // not end, so it answers success while a crashed run's child may still run.
    #[test]
    fn the_erase_answers_an_unread_registry_and_each_skipped_process() {
        let sweep = OrphanSweepResult {
            unreadable_cause: Some("its contents are invalid".to_owned()),
            skipped: vec![UnendedProcess {
                process_id: 4242,
                error: io::Error::from(io::ErrorKind::PermissionDenied),
            }],
            ..OrphanSweepResult::default()
        };

        let failures: Vec<String> = describe_sweep_failures(sweep).collect();

        assert_eq!(failures.len(), 2, "{failures:?}");
        assert!(
            failures[0].ends_with("its contents are invalid"),
            "{failures:?}"
        );
        assert!(failures[1].contains("4242"), "{failures:?}");
    }
}
