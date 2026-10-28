//! This machine's two keys for other devices: the Ed25519 identity key that signs the statements
//! other devices trust it by, and the X25519 key its encrypted channel runs with. Each is an item
//! in the credential store, minted at the first start once the store takes it and pinned by its
//! public half in this machine's row. Each key is read, refused and held on its own: a key gone
//! from the store or not matching its pin is refused, never minted again, and stops only what uses
//! it; a relink, or a sign-in while no registration pins the keys, mints both anew.
//!
//! Only the public halves leave this module: a caller signs and runs a handshake through
//! [`MachineIdentity`], which hands out no private key, so a relink ends every use of the old one.

use std::borrow::Cow;
use std::error::Error;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signature, Signer as _, SigningKey};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension as _, named_params};
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::daemon::status::{
    DaemonMachineKey, DaemonMachineKeyCause, DaemonMachineKeyState,
};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::trust_statement::{ChannelPublicKey, MachineIdentityKey};
use sidekicks_contracts::wire::base64::Base64Array;
use sidekicks_std::bounded_wait::wait_within;
use sidekicks_std::mutex_lock::lock;
use subtle::ConstantTimeEq as _;
use tokio::sync::watch;
use tokio_util::task::AbortOnDropHandle;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::credential_store::items::SecretItems;
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::machine::local::LocalMachine;

// The bytes of a seed and of a public half.
const KEY_LENGTH: usize = 32;

const SELECT_IDENTITY_PIN_SQL: &str =
    "SELECT identity_public_key FROM local_machine WHERE machine_id = @machineId";

const SELECT_CHANNEL_PIN_SQL: &str =
    "SELECT channel_public_key FROM local_machine WHERE machine_id = @machineId";

const UPDATE_IDENTITY_PIN_SQL: &str =
    "UPDATE local_machine SET identity_public_key = @publicKey WHERE machine_id = @machineId";

const UPDATE_CHANNEL_PIN_SQL: &str =
    "UPDATE local_machine SET channel_public_key = @publicKey WHERE machine_id = @machineId";

const SELECT_REGISTRATION_SQL: &str =
    "SELECT 1 FROM machine_trust_state WHERE machine_id = @machineId LIMIT 1";

/// The public halves of this machine's two keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MachinePublicKeys {
    /// The identity key, which every linked device pins.
    pub identity_key: MachineIdentityKey,
    /// The channel key, which the identity key certifies.
    pub channel_key: ChannelPublicKey,
}

