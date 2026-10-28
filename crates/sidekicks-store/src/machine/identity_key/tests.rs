use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ed25519_dalek::SigningKey;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::daemon::status::{
    DaemonMachineKey, DaemonMachineKeyCause, DaemonMachineKeyState,
};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::trust_statement::{ChannelPublicKey, MachineIdentityKey};
use sidekicks_contracts::wire::base64::Base64Array;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use x25519_dalek::StaticSecret;

use super::{IdentityKeyError, KEY_LENGTH, MachineIdentity, MachinePublicKeys, PinnedKey};
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::schema::schema_parts;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::machine::local::LocalMachine;

// Fixed seeds, so a case knows the public halves its items make; their hex holds letters, so its
// uppercase form differs.
const IDENTITY_SEED: [u8; KEY_LENGTH] = [0xa7; KEY_LENGTH];
const CHANNEL_SEED: [u8; KEY_LENGTH] = [0xc9; KEY_LENGTH];
const OTHER_IDENTITY_SEED: [u8; KEY_LENGTH] = [11; KEY_LENGTH];
const OTHER_CHANNEL_SEED: [u8; KEY_LENGTH] = [13; KEY_LENGTH];

/// A credential store in memory that counts its reads and writes, and refuses the next read with
/// a cause it is given.
#[derive(Default)]
struct CountingKeychain {
    items: Mutex<HashMap<String, String>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
    refused_read: Mutex<Option<KeychainRefusalCause>>,
}

impl CountingKeychain {
    fn file(&self, account: String, text: String) {
        lock(&self.items).insert(account, text);
    }

    fn item(&self, account: &str) -> Option<String> {
        lock(&self.items).get(account).cloned()
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn writes(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }
}

impl SecretKeychain for CountingKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.file(account.to_owned(), value.expose_secret().to_owned());
        Box::pin(async { Ok(()) })
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let answer = match lock(&self.refused_read).take() {
            Some(cause) => Err(KeychainRefusal::new(cause, "the test store refuses")),
            None => Ok(self.item(account).map(SecretString::from)),
        };
        Box::pin(async move { answer })
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        let removed = lock(&self.items).remove(account).is_some();
        Box::pin(async move { Ok(removed) })
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        let accounts = lock(&self.items).keys().cloned().collect();
        Box::pin(async move { Ok(accounts) })
    }
}

/// A database holding this machine's row with the pins a test sets, and the store of its keys.
struct Fixture {
    database: TestDatabase,
    machine: LocalMachine,
    keychain: Arc<CountingKeychain>,
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl Fixture {
    async fn new(pins: (Option<Vec<u8>>, Option<Vec<u8>>)) -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let machine = LocalMachine {
            machine_id: machine_id(),
            owner_user_id: UserId::try_from(mint_uuid_v7()).expect("a minted UUID is a user id"),
            name: "desk".to_owned(),
        };
        database
            .reader()
            .execute(
                "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at,
                   identity_public_key, channel_public_key)
                 VALUES (1, ?1, ?2, 'desk', '2026-10-27T00:00:00.000Z', ?3, ?4)",
                params![
                    machine.machine_id.as_str(),
                    machine.owner_user_id.to_string(),
                    pins.0,
                    pins.1
                ],
            )
            .expect("the test stores this machine's row");
        Self {
            reads: Arc::new(DatabaseReadPool::new(database.path(), 0)),
            database,
            machine,
            keychain: Arc::new(CountingKeychain::default()),
            writer: Arc::new(writer),
        }
    }

    fn identity_account(&self) -> String {
        format!("identity-{}", self.machine.machine_id.as_str())
    }

    fn channel_account(&self) -> String {
        format!("channel-{}", self.machine.machine_id.as_str())
    }

    fn identity(&self) -> Arc<MachineIdentity> {
        MachineIdentity::with_keychain(
            &self.machine,
            Arc::clone(&self.keychain) as Arc<dyn SecretKeychain>,
            Arc::clone(&self.reads),
            Arc::clone(&self.writer),
        )
    }

    fn items(&self) -> (Option<String>, Option<String>) {
        (
            self.keychain.item(&self.identity_account()),
            self.keychain.item(&self.channel_account()),
        )
    }

    fn pins(&self) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
        self.database
            .reader()
            .query_row(
                "SELECT identity_public_key, channel_public_key FROM local_machine",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the test reads the pins")
    }
}

