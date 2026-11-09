use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::daemon::data::{
    DaemonDataEraseResponse, DataEraseAccountListing, DataEraseSignOutFailure,
    DataEraseSignedInAccount,
};
use sidekicks_contracts::daemon::secrets_place::{PlaceRecord, SecretsPlace};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::CredentialStore;
use sidekicks_provider::account::credential_home::{
    HomeLeftSignedIn, HomeSignOutError, HomesSignOut,
};
use sidekicks_provider::account::homes::AccountHomesReadError;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart, os_service_name};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::credential_store::place::{record_path, write_record};
use sidekicks_store::credential_store::service::KeychainService;
use tokio::sync::{Notify, watch};

use super::{
    DataErase, DataEraseDeps, DataEraseFailure, DataEraseOutcome, DataEraseRefusal, erase_data,
};

type CallLog = Arc<Mutex<Vec<String>>>;

// What the accounts' sign-out answers.
type SignOutAnswer = Result<HomesSignOut, AccountHomesReadError>;

fn record(calls: &CallLog, call: String) {
    lock(calls).push(call);
}

fn signed_in_account() -> ProviderAccountId {
    ProviderAccountId::new("account-1".to_owned()).expect("a test account id")
}

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

fn write_file(path: &Path) {
    fs::create_dir_all(path.parent().expect("the file has a folder")).expect("folder made");
    fs::write(path, "kept").expect("the file is written");
}

