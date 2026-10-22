use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{BlockingCredentialStore, CredentialStore, secret_store_offer};

use super::{SecretItems, SecretItemsStart};
use crate::credential_store::SecretKeychain;
use crate::credential_store::file::SecretItemsFile;
use crate::credential_store::os::{SystemCredentialStore, TestStoreAccess};
use crate::credential_store::service::KeychainService;
use crate::random_hex::random_hex;

const RECORD: &str = "secrets-place.json";
const ITEMS: &str = "secrets.json";
const WORKFLOW: &str = "ai-sidekicks-workflow-secrets";
const PROBE: &str = "ai-sidekicks-probe";

const OPERATING_SYSTEM: &str = r#"{"place":{"kind":"operatingSystem"}}"#;
const NO_SECRET_SERVICE: &str = r#"{"place":{"kind":"file","reason":"noSecretService"}}"#;
const LOGGED_OUT: &str = r#"{"place":{"kind":"file","reason":"loggedOutService"}}"#;
const MOVING_IN: &str =
    r#"{"place":{"kind":"file","reason":"noSecretService"},"movingTo":{"kind":"operatingSystem"}}"#;

// The secret items of `folder` over `access`, each call answered within `call_timeout`.
fn secret_items(
    folder: &Path,
    access: &Arc<TestStoreAccess>,
    runs_while_logged_out: bool,
    call_timeout: Duration,
) -> Arc<SecretItems> {
    SecretItems::new(SecretItemsStart {
        data_folder: folder.to_path_buf(),
        runs_while_logged_out,
        access: Arc::clone(access) as _,
        call_timeout,
    })
    .expect("the system gives random bytes")
}

// Writes `value` under `account` in the workflow secrets and reads it back.
async fn write_and_read(
    items: &Arc<SecretItems>,
    account: &str,
    value: &str,
) -> Result<Option<String>, KeychainRefusalCause> {
    let keychain = items.keychain(KeychainService::WorkflowSecrets);
    keychain
        .write(account, &SecretString::from(value))
        .await
        .map_err(|refusal| refusal.cause())?;
    let kept = keychain
        .read(account)
        .await
        .map_err(|refusal| refusal.cause())?;
    Ok(kept.map(|kept| kept.expose_secret().to_owned()))
}

// A data folder whose items file holds `first = one` because no Secret Service ran.
async fn folder_with_a_filed_secret() -> tempfile::TempDir {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), NO_SECRET_SERVICE)
        .expect("the test writes the record");
    SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW)
        .write("first", &SecretString::from("one"))
        .await
        .expect("the test fills the file");
    folder
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn stored(credentials: &CredentialStore, service: &str, account: &str) -> Option<String> {
    credentials
        .read(service, account)
        .expect("the in-memory store answers")
        .map(|value| value.expose_secret().to_owned())
}