fn machine_id() -> MachineId {
    MachineId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a machine id")
}

fn hex(seed: &[u8; KEY_LENGTH]) -> String {
    base16ct::lower::encode_string(seed)
}

// The public halves the two seeds make.
fn public_halves(identity: &[u8; KEY_LENGTH], channel: &[u8; KEY_LENGTH]) -> ([u8; 32], [u8; 32]) {
    (
        SigningKey::from_seed(identity).public_half(),
        StaticSecret::from_seed(channel).public_half(),
    )
}

// The pins `keys` set.
fn pins_of(keys: &MachinePublicKeys) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let MachineIdentityKey::Ed25519 {
        public_key: identity,
    } = &keys.identity_key;
    let ChannelPublicKey::X25519 {
        public_key: channel,
    } = &keys.channel_key;
    (
        Some(identity.as_bytes().to_vec()),
        Some(channel.as_bytes().to_vec()),
    )
}

/// The pins before the first read.
#[derive(Clone, Copy, Debug)]
enum Pins {
    Unset,
    OfItems,
    OfOtherKeys,
    ThirtyOneBytes,
}

/// The two items before the first read, each made from its own seed.
#[derive(Clone, Copy, Debug)]
enum Items {
    Absent,
    Keys,
    Empty,
    ShortHex,
    UppercaseHex,
    Zeros,
}

impl Items {
    fn text(self, seed: &[u8; KEY_LENGTH]) -> Option<String> {
        match self {
            Self::Absent => None,
            Self::Keys => Some(hex(seed)),
            Self::Empty => Some(String::new()),
            Self::ShortHex => Some(hex(seed)[..62].to_owned()),
            Self::UppercaseHex => Some(hex(seed).to_uppercase()),
            Self::Zeros => Some("0".repeat(64)),
        }
    }
}

/// What the read finds.
#[derive(Clone, Copy, Debug)]
enum Expected {
    Minted,
    Adopted,
    Held,
    Refused(DaemonMachineKeyState, Option<DaemonMachineKeyCause>),
}

