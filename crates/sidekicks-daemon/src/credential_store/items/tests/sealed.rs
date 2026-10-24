//! The Linux places: the items file sealed through systemd's credential service, or plain with its
//! reason, over a test's seal.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::daemon::status::{
    DaemonSecretsFileUnopened as Unopened, DaemonSecretsPlainReason as Reason,
    DaemonSecretsProtection as Protection,
};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{SealKey, SecretStoreOffer, secret_store_offer};

use super::{ITEMS, RECORD, WORKFLOW, read_text, secret_items, write_and_read};
use crate::credential_store::SecretKeychain;
use crate::credential_store::file::SecretItemsFile;
use crate::credential_store::items::{SecretItems, SecretItemsStart};
use crate::credential_store::os::{SystemCredentialStore, TestStoreAccess};
use crate::credential_store::place::SecretsPlace;
use crate::credential_store::seal::{TestSeal, TestSealAnswer};
use crate::credential_store::service::KeychainService;
use crate::random_hex::random_hex;

const SEALED: &str = r#"{"place":{"kind":"sealedFile"}}"#;
const NO_SEAL_SERVICE: &str = r#"{"place":{"kind":"plainFile","reason":"noSealService"}}"#;
const SEAL_FAILED: &str = r#"{"place":{"kind":"plainFile","reason":"sealFailed"}}"#;
const BOOT_BOUND: &str = r#"{"place":{"kind":"plainFile","reason":"bootBound"}}"#;

// The mask of a seal bound to PCR 7, the Secure Boot state.
const PCR_7: u64 = 1 << 7;

// A call time whose check's share a held seal outlasts, the call still answering in it.
const HELD_CALL_TIMEOUT: Duration = Duration::from_millis(600);

// The item each case files before the start, beside the one its call writes.
const EARLIER: &str = "earlier";

// What the items file holds before the start.
#[derive(Clone, Copy)]
enum Before {
    Nothing,
    Plain,
    // One item sealed with the key.
    Sealed(SealKey),
}

// How the test's seal answers from the start on.
#[derive(Clone, Copy)]
struct SealNow {
    answer: TestSealAnswer,
    key: SealKey,
    pcr_mask: u64,
    // Whether the blobs sealed before the start no longer open, as under a lost key.
    forgets: bool,
}

impl SealNow {
    const fn serves(key: SealKey) -> Self {
        Self {
            answer: TestSealAnswer::Serves,
            key,
            pcr_mask: 0,
            forgets: false,
        }
    }

    const fn bound() -> Self {
        Self {
            pcr_mask: PCR_7,
            ..Self::serves(SealKey::Chip)
        }
    }

    const fn forgets(key: SealKey) -> Self {
        Self {
            forgets: true,
            ..Self::serves(key)
        }
    }

    const fn answers(answer: TestSealAnswer) -> Self {
        Self {
            answer,
            ..Self::serves(SealKey::Chip)
        }
    }

    fn apply(self, seal: &TestSeal) {
        seal.seal_with(self.key, self.pcr_mask);
        if self.forgets {
            seal.forget_the_blobs_sealed_so_far();
        }
        seal.answer(self.answer);
    }
}

// What the items file holds after the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum After {
    Absent,
    // Byte for byte as it was before the start.
    Unchanged,
    // In the form named.
    Form(&'static str),
}

type Status = Option<(Protection, Option<Reason>, Option<Unopened>)>;

const fn refuses(error: &'static str, errno: Option<i64>) -> SealNow {
    SealNow::answers(TestSealAnswer::Refuses { error, errno })
}

// Files `before` in `folder` through `seal`, sealing with its key at the time.
async fn file_before(folder: &Path, seal: &Arc<TestSeal>, before: Before) {
    let seal = match before {
        Before::Nothing => return,
        Before::Plain => None,
        Before::Sealed(key) => {
            seal.seal_with(key, 0);
            Some(Arc::clone(seal) as _)
        }
    };
    SecretItemsFile::new(folder)
        .keychain(WORKFLOW, seal)
        .write(EARLIER, &SecretString::from("earlier value"))
        .await
        .expect("the test fills the file");
}

