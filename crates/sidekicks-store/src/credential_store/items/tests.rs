mod seal_pass;
mod sealed;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{
    BlockingCredentialStore, CredentialStore, SealKey, SecretStoreOffer, secret_store_offer,
};
use sidekicks_std::random_hex::random_hex;

use super::{SecretItems, SecretItemsStart};
use crate::credential_store::SecretKeychain;
use crate::credential_store::file::SecretItemsFile;
use crate::credential_store::os::{SystemCredentialStore, TestStoreAccess};
use crate::credential_store::seal::{TestSeal, TestSealAnswer};
use crate::credential_store::service::KeychainService;

const RECORD: &str = "secrets-place.json";
const ITEMS: &str = "secrets.json";
const WORKFLOW: &str = "ai-sidekicks-workflow-secrets";
const PROBE: &str = "ai-sidekicks-probe";

const OPERATING_SYSTEM: &str = r#"{"place":{"kind":"operatingSystem"}}"#;
const LOGGED_OUT: &str = r#"{"place":{"kind":"loggedOutServiceFile"}}"#;
const MOVING_IN: &str =
    r#"{"place":{"kind":"loggedOutServiceFile"},"movingTo":{"kind":"operatingSystem"}}"#;

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

// A call time whose check's share a held seal outlasts, the call still answering in it.
const HELD_CALL_TIMEOUT: Duration = Duration::from_millis(600);

const SEALED: &str = r#"{"place":{"kind":"sealedFile"}}"#;

// The item a case files before the start, beside the one its call writes.
const EARLIER: &str = "earlier";

// What the items file holds before the start.
#[derive(Clone, Copy)]
enum Before {
    Nothing,
    Plain,
    // One item sealed with the key.
    Sealed(SealKey),
    // One item sealed with the chip and one with the system key.
    Mixed,
}

// The status read's secrets file as the wire sends it, its path left out.
type Status = Option<serde_json::Value>;

// Files `before` in `folder` through `seal`, sealing with the key `before` names.
async fn file_before(folder: &Path, seal: &Arc<TestSeal>, before: Before) {
    let filed: &[(&str, Option<SealKey>)] = match before {
        Before::Nothing => &[],
        Before::Plain => &[(EARLIER, None)],
        Before::Sealed(key) => &[(EARLIER, Some(key))],
        Before::Mixed => &[
            (EARLIER, Some(SealKey::Chip)),
            ("earlier-with-the-system-key", Some(SealKey::SystemKey)),
        ],
    };
    let items_file = SecretItemsFile::new(folder);
    for (account, key) in filed {
        if let Some(key) = key {
            seal.seal_with(*key, 0);
        }
        items_file
            .keychain(WORKFLOW, key.map(|_| Arc::clone(seal) as _))
            .write(account, &SecretString::from("earlier value"))
            .await
            .expect("the test fills the file");
    }
}

async fn status(items: &SecretItems) -> Status {
    items
        .secrets_file()
        .await
        .expect("the path is a wire path")
        .map(|file| {
            let mut wire = serde_json::to_value(file).expect("the status writes");
            wire.as_object_mut()
                .expect("the secrets file is an object")
                .remove("path");
            wire
        })
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

/// Every pick the record and an operating system's store allow, each served or refused as its
/// place says, and the record written only once its place passes its check. Mutations: ignore the
/// record at a later start (a recorded store that does not open is then traded for the file); let
/// a store that does not open fall back to the file; write the record before the check accepts;
/// pick the login keychain for a Mac's logged-out service.
#[rstest]
#[case::first_start_with_a_store(
    None,
    None,
    true,
    false,
    Ok(()),
    (Some(OPERATING_SYSTEM), false, true)
)]
#[case::first_start_whose_store_does_not_open(
    None,
    None,
    false,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (None, false, false)
)]
#[case::first_start_of_a_logged_out_service(
    None,
    None,
    true,
    true,
    Ok(()),
    (Some(LOGGED_OUT), true, false)
)]
#[case::recorded_store(
    Some(OPERATING_SYSTEM),
    None,
    true,
    false,
    Ok(()),
    (Some(OPERATING_SYSTEM), false, true)
)]
#[case::recorded_store_that_does_not_open(
    Some(OPERATING_SYSTEM),
    None,
    false,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some(OPERATING_SYSTEM), false, false)
)]
#[case::recorded_file_of_a_logged_out_service(
    Some(LOGGED_OUT),
    None,
    true,
    false,
    Ok(()),
    (Some(LOGGED_OUT), true, false)
)]
#[case::recorded_move(
    Some(MOVING_IN),
    None,
    true,
    false,
    Ok(()),
    (Some(OPERATING_SYSTEM), false, true)
)]
#[case::recorded_move_whose_store_does_not_open(
    Some(MOVING_IN),
    None,
    false,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some(MOVING_IN), false, false)
)]
#[case::unreadable_record(
    Some("{\"place\":"),
    None,
    true,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some("{\"place\":"), false, false)
)]
#[case::unreadable_items_file(
    Some(LOGGED_OUT),
    Some("{\"ai-sidekicks"),
    true,
    false,
    Err(KeychainRefusalCause::Unavailable),
    (Some(LOGGED_OUT), true, false)
)]
#[tokio::test]
async fn the_start_picks_and_keeps_the_secrets_place(
    #[case] record: Option<&str>,
    #[case] items_file: Option<&str>,
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
    access.opens.store(opens, Ordering::SeqCst);
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
    assert_eq!(
        items
            .secrets_file()
            .await
            .expect("the path is a wire path")
            .is_some(),
        has_secrets_file
    );
    assert_eq!(
        stored(&credentials, WORKFLOW, "secret").is_some(),
        is_in_store
    );
}

