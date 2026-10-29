use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::ProviderAccountCredentialSealRefusedDetails;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::sync::Notify;

use super::{ProviderTokenCustody, TokenAccountRegistration, TokenCustodyError};
use crate::account::registry::{MintedAccount, ProviderAccountRegistry, open_test_registry};
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::account::ProviderTokenStatusLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;

const PROVIDER: &str = "claude";

// An in-memory keychain service that answers a write with the refusal a test sets.
#[derive(Default)]
struct ScriptedKeychain {
    items: Mutex<BTreeMap<String, String>>,
    write_refusal: Mutex<Option<KeychainRefusalCause>>,
}

impl ScriptedKeychain {
    fn held(&self) -> BTreeMap<String, String> {
        lock(&self.items).clone()
    }
}

impl SecretKeychain for ScriptedKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        let refusal = *lock(&self.write_refusal);
        let answer = if let Some(cause) = refusal {
            Err(KeychainRefusal::of_test_keychain(cause))
        } else {
            lock(&self.items).insert(account.to_owned(), value.expose_secret().to_owned());
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        let held = lock(&self.items)
            .get(account)
            .cloned()
            .map(SecretString::from);
        async move { Ok(held) }.boxed()
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        let removed = lock(&self.items).remove(account).is_some();
        async move { Ok(removed) }.boxed()
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        let accounts = lock(&self.items).keys().cloned().collect();
        async move { Ok(accounts) }.boxed()
    }
}

// What the scripted status read answers.
#[derive(Clone, Copy)]
enum StatusAnswer {
    Accepts(ProviderAuthMode),
    Refuses,
    NeverAnswers,
}

// A provider's status read that answers as the test sets and counts its calls.
struct ScriptedStatusLegs {
    answer: Mutex<StatusAnswer>,
    calls: Mutex<usize>,
    // Woken by a read that never answers, once it is reached.
    stalled: Notify,
}

impl ProviderTokenStatusLegs for ScriptedStatusLegs {
    fn read_token_status<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>> {
        *lock(&self.calls) += 1;
        let answer = *lock(&self.answer);
        match answer {
            StatusAnswer::Accepts(mode) => async move { Ok(Some(mode)) }.boxed(),
            StatusAnswer::Refuses => async { Ok(None) }.boxed(),
            StatusAnswer::NeverAnswers => {
                self.stalled.notify_one();
                futures::future::pending().boxed()
            }
        }
    }
}

struct Fixture {
    _database: TestDatabase,
    data_folder: tempfile::TempDir,
    registry: Arc<ProviderAccountRegistry>,
    writer: Arc<DatabaseWriter>,
    keychain: Arc<ScriptedKeychain>,
    status_legs: Arc<ScriptedStatusLegs>,
    custody: Arc<ProviderTokenCustody>,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let (registry, writer) = open_test_registry(&database, data_folder.path()).await;
        let registry = Arc::new(registry);
        let keychain = Arc::new(ScriptedKeychain::default());
        let status_legs = Arc::new(ScriptedStatusLegs {
            answer: Mutex::new(StatusAnswer::Accepts(ProviderAuthMode::OauthToken)),
            calls: Mutex::new(0),
            stalled: Notify::new(),
        });
        let custody = Arc::new(ProviderTokenCustody::new(
            Arc::clone(&registry),
            Arc::clone(&keychain) as _,
            HashMap::from([(
                provider(),
                Arc::clone(&status_legs) as Arc<dyn ProviderTokenStatusLegs>,
            )]),
        ));
        Self {
            _database: database,
            data_folder,
            registry,
            writer,
            keychain,
            status_legs,
            custody,
        }
    }

    fn answer(&self, answer: StatusAnswer) {
        *lock(&self.status_legs.answer) = answer;
    }

    fn mint(&self) -> MintedAccount {
        self.registry
            .mint(provider())
            .expect("the account is minted")
    }

    // Registers a fresh account on `token`, the status read accepting it.
    async fn register(&self, name: &str, token: &str) -> ProviderAccountId {
        let minted = self.mint();
        self.custody
            .register(
                &minted,
                &folders(&minted),
                registration(name),
                &secret(token),
            )
            .await
            .expect("the token is registered")
            .account_id
    }

    async fn mark_removal_intent(&self, account_id: &ProviderAccountId) {
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(
                    "UPDATE provider_accounts SET removal_intent = 1 WHERE account_id = @account_id",
                ),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@account_id",
                    account_id.as_str(),
                )]),
                expected_row_count: Some(1),
            }])
            .await
            .expect("the row is marked");
    }

    // Whether a row of `account_id` is stored, marked or not.
    async fn has_row(&self, account_id: &ProviderAccountId) -> bool {
        let accounts = self
            .registry
            .read_account_ids_by_removal_intent()
            .await
            .expect("the accounts read");
        accounts.registered.contains(account_id) || accounts.marked.contains(account_id)
    }
}