// The erase runs in its order: the sign-ins under way end, then the provider accounts sign out in
// their homes while the folder and the keychain are whole, and only then does the erase answer,
// naming the account left signed in and that a home row could not be named, so the account list
// could not all be read; then the work stops while the data folder is whole, each
// provider's services end, the keychain's items go before the data folder closes, and the process
// ends last; the data folder goes but for an earlier backup, and a project folder is untouched. An
// account that does not sign out stops nothing. A second erase sent while the accounts sign out is
// refused and starts nothing. Killed by the sign-ins' end run after the sign-outs, after the answer
// or not at all, by the sign-out moved after the answer or after the work stops, by the account
// left signed in missing from the answer or answered without its provider or listing, by the
// unnamed row's flag dropped from the answer, by an erase
// that stops on that account, by a delete before the stop, by items deleted after the folder, by a
// provider service ended as for a restart, by a project folder or a backup deleted, by a second
// erase let run beside the first, and by a second erase answered as the first.
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
    let secret_service = os_service_name(&data, KeychainService::WorkflowSecrets);
    credentials
        .write(&secret_service, "deploy", &SecretString::from("planted"))
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
    driver
        .expect_shutdown()
        .times(1)
        .returning(move |intent, _deadline| {
            record(
                &shutdown_calls,
                format!("provider services end ({intent:?})"),
            );
            async {}.boxed()
        });
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    let ended = Arc::new(Notify::new());
    let (stop_calls, sign_in_calls, sign_out_calls, close_calls, end_calls) = (
        Arc::clone(&calls),
        Arc::clone(&calls),
        Arc::clone(&calls),
        Arc::clone(&calls),
        Arc::clone(&calls),
    );
    let (stop_data, sign_in_data, sign_out_data) = (data.clone(), data.clone(), data.clone());
    let end_signal = Arc::clone(&ended);
    let (sign_out_credentials, sign_out_service) = (credentials.clone(), secret_service.clone());
    let sign_out_signal = Arc::new(Notify::new());
    let sign_out_started = Arc::clone(&sign_out_signal);
    // The sign-outs end only once the gate opens, so a second erase arrives while the first runs.
    let (gate, gate_open) = watch::channel(false);
    let erase = Arc::new(DataErase::new(DataEraseDeps {
        data_folder: data.clone(),
        secret_items,
        providers,
        stop_work: Arc::new(move || {
            let whole = stop_data.join("daemon.db").exists();
            record(&stop_calls, format!("work stops (folder whole: {whole})"));
            async {}.boxed()
        }),
        end_sign_ins: Arc::new(move || {
            let whole = sign_in_data.join("accounts").exists();
            record(
                &sign_in_calls,
                format!("sign-ins end (folder whole: {whole})"),
            );
            async { true }.boxed()
        }),
        sign_out_accounts: Arc::new(move || {
            let whole = sign_out_data.join("accounts").exists();
            let held = sign_out_credentials
                .read(&sign_out_service, "deploy")
                .expect("the store reads")
                .is_some();
            record(
                &sign_out_calls,
                format!("accounts sign out (folder whole: {whole}, item held: {held})"),
            );
            sign_out_started.notify_one();
            let mut gate_open = gate_open.clone();
            async move {
                gate_open
                    .wait_for(|is_open| *is_open)
                    .await
                    .expect("the gate stays while the test runs");
                Ok(HomesSignOut {
                    left_signed_in: vec![HomeLeftSignedIn {
                        account_id: signed_in_account(),
                        provider: claude(),
                        listing: DataEraseAccountListing::Removed,
                        cause: HomeSignOutError::Overran,
                    }],
                    has_unnamed_home: true,
                })
            }
            .boxed()
        }),
        close_data_folder: Arc::new(move || {
            let held = credentials
                .read(&secret_service, "deploy")
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

    let first = tokio::spawn({
        let erase = Arc::clone(&erase);
        async move { erase.begin().await }
    });
    sign_out_signal.notified().await;
    assert!(matches!(
        erase.begin().await,
        Err(DataEraseFailure::Refused(DataEraseRefusal::Running))
    ));
    assert!(
        !first.is_finished(),
        "the erase answers once the sign-outs end"
    );
    assert_eq!(
        lock(&calls).len(),
        2,
        "nothing but the sign-ins' end and the sign-outs runs before the answer"
    );
    gate.send_replace(true);
    let answer = first
        .await
        .expect("the erase's call ends")
        .expect("the keychain can be emptied");
    assert_eq!(
        answer,
        DaemonDataEraseResponse {
            signed_in_accounts: vec![DataEraseSignedInAccount {
                account_id: signed_in_account(),
                provider: claude(),
                listing: DataEraseAccountListing::Removed,
                cause: DataEraseSignOutFailure::TimedOut,
            }],
            is_account_list_unread: true,
        }
    );
    tokio::time::timeout(Duration::from_secs(10), ended.notified())
        .await
        .expect("the erase ends the process");

    assert_eq!(
        *lock(&calls),
        [
            "sign-ins end (folder whole: true)".to_owned(),
            "accounts sign out (folder whole: true, item held: true)".to_owned(),
            "work stops (folder whole: true)".to_owned(),
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

// An item the keychain refuses after the check passed keeps the secrets and the whole data folder,
// answered as kept, so the erase can run again. Killed by a refusal answered as erased, which the
// command line would print as everything erased, and by the data folder deleted after a refusal.
#[tokio::test]
async fn a_refused_item_keeps_the_data_folder_and_is_answered_as_kept() {
    let data_folder = tempfile::tempdir().expect("the data folder is made");
    let data = data_folder.path().join(".ai-sidekicks");
    write_file(&data.join("daemon.db"));
    // The record names the operating system's store, so the erase must empty it.
    write_record(
        &record_path(&data),
        &PlaceRecord::settled(SecretsPlace::OperatingSystem),
    )
    .await
    .expect("the record is written");
    let credentials = CredentialStore::in_memory();
    let secret_service = os_service_name(&data, KeychainService::WorkflowSecrets);
    credentials
        .write(&secret_service, "deploy", &SecretString::from("planted"))
        .expect("an item is stored");
    let access = TestStoreAccess::new(credentials.clone());
    let secret_items = SecretItems::new(SecretItemsStart {
        data_folder: data.clone(),
        runs_while_logged_out: false,
        access: access as _,
        call_timeout: Duration::from_secs(5),
    })
    .expect("the system gives random bytes");
    secret_items
        .check_for_erase()
        .await
        .expect("the keychain can be emptied");
    // The store stays open once the check opened it, so the refusal is the item's own.
    credentials.refuse_next_call(&secret_service, "deploy");

    let outcome = erase_data(&secret_items, &data, || async {}.boxed()).await;

    assert!(matches!(outcome, DataEraseOutcome::SecretsKept(_)));
    assert!(
        data.join("daemon.db").is_file(),
        "the data folder stays whole"
    );
}

// An erase that ends before it answers, here as its sign-out panics, fails with an error and lets
// the next erase start rather than refusing it as already running. Killed by the running flag left
// set on that path (the second erase is refused as running and never signs out).
#[tokio::test]
async fn an_erase_that_ends_before_it_answers_fails_and_admits_the_next() {
    let data_folder = tempfile::tempdir().expect("the data folder is made");
    let data = data_folder.path().join(".ai-sidekicks");
    let secret_items = SecretItems::new(SecretItemsStart {
        data_folder: data.clone(),
        runs_while_logged_out: false,
        access: TestStoreAccess::new(CredentialStore::in_memory()) as _,
        call_timeout: Duration::from_secs(5),
    })
    .expect("the system gives random bytes");
    let sign_outs = Arc::new(Mutex::new(0_usize));
    let sign_out_count = Arc::clone(&sign_outs);
    let erase = Arc::new(DataErase::new(DataEraseDeps {
        data_folder: data,
        secret_items,
        providers: Arc::new(registry_of_first_provider(Arc::new(
            MockProviderDriver::new(),
        ))),
        sign_out_accounts: Arc::new(move || -> BoxFuture<'static, SignOutAnswer> {
            *lock(&sign_out_count) += 1;
            panic!("a provider's sign-out panics")
        }),
        end_sign_ins: Arc::new(|| async { true }.boxed()),
        stop_work: Arc::new(|| -> BoxFuture<'static, ()> {
            unreachable!("an erase that did not answer stops no work")
        }),
        close_data_folder: Arc::new(|| -> BoxFuture<'static, ()> {
            unreachable!("an erase that did not answer closes nothing")
        }),
        end_process: Arc::new(|| unreachable!("an erase that did not answer ends no process")),
    }));

    assert!(matches!(erase.begin().await, Err(DataEraseFailure::Ended)));
    assert!(matches!(erase.begin().await, Err(DataEraseFailure::Ended)));
    assert_eq!(
        *lock(&sign_outs),
        2,
        "the second erase starts and signs out"
    );
}