// The items file's form, `None` when there is none.
fn form(folder: &Path) -> Option<String> {
    let text = read_text(&folder.join(ITEMS))?;
    let file: serde_json::Value = serde_json::from_str(&text).expect("the file is JSON");
    file["form"].as_str().map(str::to_owned)
}

async fn status(items: &SecretItems) -> Status {
    items
        .secrets_file()
        .await
        .expect("the path is a wire path")
        .map(|file| (file.protection, file.reason, file.cannot_open))
}

/// Every Linux pick: a first start through the probe (sealed bound to no boot state, plain for the
/// boot state, for no service, or for a refusal from the three that mean the service cannot seal
/// here, and any other failure refusing the call with nothing recorded), and a later start keeping
/// its record (a sealed file that cannot open refused with its cause and left byte for byte, a
/// chip item failing under a probe without the chip read as the chip off, an item failing under
/// the probe's own key as the key changed, a plain file sealed once the service seals unbound, an
/// item sealed with the system key sealed again with the chip). Mutations: drop the allow-list (any
/// refusal then picks the plain file); read every refusal as definite; read a bound probe as
/// sealed; read every failing item as `keyChanged`, or every chip item as `chipUnavailable`; keep a
/// plain record when the service seals; skip the upward re-seal; write the record before the open.
#[rstest]
#[case::first_start_sealed_with_the_chip(
    None, Before::Nothing, SealNow::serves(SealKey::Chip),
    Ok(()), Some(SEALED), After::Form("sealed"),
    Some((Protection::SealedWithChip, None, None))
)]
#[case::first_start_sealed_with_the_system_key(
    None, Before::Nothing, SealNow::serves(SealKey::SystemKey),
    Ok(()), Some(SEALED), After::Form("sealed"),
    Some((Protection::SealedWithSystemKey, None, None))
)]
#[case::first_start_bound_to_the_boot_state(
    None, Before::Nothing, SealNow::bound(),
    Ok(()), Some(BOOT_BOUND), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::BootBound), None))
)]
#[case::first_start_without_the_service(
    None, Before::Nothing, SealNow::answers(TestSealAnswer::Absent),
    Ok(()), Some(NO_SEAL_SERVICE), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::NoSealService), None))
)]
#[case::first_start_for_no_such_user(
    None, Before::Nothing, refuses("io.systemd.Credentials.NoSuchUser", None),
    Ok(()), Some(SEAL_FAILED), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::SealFailed), None))
)]
#[case::first_start_without_a_key(
    None, Before::Nothing, refuses("io.systemd.System", Some(131)),
    Ok(()), Some(SEAL_FAILED), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::SealFailed), None))
)]
#[case::first_start_without_the_cryptography(
    None, Before::Nothing, refuses("io.systemd.System", Some(95)),
    Ok(()), Some(SEAL_FAILED), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::SealFailed), None))
)]
#[case::first_start_with_another_system_error(
    None,
    Before::Nothing,
    refuses("io.systemd.System", Some(5)),
    Err(KeychainRefusalCause::Unavailable),
    None,
    After::Absent,
    None
)]
#[case::first_start_with_another_refusal(
    None,
    Before::Nothing,
    refuses("io.systemd.Credentials.BadFormat", None),
    Err(KeychainRefusalCause::Unavailable),
    None,
    After::Absent,
    None
)]
#[case::recorded_sealed_that_opens(
    Some(SEALED), Before::Sealed(SealKey::Chip), SealNow::serves(SealKey::Chip),
    Ok(()), Some(SEALED), After::Form("sealed"),
    Some((Protection::SealedWithChip, None, None))
)]
#[case::recorded_sealed_without_the_service(
    Some(SEALED), Before::Sealed(SealKey::Chip), SealNow::answers(TestSealAnswer::Absent),
    Err(KeychainRefusalCause::Unavailable), Some(SEALED), After::Unchanged,
    Some((Protection::SealedWithChip, None, Some(Unopened::SealServiceMissing)))
)]
#[case::recorded_sealed_with_a_failing_service(
    Some(SEALED), Before::Sealed(SealKey::Chip), refuses("io.systemd.System", Some(5)),
    Err(KeychainRefusalCause::Unavailable), Some(SEALED), After::Unchanged,
    Some((Protection::SealedWithChip, None, Some(Unopened::SealServiceFailing)))
)]
#[case::recorded_sealed_whose_chip_is_off(
    Some(SEALED), Before::Sealed(SealKey::Chip), SealNow::forgets(SealKey::SystemKey),
    Err(KeychainRefusalCause::Unavailable), Some(SEALED), After::Unchanged,
    Some((Protection::SealedWithChip, None, Some(Unopened::ChipUnavailable)))
)]
#[case::recorded_sealed_whose_chip_key_changed(
    Some(SEALED), Before::Sealed(SealKey::Chip), SealNow::forgets(SealKey::Chip),
    Err(KeychainRefusalCause::Unavailable), Some(SEALED), After::Unchanged,
    Some((Protection::SealedWithChip, None, Some(Unopened::KeyChanged)))
)]
#[case::recorded_sealed_whose_system_key_changed(
    Some(SEALED), Before::Sealed(SealKey::SystemKey), SealNow::forgets(SealKey::SystemKey),
    Err(KeychainRefusalCause::Unavailable), Some(SEALED), After::Unchanged,
    Some((Protection::SealedWithSystemKey, None, Some(Unopened::KeyChanged)))
)]
#[case::recorded_system_key_sealed_again_with_the_chip(
    Some(SEALED), Before::Sealed(SealKey::SystemKey), SealNow::serves(SealKey::Chip),
    Ok(()), Some(SEALED), After::Form("sealed"),
    Some((Protection::SealedWithChip, None, None))
)]
#[case::recorded_plain_sealed_once_the_service_seals(
    Some(NO_SEAL_SERVICE), Before::Plain, SealNow::serves(SealKey::Chip),
    Ok(()), Some(SEALED), After::Form("sealed"),
    Some((Protection::SealedWithChip, None, None))
)]
#[case::recorded_plain_whose_service_binds_the_boot_state(
    Some(NO_SEAL_SERVICE), Before::Plain, SealNow::bound(),
    Ok(()), Some(BOOT_BOUND), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::BootBound), None))
)]
#[case::recorded_plain_without_the_service(
    Some(BOOT_BOUND), Before::Plain, SealNow::answers(TestSealAnswer::Absent),
    Ok(()), Some(BOOT_BOUND), After::Form("plain"),
    Some((Protection::Plain, Some(Reason::BootBound), None))
)]
#[tokio::test]
async fn the_start_picks_and_keeps_the_linux_secrets_place(
    #[case] record: Option<&str>,
    #[case] before: Before,
    #[case] seal_now: SealNow,
    #[case] served: Result<(), KeychainRefusalCause>,
    #[case] record_after: Option<&str>,
    #[case] after: After,
    #[case] status_after: Status,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    if let Some(record) = record {
        std::fs::write(folder.path().join(RECORD), record).expect("the test writes the record");
    }
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, before).await;
    let bytes_before = std::fs::read(folder.path().join(ITEMS)).ok();
    seal_now.apply(&seal);
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
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
    match after {
        After::Absent => assert!(!folder.path().join(ITEMS).exists()),
        After::Unchanged => assert_eq!(std::fs::read(folder.path().join(ITEMS)).ok(), bytes_before),
        After::Form(expected) => assert_eq!(form(folder.path()).as_deref(), Some(expected)),
    }
    if matches!(before, Before::Plain | Before::Sealed(_)) && served.is_ok() {
        let earlier = items
            .keychain(KeychainService::WorkflowSecrets)
            .read(EARLIER)
            .await
            .expect("the earlier item reads");
        assert_eq!(
            earlier.as_ref().map(ExposeSecret::expose_secret),
            Some("earlier value")
        );
    }
    assert_eq!(status(&items).await, status_after);
}

