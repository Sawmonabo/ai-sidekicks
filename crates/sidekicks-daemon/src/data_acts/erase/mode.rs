//! The `data erase` mode: everything the app keeps on this computer erased with the service
//! stopped. It makes the data folder when it is missing and takes its lock, so it is refused while
//! a service runs, and checks that the keychain can be emptied, refused with nothing changed when
//! it cannot. It then signs every registered provider account out in its home through the
//! provider's own sign-out, as the running erase does, so no erase leaves an account signed in at
//! its provider; an account that does not sign out is named with why, and the erase goes on. It
//! then ends what a stopped or crashed service left running, the children the orphan registry
//! names and each provider's recorded services, deletes every credential-store item the app made,
//! and then the data folder but its backups. The mode installs no log, so its answer, one JSON
//! object on its standard output, names every failure.

use std::error::Error;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_provider::account::credential_home::HomeSignOutError;
use sidekicks_provider::account::homes::AccountHome;
use sidekicks_provider::driver::contract::account::HelperModeAccountLegs;
use sidekicks_provider::driver::{HelperModeServices, PROVIDER_REGISTRATIONS, ProviderDescriptor};
use sidekicks_shell::orphan::guard::sweep_left_orphans;
use sidekicks_shell::orphan::sweep::OrphanSweepResult;
use sidekicks_std::error_description::describe_error;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::data_folder::lock::DataFolderLock;

use crate::data_acts::erase::{
    ACCOUNT_SIGN_OUT_BOUND, DataEraseOutcome, erase_data, stop_every_recorded_service,
};
use crate::data_acts::mode_outcome::{
    ModeFolders, hold_data_folder, login_session_secret_items, run_data_folder_mode,
    store_unavailable,
};
use crate::data_acts::provider_accounts::{
    ModeAccountsError, helper_mode_services, read_account_homes,
};

/// Runs the `data erase` mode. Writes its outcome on standard output and exits 0 once every account
/// signed out and everything is erased; exits 1 with `daemon.dataFolder.held` while the data folder
/// is held, `daemon.data.storeUnavailable` when the keychain cannot be emptied, both with nothing
/// changed, an internal error naming each failure otherwise, an account left signed in among them,
/// or, when the outcome cannot be written, that failure on standard error.
pub(crate) fn run_data_erase_mode() -> ExitCode {
    run_data_folder_mode("erase", erase_data_folder)
}

// Takes the data folder and reaches the login session's secrets, then runs the erase's steps,
// the providers' legs reading the bundle captured from the login shell.
async fn erase_data_folder(folders: ModeFolders) -> DaemonModeOutcome<()> {
    let lock = match hold_data_folder(&folders.data_folder).await {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };
    let secret_items = match login_session_secret_items(folders.data_folder.clone()) {
        Ok(secret_items) => secret_items,
        Err(outcome) => return outcome,
    };
    erase_held_data_folder(
        &folders.data_folder,
        lock,
        &secret_items,
        helper_mode_services(&folders),
    )
    .await
}

