use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{SealHeader, SealKey};

use super::{FileSecretKeychain, SealPass, SecretItemsFile};
use crate::credential_store::SecretKeychain;
use crate::credential_store::seal::TestSeal;

const SERVICE: &str = "ai-sidekicks-workflow-secrets";
const OTHER_SERVICE: &str = "ai-sidekicks-notification-secrets";

// The items of `service` in `items_file`, sealed through `seal` or plain.
fn keychain(
    items_file: &Arc<SecretItemsFile>,
    seal: Option<&Arc<TestSeal>>,
    service: &str,
) -> FileSecretKeychain {
    items_file.keychain(service, seal.map(|seal| Arc::clone(seal) as _))
}

/// A file this run cannot read refuses every call, names none of its values, and is left byte
/// for byte: one cut short, one with no form (an older build's), and one in the other form,
/// so a sealed run never serves or rewrites a plain file, nor a plain run a sealed one.
/// Mutations: read an unparsable or formless file as holding nothing (a write then rewrites
/// it and every secret is lost); drop the form check (a sealed run then serves plain values).
#[rstest]
#[case::cut_short(
    false,
    r#"{"form":"plain","items":{"ai-sidekicks-workflow-secrets":{"secret":"hunter2""#
)]
#[case::no_form(false, r#"{"ai-sidekicks-workflow-secrets":{"secret":"hunter2"}}"#)]
#[case::plain_under_a_sealed_run(
    true,
    r#"{"form":"plain","items":{"ai-sidekicks-workflow-secrets":{"secret":"hunter2"}}}"#
)]
#[case::sealed_under_a_plain_run(
    false,
    r#"{"form":"sealed","items":{"ai-sidekicks-workflow-secrets":{"secret":"aHVudGVyMg=="}}}"#
)]
#[tokio::test]
async fn an_unreadable_items_file_refuses_every_call_and_is_left_byte_for_byte(
    #[case] is_sealed: bool,
    #[case] text: &str,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let seal = is_sealed.then(TestSeal::new);
    let items_file = SecretItemsFile::new(folder.path());
    std::fs::write(items_file.file_path(), text).expect("the test writes the file");
    let keychain = keychain(&items_file, seal.as_ref(), SERVICE);
    let value = SecretString::from("new-value");

    let refusals = [
        keychain.write("secret", &value).await.err(),
        keychain.read("secret").await.err(),
        keychain.remove("secret").await.err(),
    ];
    for refusal in refusals {
        let refusal = refusal.expect("an unreadable items file refuses the call");
        assert_eq!(refusal.cause(), KeychainRefusalCause::Unavailable);
        let mut chain: Vec<String> = vec![refusal.to_string(), format!("{refusal:?}")];
        let mut source = refusal.source();
        while let Some(failure) = source {
            chain.push(failure.to_string());
            chain.push(format!("{failure:?}"));
            source = failure.source();
        }
        assert!(chain.iter().all(|text| !text.contains("hunter2")));
    }
    assert_eq!(
        std::fs::read(items_file.file_path()).expect("the file is still there"),
        text.as_bytes()
    );
}

/// Two services' writes joined on one file are both kept and read back, and a sealed file
/// holds neither value as written. Mutations: give each keychain its own lock (or none), so
/// the second write replaces the first's value; keep the value in place of its sealed blob.
#[rstest]
#[case::plain(false)]
#[case::sealed(true)]
#[tokio::test]
async fn joined_writes_from_two_services_on_one_file_are_both_kept(#[case] is_sealed: bool) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let seal = is_sealed.then(TestSeal::new);
    let items_file = SecretItemsFile::new(folder.path());
    let workflow_secrets = keychain(&items_file, seal.as_ref(), SERVICE);
    let other_secrets = keychain(&items_file, seal.as_ref(), OTHER_SERVICE);
    let (first, second) = (
        SecretString::from("first-value"),
        SecretString::from("second-value"),
    );

    let (first_write, second_write) = tokio::join!(
        workflow_secrets.write("secret", &first),
        other_secrets.write("secret", &second),
    );
    first_write.expect("the first write is kept");
    second_write.expect("the second write is kept");

    let first_read = workflow_secrets
        .read("secret")
        .await
        .expect("the file reads");
    let second_read = other_secrets.read("secret").await.expect("the file reads");
    assert_eq!(
        first_read.as_ref().map(ExposeSecret::expose_secret),
        Some("first-value")
    );
    assert_eq!(
        second_read.as_ref().map(ExposeSecret::expose_secret),
        Some("second-value")
    );
    let text = std::fs::read_to_string(items_file.file_path()).expect("the test reads the file");
    assert_eq!(
        !text.contains("first-value") && !text.contains("second-value"),
        is_sealed
    );
}

