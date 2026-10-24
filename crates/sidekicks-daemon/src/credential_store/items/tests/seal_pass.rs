//! The pass that seals the Linux items file again: its time for each seal, its one run while a
//! call waits, and a refused pass kept from starting again until the next start.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{SealKey, is_superuser, make_unreadable};

use super::sealed::{NO_SEAL_SERVICE, SEAL_FAILED, form};
use super::{
    Before, EARLIER, HELD_CALL_TIMEOUT, ITEMS, RECORD, SEALED, WORKFLOW, file_before, read_text,
    secret_items, status,
};
use crate::credential_store::SecretKeychain;
use crate::credential_store::file::SecretItemsFile;
use crate::credential_store::items::sealed_file::pass_unanswered;
use crate::credential_store::os::TestStoreAccess;
use crate::credential_store::seal::{TestSeal, TestSealAnswer};
use crate::credential_store::service::KeychainService;

/// A pass sealing a plain file that runs past a call's time keeps running once that call refuses,
/// and a later call waits for it and is served from the sealed file, one pass having run.
/// Mutation: run the pass inside the call's time, so each call drops it and starts it over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seal_pass_longer_than_a_call_lands_once() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), NO_SEAL_SERVICE).expect("the test writes it");
    let plain = SecretItemsFile::new(folder.path()).keychain(WORKFLOW, None);
    for account in [EARLIER, "second", "third", "fourth", "fifth"] {
        plain
            .write(account, &SecretString::from("earlier value"))
            .await
            .expect("the test fills the file");
    }
    let seal = TestSeal::new();
    // Five items' seals, each inside the check's 400 ms and 1.5 s in all, outlast the 1.2 s
    // call; the probe's are not delayed.
    seal.delay_seals_under(WORKFLOW, Duration::from_millis(300));
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_millis(1_200),
    );
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    let scenario = async {
        let first = keychain
            .read(EARLIER)
            .await
            .map_err(|refusal| refusal.cause());
        seal.wait_for_seals(6).await;
        let later = keychain
            .read(EARLIER)
            .await
            .map_err(|refusal| refusal.cause());
        (first, later)
    };
    let (first, later) = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");

    assert_eq!(first.err(), Some(KeychainRefusalCause::Unavailable));
    assert_eq!(
        later.map(|kept| kept.map(|kept| kept.expose_secret().to_owned())),
        Ok(Some("earlier value".to_owned()))
    );
    assert_eq!(seal.seals(), 7, "two probes and one seal per item");
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(SEALED)
    );
    assert_eq!(form(folder.path()).as_deref(), Some("sealed"));
}

/// A seal that gives no answer within the check's time ends the pass, the file kept byte for byte
/// and its lock let go, so each later call and the relink answer with the pass's refusal within
/// their time rather than waiting on the file. Mutation: drop the time from the pass's seals in
/// `seal_held` (`within_pass_time`'s `timeout`), so the pass holds the lock and each call runs out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seal_with_no_answer_ends_the_pass_and_lets_the_file_go() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), NO_SEAL_SERVICE).expect("the test writes it");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Plain).await;
    let bytes_before = std::fs::read(folder.path().join(ITEMS)).expect("the file is there");
    seal.delay_seals_under(WORKFLOW, Duration::from_secs(30));
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        HELD_CALL_TIMEOUT,
    );
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    let scenario = async {
        let first = keychain.read(EARLIER).await.err();
        let later = keychain.read(EARLIER).await.err();
        let relink = items.empty_place().await.err();
        [first, later, relink]
    };
    let refusals = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");

    let unanswered = pass_unanswered();
    for refusal in refusals {
        let refusal = refusal.expect("a pass with no answer refuses the call");
        assert_eq!(refusal.cause(), KeychainRefusalCause::Unavailable);
        assert_eq!(refusal.reason(), unanswered.reason());
    }
    assert_eq!(
        std::fs::read(folder.path().join(ITEMS)).expect("the file is there"),
        bytes_before
    );
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(NO_SEAL_SERVICE)
    );
}

// How a case's pass is refused.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PassRefusal {
    // systemd's credential service refuses the item's seal.
    ItemSeal,
    // The file cannot be read once the probe passes.
    FileRead,
}