fn provider() -> ProviderId {
    ProviderId::new(PROVIDER.to_owned()).expect("a test provider id")
}

fn secret(text: &str) -> SecretString {
    SecretString::from(text)
}

fn registration(name: &str) -> TokenAccountRegistration {
    TokenAccountRegistration {
        display_label: serde_json::from_value(name.into()).expect("a test name"),
        billing_mode: BillingMode::Subscription,
    }
}

fn folders(minted: &MintedAccount) -> ProviderAccountFolders {
    let home = minted.home().path().to_owned();
    ProviderAccountFolders {
        configuration_folder: home.clone(),
        credential_store_folder: home,
    }
}

// Every file and folder under `root`, each file with its bytes.
fn snapshot(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    let mut entries = BTreeMap::new();
    let mut folders = vec![root.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).expect("the folder reads") {
            let path = entry.expect("the entry reads").path();
            let name = path
                .strip_prefix(root)
                .expect("under the root")
                .to_string_lossy()
                .into();
            if path.is_dir() {
                entries.insert(name, None);
                folders.push(path);
            } else {
                entries.insert(name, Some(std::fs::read(&path).expect("the file reads")));
            }
        }
    }
    entries
}

// Where table T4 leaves a crash: an item sealed before its row was written, a row marked for
// removal with its item, and a marked row whose item is already gone.
#[derive(Clone, Copy)]
enum CrashPoint {
    SealedBeforeTheRow,
    MarkedWithItsItem,
    MarkedAfterItsItemWent,
}

/// Each crash point is finished by the start's sweep: the stranded item destroyed and the marked
/// row deleted, the account's home left on disk, and a registered account's item and row kept. A
/// registration stopped inside its status read has sealed its item and written no row. Fails when
/// the row is written before the seal (a row stands at the stop) and when the sweep skips marked
/// rows (their item or row survives it).
#[rstest]
#[case::sealed_before_the_row(CrashPoint::SealedBeforeTheRow)]
#[case::marked_with_its_item(CrashPoint::MarkedWithItsItem)]
#[case::marked_after_its_item_went(CrashPoint::MarkedAfterItsItemWent)]
#[tokio::test]
async fn the_start_sweep_finishes_every_crash_point(#[case] crash_point: CrashPoint) {
    let fixture = Fixture::new().await;
    let kept = fixture.register("Kept", "kept-token").await;

    let minted = fixture.mint();
    let account_id = minted.account_id().clone();
    let home = minted.home().path().to_owned();
    match crash_point {
        CrashPoint::SealedBeforeTheRow => {
            fixture.answer(StatusAnswer::NeverAnswers);
            let custody = Arc::clone(&fixture.custody);
            let registration_task = tokio::spawn(async move {
                custody
                    .register(
                        &minted,
                        &folders(&minted),
                        registration("Stopped"),
                        &secret("t"),
                    )
                    .await
                    .map(drop)
            });
            fixture.status_legs.stalled.notified().await;
            registration_task.abort();
            assert!(
                registration_task
                    .await
                    .is_err_and(|ended| ended.is_cancelled())
            );
            assert!(
                !fixture.has_row(&account_id).await,
                "no row before the status read ends"
            );
            assert!(fixture.keychain.held().contains_key(account_id.as_str()));
        }
        CrashPoint::MarkedWithItsItem | CrashPoint::MarkedAfterItsItemWent => {
            fixture
                .custody
                .register(
                    &minted,
                    &folders(&minted),
                    registration("Removed"),
                    &secret("t"),
                )
                .await
                .expect("the token is registered");
            fixture.mark_removal_intent(&account_id).await;
            if matches!(crash_point, CrashPoint::MarkedAfterItsItemWent) {
                lock(&fixture.keychain.items).remove(account_id.as_str());
            }
        }
    }
    let home_before = snapshot(&home);

    fixture.custody.sweep().await.expect("the sweep runs");

    assert!(!fixture.keychain.held().contains_key(account_id.as_str()));
    assert!(!fixture.has_row(&account_id).await);
    assert_eq!(
        snapshot(&home),
        home_before,
        "the home stays on disk as it was"
    );
    assert_eq!(
        fixture
            .keychain
            .held()
            .get(kept.as_str())
            .map(String::as_str),
        Some("kept-token")
    );
    fixture
        .registry
        .read(kept)
        .await
        .expect("the registered account stays");
}