/// A pass that sealed the file and stopped before its record leaves a sealed file under a plain
/// record: the next start moves the record with no seal but the probe's, and the file is left
/// byte for byte. Mutation: read the form through the plain file's reader, which refuses it, or
/// seal the file again.
#[tokio::test]
async fn a_sealed_file_under_a_plain_record_moves_the_record_and_seals_nothing() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), NO_SEAL_SERVICE).expect("the test writes it");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    let bytes_before = std::fs::read(folder.path().join(ITEMS)).expect("the file is there");
    let seals_before = seal.seals();
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );

    let earlier = items
        .keychain(KeychainService::WorkflowSecrets)
        .read(EARLIER)
        .await
        .expect("the sealed file opens");

    assert_eq!(
        earlier.as_ref().map(ExposeSecret::expose_secret),
        Some("earlier value")
    );
    assert_eq!(seal.seals() - seals_before, 1, "only the probe seals");
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(SEALED)
    );
    assert_eq!(
        std::fs::read(folder.path().join(ITEMS)).expect("the file is there"),
        bytes_before
    );
}

/// A pass sealing a plain file that runs past a call's time keeps running once that call refuses,
/// and a later call waits for it and is served from the sealed file, one pass having run.
/// Mutation: run the pass inside the call's time, so each call drops it and starts it over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seal_pass_longer_than_a_call_lands_once() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), NO_SEAL_SERVICE).expect("the test writes it");
    let plain = SecretItemsFile::new(folder.path()).keychain(WORKFLOW, None);
    for account in [EARLIER, "second", "third"] {
        plain
            .write(account, &SecretString::from("earlier value"))
            .await
            .expect("the test fills the file");
    }
    let seal = TestSeal::new();
    // Three items' seals, 360 ms in all, outlast the 300 ms call; the probe's are not delayed.
    seal.delay_seals_under(WORKFLOW, Duration::from_millis(120));
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_millis(300),
    );
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    let scenario = async {
        let first = keychain
            .read(EARLIER)
            .await
            .map_err(|refusal| refusal.cause());
        seal.wait_for_seals(4).await;
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
    assert_eq!(seal.seals(), 5, "two probes and one seal per item");
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(SEALED)
    );
    assert_eq!(form(folder.path()).as_deref(), Some("sealed"));
}