/// A move whose store is gone again refuses each call with the cause, leaving the file and the
/// record, and the first call after the store returns finishes it. Mutation: serve a recorded move
/// from its source, which may have lost items already.
#[tokio::test]
async fn a_move_whose_store_is_gone_waits_and_finishes_once_it_returns() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), MOVING_IN).expect("the test writes the record");
    SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW, None)
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

// The place a first start picks before its record write fails.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FirstPlace {
    OperatingSystem,
    SealedFile,
    PlainFile,
}

/// A first start whose record cannot be written refuses that call and the next, and no item lands
/// in the place it picked, so no later start that picks another place strands one. The store's
/// record fails for a data folder that is gone, a file's for a folder made at the record's path
/// once the record was read. Mutation: accept the place before its record is written, so the
/// second call is served.
#[rstest]
#[case::operating_system(FirstPlace::OperatingSystem)]
#[case::sealed_file(FirstPlace::SealedFile)]
#[case::plain_file(FirstPlace::PlainFile)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_place_whose_record_cannot_be_written_serves_no_call(#[case] place: FirstPlace) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let credentials = CredentialStore::in_memory();
    let seal = TestSeal::new();
    let (data_folder, access) = match place {
        FirstPlace::OperatingSystem => (
            folder.path().join("gone"),
            TestStoreAccess::new(credentials.clone()),
        ),
        FirstPlace::SealedFile | FirstPlace::PlainFile => (
            folder.path().to_path_buf(),
            TestStoreAccess::sealing(Arc::clone(&seal)),
        ),
    };
    if place == FirstPlace::PlainFile {
        seal.answer(TestSealAnswer::Absent);
    }
    let items = secret_items(&data_folder, &access, false, Duration::from_secs(5));
    let release = seal.hold_next_seal();
    let block_the_record = async {
        if place != FirstPlace::OperatingSystem {
            seal.wait_for_seals(1).await;
            std::fs::create_dir(folder.path().join(RECORD)).expect("the test makes the folder");
        }
        drop(release);
    };

    let (first, ()) = tokio::join!(write_and_read(&items, "secret", "value"), block_the_record);
    let second = write_and_read(&items, "secret", "value").await;

    assert_eq!(first, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(second, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(stored(&credentials, WORKFLOW, "secret"), None);
    assert!(!data_folder.join(ITEMS).exists());
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

/// A place that keeps another value than its check gave it is refused `unavailable` for the run,
/// nothing recorded and no items file written, the operating system's store and the seal alike.
/// Mutations: drop the check's or the probe's compare; drop the mismatch's latch, so the second
/// call checks again and is served.
#[rstest]
#[case::operating_system(FirstPlace::OperatingSystem)]
#[case::seal(FirstPlace::SealedFile)]
#[tokio::test]
async fn a_place_keeping_another_value_is_refused_for_the_run(#[case] place: FirstPlace) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let blocking_store = BlockingCredentialStore::new();
    blocking_store.release();
    let seal = TestSeal::new();
    let access = if place == FirstPlace::OperatingSystem {
        TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()))
    } else {
        TestStoreAccess::sealing(Arc::clone(&seal))
    };
    blocking_store.keep_changed_values_for(PROBE);
    seal.keep_another_value(true);
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    let first = write_and_read(&items, "secret", "value").await;
    blocking_store.stop_changing_values_for(PROBE);
    seal.keep_another_value(false);
    let second = write_and_read(&items, "secret", "value").await;

    assert_eq!(first, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(second, Err(KeychainRefusalCause::Unavailable));
    assert!(!folder.path().join(RECORD).exists());
    assert!(!folder.path().join(ITEMS).exists());
}

// What keeps a first call from being served until the test lifts it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Passing {
    // The operating system's store gives no answer, as behind an unlock prompt.
    StoreWithNoAnswer,
    // The seal gives the first start's probe no answer.
    SealWithNoAnswer,
    // The seal gives the probe of a recorded sealed file no answer.
    RecordedSealWithNoAnswer,
    // The seal service of a recorded sealed file is gone.
    RecordedSealGone,
}