/// One read over each row of the pin-and-item table, read again once the first read ended: each
/// case's keys, items, pins, write count and status member. Killed by a mint on a lost key, an
/// overwrite of a changed one, the length check or the all-zero check dropped, a cache that is not
/// kept, and an error that names the item.
#[rstest]
#[case::mint(Pins::Unset, Items::Absent, Expected::Minted)]
#[case::adopt(Pins::Unset, Items::Keys, Expected::Adopted)]
#[case::held(Pins::OfItems, Items::Keys, Expected::Held)]
#[case::changed(
    Pins::OfOtherKeys,
    Items::Keys,
    Expected::Refused(DaemonMachineKeyState::Changed, None)
)]
#[case::lost(
    Pins::OfItems,
    Items::Absent,
    Expected::Refused(DaemonMachineKeyState::Lost, None)
)]
#[case::empty(
    Pins::Unset,
    Items::Empty,
    Expected::Refused(DaemonMachineKeyState::Changed, None)
)]
#[case::short(
    Pins::Unset,
    Items::ShortHex,
    Expected::Refused(DaemonMachineKeyState::Changed, None)
)]
#[case::uppercase(
    Pins::Unset,
    Items::UppercaseHex,
    Expected::Refused(DaemonMachineKeyState::Changed, None)
)]
#[case::all_zero(
    Pins::Unset,
    Items::Zeros,
    Expected::Refused(DaemonMachineKeyState::Changed, None)
)]
#[case::short_pin(
    Pins::ThirtyOneBytes,
    Items::Keys,
    Expected::Refused(DaemonMachineKeyState::Changed, Some(DaemonMachineKeyCause::StoredPin))
)]
#[tokio::test]
async fn a_read_mints_adopts_holds_or_refuses_as_the_pins_and_items_say(
    #[case] pins: Pins,
    #[case] items: Items,
    #[case] expected: Expected,
) {
    let (identity_half, channel_half) = public_halves(&IDENTITY_SEED, &CHANNEL_SEED);
    let pins_before = match pins {
        Pins::Unset => (None, None),
        Pins::OfItems => (Some(identity_half.to_vec()), Some(channel_half.to_vec())),
        Pins::OfOtherKeys => {
            let (identity, channel) = public_halves(&OTHER_IDENTITY_SEED, &OTHER_CHANNEL_SEED);
            (Some(identity.to_vec()), Some(channel.to_vec()))
        }
        Pins::ThirtyOneBytes => (Some(vec![1; 31]), Some(vec![1; 31])),
    };
    let fixture = Fixture::new(pins_before.clone()).await;
    let items_before = (items.text(&IDENTITY_SEED), items.text(&CHANNEL_SEED));
    if let Some(text) = &items_before.0 {
        fixture
            .keychain
            .file(fixture.identity_account(), text.clone());
    }
    if let Some(text) = &items_before.1 {
        fixture
            .keychain
            .file(fixture.channel_account(), text.clone());
    }
    let identity = fixture.identity();
    identity.stop().await;
    let reads_after_first = fixture.keychain.reads();

    let read = identity.key().await;

    let items_after = fixture.items();
    let pins_after = fixture.pins();
    let recorded = identity.machine_key().await;
    match expected {
        Expected::Minted => {
            let keys = read.expect("the keys are minted");
            let (Some(identity_item), Some(channel_item)) = &items_after else {
                panic!("both items are written");
            };
            let identity_seed = super::item_seed(&SecretString::from(identity_item.clone()))
                .expect("the identity item is a seed in lowercase hex");
            let channel_seed = super::item_seed(&SecretString::from(channel_item.clone()))
                .expect("the channel item is a seed in lowercase hex");
            let (identity, channel) = public_halves(&identity_seed, &channel_seed);
            assert_eq!(
                pins_after,
                (Some(identity.to_vec()), Some(channel.to_vec()))
            );
            assert_eq!(pins_of(&keys), pins_after);
            assert_eq!(fixture.keychain.writes(), 2);
            assert_eq!(fixture.keychain.reads(), reads_after_first);
            assert_eq!(recorded, None);
        }
        Expected::Adopted | Expected::Held => {
            let keys = read.expect("the stored keys are read");
            assert_eq!(
                keys,
                MachinePublicKeys {
                    identity_key: MachineIdentityKey::Ed25519 {
                        public_key: Base64Array::new(identity_half),
                    },
                    channel_key: ChannelPublicKey::X25519 {
                        public_key: Base64Array::new(channel_half),
                    },
                }
            );
            assert_eq!(
                pins_after,
                (Some(identity_half.to_vec()), Some(channel_half.to_vec()))
            );
            assert!(
                items_after == items_before,
                "the items are kept as they were"
            );
            assert_eq!(fixture.keychain.writes(), 0);
            assert_eq!(fixture.keychain.reads(), reads_after_first);
            assert_eq!(recorded, None);
        }
        Expected::Refused(state, cause) => {
            let error = read.expect_err("the read is refused");
            let machine_key = Some(DaemonMachineKey { state, cause });
            assert_eq!(error.machine_key(), machine_key);
            assert_eq!(recorded, machine_key);
            assert_eq!(pins_after, pins_before);
            assert!(
                items_after == items_before,
                "the items are kept as they were"
            );
            assert_eq!(fixture.keychain.writes(), 0);
            let texts: Vec<String> =
                std::iter::successors(Some(&error as &(dyn Error + 'static)), |&error| {
                    error.source()
                })
                .map(ToString::to_string)
                .collect();
            let item_texts = [items_before.0, items_before.1];
            assert!(
                !texts.iter().any(|text| {
                    item_texts
                        .iter()
                        .flatten()
                        .any(|item| !item.is_empty() && text.contains(item.as_str()))
                }),
                "no error text names an item"
            );
        }
    }
}

/// A store that refuses the first read as locked: the status member reads the start's refused read
/// without reading again, and a later read mints the keys. Killed by a cached refusal, and by a
/// status read that reads the store.
#[tokio::test]
async fn a_locked_first_read_is_reported_and_the_next_read_mints() {
    let fixture = Fixture::new((None, None)).await;
    *lock(&fixture.keychain.refused_read) = Some(KeychainRefusalCause::Locked);
    let identity = fixture.identity();

    assert_eq!(
        identity.machine_key().await,
        Some(DaemonMachineKey {
            state: DaemonMachineKeyState::NotMinted,
            cause: Some(DaemonMachineKeyCause::Locked),
        })
    );
    assert_eq!(fixture.keychain.reads(), 1);

    identity.stop().await;
    identity
        .key()
        .await
        .expect("the store answers, so the keys are minted");
    assert_eq!(identity.machine_key().await, None);
    assert_eq!(fixture.keychain.writes(), 2);
}

/// A relink whose pin write fails after both items landed: the next read adopts the new keys,
/// both of them. Killed by a relink that keeps the cache, one that sets the pins before writing
/// the items, and one that rotates only the identity key.
#[tokio::test]
async fn a_relink_stopped_before_its_pins_is_finished_by_the_next_read() {
    let fixture = Fixture::new((None, None)).await;
    let identity = fixture.identity();
    identity.stop().await;
    let first = identity.key().await.expect("the keys are minted");
    fixture
        .database
        .reader()
        .execute_batch(
            "CREATE TRIGGER pin_refused BEFORE UPDATE OF identity_public_key ON local_machine
             WHEN NEW.identity_public_key IS NOT NULL
             BEGIN SELECT RAISE(ABORT, 'the test refuses the pin'); END",
        )
        .expect("the test installs the refusing trigger");

    let refused = identity.mint_again().await;

    assert!(matches!(refused, Err(IdentityKeyError::Write(_))));
    assert_eq!(fixture.pins(), (None, None));
    fixture
        .database
        .reader()
        .execute_batch("DROP TRIGGER pin_refused")
        .expect("the test drops the trigger");
    let second = identity.key().await.expect("the relinked keys are adopted");
    assert_ne!(second.identity_key, first.identity_key);
    assert_ne!(second.channel_key, first.channel_key);
    assert_eq!(fixture.pins(), pins_of(&second));
}

/// Where a registration names a machine.
#[derive(Clone, Copy, Debug)]
enum Registration {
    Nothing,
    ThisMachine,
    AnotherMachine,
}

/// A sign-in mints both keys again only while this machine has no registration. Killed by the
/// registration read dropped, and by one that ignores the machine id.
#[rstest]
#[case::unregistered(Registration::Nothing, true)]
#[case::registered(Registration::ThisMachine, false)]
#[case::another_machine_registered(Registration::AnotherMachine, true)]
#[tokio::test]
async fn a_sign_in_mints_again_only_while_unregistered(
    #[case] registration: Registration,
    #[case] is_minted: bool,
) {
    let fixture = Fixture::new((None, None)).await;
    let identity = fixture.identity();
    identity.stop().await;
    let first = identity.key().await.expect("the keys are minted");
    let registered = match registration {
        Registration::Nothing => None,
        Registration::ThisMachine => Some(fixture.machine.machine_id.clone()),
        Registration::AnotherMachine => Some(machine_id()),
    };
    if let Some(registered) = registered {
        fixture
            .database
            .reader()
            .execute(
                "INSERT INTO machine_trust_state
                   (machine_id, owner_user_id, established_at, updated_at)
                 VALUES (?1, ?2, '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z')",
                params![registered.as_str(), mint_uuid_v7().to_string()],
            )
            .expect("the test registers a machine");
    }

    let minted = identity.mint_again_unregistered().await;

    let now = identity.key().await.expect("the keys are read");
    if is_minted {
        assert_eq!(minted.expect("the keys are minted again"), now);
        assert_ne!(now.identity_key, first.identity_key);
        assert_ne!(now.channel_key, first.channel_key);
    } else {
        assert!(matches!(minted, Err(IdentityKeyError::Registered)));
        assert_eq!(now, first);
        assert_eq!(identity.machine_key().await, None);
    }
}
