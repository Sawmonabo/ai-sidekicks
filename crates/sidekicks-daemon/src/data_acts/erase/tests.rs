use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::CredentialStore;
use sidekicks_provider::account::credential_home::HomeSignOutError;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::credential_store::service::KeychainService;
use tokio::sync::{Notify, watch};

use super::{DataErase, DataEraseDeps, DataEraseRefusal};

type CallLog = Arc<Mutex<Vec<String>>>;

fn record(calls: &CallLog, call: String) {
    lock(calls).push(call);
}

fn write_file(path: &Path) {
    fs::create_dir_all(path.parent().expect("the file has a folder")).expect("folder made");
    fs::write(path, "kept").expect("the file is written");
}

// The erase runs in its order: the work stops while the data folder is whole, the provider
// accounts sign out in their homes while the folder and the keychain are whole, each provider's
// services end, the keychain's items go before the data folder closes, and the process ends
// last; the data folder goes but for an earlier backup, and a project folder is untouched. An
// account that does not sign out stops nothing. A second erase sent while it stops the work is
// refused and starts nothing. Killed by a delete before the stop, by the sign-out not handed to
// the work stop or run after the services end or the folder goes, by an erase that stops on an
// account left signed in, by items deleted after the folder, by a provider service ended as for a
// restart, by a project folder or a backup deleted, by a second erase let run beside the first,
// and by a second erase answered as the first.
#[tokio::test]
async fn an_erase_runs_in_order_and_keeps_backups_and_project_folders() {
    let data_folder = tempfile::tempdir().expect("the data folder is made");
    let data = data_folder.path().join(".ai-sidekicks");
    let project = tempfile::tempdir().expect("the project folder is made");
    for kept in [
        "daemon.db",
        "logs/service.log",
        "accounts/account-1/settings.json",
    ] {
        write_file(&data.join(kept));
    }
    let backup = data
        .join("backups")
        .join("2026-10-20")
        .join("manifest.json");
    write_file(&backup);
    let project_file = project.path().join("src").join("main.rs");
    write_file(&project_file);
    let credentials = CredentialStore::in_memory();
    let secret_service = KeychainService::WorkflowSecrets.as_str();
    credentials
        .write(secret_service, "deploy", &SecretString::from("planted"))
        .expect("an item is stored");
    let secret_items = SecretItems::new(SecretItemsStart {
        data_folder: data.clone(),
        runs_while_logged_out: false,
        access: TestStoreAccess::new(credentials.clone()) as _,
        call_timeout: Duration::from_secs(5),
    })
    .expect("the system gives random bytes");

    let calls: CallLog = Arc::default();
    let mut driver = MockProviderDriver::new();
    let shutdown_calls = Arc::clone(&calls);
    driver.expect_shutdown().times(1).returning(move |intent| {
        record(
            &shutdown_calls,
            format!("provider services end ({intent:?})"),
        );
        async { Ok(()) }.boxed()
    });
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    let ended = Arc::new(Notify::new());
    let (stop_calls, sign_out_calls, close_calls, end_calls) = (
        Arc::clone(&calls),
        Arc::clone(&calls),
        Arc::clone(&calls),
        Arc::clone(&calls),
    );
    let (stop_data, sign_out_data, end_signal) = (data.clone(), data.clone(), Arc::clone(&ended));
    let sign_out_credentials = credentials.clone();
    // The work stops only once the gate opens, so a second erase arrives while the first runs.
    let (gate, gate_open) = watch::channel(false);
    let erase = Arc::new(DataErase::new(DataEraseDeps {
        data_folder: data.clone(),
        secret_items,
        providers,
        // The step given runs where the stop runs it, before the drivers' services end.
        stop_work: Arc::new(move |before_drivers_end| {
            let whole = stop_data.join("daemon.db").exists();
            record(&stop_calls, format!("work stops (folder whole: {whole})"));
            let mut gate_open = gate_open.clone();
            async move {
                gate_open
                    .wait_for(|is_open| *is_open)
                    .await
                    .expect("the gate stays while the test runs");
                before_drivers_end().await;
            }
            .boxed()
        }),
        sign_out_accounts: Arc::new(move || {
            let whole = sign_out_data.join("accounts").exists();
            let held = sign_out_credentials
                .read(secret_service, "deploy")
                .expect("the store reads")
                .is_some();
            record(
                &sign_out_calls,
                format!("accounts sign out (folder whole: {whole}, item held: {held})"),
            );
            let unsigned =
                ProviderAccountId::new("account-1".to_owned()).expect("a test account id");
            async move { Ok(vec![(unsigned, HomeSignOutError::Overran)]) }.boxed()
        }),
        close_data_folder: Arc::new(move || {
            let held = credentials
                .read(secret_service, "deploy")
                .expect("the store reads")
                .is_some();
            record(&close_calls, format!("folder closes (item held: {held})"));
            async {}.boxed()
        }),
        end_process: Arc::new(move || {
            record(&end_calls, "process ends".to_owned());
            end_signal.notify_one();
        }),
    }));

    erase.begin().await.expect("the keychain can be emptied");
    tokio::task::yield_now().await;
    assert!(matches!(
        erase.begin().await,
        Err(DataEraseRefusal::Running)
    ));
    gate.send_replace(true);
    tokio::time::timeout(Duration::from_secs(10), ended.notified())
        .await
        .expect("the erase ends the process");

    assert_eq!(
        *lock(&calls),
        [
            "work stops (folder whole: true)".to_owned(),
            "accounts sign out (folder whole: true, item held: true)".to_owned(),
            format!("provider services end ({:?})", DaemonStopIntent::Stop),
            "folder closes (item held: false)".to_owned(),
            "process ends".to_owned(),
        ]
    );
    let left: Vec<_> = fs::read_dir(&data)
        .expect("the backups keep the folder")
        .map(|entry| entry.expect("an entry lists").file_name())
        .collect();
    assert_eq!(left, ["backups"]);
    assert!(backup.is_file(), "an earlier backup keeps its copy");
    assert!(project_file.is_file(), "a project folder is untouched");
}