/// Every pick the record and the machine allow, each served or refused as its place says, the
/// record written only once its place passes its check, and a call served from the file even once
/// a Secret Service runs. Mutations: ignore the record at a later start (a recorded store that
/// cannot be reached is then traded for the file); let a store that does not open fall back to the
/// file; write the record before the check accepts; pick the login keychain for a Mac's logged-out
/// service.
#[rstest]
#[case::first_start_with_a_store(
    None,
    None,
    true,
    true,
    false,
    Ok(()),
    (Some(OPERATING_SYSTEM), false, true)
)]
#[case::first_start_whose_store_does_not_open(
    None,
    None,
    true,
    false,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (None, false, false)
)]
#[case::first_start_with_no_secret_service(
    None,
    None,
    false,
    false,
    false,
    Ok(()),
    (Some(NO_SECRET_SERVICE), true, false)
)]
#[case::first_start_of_a_logged_out_service(
    None,
    None,
    true,
    true,
    true,
    Ok(()),
    (Some(LOGGED_OUT), true, false)
)]
#[case::recorded_store(
    Some(OPERATING_SYSTEM),
    None,
    true,
    true,
    false,
    Ok(()),
    (Some(OPERATING_SYSTEM), false, true)
)]
#[case::recorded_store_not_reached(
    Some(OPERATING_SYSTEM),
    None,
    false,
    false,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some(OPERATING_SYSTEM), false, false)
)]
#[case::recorded_file_still_without_a_secret_service(
    Some(NO_SECRET_SERVICE),
    None,
    false,
    true,
    false,
    Ok(()),
    (Some(NO_SECRET_SERVICE), true, false)
)]
#[case::recorded_file_while_a_secret_service_runs(
    Some(NO_SECRET_SERVICE),
    None,
    true,
    true,
    false,
    Ok(()),
    (Some(NO_SECRET_SERVICE), true, false)
)]
#[case::recorded_file_of_a_logged_out_service(
    Some(LOGGED_OUT),
    None,
    true,
    true,
    false,
    Ok(()),
    (Some(LOGGED_OUT), true, false)
)]
#[case::recorded_move(
    Some(MOVING_IN),
    None,
    true,
    true,
    false,
    Ok(()),
    (Some(OPERATING_SYSTEM), false, true)
)]
#[case::recorded_move_whose_store_is_gone(
    Some(MOVING_IN),
    None,
    false,
    false,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some(MOVING_IN), false, false)
)]
#[case::unreadable_record(
    Some("{\"place\":"),
    None,
    true,
    true,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some("{\"place\":"), false, false)
)]
#[case::unreadable_items_file(
    Some(NO_SECRET_SERVICE),
    Some("{\"ai-sidekicks"),
    false,
    true,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some(NO_SECRET_SERVICE), true, false)
)]
#[tokio::test]
async fn the_start_picks_and_keeps_the_secrets_place(
    #[case] record: Option<&str>,
    #[case] items_file: Option<&str>,
    #[case] is_reachable: bool,
    #[case] opens: bool,
    #[case] runs_while_logged_out: bool,
    #[case] served: Result<(), KeychainRefusalCause>,
    #[case] kept: (Option<&str>, bool, bool),
) {
    let (record_after, has_secrets_file, is_in_store) = kept;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    if let Some(record) = record {
        std::fs::write(folder.path().join(RECORD), record).expect("the test writes the record");
    }
    if let Some(items_file) = items_file {
        std::fs::write(folder.path().join(ITEMS), items_file).expect("the test writes the file");
    }
    let credentials = CredentialStore::in_memory();
    let access = TestStoreAccess::new(credentials.clone());
    access.is_reachable.store(is_reachable, Ordering::SeqCst);
    access.opens.store(opens, Ordering::SeqCst);
    // A locked default collection keeps any settling run a call asks for from moving the items.
    access.is_unlocked.store(false, Ordering::SeqCst);
    let items = secret_items(
        folder.path(),
        &access,
        runs_while_logged_out,
        Duration::from_secs(5),
    );

    let answer = write_and_read(&items, "secret", "value").await;

    assert_eq!(
        answer.map(|kept| assert_eq!(kept.as_deref(), Some("value"))),
        served
    );
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        record_after
    );
    if let Some(items_file) = items_file {
        assert_eq!(
            read_text(&folder.path().join(ITEMS)).as_deref(),
            Some(items_file)
        );
    }
    assert_eq!(items.secrets_file().await.is_some(), has_secrets_file);
    assert_eq!(
        stored(&credentials, WORKFLOW, "secret").is_some(),
        is_in_store
    );
}

