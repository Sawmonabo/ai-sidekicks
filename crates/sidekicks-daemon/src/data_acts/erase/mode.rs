//! The `data erase` mode: everything the app keeps on this computer erased with the service
//! stopped. It makes the data folder when it is missing and takes its lock, so it is refused while
//! a service runs, and checks that the keychain can be emptied, refused with nothing changed when
//! it cannot. It then signs every account home it deletes out through the provider's own
//! sign-out, as the running erase does, so no erase leaves an account signed in at its provider;
//! an account that does not sign out is named with why, and the erase goes on. It then ends what
//! a stopped or crashed service left running, the children the orphan registry names and each
//! provider's recorded services, removes every session's own folder on another volume, naming
//! each it leaves, deletes every credential-store item the app made, and then the data folder but
//! its backups. The mode installs no log, so its answer, one JSON object on its standard output,
//! names every failure.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::data::DataEraseAccountListing;
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_provider::account::credential_home::{ACCOUNT_SIGN_OUT_BOUND, sign_out_homes};
use sidekicks_provider::driver::contract::account::HelperModeAccountLegs;
use sidekicks_provider::driver::{HelperModeServices, PROVIDER_REGISTRATIONS, descriptor_of};
use sidekicks_shell::orphan::guard::sweep_left_orphans;
use sidekicks_shell::orphan::sweep::OrphanSweepResult;
use sidekicks_std::error_description::describe_error;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::data_folder::lock::DataFolderLock;

