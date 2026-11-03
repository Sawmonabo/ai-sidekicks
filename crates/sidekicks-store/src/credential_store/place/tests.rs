//! A move between two places that a call refuses partway, put back whole.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::daemon::secrets_place::{PlaceRecord, SecretsPlace, read_place_record};
use sidekicks_contracts::keychain::KeychainRefusalCause;

use super::{move_items, record_path, write_record};
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};

// One place's items by service and account, with the one account whose removal it refuses.
#[derive(Clone, Default)]
struct PlaceItems {
    items: Arc<Mutex<BTreeMap<(&'static str, String), String>>>,
    refused_removal: Option<&'static str>,
}

impl PlaceItems {
    fn values(&self) -> BTreeMap<(&'static str, String), String> {
        self.items.lock().expect("the items are readable").clone()
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
        let answer = if self.place.refused_removal == Some(account) {
            Err(KeychainRefusal::of_test_keychain(
                KeychainRefusalCause::Unavailable,
            ))
        } else {
            Ok(self
                .items()
                .remove(&(self.service, account.to_owned()))
                .is_some())
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
// the keychain alone and the record names the keychain settled. Killed by the record left
// mid-move, by the deleted item not written back, and by the copies left in the files.
#[tokio::test]
async fn a_move_refused_partway_is_put_back_at_its_start() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let path = record_path(folder.path());
    let start = PlaceRecord::settled(SecretsPlace::OperatingSystem);
    write_record(&path, &start)
        .await
        .expect("the test writes the record");
    let keychain = PlaceItems {
        refused_removal: Some("second"),
        ..PlaceItems::default()
    };
    let service = KeychainService::WorkflowSecrets.as_str();
    for account in ["first", "second"] {
        keychain
            .items
            .lock()
            .expect("the items are readable")
            .insert((service, account.to_owned()), format!("value-{account}"));
    }
    let before = keychain.values();
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