/// The items file's secrets move into a Secret Service once one runs and its default collection is
/// unlocked: every item lands in the store with its value, the file goes and the record names the
/// store. A store that keeps another value leaves the file and the record byte for byte, and calls
/// go on to the file. Mutations: delete an item from the file before its copy reads back; record
/// the store before the last item moved.
#[tokio::test]
async fn the_items_file_moves_into_a_secret_service_only_once_every_copy_reads_back() {
    for keeps_another_value in [false, true] {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        std::fs::write(folder.path().join(RECORD), NO_SECRET_SERVICE)
            .expect("the test writes the record");
        let file_keychain = SecretItemsFile::new(folder.path()).keychain(WORKFLOW);
        for (account, value) in [("first", "one"), ("second", "two")] {
            file_keychain
                .write(account, &SecretString::from(value))
                .await
                .expect("the test fills the file");
        }
        let items_text = read_text(&folder.path().join(ITEMS));
        let blocking_store = BlockingCredentialStore::new();
        blocking_store.release();
        if keeps_another_value {
            blocking_store.keep_changed_values_for(WORKFLOW);
        }
        let credentials = CredentialStore::from_store(blocking_store.clone());
        let access = TestStoreAccess::new(credentials.clone());
        let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

        items.settle().await;
        let first = items
            .keychain(KeychainService::WorkflowSecrets)
            .read("first")
            .await
            .expect("the moved or kept item reads");

        assert_eq!(first.as_ref().map(ExposeSecret::expose_secret), Some("one"));
        if keeps_another_value {
            assert_eq!(read_text(&folder.path().join(ITEMS)), items_text);
            assert_eq!(
                read_text(&folder.path().join(RECORD)).as_deref(),
                Some(NO_SECRET_SERVICE)
            );
        } else {
            assert_eq!(
                stored(&credentials, WORKFLOW, "first").as_deref(),
                Some("one")
            );
            assert_eq!(
                stored(&credentials, WORKFLOW, "second").as_deref(),
                Some("two")
            );
            assert!(!folder.path().join(ITEMS).exists());
            assert_eq!(
                read_text(&folder.path().join(RECORD)).as_deref(),
                Some(OPERATING_SYSTEM)
            );
        }
    }
}

/// A move whose store is gone again refuses each call with the cause, leaving the file and the
/// record, and the first call after the store returns finishes it. Mutation: serve a recorded move
/// from its source, which may have lost items already.
#[tokio::test]
async fn a_move_whose_store_is_gone_waits_and_finishes_once_it_returns() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), MOVING_IN).expect("the test writes the record");
    SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW)
        .write("secret", &SecretString::from("value"))
        .await
        .expect("the test fills the file");
    let credentials = CredentialStore::in_memory();
    let access = TestStoreAccess::new(credentials.clone());
    access.opens.store(false, Ordering::SeqCst);
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    let refused = keychain.read("secret").await.expect_err("the move waits");
    assert_eq!(refused.cause(), KeychainRefusalCause::Unavailable);
    assert!(folder.path().join(ITEMS).exists());
    access.opens.store(true, Ordering::SeqCst);
    let moved = keychain.read("secret").await.expect("the move finishes");

    assert_eq!(
        moved.as_ref().map(ExposeSecret::expose_secret),
        Some("value")
    );
    assert_eq!(
        stored(&credentials, WORKFLOW, "secret").as_deref(),
        Some("value")
    );
    assert!(!folder.path().join(ITEMS).exists());
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
}

/// The check writes under a fresh account each start, so a leftover from an earlier build that
/// refuses its write is never touched. Mutation: check under the fixed account `store-verify`.
#[tokio::test]
async fn the_check_never_touches_an_earlier_probe_item() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let credentials = CredentialStore::in_memory();
    credentials
        .write(PROBE, "store-verify", &SecretString::from("left over"))
        .expect("the test leaves a probe item");
    credentials.refuse_next_call(PROBE, "store-verify");
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::new(credentials),
        false,
        Duration::from_secs(5),
    );

    assert_eq!(
        write_and_read(&items, "secret", "value").await,
        Ok(Some("value".to_owned()))
    );
}

/// A store that keeps another value than the one written is refused `unavailable`, its record
/// never written, and stays refused for the run once it keeps values again. Mutations: drop the
/// check's compare; drop the mismatch's latch, so the second call checks again and is served.
#[tokio::test]
async fn a_store_keeping_another_value_is_refused_for_the_run() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let blocking_store = BlockingCredentialStore::new();
    blocking_store.release();
    blocking_store.keep_changed_values_for(PROBE);
    let access = TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()));
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    let first = write_and_read(&items, "secret", "value").await;
    blocking_store.stop_changing_values_for(PROBE);
    let second = write_and_read(&items, "secret", "value").await;

    assert_eq!(first, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(second, Err(KeychainRefusalCause::Unavailable));
    assert!(!folder.path().join(RECORD).exists());
}