// Checks the keychain, signs every account out with the bundle `account_services` gives, awaited
// only when an account is registered, then ends what a stopped service left and erases, answering
// every failure.
async fn erase_held_data_folder(
    data_folder: &Path,
    lock: DataFolderLock,
    secret_items: &SecretItems,
    account_services: impl Future<Output = Result<HelperModeServices, ModeAccountsError>>,
) -> DaemonModeOutcome<()> {
    if let Err(refusal) = secret_items.check_for_erase().await {
        return store_unavailable(refusal);
    }

    let mut failures = sign_out_account_homes(data_folder, account_services).await;
    let not_ended = |failure: &(dyn Error + 'static)| {
        format!(
            "a process the erase had to end did not end: {}",
            describe_error(failure)
        )
    };
    // The sweep empties the registry a stopped or crashed service left.
    match sweep_left_orphans(data_folder).await {
        Ok(sweep) => failures.extend(describe_sweep_failures(sweep)),
        Err(failure) => failures.push(not_ended(&failure)),
    }
    let recorded_stops = PROVIDER_REGISTRATIONS
        .iter()
        .filter_map(|registration| registration.stop_recorded_services);
    for failure in stop_every_recorded_service(recorded_stops, data_folder).await {
        failures.push(not_ended(&failure));
    }

    // The lock file sits in the data folder, so it closes before the folder goes.
    let close_data_folder = move || {
        drop(lock);
        async {}.boxed()
    };
    match erase_data(secret_items, data_folder, close_data_folder).await {
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

// One registered provider and its helper-mode account legs.
type ProviderLegs = (&'static ProviderDescriptor, Arc<dyn HelperModeAccountLegs>);

// Signs every account the accounts table in `data_folder` lists out in its home through its
// provider's helper-mode legs over the bundle `account_services` gives, all at once and each
// within its bound, and answers each account left signed in, naming its provider and why, or why
// the accounts could not be reached. Starts nothing when no account is registered.
async fn sign_out_account_homes(
    data_folder: &Path,
    account_services: impl Future<Output = Result<HelperModeServices, ModeAccountsError>>,
) -> Vec<String> {
    let unreached = |failure: &ModeAccountsError| {
        vec![format!(
            "the provider accounts were not signed out: {}",
            describe_error(failure)
        )]
    };
    let homes = match read_account_homes(data_folder).await {
        Ok(homes) if homes.is_empty() => return Vec::new(),
        Ok(homes) => homes,
        Err(failure) => return unreached(&failure),
    };
    let services = match account_services.await {
        Ok(services) => services,
        Err(failure) => return unreached(&failure),
    };
    let legs: Vec<ProviderLegs> = PROVIDER_REGISTRATIONS
        .iter()
        .map(|registration| {
            (
                registration.descriptor,
                (registration.helper_mode_account_legs)(&services),
            )
        })
        .collect();
    let sign_outs = homes.iter().map(|home| sign_out_account_home(&legs, home));
    futures::future::join_all(sign_outs)
        .await
        .into_iter()
        .flatten()
        .collect()
}

// Signs `home`'s account out through the legs of its provider among `legs`, within its bound, and
// answers why it was left signed in, naming its provider, or `None` once it signed out.
async fn sign_out_account_home(legs: &[ProviderLegs], home: &AccountHome) -> Option<String> {
    let left_signed_in = |provider: &str, cause: &(dyn Error + 'static)| {
        format!(
            "the {provider} account {} was left signed in: {}",
            home.account_id,
            describe_error(cause)
        )
    };
    let provider_legs = legs
        .iter()
        .find(|(descriptor, _)| descriptor.id == home.provider);
    let (Some((descriptor, legs)), Ok(folders)) = (provider_legs, home.folders()) else {
        return Some(left_signed_in(
            &home.provider,
            &HomeSignOutError::NoProvider,
        ));
    };
    let provider = descriptor.name();
    let Some(account_id) = ProviderAccountId::new(home.account_id.clone()) else {
        return Some(format!(
            "the {provider} account stored as {} was left signed in: its id is no account id",
            home.account_id
        ));
    };
    let signed_out = tokio::time::timeout(
        ACCOUNT_SIGN_OUT_BOUND,
        legs.sign_out_home(account_id, folders),
    )
    .await;
    let cause = match signed_out {
        Ok(Ok(())) => return None,
        Ok(Err(failure)) => HomeSignOutError::SignOut(failure),
        Err(_elapsed) => HomeSignOutError::Overran,
    };
    Some(left_signed_in(provider, &cause))
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
    use std::sync::Arc;
    use std::time::Duration;

    use rusqlite::params;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_platforms::{CredentialStore, Spawner, UnendedProcess};
    use sidekicks_provider::command_search::ProviderCommandSearch;
    use sidekicks_provider::driver::{HelperModeServices, PROVIDERS};
    use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
    use sidekicks_shell::orphan::sweep::OrphanSweepResult;
    use sidekicks_std::file::atomic_write::write_file_atomically;
    use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
    use sidekicks_store::credential_store::os::TestStoreAccess;
    use sidekicks_store::database::connection::writer_open::{
        DAEMON_DATABASE_FILE_NAME, open_database,
    };
    use tokio::runtime::Handle;

    use super::{describe_sweep_failures, erase_held_data_folder};
    use crate::daemon::schema::schema_parts;
    use crate::data_acts::mode_outcome::hold_data_folder;

    // With a Claude Code account registered, the erase runs `claude auth logout` in the account's
    // home while that home still holds its files, and only then deletes the data folder with the
    // home in it. Killed by the sign-out skipped, and by the sign-out run after the delete.
    #[tokio::test]
    async fn the_offline_erase_signs_every_account_out_before_it_deletes() {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let data = root.path().join("data");
        let home = data.join("accounts").join("account-1");
        tokio::fs::create_dir_all(&home)
            .await
            .expect("the account's home is made");
        tokio::fs::write(home.join("settings.json"), "kept")
            .await
            .expect("the home holds a file");
        let connection = open_database(
            &data.join(DAEMON_DATABASE_FILE_NAME),
            &schema_parts().into_schema(),
        )
        .expect("the store opens");
        let now = WireInstant::now();
        connection
            .execute(
                "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
                   billing_mode, is_default, created_at, updated_at)
                 VALUES ('account-1', 'claude', ?1, 'unknown', 1, ?2, ?2)",
                params![
                    home.to_str().expect("the home's path is text"),
                    now.as_str()
                ],
            )
            .expect("the account is stored");
        drop(connection);
        let programs = root.path().join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        let record = root.path().join("sign-outs");
        write_file_atomically(
            &programs.join("claude"),
            format!(
                "#!/bin/sh\nif [ -e \"$CLAUDE_CONFIG_DIR/settings.json\" ]; then held=whole; \
                 else held=gone; fi\nprintf '%s|%s|%s\\n' \"$CLAUDE_CONFIG_DIR\" \"$*\" \
                 \"$held\" >> '{}'\n",
                record.display()
            ),
            0o755,
        )
        .await
        .expect("the stand-in is written");
        let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
        let services = HelperModeServices {
            command_search: Arc::new(ProviderCommandSearch::new(spawner.clone())),
            spawner,
            data_folder: data.clone(),
            home_folder: root.path().join("home"),
            base_environment: Arc::from([(
                "PATH".to_owned(),
                format!("{}:/usr/bin:/bin", programs.display()),
            )]),
            reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(PROVIDERS)),
        };
        let lock = hold_data_folder(&data)
            .await
            .expect("the data folder is held");
        let secret_items = SecretItems::new(SecretItemsStart {
            data_folder: data.clone(),
            runs_while_logged_out: false,
            access: TestStoreAccess::new(CredentialStore::in_memory()) as _,
            call_timeout: Duration::from_secs(5),
        })
        .expect("the system gives random bytes");

        erase_held_data_folder(&data, lock, &secret_items, async { Ok(services) }).await;

        let recorded = tokio::fs::read_to_string(&record)
            .await
            .expect("the account's sign-out ran");
        assert_eq!(recorded, format!("{}|auth logout|whole\n", home.display()));
        assert!(!home.exists(), "the erase left the account's home");
    }

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