/// A locked and an unavailable keychain each refuse the registration with
/// `provider.account.credentialSealRefused` and their own cause, before any status read, and no
/// file under the data folder changes and no row is written. Fails when a refused seal falls back
/// to a write anywhere else, and when the cause is not carried.
#[rstest]
#[case::locked(KeychainRefusalCause::Locked)]
#[case::unavailable(KeychainRefusalCause::Unavailable)]
#[tokio::test]
async fn a_refused_seal_answers_its_cause_and_writes_nothing(#[case] cause: KeychainRefusalCause) {
    let fixture = Fixture::new().await;
    let minted = fixture.mint();
    let before = snapshot(fixture.data_folder.path());
    *lock(&fixture.keychain.write_refusal) = Some(cause);

    let refused = fixture
        .custody
        .register(
            &minted,
            &folders(&minted),
            registration("Sealed"),
            &secret("token"),
        )
        .await
        .expect_err("a token the keychain refuses is not registered");

    assert!(matches!(refused, TokenCustodyError::Sealing(_)));
    let HandlerError::Refused(refusal) = HandlerError::from(refused) else {
        panic!("a seal refusal answers a refusal");
    };
    assert_eq!(
        refusal.code,
        RefusalCode::ProviderAccountCredentialSealRefused
    );
    assert_eq!(
        refusal.detail.map(serde_json::Value::Object),
        Some(
            serde_json::to_value(ProviderAccountCredentialSealRefusedDetails { cause })
                .expect("the details write")
        )
    );
    assert_eq!(snapshot(fixture.data_folder.path()), before);
    assert!(fixture.keychain.held().is_empty());
    assert!(!fixture.has_row(minted.account_id()).await);
    assert_eq!(*lock(&fixture.status_legs.calls), 0);
}

/// A token is registered with the mode its status read observed, and a re-supply the provider
/// refuses changes nothing, while one it accepts replaces the sealed token, destroying the prior
/// one, and raises the generation; no file in the account's home changes throughout. Fails when a
/// re-supply leaves the prior token sealed, when a refused one replaces it, and when the token is
/// written into the home.
#[tokio::test]
async fn a_resupply_replaces_the_sealed_token_and_never_touches_the_home() {
    let fixture = Fixture::new().await;
    let minted = fixture.mint();
    let home_before = snapshot(minted.home().path());
    let account = fixture
        .custody
        .register(
            &minted,
            &folders(&minted),
            registration("Pasted"),
            &secret("first"),
        )
        .await
        .expect("the token is registered");
    assert_eq!(
        account.observed_auth_mode,
        Some(ProviderAuthMode::OauthToken)
    );
    assert_eq!(
        account.health.map(|health| health.state),
        Some(ProviderAccountHealthState::Authenticated)
    );
    let account_id = account.account_id;

    fixture.answer(StatusAnswer::Refuses);
    let refused = fixture
        .custody
        .replace(account_id.clone(), &folders(&minted), &secret("second"))
        .await
        .expect_err("a token the provider refuses replaces nothing");
    assert!(matches!(refused, TokenCustodyError::NotAccepted));
    assert_eq!(
        fixture.keychain.held(),
        BTreeMap::from([(account_id.as_str().to_owned(), "first".to_owned())])
    );

    fixture.answer(StatusAnswer::Accepts(ProviderAuthMode::OauthToken));
    let replaced = fixture
        .custody
        .replace(account_id.clone(), &folders(&minted), &secret("second"))
        .await
        .expect("the token is replaced");

    assert_eq!(
        fixture.keychain.held(),
        BTreeMap::from([(account_id.as_str().to_owned(), "second".to_owned())])
    );
    assert_eq!(
        serde_json::to_value(replaced.credential_generation).expect("the generation writes"),
        serde_json::json!(2)
    );
    assert_eq!(snapshot(minted.home().path()), home_before);
}
