//! The move of the daemon's own secrets between the login keychain and the logged-out service's
//! items file: a refused move back changes nothing, and a move into the files serves a start that
//! runs while the person is logged out.

use std::sync::atomic::Ordering;
use std::time::Duration;

use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::daemon::secrets_place::SecretsMoveDestination;
use sidekicks_platforms::CredentialStore;

use super::sealed::NO_SEAL_SERVICE;
use super::{
    LOGGED_OUT, MOVING_IN, OPERATING_SYSTEM, RECORD, WORKFLOW, read_text, secret_items, stored,
};
use crate::credential_store::SecretKeychain;
use crate::credential_store::file::SecretItemsFile;
use crate::credential_store::items::os_service_name;
use crate::credential_store::os::TestStoreAccess;
use crate::credential_store::service::KeychainService;

// How a case keeps the move back from landing.
#[derive(Clone, Copy)]
enum Refusal {
    // The login keychain does not open.
    Locked,
    // The keychain refuses the item's copy.
    ItemRefused,
    // The record names the Linux plain file, outside the pair.
    PlainFileRecord,
}

/// A move back into the keychain that is refused leaves the record, the file and the keychain as
/// they were. Mutations: record the direction before the copies (`item_refused` reads the record
/// moving), delete the item before its copy reads back (`item_refused` loses the file's value), or
/// drop the pair's guard (`plain_file_record` moves the item into the keychain).
#[rstest]
#[case::locked(Refusal::Locked)]
#[case::item_refused(Refusal::ItemRefused)]
#[case::plain_file_record(Refusal::PlainFileRecord)]
#[tokio::test]
async fn a_move_back_the_keychain_refuses_changes_nothing(#[case] refusal: Refusal) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let record = match refusal {
        Refusal::Locked | Refusal::ItemRefused => LOGGED_OUT,
        Refusal::PlainFileRecord => NO_SEAL_SERVICE,
    };
    std::fs::write(folder.path().join(RECORD), record).expect("the test writes the record");
    SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW, None)
        .write("secret", &SecretString::from("value"))
        .await
        .expect("the test fills the file");
    let credentials = CredentialStore::in_memory();
    let workflow = os_service_name(folder.path(), KeychainService::WorkflowSecrets);
    let access = TestStoreAccess::new(credentials.clone());
    match refusal {
        Refusal::Locked => access.opens.store(false, Ordering::SeqCst),
        Refusal::ItemRefused => credentials.refuse_next_call(&workflow, "secret"),
        Refusal::PlainFileRecord => {}
    }
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    let moved = items.move_to(SecretsMoveDestination::OperatingSystem).await;

    assert!(moved.is_err());
    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(record)
    );
    let kept = SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW, None)
        .read("secret")
        .await
        .expect("the file reads");
    assert_eq!(
        kept.as_ref().map(ExposeSecret::expose_secret),
        Some("value")
    );
    assert_eq!(stored(&credentials, &workflow, "secret"), None);
}

/// A move into the files from the keychain, or from a move back the record names, leaves the
/// items in the file alone, the record settled there and the keychain empty, and a start running
/// while the person is logged out reads them. Mutations: skip the source's delete (`settled`: the
/// keychain still holds the item), skip the settled record (it reads moving), or take a recorded
/// move as settled at its source (`moving_back` answers with the record still moving).
#[rstest]
#[case::settled(OPERATING_SYSTEM)]
#[case::moving_back(MOVING_IN)]
#[tokio::test]
async fn a_move_into_the_files_serves_a_logged_out_start(#[case] record: &str) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    std::fs::write(folder.path().join(RECORD), record).expect("the test writes the record");
    let credentials = CredentialStore::in_memory();
    let workflow = os_service_name(folder.path(), KeychainService::WorkflowSecrets);
    if record == OPERATING_SYSTEM {
        credentials
            .write(&workflow, "secret", &SecretString::from("value"))
            .expect("the in-memory store answers");
    } else {
        SecretItemsFile::new(folder.path())
            .keychain(WORKFLOW, None)
            .write("secret", &SecretString::from("value"))
            .await
            .expect("the test fills the file");
    }
    let access = TestStoreAccess::new(credentials.clone());
    let items = secret_items(folder.path(), &access, false, Duration::from_secs(5));

    items
        .move_to(SecretsMoveDestination::LoggedOutServiceFile)
        .await
        .expect("the move lands");

    assert_eq!(
        read_text(&folder.path().join(RECORD)).as_deref(),
        Some(LOGGED_OUT)
    );
    let kept = SecretItemsFile::new(folder.path())
        .keychain(WORKFLOW, None)
        .read("secret")
        .await
        .expect("the file reads");
    assert_eq!(
        kept.as_ref().map(ExposeSecret::expose_secret),
        Some("value")
    );
    assert_eq!(stored(&credentials, &workflow, "secret"), None);
    let logged_out = secret_items(folder.path(), &access, true, Duration::from_secs(5));
    let served = logged_out
        .keychain(KeychainService::WorkflowSecrets)
        .read("secret")
        .await
        .expect("the logged-out start serves the file");
    assert_eq!(
        served.as_ref().map(ExposeSecret::expose_secret),
        Some("value")
    );
}