/// A pass the service or the file refuses starts no other this run: at a first start a refused
/// item seal records the plain file for the seal's failure and serves it; under a plain record a
/// file that fails the pass refuses that call, and the next is served plain with no pass. Mutation:
/// never set `is_pass_refused`, so the plain record's second call seals the item again; answer a
/// refused first start's pass as the weaker one, so each call refuses.
#[rstest]
#[case::first_start_whose_item_seal_refuses(
    None, PassRefusal::ItemSeal, true, Some(SEAL_FAILED), 0,
    Some(json!({"protection":"plain","reason":"sealFailed"}))
)]
#[case::plain_record_whose_file_fails_the_pass(
    Some(NO_SEAL_SERVICE), PassRefusal::FileRead, false, Some(NO_SEAL_SERVICE), 1,
    Some(json!({"protection":"plain","reason":"noSealService"}))
)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_seal_pass_starts_no_other_this_run(
    #[case] record: Option<&str>,
    #[case] refusal: PassRefusal,
    #[case] is_first_served: bool,
    #[case] record_after: Option<&str>,
    #[case] second_seals: usize,
    #[case] status_after: super::Status,
) {
    // Root reads a file whatever its mode.
    if refusal == PassRefusal::FileRead && is_superuser() {
        return;
    }
    let folder = tempfile::tempdir().expect("the test makes a folder");
    if let Some(record) = record {
        std::fs::write(folder.path().join(RECORD), record).expect("the test writes the record");
    }
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Plain).await;
    if refusal == PassRefusal::ItemSeal {
        seal.refuse_seals_under(WORKFLOW);
    }
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    // The file is darkened once the probe's seal is asked for, after its form is read.
    let seals = seal.seals();
    let release = seal.hold_next_seal();
    let darken = async {
        seal.wait_for_seals(seals + 1).await;
        let darkened = (refusal == PassRefusal::FileRead).then(|| {
            make_unreadable(&folder.path().join(ITEMS)).expect("the file is made unreadable")
        });
        drop(release);
        darkened
    };
    let scenario = async { tokio::join!(keychain.read(EARLIER), darken) };
    let (first, darkened) = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");
    drop(darkened);
    let seals = seal.seals();
    let second = keychain.read(EARLIER).await;

    assert_eq!(first.is_ok(), is_first_served);
    assert_eq!(
        second
            .expect("the plain file serves")
            .as_ref()
            .map(ExposeSecret::expose_secret),
        Some("earlier value")
    );
    assert_eq!(
        seal.seals() - seals,
        second_seals,
        "no pass seals the item again"
    );
    assert_eq!(form(folder.path()).as_deref(), Some("plain"));
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        record_after
    );
    assert_eq!(status(&items).await, status_after);
}

/// A cause the run checks again is forgotten once every sampled item opens, so a call that runs out
/// of time while its pass seals the items again leaves the status naming none. Mutation: drop
/// `clear_opening` from `open_sealed`, so the status keeps the cause from the earlier call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cause_is_forgotten_once_the_items_open_again() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    seal.seal_with(SealKey::SystemKey, 0);
    let sealed =
        SecretItemsFile::new(folder.path()).keychain(WORKFLOW, Some(Arc::clone(&seal) as _));
    for account in [EARLIER, "second", "third", "fourth", "fifth"] {
        sealed
            .write(account, &SecretString::from("earlier value"))
            .await
            .expect("the test fills the file");
    }
    seal.answer(TestSealAnswer::Absent);
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_millis(1_200),
    );
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    let missing = keychain.read(EARLIER).await.err();
    let status_missing = status(&items).await;
    seal.answer(TestSealAnswer::Serves);
    seal.seal_with(SealKey::Chip, 0);
    // Five items' seals again, each inside the check's 400 ms and 1.5 s in all, outlast the 1.2 s
    // call; the probe's are not delayed.
    seal.delay_seals_under(WORKFLOW, Duration::from_millis(300));
    let ran_out = tokio::time::timeout(Duration::from_secs(5), keychain.read(EARLIER))
        .await
        .expect("the call answers within its time")
        .err();
    let status_after = status(&items).await.expect("the file holds items");

    assert!(
        missing.is_some() && ran_out.is_some(),
        "both calls are refused"
    );
    assert_eq!(
        status_missing,
        Some(json!({"protection":"sealedWithSystemKey","cannotOpen":"sealServiceMissing"}))
    );
    assert_eq!(status_after.get("cannotOpen"), None, "{status_after}");
}