/// A check that gets no answer in time refuses that call `locked`, and the next call checks again
/// and is served. Mutation: keep a `locked` check's refusal for the run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_locked_check_refuses_that_call_and_the_next_one_checks_again() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let blocking_store = BlockingCredentialStore::new();
    let access = TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()));
    let items = secret_items(folder.path(), &access, false, Duration::from_millis(300));

    let scenario = async {
        let locked = write_and_read(&items, "secret", "value").await;
        blocking_store.release();
        let served = write_and_read(&items, "secret", "value").await;
        (locked, served)
    };
    let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
    blocking_store.release();
    let (locked, served) = outcome.expect("every call answers within its time");

    assert_eq!(locked, Err(KeychainRefusalCause::Locked));
    assert_eq!(served, Ok(Some("value".to_owned())));
}

/// The erase deletes every item the app made in the store, probe leftovers included, and the
/// items file, and leaves another program's item whose service only starts like one of ours. Its
/// check refuses a store that cannot be used when the record names it or cannot be read, and passes
/// over one a readable record does not name. Mutations: drop the exact-service filter; leave a
/// service out of the set; let the check pass a recorded store that cannot be used; sweep a store
/// under an unreadable record only as far as it answers.
#[tokio::test]
async fn the_erase_deletes_every_item_the_app_made_and_nothing_else() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), OPERATING_SYSTEM).expect("the test writes it");
    SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW)
        .write("secret", &SecretString::from("value"))
        .await
        .expect("the test fills the file");
    let credentials = CredentialStore::in_memory();
    let ours = [
        (WORKFLOW, "first"),
        (WORKFLOW, "second"),
        (PROBE, "store-verify"),
        (PROBE, "store-verify-0a1b2c3d4e5f6a7b"),
    ];
    let theirs = ("ai-sidekicks-workflow-secrets-x", "first");
    for (service, account) in ours.into_iter().chain([theirs]) {
        credentials
            .write(service, account, &SecretString::from("value"))
            .expect("the test fills the store");
    }
    let access = TestStoreAccess::new(credentials.clone());
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    access.opens.store(false, Ordering::SeqCst);
    let refused = items
        .check_for_erase()
        .await
        .expect_err("a recorded store that cannot be used refuses the erase");
    assert_eq!(refused.cause(), KeychainRefusalCause::Unavailable);
    std::fs::write(folder.path().join(RECORD), "{\"place\":").expect("the test writes it");
    let refused = items
        .check_for_erase()
        .await
        .expect_err("a store that can be reached under an unreadable record must be emptied");
    assert_eq!(refused.cause(), KeychainRefusalCause::Unavailable);
    std::fs::write(folder.path().join(RECORD), NO_SECRET_SERVICE).expect("the test writes it");
    items
        .check_for_erase()
        .await
        .expect("a store the record does not name is passed over");
    std::fs::write(folder.path().join(RECORD), OPERATING_SYSTEM).expect("the test writes it");
    access.opens.store(true, Ordering::SeqCst);
    items.check_for_erase().await.expect("the store answers");
    items.erase_all().await.expect("every item goes");

    for (service, account) in ours {
        assert_eq!(
            stored(&credentials, service, account),
            None,
            "{service} {account}"
        );
    }
    assert_eq!(
        stored(&credentials, theirs.0, theirs.1).as_deref(),
        Some("value")
    );
    assert!(!folder.path().join(ITEMS).exists());
}

/// A call made while a settling run checks a Secret Service is served from the file at once and
/// never reaches the store, and the run then moves the items. Mutation: run the move inside the
/// call, so the call waits on the held check and is refused `locked`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_during_a_move_is_served_from_the_file_without_a_store_call() {
    let folder = folder_with_a_filed_secret().await;
    let blocking_store = BlockingCredentialStore::new();
    let credentials = CredentialStore::from_store(blocking_store.clone());
    let access = TestStoreAccess::new(credentials.clone());
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(2));

    let scenario = async {
        let settling = tokio::spawn({
            let items = Arc::clone(&items);
            async move { items.settle().await }
        });
        // The move's check waits on its first write.
        blocking_store.wait_for_calls(1).await;
        let served = items
            .keychain(KeychainService::WorkflowSecrets)
            .read("first")
            .await
            .map(|kept| kept.map(|kept| kept.expose_secret().to_owned()))
            .map_err(|refusal| refusal.cause());
        let calls_while_moving = blocking_store.calls();
        blocking_store.release();
        settling.await.expect("the settling run ends");
        (served, calls_while_moving)
    };
    let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
    blocking_store.release();
    let (served, calls_while_moving) = outcome.expect("every call answers within its time");

    assert_eq!(served, Ok(Some("one".to_owned())));
    assert_eq!(calls_while_moving, 1);
    assert_eq!(
        stored(&credentials, WORKFLOW, "first").as_deref(),
        Some("one")
    );
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
}