/// A sealed file whose key changed refuses read, write and the account list, latched for the run
/// with no further seal or unseal, while one whose service is gone checks again at each call and is
/// served once it returns. Mutations: drop the latch, so the next call probes again; latch every
/// cause, so the returned service is never used.
#[tokio::test]
async fn a_changed_key_is_latched_and_a_missing_service_is_checked_again() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    seal.forget_the_blobs_sealed_so_far();
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );
    let keychain = items.keychain(KeychainService::WorkflowSecrets);

    let read = keychain
        .read(EARLIER)
        .await
        .map_err(|refusal| refusal.cause());
    let calls = (seal.seals(), seal.unseals());
    let write = keychain
        .write("secret", &SecretString::from("value"))
        .await
        .map_err(|refusal| refusal.cause());
    let accounts = keychain.accounts().await.map_err(|refusal| refusal.cause());

    assert_eq!(read.err(), Some(KeychainRefusalCause::Unavailable));
    assert_eq!(write, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(accounts.err(), Some(KeychainRefusalCause::Unavailable));
    assert_eq!(
        (seal.seals(), seal.unseals()),
        calls,
        "the latch calls no seal"
    );

    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    seal.answer(TestSealAnswer::Absent);
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );

    let missing = write_and_read(&items, "secret", "value").await;
    seal.answer(TestSealAnswer::Serves);
    let served = write_and_read(&items, "secret", "value").await;

    assert_eq!(missing, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(served, Ok(Some("value".to_owned())));
    assert_eq!(
        status(&items).await,
        Some((Protection::SealedWithChip, None, None))
    );
}