/// A cause that may pass refuses that one call, the status naming it, and the next call checks
/// again and is served, the cause gone from the status: a store with no answer in time reads
/// `locked`, a seal with none `unavailable`, since nothing on Linux can be unlocked, and a recorded
/// sealed file's service that does not answer within the check's time reads failing. Mutations:
/// answer every time-out `locked`, or every one `unavailable`; keep the refusal for the run, or
/// latch every cause; drop the check's own time, so the call's time runs out before the cause is
/// recorded; skip recording the cause.
#[rstest]
#[case::store_with_no_answer(Passing::StoreWithNoAnswer, KeychainRefusalCause::Locked, None, None)]
#[case::seal_with_no_answer(
    Passing::SealWithNoAnswer,
    KeychainRefusalCause::Unavailable,
    None,
    Some(json!({"protection":"sealedWithChip"}))
)]
#[case::recorded_seal_with_no_answer(
    Passing::RecordedSealWithNoAnswer,
    KeychainRefusalCause::Unavailable,
    Some(json!({"protection":"sealedWithChip","cannotOpen":"sealServiceFailing"})),
    Some(json!({"protection":"sealedWithChip"}))
)]
#[case::recorded_seal_gone(
    Passing::RecordedSealGone,
    KeychainRefusalCause::Unavailable,
    Some(json!({"protection":"sealedWithChip","cannotOpen":"sealServiceMissing"})),
    Some(json!({"protection":"sealedWithChip"}))
)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_passing_cause_refuses_that_call_and_the_next_one_checks_again(
    #[case] passing: Passing,
    #[case] cause: KeychainRefusalCause,
    #[case] status_refused: Status,
    #[case] status_served: Status,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let blocking_store = BlockingCredentialStore::new();
    let seal = TestSeal::new();
    let access = if passing == Passing::StoreWithNoAnswer {
        TestStoreAccess::new(CredentialStore::from_store(blocking_store.clone()))
    } else {
        TestStoreAccess::sealing(Arc::clone(&seal))
    };
    if matches!(
        passing,
        Passing::RecordedSealWithNoAnswer | Passing::RecordedSealGone
    ) {
        std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
        file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    }
    let held = matches!(
        passing,
        Passing::SealWithNoAnswer | Passing::RecordedSealWithNoAnswer
    )
    .then(|| seal.hold_next_seal());
    if passing == Passing::RecordedSealGone {
        seal.answer(TestSealAnswer::Absent);
    }
    let items = secret_items(folder.path(), &access, false, HELD_CALL_TIMEOUT);

    let scenario = async {
        let refused = write_and_read(&items, "secret", "value").await;
        let status_after_refusal = status(&items).await;
        blocking_store.release();
        drop(held);
        seal.answer(TestSealAnswer::Serves);
        let served = write_and_read(&items, "secret", "value").await;
        (refused, status_after_refusal, served, status(&items).await)
    };
    let outcome = tokio::time::timeout(Duration::from_secs(5), scenario).await;
    blocking_store.release();
    let (refused, status_after_refusal, served, status_after_serving) =
        outcome.expect("every call answers within its time");

    assert_eq!(refused, Err(cause));
    assert_eq!(status_after_refusal, status_refused);
    assert_eq!(served, Ok(Some("value".to_owned())));
    assert_eq!(status_after_serving, status_served);
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
        .keychain(WORKFLOW, None)
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
    std::fs::write(folder.path().join(RECORD), LOGGED_OUT).expect("the test writes it");
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

/// Each item round-trips through this machine's own credential store, the login keychain on macOS
/// or the Credential Manager on Windows; Linux runs the sealed file's live test instead.
#[tokio::test]
#[ignore = "needs the login keychain on macOS or the Credential Manager on Windows"]
async fn an_item_round_trips_through_this_machines_credential_store() {
    let offer = secret_store_offer();
    assert!(
        matches!(offer, SecretStoreOffer::OperatingSystem(_)),
        "this machine offers its own credential store only on macOS and Windows"
    );
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let items = SecretItems::new(SecretItemsStart {
        data_folder: folder.path().to_path_buf(),
        runs_while_logged_out: false,
        access: Arc::new(SystemCredentialStore { offer }),
        call_timeout: Duration::from_secs(30),
    })
    .expect("the system gives random bytes");
    let keychain = items.keychain(KeychainService::WorkflowSecrets);
    let account = format!(
        "live-test-{}",
        random_hex(8).expect("the system gives random bytes")
    );

    keychain
        .write_verified(&account, &SecretString::from("value"))
        .await
        .expect("the store keeps the item");
    let removed = keychain.remove(&account).await;

    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(OPERATING_SYSTEM)
    );
    assert_eq!(removed.map_err(|refusal| refusal.cause()), Ok(true));
}