use crate::data_acts::erase::{
    DataEraseOutcome, erase_data, remove_every_volume_folder, stop_every_recorded_service,
};
use crate::data_acts::mode_outcome::{
    ModeFolders, hold_data_folder, login_session_secret_items, run_data_folder_mode,
    store_unavailable,
};
use crate::data_acts::provider_accounts::{
    ModeAccountsError, helper_mode_services, read_homes_to_erase,
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
// only when an account is registered, then ends what a stopped service left, removes the sessions'
// folders on other volumes and erases, answering every failure and every folder left.
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
    // No row names a session's folder on another volume once the data folder is gone.
    match remove_every_volume_folder(data_folder).await {
        Ok(left) => failures.extend(left.into_iter().map(|left| match left.removal_failure {
            None => format!(
                "a session's folder on a volume that is not connected was left: {}",
                left.folder.as_str()
            ),
            Some(failure) => format!(
                "a session's folder on another volume was left: {}: {}",
                left.folder.as_str(),
                describe_error(&failure)
            ),
        })),
        Err(failure) => failures.push(format!(
            "the sessions' folders on other volumes were not removed: {}",
            describe_error(&failure)
        )),
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

// Signs every account home an erase of `data_folder` deletes out through its provider's helper-mode
// legs over the bundle `account_services` gives, all at once and each within its bound, and
// answers each account left signed in, naming its provider, how it stood on the list and why, or
// why the homes could not be reached at all. A row that names no valid account or provider id is
// named left signed in, and the rest sign out. Starts nothing when there is no home to sign out.
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
    let homes = match read_homes_to_erase(data_folder).await {
        Ok(homes) if homes.is_empty() => return Vec::new(),
        Ok(homes) => homes,
        Err(failure) => return unreached(&failure),
    };
    let services = match account_services.await {
        Ok(services) => services,
        Err(failure) => return unreached(&failure),
    };
    let legs: HashMap<&str, Arc<dyn HelperModeAccountLegs>> = PROVIDER_REGISTRATIONS
        .iter()
        .map(|registration| {
            (
                registration.descriptor.id,
                (registration.helper_mode_account_legs)(&services),
            )
        })
        .collect();
    let mut failures = Vec::new();
    let mut accounts = Vec::new();
    for home in homes {
        let (provider, account_id, listing) = (
            home.home.provider.clone(),
            home.home.account_id.clone(),
            home.listing,
        );
        match home.sign_out() {
            Ok(account) => accounts.push(account),
            Err(unnamed) => failures.push(left_signed_in(
                provider_name(&provider),
                &account_id,
                listing,
                &unnamed,
            )),
        }
    }
    let sign_out = |provider: &ProviderId, account_id, folders| {
        legs.get(provider.as_str())
            .map(|legs| legs.sign_out_home(account_id, folders))
    };
    for left in sign_out_homes(accounts, sign_out, ACCOUNT_SIGN_OUT_BOUND).await {
        failures.push(left_signed_in(
            provider_name(left.provider.as_str()),
            left.account_id.as_str(),
            left.listing,
            &left.cause,
        ));
    }
    failures
}

// The name a person reads for the provider `provider` names, the id itself where no driver
// answers to it.
fn provider_name(provider: &str) -> &str {
    descriptor_of(provider).map_or(provider, |descriptor| descriptor.name())
}

// The line naming `provider`'s account `account_id`, which stood on the list as `listing`, as left
// signed in, and why.
fn left_signed_in(
    provider: &str,
    account_id: &str,
    listing: DataEraseAccountListing,
    cause: &(dyn Error + 'static),
) -> String {
    let account = match listing {
        DataEraseAccountListing::Listed => format!("the {provider} account {account_id}"),
        DataEraseAccountListing::Removed => {
            format!("the {provider} account {account_id}, removed from the list,")
        }
        DataEraseAccountListing::SignInUnfinished => {
            format!("the {provider} account {account_id} from a sign-in that did not finish")
        }
    };
    format!("{account} was left signed in: {}", describe_error(cause))
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
    use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_platforms::{CredentialStore, Spawner, UnendedProcess};
    use sidekicks_provider::account::credential_home::marks::{mark_minted, mark_removed};
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

    // With two Claude Code accounts registered, a third removed from the list with its home kept
    // and a fourth minted by a sign-in that did not finish, the erase runs `claude auth logout`,
    // after the settings document, in each home while it still holds its files, and only then
    // deletes the data folder with the homes in it; the second's, third's and fourth's sign-outs
    // exit 1, so the erase deletes every home and fails naming each as left signed in, the third
    // as removed from the list and the fourth as from a sign-in that did not finish. Killed by the
    // sign-out skipped, by the sign-out run after the delete, by an early return on a failed
    // sign-out, by only the rows read, and by the removed or the unfinished account's line written
    // as a listed one.
    #[tokio::test]
    async fn the_offline_erase_signs_every_account_out_before_it_deletes() {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let data = root.path().join("data");
        let homes = ["account-1", "account-2", "account-3", "account-4"]
            .map(|account| data.join("accounts").join(account));
        tokio::fs::create_dir_all(&data)
            .await
            .expect("the data folder is made");
        let connection = open_database(
            &data.join(DAEMON_DATABASE_FILE_NAME),
            &schema_parts().into_schema(),
        )
        .expect("the store opens");
        let now = WireInstant::now();
        for home in &homes {
            tokio::fs::create_dir_all(home)
                .await
                .expect("the account's home is made");
            tokio::fs::write(home.join("settings.json"), "kept")
                .await
                .expect("the home holds a file");
        }
        let claude = ProviderId::new("claude".to_owned()).expect("the Claude Code provider id");
        let marked = ["account-3", "account-4"]
            .map(|account| ProviderAccountId::new(account.to_owned()).expect("a test account id"));
        mark_removed(&data, &marked[0], &claude).expect("the removed account is marked");
        mark_minted(&data, &marked[1], &claude).expect("the unfinished sign-in is marked");
        for (home, is_default) in homes.iter().zip([1, 0]) {
            connection
                .execute(
                    "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
                       billing_mode, is_default, created_at, updated_at)
                     VALUES (?1, 'claude', ?2, 'unknown', ?3, ?4, ?4)",
                    params![
                        home.file_name()
                            .expect("the home has a name")
                            .to_str()
                            .expect("the home's name is text"),
                        home.to_str().expect("the home's path is text"),
                        is_default,
                        now.as_str()
                    ],
                )
                .expect("the account is stored");
        }
        drop(connection);
        let programs = root.path().join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        // The stand-in records the settings flag and the subcommand after its document, one short
        // line a run, so the concurrent sign-outs' appends never interleave.
        let record = root.path().join("sign-outs");
        write_file_atomically(
            &programs.join("claude"),
            format!(
                "#!/bin/sh\nif [ -e \"$CLAUDE_CONFIG_DIR/settings.json\" ]; then held=whole; \
                 else held=gone; fi\nflag=$1; shift 2\nprintf '%s|%s %s|%s\\n' \
                 \"$CLAUDE_CONFIG_DIR\" \"$flag\" \"$*\" \"$held\" >> '{}'\n\
                 case \"$CLAUDE_CONFIG_DIR\" in */account-2|*/account-3|*/account-4) exit 1;; \
                 esac\n",
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

        let outcome =
            erase_held_data_folder(&data, lock, &secret_items, async { Ok(services) }).await;

        let recorded = tokio::fs::read_to_string(&record)
            .await
            .expect("the accounts' sign-outs ran");
        let mut recorded: Vec<&str> = recorded.lines().collect();
        recorded.sort_unstable();
        let expected: Vec<String> = homes
            .iter()
            .map(|home| format!("{}|--settings auth logout|whole", home.display()))
            .collect();
        assert_eq!(recorded, expected);
        for home in &homes {
            assert!(!home.exists(), "the erase left an account's home");
        }
        let DaemonModeOutcome::Error(failure) = outcome else {
            panic!("an erase that left an account signed in answered success");
        };
        for left in [
            "the Claude Code account account-2 was left signed in",
            "the Claude Code account account-3, removed from the list, was left signed in",
            "the Claude Code account account-4 from a sign-in that did not finish was left \
             signed in",
        ] {
            assert!(failure.message.contains(left), "{}", failure.message);
        }
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