/// The status read names the cause the run holds while a call checks the sealed file again, and
/// waits for none of it. Mutation: read the place through the run's lock with a fallback, so a
/// read during the check drops the cause.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_status_keeps_the_cause_while_a_call_checks_again() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    SealNow::forgets(SealKey::SystemKey).apply(&seal);
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );

    let first = write_and_read(&items, "secret", "value").await;
    let seals = seal.seals();
    let release = seal.hold_next_seal();
    let status_while_checking = async {
        seal.wait_for_seals(seals + 1).await;
        let status_now = status(&items).await;
        drop(release);
        status_now
    };
    let scenario = async {
        tokio::join!(
            write_and_read(&items, "secret", "value"),
            status_while_checking
        )
    };
    let (second, status_now) = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");

    assert_eq!(first, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(second, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(
        status_now,
        Some((
            Protection::SealedWithChip,
            None,
            Some(Unopened::ChipUnavailable)
        ))
    );
}

/// A service that keeps another value than the probe gave it is refused for the run, nothing
/// recorded and no items file written. Mutations: drop the probe's compare; drop its latch.
#[tokio::test]
async fn a_seal_keeping_another_value_is_refused_for_the_run() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let seal = TestSeal::new();
    seal.keep_another_value(true);
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );

    let first = write_and_read(&items, "secret", "value").await;
    seal.keep_another_value(false);
    let second = write_and_read(&items, "secret", "value").await;

    assert_eq!(first, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(second, Err(KeychainRefusalCause::Unavailable));
    assert!(!folder.path().join(RECORD).exists());
    assert!(!folder.path().join(ITEMS).exists());
}

/// A probe that gets no answer in time refuses that call `unavailable`, since nothing on Linux can
/// be unlocked, and the next call probes again and is served. Mutations: answer every time-out
/// `locked`; keep the time-out's refusal for the run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seal_with_no_answer_in_time_refuses_that_call_unavailable() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let seal = TestSeal::new();
    let release = seal.hold_next_seal();
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_millis(300),
    );

    let scenario = async {
        let timed_out = write_and_read(&items, "secret", "value").await;
        drop(release);
        let served = write_and_read(&items, "secret", "value").await;
        (timed_out, served)
    };
    let (timed_out, served) = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");

    assert_eq!(timed_out, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(served, Ok(Some("value".to_owned())));
}

/// A recorded sealed file whose service gives no answer within the check's time refuses that call
/// `unavailable`, and the status names the service failing. Mutations: drop the probe's own time,
/// so the call's time runs out and drops the settle before it records why; skip recording the
/// cause.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sealed_file_whose_service_gives_no_answer_reads_as_failing() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    let release = seal.hold_next_seal();
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        HELD_CALL_TIMEOUT,
    );

    let scenario = async {
        let timed_out = write_and_read(&items, "secret", "value").await;
        (timed_out, status(&items).await)
    };
    let (timed_out, status_after) = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");
    drop(release);

    assert_eq!(timed_out, Err(KeychainRefusalCause::Unavailable));
    assert_eq!(
        status_after,
        Some((
            Protection::SealedWithChip,
            None,
            Some(Unopened::SealServiceFailing)
        ))
    );
}

/// The erase deletes a sealed items file without opening any item. Mutation: unseal each item
/// before the delete, or keep the file.
#[tokio::test]
async fn the_erase_deletes_a_sealed_file_opening_nothing() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        Duration::from_secs(5),
    );

    items
        .check_for_erase()
        .await
        .expect("Linux has no store to check");
    items.erase_all().await.expect("the file goes");

    assert!(!folder.path().join(ITEMS).exists());
    assert_eq!(seal.unseals(), 0);
}

// Where the relink meets a seal held past the check's time.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Held {
    Nowhere,
    // At the relink's own check.
    AtTheRelink,
    // At an earlier call, which recorded the cause this run holds.
    AtAnEarlierCall,
}