/// A sealed write held past its caller's time, then a retry with another value: the retry
/// seals only after the late write lands, so the item holds the retry's value. Mutation: hold
/// no item from the seal through the file write, so the retry lands first and the late write
/// overwrites it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_seal_lands_before_the_retry_and_never_overwrites_it() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let seal = TestSeal::new();
    let keychain = Arc::new(keychain(
        &SecretItemsFile::new(folder.path()),
        Some(&seal),
        SERVICE,
    ));
    let release = seal.hold_next_seal();

    let scenario = async {
        let first = SecretString::from("first");
        let late =
            tokio::time::timeout(Duration::from_millis(200), keychain.write("secret", &first));
        let (late, ()) = tokio::join!(late, seal.wait_for_seals(1));
        assert!(late.is_err(), "the held write is given up");
        let retry = tokio::spawn({
            let keychain = Arc::clone(&keychain);
            async move {
                keychain
                    .write("secret", &SecretString::from("second"))
                    .await
            }
        });
        // Long enough for a retry that took the item to reach the seal.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let seals_before_release = seal.seals();
        drop(release);
        let retry = retry.await.expect("the retry's task ends");
        (retry, seals_before_release)
    };
    let (retry, seals_before_release) = tokio::time::timeout(Duration::from_secs(5), scenario)
        .await
        .expect("every call answers within its time");

    retry.expect("the retry is written once the late write lands");
    assert_eq!(seals_before_release, 1);
    let kept = keychain.read("secret").await.expect("the file reads");
    assert_eq!(
        kept.as_ref().map(ExposeSecret::expose_secret),
        Some("second")
    );
}

/// A pass sealing a plain file again whose new blob would be weaker than the start's probe or
/// bound to the boot state is abandoned, the plain file left byte for byte. Mutation: drop the
/// pass's floor check, so the file is sealed downward.
#[rstest]
#[case::weaker_key(SealKey::SystemKey, 0)]
#[case::bound_to_the_boot_state(SealKey::Chip, 1 << 7)]
#[tokio::test]
async fn a_pass_that_would_seal_downward_is_abandoned(#[case] key: SealKey, #[case] pcr_mask: u64) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    keychain(&SecretItemsFile::new(folder.path()), None, SERVICE)
        .write("secret", &SecretString::from("value"))
        .await
        .expect("the test fills the file");
    let bytes_before = std::fs::read(folder.path().join("secrets.json")).expect("it is there");
    let seal = TestSeal::new();
    seal.seal_with(key, pcr_mask);
    let probe = SealHeader::read(&SealHeader::test_blob(SealKey::Chip, 0, b"probe"))
        .expect("the test blob has a header");

    let pass = SecretItemsFile::new(folder.path())
        .seal_again(Arc::clone(&seal) as _, probe, Duration::from_secs(5))
        .await
        .expect("the file reads");

    assert!(matches!(pass, SealPass::Abandoned(_)), "{pass:?}");
    assert_eq!(
        std::fs::read(folder.path().join("secrets.json")).expect("it is there"),
        bytes_before
    );
}

/// Mutation: skip the leftovers' removal, so a write cut short leaves every value it held on
/// disk.
#[tokio::test]
async fn the_first_call_removes_a_cut_short_writes_leftover() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let leftover = folder.path().join("secrets.json.a1b2c3.tmp");
    std::fs::write(&leftover, b"{}").expect("the test writes a leftover");

    let keychain = keychain(&SecretItemsFile::new(folder.path()), None, SERVICE);
    let read = keychain
        .read("secret")
        .await
        .expect("a missing file reads as empty");

    assert!(read.is_none());
    assert!(!leftover.exists());
}