/// A settling request made while a run is under way returns at once and runs it once more when
/// it ends, so a run whose copy was refused is followed by one that moves the items. Mutation:
/// drop the request made during a run.
#[tokio::test]
async fn a_settling_request_during_a_run_runs_it_once_more() {
    let folder = folder_with_a_filed_secret().await;
    let credentials = CredentialStore::in_memory();
    // The first run's copy is refused, before the move records its direction.
    credentials.refuse_next_call(WORKFLOW, "first");
    let access = TestStoreAccess::new(credentials.clone());
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    let mut first_run = std::pin::pin!(items.settle());
    assert!(futures::poll!(first_run.as_mut()).is_pending());
    items.settle().await;
    first_run.await;

    assert_eq!(
        stored(&credentials, WORKFLOW, "first").as_deref(),
        Some("one")
    );
    assert!(!folder.path().join(ITEMS).exists());
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
}

/// A Secret Service whose default collection is locked or missing gets no move and no store call,
/// so no move raises an unlock prompt; the file and the record stay byte for byte. Mutation: drop
/// the collection's lock read.
#[tokio::test]
async fn a_locked_default_collection_keeps_the_secrets_in_the_file() {
    let folder = folder_with_a_filed_secret().await;
    let items_text = read_text(&folder.path().join(ITEMS));
    let blocking_store = BlockingCredentialStore::new();
    blocking_store.release();
    let access = TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()));
    access.is_unlocked.store(false, Ordering::SeqCst);
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    items.settle().await;

    assert_eq!(blocking_store.calls(), 0);
    assert_eq!(read_text(&folder.path().join(ITEMS)), items_text);
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(NO_SECRET_SERVICE)
    );
}

/// A write made while the move copies the items waits for the copy and the deletes, then lands in
/// the store, never in the file the move deletes. Mutation: copy under the place's read lock, so
/// the write lands in the file mid-move and is deleted with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_during_the_copy_waits_for_it_and_lands_in_the_store() {
    let folder = folder_with_a_filed_secret().await;
    let blocking_store = BlockingCredentialStore::new();
    blocking_store.release();
    blocking_store.hold_calls_for(WORKFLOW);
    let credentials = CredentialStore::from_store(blocking_store.clone());
    let access = TestStoreAccess::new(credentials.clone());
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    let scenario = async {
        let settling = tokio::spawn({
            let items = Arc::clone(&items);
            async move { items.settle().await }
        });
        // The check's write, read and delete answer; the copy's write is held.
        blocking_store.wait_for_calls(4).await;
        let writing = tokio::spawn({
            let items = Arc::clone(&items);
            async move {
                items
                    .keychain(KeychainService::WorkflowSecrets)
                    .write("first", &SecretString::from("two"))
                    .await
                    .map_err(|refusal| refusal.cause())
            }
        });
        // Long enough for a write that does not wait for the copy to land in the file.
        tokio::time::sleep(Duration::from_millis(100)).await;
        blocking_store.release();
        settling.await.expect("the settling run ends");
        writing.await.expect("the write's task ends")
    };
    let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
    blocking_store.release();

    assert_eq!(outcome.expect("every call answers within its time"), Ok(()));
    assert_eq!(
        stored(&credentials, WORKFLOW, "first").as_deref(),
        Some("two")
    );
    assert!(!folder.path().join(ITEMS).exists());
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
}