/// The relink's call empties a sealed file that cannot open, for every cause, with its record, and
/// picks the place again as at a first start; a place that opens is kept byte for byte. A service
/// that gives no answer is named failing within the check's time, and a cause this run already
/// holds empties the place without checking it again. Mutations: empty only under `keyChanged`;
/// keep the record, so the old place is kept; empty a file that opens; drop the check's own time;
/// settle again under a cause the run holds, so a service back since keeps the file.
#[rstest]
#[case::key_changed(
    SealNow::forgets(SealKey::Chip),
    Held::Nowhere,
    Ok(SecretsPlace::SealedFile),
    Some(SEALED),
    true
)]
#[case::chip_off(
    SealNow::forgets(SealKey::SystemKey),
    Held::Nowhere,
    Ok(SecretsPlace::SealedFile),
    Some(SEALED),
    true
)]
#[case::service_missing(
    SealNow::answers(TestSealAnswer::Absent), Held::Nowhere,
    Ok(SecretsPlace::PlainFile { reason: Reason::NoSealService }), Some(NO_SEAL_SERVICE), true
)]
#[case::service_failing(
    refuses("io.systemd.System", Some(5)),
    Held::Nowhere,
    Err(KeychainRefusalCause::Unavailable),
    None,
    true
)]
#[case::no_answer(
    SealNow::serves(SealKey::Chip),
    Held::AtTheRelink,
    Ok(SecretsPlace::SealedFile),
    Some(SEALED),
    true
)]
#[case::cause_held_from_an_earlier_call(
    SealNow::serves(SealKey::Chip),
    Held::AtAnEarlierCall,
    Ok(SecretsPlace::SealedFile),
    Some(SEALED),
    true
)]
#[case::opens(
    SealNow::serves(SealKey::Chip),
    Held::Nowhere,
    Ok(SecretsPlace::SealedFile),
    Some(SEALED),
    false
)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_relink_empties_a_sealed_file_that_cannot_open_and_picks_again(
    #[case] seal_now: SealNow,
    #[case] held: Held,
    #[case] picked_again: Result<SecretsPlace, KeychainRefusalCause>,
    #[case] record_after: Option<&str>,
    #[case] is_emptied: bool,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), SEALED).expect("the test writes the record");
    let seal = TestSeal::new();
    file_before(folder.path(), &seal, Before::Sealed(SealKey::Chip)).await;
    let bytes_before = std::fs::read(folder.path().join(ITEMS)).expect("the file is there");
    seal_now.apply(&seal);
    let call_timeout = match held {
        Held::Nowhere => Duration::from_secs(5),
        Held::AtTheRelink | Held::AtAnEarlierCall => HELD_CALL_TIMEOUT,
    };
    let items = secret_items(
        folder.path(),
        &TestStoreAccess::sealing(Arc::clone(&seal)),
        false,
        call_timeout,
    );

    let scenario = async {
        if held == Held::AtAnEarlierCall {
            let release = seal.hold_next_seal();
            let refused = write_and_read(&items, "secret", "value").await;
            assert_eq!(refused, Err(KeychainRefusalCause::Unavailable));
            drop(release);
        }
        let release = (held == Held::AtTheRelink).then(|| seal.hold_next_seal());
        let place = items.empty_place().await;
        drop(release);
        place
    };
    let place = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every step answers within its time");

    assert_eq!(place.map_err(|refusal| refusal.cause()), picked_again);
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        record_after
    );
    let bytes_after = std::fs::read(folder.path().join(ITEMS)).ok();
    if is_emptied {
        assert_eq!(bytes_after, None, "the file and its items are gone");
    } else {
        assert_eq!(bytes_after, Some(bytes_before));
    }
}

/// An item sealed through this machine's own systemd credential service, read back from the sealed
/// file, which never holds the value as written.
#[tokio::test]
#[ignore = "needs systemd 256 or newer with its credential service"]
async fn an_item_round_trips_through_systemds_credential_service() {
    let offer = secret_store_offer();
    assert!(
        matches!(offer, SecretStoreOffer::SealService(_)),
        "this machine offers systemd's credential service only on Linux"
    );
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let items = SecretItems::new(SecretItemsStart {
        data_folder: folder.path().to_path_buf(),
        runs_while_logged_out: false,
        access: Arc::new(SystemCredentialStore { offer }),
        call_timeout: Duration::from_secs(30),
    })
    .expect("the system gives random bytes");
    let value = format!(
        "live-{}",
        random_hex(8).expect("the system gives random bytes")
    );

    let kept = write_and_read(&items, "live-test", &value).await;

    assert_eq!(kept, Ok(Some(value.clone())));
    let record = read_text(&folder.path().join(RECORD)).expect("the place is recorded");
    assert!(record == SEALED || record == BOOT_BOUND, "{record}");
    if record == SEALED {
        let text = read_text(&folder.path().join(ITEMS)).expect("the file is there");
        assert!(!text.contains(&value));
    }
}
