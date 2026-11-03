//! A move between two places that a call refuses partway, put back whole.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rstest::rstest;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::daemon::secrets_place::{PlaceRecord, SecretsPlace, read_place_record};
use sidekicks_contracts::keychain::KeychainRefusalCause;

use super::{move_items, record_path, write_record};
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};

// How a place refuses an account's removal: before deleting its item, or after, as a delete that
// outlived its caller's wait and landed anyway does.
#[derive(Clone, Copy)]
enum RemovalRefusal {
    BeforeDelete,
    AfterDelete,
}

// One place's items by service and account, with the one account whose removal it refuses and
// how, and the one account whose write it refuses.
#[derive(Clone, Default)]
struct PlaceItems {
    items: Arc<Mutex<BTreeMap<(&'static str, String), String>>>,
    refused_removal: Option<(&'static str, RemovalRefusal)>,
    refused_write: Option<&'static str>,
}

impl PlaceItems {
    fn values(&self) -> BTreeMap<(&'static str, String), String> {
        self.items.lock().expect("the items are readable").clone()
    }

    // The place holding `value-<account>` for each of `accounts` under `service`.
    fn holding(&self, service: &'static str, accounts: &[&str]) -> &Self {
        let mut items = self.items.lock().expect("the items are readable");
        for account in accounts {
            items.insert((service, (*account).to_owned()), format!("value-{account}"));
        }
        drop(items);
        self
    }

    fn keychain(&self, service: KeychainService) -> Box<dyn SecretKeychain> {
        Box::new(ServiceItems {
            place: self.clone(),
            service: service.as_str(),
        })
    }
}

// One service's items in a place.
struct ServiceItems {
    place: PlaceItems,
    service: &'static str,
}

impl ServiceItems {
    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<(&'static str, String), String>> {
        self.place.items.lock().expect("the items are readable")
    }
}

impl SecretKeychain for ServiceItems {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        if self.place.refused_write == Some(account) {
            return Box::pin(async {
                Err(KeychainRefusal::of_test_keychain(
                    KeychainRefusalCause::Unavailable,
                ))
            });
        }
        let key = (self.service, account.to_owned());
        self.items().insert(key, value.expose_secret().to_owned());
        Box::pin(async { Ok(()) })
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        let value = self
            .items()
            .get(&(self.service, account.to_owned()))
            .cloned();
        Box::pin(async { Ok(value.map(SecretString::from)) })
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        let refusal = self
            .place
            .refused_removal
            .and_then(|(refused, refusal)| (refused == account).then_some(refusal));
        let was_held = !matches!(refusal, Some(RemovalRefusal::BeforeDelete))
            && self
                .items()
                .remove(&(self.service, account.to_owned()))
                .is_some();
        let answer = match refusal {
            None => Ok(was_held),
            Some(_) => Err(KeychainRefusal::of_test_keychain(
                KeychainRefusalCause::Unavailable,
            )),
        };
        Box::pin(async { answer })
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        let accounts = self
            .items()
            .keys()
            .filter(|(service, _)| *service == self.service)
            .map(|(_, account)| account.clone())
            .collect();
        Box::pin(async { Ok(accounts) })
    }
}

// A move from the keychain into the files whose second delete from the keychain is refused, so the
// record names the move and the first item is gone from its source, is put back: both items are in
// the keychain alone and the record names the keychain settled, the refused item too when its
// delete took effect. Killed by the record left mid-move, by the deleted item not written back, by
// the item whose delete was refused not written back, and by the copies left in the files.
#[rstest]
#[case::refused_before_its_delete(RemovalRefusal::BeforeDelete)]
#[case::refused_after_its_delete(RemovalRefusal::AfterDelete)]
#[tokio::test]
async fn a_move_refused_partway_is_put_back_at_its_start(#[case] removal_refusal: RemovalRefusal) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let path = record_path(folder.path());
    let start = PlaceRecord::settled(SecretsPlace::OperatingSystem);
    write_record(&path, &start)
        .await
        .expect("the test writes the record");
    let keychain = PlaceItems {
        refused_removal: Some(("second", removal_refusal)),
        ..PlaceItems::default()
    };
    let service = KeychainService::WorkflowSecrets.as_str();
    let before = keychain.holding(service, &["first", "second"]).values();
    let files = PlaceItems::default();
    let from = |service| Ok(keychain.keychain(service));
    let to = |service| Ok(files.keychain(service));

    let stopped = move_items(&path, start, SecretsPlace::LoggedOutServiceFile, &from, &to)
        .await
        .expect_err("the refused delete stops the move");

    assert_eq!(stopped.record, start);
    assert_eq!(
        read_place_record(&path).expect("the record reads"),
        Some(start)
    );
    assert_eq!(keychain.values(), before);
    assert!(files.values().is_empty(), "{:?}", files.values().keys());
    assert!(
        !stopped.refusal.reason().contains("put back"),
        "{}",
        stopped.refusal.reason()
    );
}

// The same move whose first item, deleted from the keychain, cannot be written back there: its
// copy in the files, the only one left, stays, and the record still names the move, which the next
// start finishes. Killed by the copy of an item not written back deleted all the same.
#[tokio::test]
async fn a_copy_whose_item_cannot_be_written_back_stays_with_the_move_recorded() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let path = record_path(folder.path());
    let start = PlaceRecord::settled(SecretsPlace::OperatingSystem);
    write_record(&path, &start)
        .await
        .expect("the test writes the record");
    let keychain = PlaceItems {
        refused_removal: Some(("second", RemovalRefusal::BeforeDelete)),
        refused_write: Some("first"),
        ..PlaceItems::default()
    };
    let service = KeychainService::WorkflowSecrets.as_str();
    keychain.holding(service, &["first", "second"]);
    let files = PlaceItems::default();
    let from = |service| Ok(keychain.keychain(service));
    let to = |service| Ok(files.keychain(service));

    let stopped = move_items(&path, start, SecretsPlace::LoggedOutServiceFile, &from, &to)
        .await
        .expect_err("the refused delete stops the move");

    let moving = PlaceRecord::moving(
        SecretsPlace::OperatingSystem,
        SecretsPlace::LoggedOutServiceFile,
    );
    assert_eq!(stopped.record, moving);
    assert_eq!(
        read_place_record(&path).expect("the record reads"),
        Some(moving)
    );
    assert_eq!(
        files.values().into_keys().collect::<Vec<_>>(),
        [(service, "first".to_owned())]
    );
    assert_eq!(
        keychain.values().into_keys().collect::<Vec<_>>(),
        [(service, "second".to_owned())]
    );
}