/// A settling run made with no person's call leaves every place but a file waiting to move for the
/// next call: with no record, a recorded store, a recorded move, or a store a refused call picked
/// and left unchecked, it makes no store call, so it never writes the check's probe into a locked
/// Secret Service, and the record stays as it was. Mutation: drop the run's early return, or answer
/// true for a picked place, so it picks or checks the store.
#[rstest]
#[case::no_record(None, false)]
#[case::recorded_store(Some(OPERATING_SYSTEM), false)]
#[case::recorded_move(Some(MOVING_IN), false)]
#[case::picked_unchecked(None, true)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_with_no_call_settles_only_a_file_waiting_to_move(
    #[case] record: Option<&str>,
    #[case] picks_by_a_refused_call: bool,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    if let Some(record) = record {
        std::fs::write(folder.path().join(RECORD), record).expect("the test writes the record");
    }
    let blocking_store = BlockingCredentialStore::new();
    let access = TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()));
    let items = secret_items(folder.path(), &access, false, Duration::from_millis(300));
    if picks_by_a_refused_call {
        let locked = tokio::time::timeout(Duration::from_secs(5), write_and_read(&items, "a", "v"))
            .await
            .expect("the held check answers within its time");
        assert_eq!(locked, Err(KeychainRefusalCause::Locked));
    }
    blocking_store.release();
    let calls_before = blocking_store.calls();
    let record_before = read_text(&folder.path().join(RECORD));

    items.settle().await;

    assert_eq!(blocking_store.calls(), calls_before);
    assert_eq!(read_text(&folder.path().join(RECORD)), record_before);
    assert_eq!(record_before.as_deref(), record);
}

/// A move refused after it recorded its direction leaves the run on the recorded move, which the
/// next call finishes, never on the file it was emptying. Mutation: keep the run's file state when
/// the move stops after its record, so the next call is served from that file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_refused_after_its_record_is_finished_by_the_next_call() {
    let folder = folder_with_a_filed_secret().await;
    let blocking_store = BlockingCredentialStore::new();
    blocking_store.release();
    blocking_store.hold_calls_for(WORKFLOW);
    let credentials = CredentialStore::from_store(blocking_store.clone());
    let access = TestStoreAccess::new(credentials.clone());
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    let scenario = async {
        let settling = tokio::spawn({
            let items = Arc::clone(&items);
            async move { items.settle().await }
        });
        // The check's write, read and delete answer; the copy has read the file and its write is
        // held.
        blocking_store.wait_for_calls(4).await;
        // The source's delete then reads a file that is not an items file and is refused.
        std::fs::write(folder.path().join(ITEMS), "not an items file")
            .expect("the test spoils the file");
        blocking_store.release();
        settling.await.expect("the settling run ends");
    };
    let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
    blocking_store.release();
    outcome.expect("the settling run ends within its time");
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(MOVING_IN)
    );
    // The state a move leaves once its first source delete landed.
    std::fs::remove_file(folder.path().join(ITEMS)).expect("the test deletes the file");

    let first = items
        .keychain(KeychainService::WorkflowSecrets)
        .read("first")
        .await
        .expect("the call finishes the move");

    assert_eq!(first.as_ref().map(ExposeSecret::expose_secret), Some("one"));
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
    assert_eq!(
        stored(&credentials, WORKFLOW, "first").as_deref(),
        Some("one")
    );
}

/// Each item round-trips through this machine's own credential store, the login keychain or the
/// Credential Manager.
#[tokio::test]
#[ignore = "needs this machine's real credential store"]
async fn an_item_round_trips_through_this_machines_credential_store() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let items = SecretItems::new(SecretItemsStart {
        data_folder: folder.path().to_path_buf(),
        runs_while_logged_out: false,
        access: Arc::new(SystemCredentialStore {
            offer: secret_store_offer(),
        }),
        call_timeout: Duration::from_secs(30),
    })
    .expect("the system gives random bytes");
    let keychain = items.keychain(KeychainService::WorkflowSecrets);
    let account = format!(
        "live-test-{}",
        random_hex(8).expect("the system gives random bytes")
    );

    keychain
        .seal(&account, &SecretString::from("value"))
        .await
        .expect("the store keeps the item");
    let removed = keychain.remove(&account).await;

    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
    assert_eq!(removed.map_err(|refusal| refusal.cause()), Ok(true));
}