/// Why this machine's keys could not be read, minted or used. No text or source of it holds an
/// item's text, a seed or a private key.
#[derive(Debug, thiserror::Error)]
pub enum IdentityKeyError {
    /// The credential store refused the call.
    #[error("the credential store could not be used for this machine's keys")]
    Store(#[from] KeychainRefusal),
    /// A pinned key is gone from the credential store.
    #[error("this machine's key is gone from the credential store")]
    Lost,
    /// The credential store holds another key than the pinned one, or an item that is no key.
    #[error("the credential store holds another key than the one this machine made")]
    Changed,
    /// A stored pin is not a 32-byte public key.
    #[error("this machine's stored key pin is not a public key")]
    StoredPin,
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error("this machine's key pins could not be read")]
    Read(#[from] DatabaseReadError),
    /// SQLite refused the read of the pins or the registration.
    #[error("SQLite refused the read of this machine's key pins")]
    Query(#[from] rusqlite::Error),
    /// The pins were not stored.
    #[error("this machine's key pins were not stored")]
    Write(#[from] WriteError),
    /// The system gave no random bytes for a seed.
    #[error("the system gave no random bytes for this machine's key")]
    Random(#[from] getrandom::Error),
}

impl IdentityKeyError {
    // What the status read says for this refusal.
    fn machine_key(&self) -> DaemonMachineKey {
        let (state, cause) = match self {
            Self::Store(refusal) => {
                let cause = if refusal.is_secrets_file_unopened() {
                    DaemonMachineKeyCause::SecretsFile
                } else {
                    match refusal.cause() {
                        KeychainRefusalCause::Locked => DaemonMachineKeyCause::Locked,
                        KeychainRefusalCause::Unavailable => DaemonMachineKeyCause::Unavailable,
                    }
                };
                (DaemonMachineKeyState::NotMinted, Some(cause))
            }
            Self::Random(_) => (
                DaemonMachineKeyState::NotMinted,
                Some(DaemonMachineKeyCause::Random),
            ),
            Self::Read(_) | Self::Query(_) | Self::Write(_) => (
                DaemonMachineKeyState::NotMinted,
                Some(DaemonMachineKeyCause::Database),
            ),
            Self::Lost => (DaemonMachineKeyState::Lost, None),
            Self::Changed => (DaemonMachineKeyState::Changed, None),
            Self::StoredPin => (
                DaemonMachineKeyState::Changed,
                Some(DaemonMachineKeyCause::StoredPin),
            ),
        };
        DaemonMachineKey { state, cause }
    }
}

/// Why a sign-in did not mint this machine's keys again.
#[derive(Debug, thiserror::Error)]
pub enum MintAgainUnregisteredError {
    /// This machine is registered, so only linking it again mints its keys again.
    #[error("this machine is registered, so only linking it again mints its keys again")]
    Registered,
    /// The registration could not be read, or the keys could not be minted.
    #[error(transparent)]
    Keys(#[from] IdentityKeyError),
}

// How long a status read waits for a running read of the keys before it answers what is
// recorded; the read goes on in the background past it.
const MACHINE_KEY_READ_WAIT: Duration = Duration::from_secs(2);

/// This machine's two keys, each read or minted once and held for the run; see the module doc.
/// Every read, mint and pin change runs under one lock.
pub struct MachineIdentity {
    /// The keys and what reads and writes them, shared with the background read.
    store: Arc<MachineKeyStore>,
    /// The last background read of both keys, the start's or one a status read started, until
    /// the stop joins it and no read starts again.
    background_reads: Mutex<BackgroundReads>,
}

impl MachineIdentity {
    /// The keys of `machine`, kept in `secret_items` and pinned through `reads` and `writer`, with
    /// their first read started at once so the start never waits on the credential store. Must be
    /// called inside a tokio runtime.
    pub fn new(
        machine: &LocalMachine,
        secret_items: &Arc<SecretItems>,
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
    ) -> Arc<Self> {
        Self::with_keychain(
            machine,
            Arc::new(secret_items.keychain(KeychainService::MachineKeys)),
            reads,
            writer,
        )
    }

    // The keys of `machine` kept in `keychain`, their first read started at once.
    fn with_keychain(
        machine: &LocalMachine,
        keychain: Arc<dyn SecretKeychain>,
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
    ) -> Arc<Self> {
        let machine_id = machine.machine_id.as_str();
        let store = Arc::new(MachineKeyStore {
            machine_id: machine.machine_id.clone(),
            identity_account: format!("identity-{machine_id}"),
            channel_account: format!("channel-{machine_id}"),
            keychain,
            reads,
            writer,
            keys: tokio::sync::Mutex::new(CachedKeys::default()),
            outcomes: Mutex::new(KeyOutcomes {
                identity: KeyOutcome::Reading,
                channel: KeyOutcome::Reading,
            }),
        });
        let first_read = read_in_background(&store);
        Arc::new(Self {
            store,
            background_reads: Mutex::new(BackgroundReads::Last(first_read)),
        })
    }

    /// The public halves of both keys, each read from the credential store or, before any was
    /// made, minted. Fails with [`IdentityKeyError`] when the store refuses, a pinned key is gone
    /// or changed, the database fails or the system gives no random bytes; the refused key is not
    /// minted, while the other key is still read or, before any was made, minted.
    pub async fn key(&self) -> Result<MachinePublicKeys, IdentityKeyError> {
        let (identity, channel) = self.store.both().await?;
        Ok(public_keys(&identity, &channel))
    }

    /// Mints both keys anew for a relink, replacing the items and the pins. Fails as
    /// [`MachineIdentity::key`] does; a relink stopped partway is finished by the next read, which
    /// adopts what the store holds.
    pub async fn mint_again(&self) -> Result<MachinePublicKeys, IdentityKeyError> {
        let mut cached = self.store.keys.lock().await;
        self.store.mint_again(&mut cached).await
    }

    /// Mints both keys anew for a sign-in, only while this machine has no registration, since
    /// nothing pins an unregistered key. Fails with [`MintAgainUnregisteredError::Registered`]
    /// when it has one, and otherwise as [`MachineIdentity::mint_again`] does.
    pub async fn mint_again_unregistered(
        &self,
    ) -> Result<MachinePublicKeys, MintAgainUnregisteredError> {
        let mut cached = self.store.keys.lock().await;
        // A refused registration read leaves the keys as they were, so nothing is recorded.
        if self.store.is_registered().await? {
            return Err(MintAgainUnregisteredError::Registered);
        }
        Ok(self.store.mint_again(&mut cached).await?)
    }

    /// Signs `message` with the identity key and answers the signature with the key's public
    /// half. Fails as [`MachineIdentity::key`] does for the identity key alone; the channel key's
    /// state does not stop it.
    pub async fn sign(
        &self,
        message: &[u8],
    ) -> Result<(Signature, MachineIdentityKey), IdentityKeyError> {
        let identity = self.store.one::<SigningKey>().await?;
        Ok((identity.key.sign(message), identity_key(&identity)))
    }

    /// Runs `use_secret` on the channel key's private bytes, for one handshake, and answers what
    /// it returns; the bytes are never handed out to keep. Fails as [`MachineIdentity::key`] does
    /// for the channel key alone.
    pub async fn with_channel_secret<T>(
        &self,
        use_secret: impl FnOnce(&[u8; KEY_LENGTH]) -> T,
    ) -> Result<T, IdentityKeyError> {
        let channel = self.store.one::<StaticSecret>().await?;
        Ok(use_secret(channel.key.as_bytes()))
    }

    /// Where the keys stand after waiting up to two seconds for a running read, or for one a store
    /// refusal starts before the stop: `None` while both are held, `reading` only before the
    /// start's read ends. Must be called inside a tokio runtime.
    pub async fn machine_key(&self) -> Option<DaemonMachineKey> {
        let mut ended = {
            let mut background_reads = lock(&self.background_reads);
            match &*background_reads {
                BackgroundReads::Last(read) if !read.task.is_finished() => read.ended.clone(),
                BackgroundReads::Last(_) => {
                    let machine_key = lock(&self.store.outcomes).machine_key();
                    if !machine_key.is_some_and(is_store_refusal) {
                        return machine_key;
                    }
                    let read = read_in_background(&self.store);
                    let ended = read.ended.clone();
                    *background_reads = BackgroundReads::Last(read);
                    ended
                }
                BackgroundReads::Stopped => return lock(&self.store.outcomes).machine_key(),
            }
        };
        // A read still running at the bound goes on in the background.
        wait_within(pin!(ended.changed()), MACHINE_KEY_READ_WAIT, None).await;
        lock(&self.store.outcomes).machine_key()
    }

    /// Waits for the last background read to end and starts no read after it; a later call
    /// returns at once.
    pub async fn stop(&self) {
        let background_reads =
            std::mem::replace(&mut *lock(&self.background_reads), BackgroundReads::Stopped);
        let BackgroundReads::Last(background_read) = background_reads else {
            return;
        };
        background_read.task.await.expect(
            "the read neither panics, which aborts the service, nor is aborted while awaited",
        );
    }
}

/// The keys, the lock every read, mint and pin change runs under, and what they are kept in.
struct MachineKeyStore {
    /// This machine's id, which the pins' row and the registration carry.
    machine_id: MachineId,
    /// The identity key's account in the credential store.
    identity_account: String,
    /// The channel key's account in the credential store.
    channel_account: String,
    /// The credential store's items of the machine's keys.
    keychain: Arc<dyn SecretKeychain>,
    /// Where the pins and the registration are read.
    reads: Arc<DatabaseReadPool>,
    /// Where the pins are written.
    writer: Arc<DatabaseWriter>,
    /// Each key once read or minted; only a success is kept.
    keys: tokio::sync::Mutex<CachedKeys>,
    /// Each key's last outcome, for the status read.
    outcomes: Mutex<KeyOutcomes>,
}

impl MachineKeyStore {
    // The one key `Key` is, under the lock.
    async fn one<Key: PinnedKey>(&self) -> Result<Arc<Resolved<Key>>, IdentityKeyError> {
        let mut cached = self.keys.lock().await;
        self.resolve::<Key>(&mut cached).await
    }

    // Both keys under the lock, the channel key resolved even when the identity key is refused.
    async fn both(
        &self,
    ) -> Result<(Arc<Resolved<SigningKey>>, Arc<Resolved<StaticSecret>>), IdentityKeyError> {
        let mut cached = self.keys.lock().await;
        let identity = self.resolve::<SigningKey>(&mut cached).await;
        let channel = self.resolve::<StaticSecret>(&mut cached).await;
        Ok((identity?, channel?))
    }

    // The cached key, else the key read or minted, cached and its outcome recorded.
    async fn resolve<Key: PinnedKey>(
        &self,
        cached: &mut CachedKeys,
    ) -> Result<Arc<Resolved<Key>>, IdentityKeyError> {
        if let Some(key) = Key::cached(cached) {
            return Ok(Arc::clone(key));
        }
        let read = self.read_or_mint::<Key>().await;
        self.record(RecordedKeys::One(Key::ROLE), read.as_ref().map(|_key| ()));
        Ok(Arc::clone(Key::cached(cached).insert(Arc::new(read?))))
    }

    // One key against its pin: minted when neither it nor its item exists, adopted when only the
    // item does, held when the item matches the pin; a key with no pin yet has it set. Fails with
    // `Lost` when a pinned item is gone and `Changed` when the item is no key or another than the
    // pinned one, writing nothing.
    async fn read_or_mint<Key: PinnedKey>(&self) -> Result<Resolved<Key>, IdentityKeyError> {
        let pin = self.read_pin(Key::ROLE).await?;
        let resolved = match self.keychain.read(self.account(Key::ROLE)).await? {
            None if pin.is_some() => return Err(IdentityKeyError::Lost),
            None => {
                let seed = random_seed()?;
                self.write_item(self.account(Key::ROLE), &seed).await?;
                Resolved::of_seed(&seed)
            }
            Some(item) => {
                let seed = item_seed(&item).ok_or(IdentityKeyError::Changed)?;
                let resolved = Resolved::<Key>::of_seed(&seed);
                if pin.is_some_and(|pin| pin != resolved.public_half) {
                    return Err(IdentityKeyError::Changed);
                }
                resolved
            }
        };
        if pin.is_none() {
            self.write_pins(&[(Key::ROLE, Some(resolved.public_half))])
                .await?;
        }
        Ok(resolved)
    }

    // The relink under the lock `cached` was taken with, its outcome recorded for both keys.
    async fn mint_again(
        &self,
        cached: &mut CachedKeys,
    ) -> Result<MachinePublicKeys, IdentityKeyError> {
        let minted = self.mint_both(cached).await;
        self.record(RecordedKeys::Both, minted.as_ref().map(|_keys| ()));
        minted
    }

    // Empties the cache, clears both pins, draws both seeds, writes both items verified, then sets
    // both pins in one write and caches the keys. A stop partway lands on a row the next read
    // resolves.
    async fn mint_both(
        &self,
        cached: &mut CachedKeys,
    ) -> Result<MachinePublicKeys, IdentityKeyError> {
        *cached = CachedKeys::default();
        self.write_pins(&[(KeyRole::Identity, None), (KeyRole::Channel, None)])
            .await?;
        let identity_seed = random_seed()?;
        let channel_seed = random_seed()?;
        self.write_item(&self.identity_account, &identity_seed)
            .await?;
        self.write_item(&self.channel_account, &channel_seed)
            .await?;
        let identity = Resolved::<SigningKey>::of_seed(&identity_seed);
        let channel = Resolved::<StaticSecret>::of_seed(&channel_seed);
        self.write_pins(&[
            (KeyRole::Identity, Some(identity.public_half)),
            (KeyRole::Channel, Some(channel.public_half)),
        ])
        .await?;
        let identity = cached.identity.insert(Arc::new(identity));
        let channel = cached.channel.insert(Arc::new(channel));
        Ok(public_keys(identity, channel))
    }

    // The credential-store account of the key `role` names.
    fn account(&self, role: KeyRole) -> &str {
        match role {
            KeyRole::Identity => &self.identity_account,
            KeyRole::Channel => &self.channel_account,
        }
    }

    // Writes `seed` under `account` and reads it back before the key is used.
    async fn write_item(
        &self,
        account: &str,
        seed: &Zeroizing<[u8; KEY_LENGTH]>,
    ) -> Result<(), KeychainRefusal> {
        // Encoded from the wiped buffer, so no unwiped copy of the seed is left.
        let item = SecretString::from(base16ct::lower::encode_string(seed.as_slice()));
        self.keychain.write_verified(account, &item).await
    }

    // The pin of the key `role` names, `None` until set. Fails with `StoredPin` when it is not 32
    // bytes.
    async fn read_pin(&self, role: KeyRole) -> Result<Option<[u8; KEY_LENGTH]>, IdentityKeyError> {
        let machine_id = self.machine_id.as_str().to_owned();
        let sql = match role {
            KeyRole::Identity => SELECT_IDENTITY_PIN_SQL,
            KeyRole::Channel => SELECT_CHANNEL_PIN_SQL,
        };
        let stored = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, IdentityKeyError>(
                    connection
                        .prepare(sql)?
                        .query_row(named_params! { "@machineId": machine_id }, |row| {
                            row.get::<_, Option<Vec<u8>>>(0)
                        })?,
                )
            })
            .await?;
        stored
            .map(|bytes| {
                <[u8; KEY_LENGTH]>::try_from(bytes).map_err(|_bytes| IdentityKeyError::StoredPin)
            })
            .transpose()
    }

    // Sets each named key's pin to its public half, or clears it on `None`, in one write.
    async fn write_pins(
        &self,
        pins: &[(KeyRole, Option<[u8; KEY_LENGTH]>)],
    ) -> Result<(), WriteError> {
        let statements = pins
            .iter()
            .map(|(role, public_half)| WriteStatement {
                sql: Cow::Borrowed(match role {
                    KeyRole::Identity => UPDATE_IDENTITY_PIN_SQL,
                    KeyRole::Channel => UPDATE_CHANNEL_PIN_SQL,
                }),
                bindings: StatementBindings::Named(vec![
                    (
                        Cow::Borrowed("@publicKey"),
                        public_half.map_or(Value::Null, |half| Value::Blob(half.to_vec())),
                    ),
                    text_binding("@machineId", self.machine_id.as_str()),
                ]),
                expected_row_count: Some(1),
            })
            .collect();
        self.writer.write(statements).await?;
        Ok(())
    }

    // Whether this machine has a registration, which pins its keys on the control plane.
    async fn is_registered(&self) -> Result<bool, IdentityKeyError> {
        let machine_id = self.machine_id.as_str().to_owned();
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, IdentityKeyError>(
                    connection
                        .prepare(SELECT_REGISTRATION_SQL)?
                        .query_row(named_params! { "@machineId": machine_id }, |_row| Ok(()))
                        .optional()?
                        .is_some(),
                )
            })
            .await
    }

    // Records `outcome` for `keys` and logs a refusal in the status member's words.
    fn record(&self, keys: RecordedKeys, outcome: Result<(), &IdentityKeyError>) {
        let recorded = match outcome {
            Ok(()) => KeyOutcome::Held,
            Err(error) => {
                let machine_key = error.machine_key();
                log_refusal(keys, error, machine_key);
                KeyOutcome::Refused(machine_key)
            }
        };
        let mut outcomes = lock(&self.outcomes);
        match keys {
            RecordedKeys::One(KeyRole::Identity) => outcomes.identity = recorded,
            RecordedKeys::One(KeyRole::Channel) => outcomes.channel = recorded,
            RecordedKeys::Both => {
                outcomes.identity = recorded;
                outcomes.channel = recorded;
            }
        }
    }
}

// The status member while the start's read has not reached both keys.
const READING: DaemonMachineKey = DaemonMachineKey {
    state: DaemonMachineKeyState::Reading,
    cause: None,
};

/// A read of both keys on its own task.
struct BackgroundRead {
    task: AbortOnDropHandle<()>,
    /// Closed when the task ends, which wakes every status read waiting on it.
    ended: watch::Receiver<()>,
}

/// The background reads: the last one started, or none again once the stop joined it.
enum BackgroundReads {
    /// The start's read, or the last one a status read started.
    Last(BackgroundRead),
    /// The stop joined the last read, so the status read starts none.
    Stopped,
}

// Starts a read of both keys on a task; each key's outcome is recorded, and a refusal logged,
// where it is made.
fn read_in_background(store: &Arc<MachineKeyStore>) -> BackgroundRead {
    let store = Arc::clone(store);
    let (ending, ended) = watch::channel(());
    let task = AbortOnDropHandle::new(tokio::spawn(async move {
        // Dropped as the task ends, aborted or not, which closes `ended`.
        let _ending = ending;
        let _keys = store.both().await;
    }));
    BackgroundRead { task, ended }
}

// Whether `machine_key` is a refusal by the credential store, which a later read can clear.
fn is_store_refusal(machine_key: DaemonMachineKey) -> bool {
    match machine_key.cause {
        Some(
            DaemonMachineKeyCause::Locked
            | DaemonMachineKeyCause::Unavailable
            | DaemonMachineKeyCause::SecretsFile,
        ) => true,
        Some(
            DaemonMachineKeyCause::Random
            | DaemonMachineKeyCause::Database
            | DaemonMachineKeyCause::StoredPin,
        )
        | None => false,
    }
}

// One log line for a refusal of `keys`, with the member's state, cause and action.
fn log_refusal(keys: RecordedKeys, error: &IdentityKeyError, machine_key: DaemonMachineKey) {
    let keys = match keys {
        RecordedKeys::One(KeyRole::Identity) => "identity",
        RecordedKeys::One(KeyRole::Channel) => "channel",
        RecordedKeys::Both => "identity and channel",
    };
    let state: &'static str = machine_key.state.into();
    let cause = machine_key.cause.map(<&'static str>::from);
    let action = machine_key.action();
    // The credential store logs its own refusals, so only another failure carries its error here.
    if let IdentityKeyError::Store(_) = error {
        tracing::warn!(
            keys,
            state,
            cause,
            action,
            "the machine's key cannot be used"
        );
    } else {
        tracing::warn!(
            error = error as &(dyn Error + 'static),
            keys,
            state,
            cause,
            action,
            "the machine's key cannot be used"
        );
    }
}

/// Which of the machine's two keys.
#[derive(Clone, Copy)]
enum KeyRole {
    /// The Ed25519 key that signs.
    Identity,
    /// The X25519 key the channel runs with.
    Channel,
}

/// The keys an outcome is recorded for: one read's key, or both for a relink.
#[derive(Clone, Copy)]
enum RecordedKeys {
    One(KeyRole),
    Both,
}

/// The last outcome of a read, mint or relink of one key.
#[derive(Clone, Copy)]
enum KeyOutcome {
    /// No read has reached the key yet.
    Reading,
    /// The key is held.
    Held,
    /// The key is not held, for this reason.
    Refused(DaemonMachineKey),
}

struct KeyOutcomes {
    identity: KeyOutcome,
    channel: KeyOutcome,
}

impl KeyOutcomes {
    // What the status read says: `reading` while either key is not reached yet, else the
    // identity key's refusal, else the channel key's; nothing while both are held.
    fn machine_key(&self) -> Option<DaemonMachineKey> {
        match (self.identity, self.channel) {
            (KeyOutcome::Reading, _) | (_, KeyOutcome::Reading) => Some(READING),
            (KeyOutcome::Refused(machine_key), _) | (_, KeyOutcome::Refused(machine_key)) => {
                Some(machine_key)
            }
            (KeyOutcome::Held, KeyOutcome::Held) => None,
        }
    }
}

/// Each key once read or minted, held for the run until a relink.
#[derive(Default)]
struct CachedKeys {
    identity: Option<Arc<Resolved<SigningKey>>>,
    channel: Option<Arc<Resolved<StaticSecret>>>,
}

// The public halves of both keys.
fn public_keys(
    identity: &Resolved<SigningKey>,
    channel: &Resolved<StaticSecret>,
) -> MachinePublicKeys {
    MachinePublicKeys {
        identity_key: identity_key(identity),
        channel_key: ChannelPublicKey::X25519 {
            public_key: Base64Array::new(channel.public_half),
        },
    }
}

// The identity key's public half on the wire.
fn identity_key(identity: &Resolved<SigningKey>) -> MachineIdentityKey {
    MachineIdentityKey::Ed25519 {
        public_key: Base64Array::new(identity.public_half),
    }
}

/// A key the credential store keeps as its seed and this machine's row pins by its public half.
trait PinnedKey: Sized {
    const ROLE: KeyRole;

    /// The key `seed` makes.
    fn from_seed(seed: &[u8; KEY_LENGTH]) -> Self;

    /// The key's public half, which its pin holds.
    fn public_half(&self) -> [u8; KEY_LENGTH];

    /// Where `cached` holds this key.
    fn cached(cached: &mut CachedKeys) -> &mut Option<Arc<Resolved<Self>>>;
}

impl PinnedKey for SigningKey {
    const ROLE: KeyRole = KeyRole::Identity;

    fn from_seed(seed: &[u8; KEY_LENGTH]) -> Self {
        Self::from_bytes(seed)
    }

    fn public_half(&self) -> [u8; KEY_LENGTH] {
        self.verifying_key().to_bytes()
    }

    fn cached(cached: &mut CachedKeys) -> &mut Option<Arc<Resolved<Self>>> {
        &mut cached.identity
    }
}

impl PinnedKey for StaticSecret {
    const ROLE: KeyRole = KeyRole::Channel;

    fn from_seed(seed: &[u8; KEY_LENGTH]) -> Self {
        Self::from(*seed)
    }

    fn public_half(&self) -> [u8; KEY_LENGTH] {
        PublicKey::from(self).to_bytes()
    }

    fn cached(cached: &mut CachedKeys) -> &mut Option<Arc<Resolved<Self>>> {
        &mut cached.channel
    }
}

/// A key read or minted, with its public half.
struct Resolved<Key> {
    key: Key,
    public_half: [u8; KEY_LENGTH],
}

impl<Key: PinnedKey> Resolved<Key> {
    fn of_seed(seed: &Zeroizing<[u8; KEY_LENGTH]>) -> Self {
        let key = Key::from_seed(seed);
        Self {
            public_half: key.public_half(),
            key,
        }
    }
}

// A fresh seed from the system's random source.
fn random_seed() -> Result<Zeroizing<[u8; KEY_LENGTH]>, getrandom::Error> {
    let mut seed = Zeroizing::new([0; KEY_LENGTH]);
    getrandom::fill(seed.as_mut_slice())?;
    Ok(seed)
}

// The seed `item` holds, or `None` when it is not exactly 64 lowercase hex characters or is all
// zero, the one seed no mint makes.
fn item_seed(item: &SecretString) -> Option<Zeroizing<[u8; KEY_LENGTH]>> {
    let text = item.expose_secret();
    if text.len() != KEY_LENGTH * 2 {
        return None;
    }
    let mut seed = Zeroizing::new([0; KEY_LENGTH]);
    base16ct::lower::decode(text, seed.as_mut_slice()).ok()?;
    if bool::from(seed.as_slice().ct_eq(&[0; KEY_LENGTH])) {
        return None;
    }
    Some(seed)
}

#[cfg(test)]
mod tests;
