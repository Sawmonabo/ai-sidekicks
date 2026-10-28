//! This machine's two keys for other devices: the Ed25519 identity key that signs the statements
//! other devices trust it by, and the X25519 key its encrypted channel runs with. Each is an item
//! in the credential store, minted at the first start once the store takes it and pinned by its
//! public half in this machine's row. A key gone from the store or not matching its pin is refused,
//! never minted again; a relink, or a sign-in while no registration pins the keys, mints both anew.
//!
//! Only the public halves leave this module: a caller signs and runs a handshake through
//! [`MachineIdentity`], which hands out no private key, so a relink ends every use of the old one.

use std::borrow::Cow;
use std::error::Error;
use std::sync::{Arc, Mutex};

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
use sidekicks_std::mutex_lock::lock;
use subtle::ConstantTimeEq as _;
use tokio::sync::watch;
use tokio_util::task::AbortOnDropHandle;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::credential_store::items::SecretItems;
use crate::credential_store::os::KEYCHAIN_CALL_TIMEOUT;
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::machine::local::LocalMachine;

// The bytes of a seed and of a public half.
const KEY_LENGTH: usize = 32;

const SELECT_PINS_SQL: &str = "SELECT identity_public_key, channel_public_key FROM local_machine
  WHERE machine_id = @machineId";

const UPDATE_PINS_SQL: &str = "UPDATE local_machine
  SET identity_public_key = @identityPublicKey, channel_public_key = @channelPublicKey
  WHERE machine_id = @machineId";

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
    /// The keys were to be minted again for a sign-in while this machine is registered.
    #[error("this machine is registered, so only linking it again mints its keys again")]
    Registered,
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
    // What the status read says for this refusal; `None` for a sign-in refused while registered,
    // which leaves the keys as they were.
    fn machine_key(&self) -> Option<DaemonMachineKey> {
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
            Self::Registered => return None,
        };
        Some(DaemonMachineKey { state, cause })
    }
}

/// This machine's two keys, read or minted once and held for the run; see the module doc. Every
/// read, mint and pin change runs under one lock.
pub struct MachineIdentity {
    /// The keys and what reads and writes them, shared with the first read.
    store: Arc<MachineKeyStore>,
    /// The start's first read, until the stop joins it.
    first_read: Mutex<Option<AbortOnDropHandle<Result<(), IdentityKeyError>>>>,
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
            keys: tokio::sync::Mutex::new(None),
            outcome: watch::Sender::new(None),
        });
        let first_read = AbortOnDropHandle::new(tokio::spawn({
            let store = Arc::clone(&store);
            async move { store.keys().await.map(|_keys| ()) }
        }));
        Arc::new(Self {
            store,
            first_read: Mutex::new(Some(first_read)),
        })
    }

    /// The public halves of the keys, read from the credential store or, before any was made,
    /// minted. Fails with [`IdentityKeyError`] when the store refuses, a pinned key is gone or
    /// changed, the database fails or the system gives no random bytes; nothing is minted then.
    pub async fn key(&self) -> Result<MachinePublicKeys, IdentityKeyError> {
        Ok(self.store.keys().await?.public_keys.clone())
    }

    /// Mints both keys anew for a relink, replacing the items and the pins. Fails as
    /// [`MachineIdentity::key`] does; a relink stopped partway is finished by the next read, which
    /// adopts what the store holds.
    pub async fn mint_again(&self) -> Result<MachinePublicKeys, IdentityKeyError> {
        let mut cached = self.store.keys.lock().await;
        let keys = self.store.mint_again(&mut cached).await;
        self.store.record(keys.as_ref().map(|_keys| ()));
        Ok(keys?.public_keys.clone())
    }

    /// Mints both keys anew for a sign-in, only while this machine has no registration, since
    /// nothing pins an unregistered key. Fails with [`IdentityKeyError::Registered`] when it has
    /// one, and otherwise as [`MachineIdentity::mint_again`] does.
    pub async fn mint_again_unregistered(&self) -> Result<MachinePublicKeys, IdentityKeyError> {
        let mut cached = self.store.keys.lock().await;
        let keys = match self.store.is_registered().await {
            Ok(true) => Err(IdentityKeyError::Registered),
            Ok(false) => self.store.mint_again(&mut cached).await,
            Err(error) => Err(error),
        };
        self.store.record(keys.as_ref().map(|_keys| ()));
        Ok(keys?.public_keys.clone())
    }

    /// Signs `message` with the identity key and answers the signature with the key's public
    /// half. Fails as [`MachineIdentity::key`] does.
    pub async fn sign(
        &self,
        message: &[u8],
    ) -> Result<(Signature, MachineIdentityKey), IdentityKeyError> {
        let keys = self.store.keys().await?;
        Ok((
            keys.identity.sign(message),
            keys.public_keys.identity_key.clone(),
        ))
    }

    /// Runs `use_secret` on the channel key's private bytes, for one handshake, and answers what
    /// it returns; the bytes are never handed out to keep. Fails as [`MachineIdentity::key`] does.
    pub async fn with_channel_secret<T>(
        &self,
        use_secret: impl FnOnce(&[u8; KEY_LENGTH]) -> T,
    ) -> Result<T, IdentityKeyError> {
        let keys = self.store.keys().await?;
        Ok(use_secret(keys.channel.as_bytes()))
    }

    /// Why the service holds no keys, as the last read, mint or relink found; `None` while they
    /// are held. Waits for the first read's outcome without reading again, and reads `locked`
    /// when it gives none within one keychain call's time, as a store call that does not answer
    /// does.
    pub async fn machine_key(&self) -> Option<DaemonMachineKey> {
        let mut outcome = self.store.outcome.subscribe();
        let recorded = tokio::time::timeout(KEYCHAIN_CALL_TIMEOUT, async {
            *outcome
                .wait_for(Option::is_some)
                .await
                .expect("the identity holds the outcome's sender")
        })
        .await;
        match recorded {
            Ok(recorded) => recorded.and_then(KeyOutcome::machine_key),
            Err(_elapsed) => Some(DaemonMachineKey {
                state: DaemonMachineKeyState::NotMinted,
                cause: Some(DaemonMachineKeyCause::Locked),
            }),
        }
    }

    /// Waits for the start's first read to end; a later call returns at once.
    pub async fn stop(&self) {
        let Some(first_read) = lock(&self.first_read).take() else {
            return;
        };
        // The read's own outcome is recorded, and a refusal logged, where it was made.
        if let Err(error) = first_read.await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the first read of the machine's keys did not finish"
            );
        }
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
    /// The keys once read or minted; only a success is kept.
    keys: tokio::sync::Mutex<Option<Arc<MachineKeys>>>,
    /// The last outcome of a read, mint or relink; `None` until the first.
    outcome: watch::Sender<Option<KeyOutcome>>,
}

impl MachineKeyStore {
    // The keys, read or minted under the lock, the outcome recorded.
    async fn keys(&self) -> Result<Arc<MachineKeys>, IdentityKeyError> {
        let mut cached = self.keys.lock().await;
        let keys = self.read_or_mint(&mut cached).await;
        self.record(keys.as_ref().map(|_keys| ()));
        keys
    }

    // The cached keys, else each key read against its pin or, with no pin and no item, minted;
    // a key with no pin yet has it set once both are read.
    async fn read_or_mint(
        &self,
        cached: &mut Option<Arc<MachineKeys>>,
    ) -> Result<Arc<MachineKeys>, IdentityKeyError> {
        if let Some(keys) = cached {
            return Ok(Arc::clone(keys));
        }
        let (identity_pin, channel_pin) = self.read_pins().await?;
        let identity = self
            .read_or_mint_one::<SigningKey>(&self.identity_account, identity_pin)
            .await?;
        let channel = self
            .read_or_mint_one::<StaticSecret>(&self.channel_account, channel_pin)
            .await?;
        if identity_pin.is_none() || channel_pin.is_none() {
            self.write_pins(Some((&identity.public_half, &channel.public_half)))
                .await?;
        }
        Ok(cache(cached, MachineKeys::new(identity, channel)))
    }

    // One key against its `pin`: minted when neither it nor its item exists, adopted when only
    // the item does, held when the item matches the pin. Fails with `Lost` when a pinned item is
    // gone and `Changed` when the item is no key or another than the pinned one, writing nothing.
    async fn read_or_mint_one<Key: PinnedKey>(
        &self,
        account: &str,
        pin: Option<[u8; KEY_LENGTH]>,
    ) -> Result<Resolved<Key>, IdentityKeyError> {
        let Some(item) = self.keychain.read(account).await? else {
            return match pin {
                None => {
                    let seed = random_seed()?;
                    self.write_item(account, &seed).await?;
                    Ok(Resolved::of_seed(&seed))
                }
                Some(_) => Err(IdentityKeyError::Lost),
            };
        };
        let seed = item_seed(&item).ok_or(IdentityKeyError::Changed)?;
        let resolved = Resolved::<Key>::of_seed(&seed);
        if pin.is_some_and(|pin| pin != resolved.public_half) {
            return Err(IdentityKeyError::Changed);
        }
        Ok(resolved)
    }

    // The relink: empties the cache, clears both pins, draws both seeds, writes both items
    // verified, then sets both pins and caches the keys. A stop partway lands on a row the next
    // read resolves.
    async fn mint_again(
        &self,
        cached: &mut Option<Arc<MachineKeys>>,
    ) -> Result<Arc<MachineKeys>, IdentityKeyError> {
        *cached = None;
        self.write_pins(None).await?;
        let identity_seed = random_seed()?;
        let channel_seed = random_seed()?;
        self.write_item(&self.identity_account, &identity_seed)
            .await?;
        self.write_item(&self.channel_account, &channel_seed)
            .await?;
        let identity = Resolved::<SigningKey>::of_seed(&identity_seed);
        let channel = Resolved::<StaticSecret>::of_seed(&channel_seed);
        self.write_pins(Some((&identity.public_half, &channel.public_half)))
            .await?;
        Ok(cache(cached, MachineKeys::new(identity, channel)))
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

    // The two pins, each `None` until set. Fails with `StoredPin` when one is not 32 bytes.
    async fn read_pins(
        &self,
    ) -> Result<(Option<[u8; KEY_LENGTH]>, Option<[u8; KEY_LENGTH]>), IdentityKeyError> {
        let machine_id = self.machine_id.as_str().to_owned();
        let (identity, channel) = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, IdentityKeyError>(connection.prepare(SELECT_PINS_SQL)?.query_row(
                    named_params! { "@machineId": machine_id },
                    |row| {
                        Ok((
                            row.get::<_, Option<Vec<u8>>>(0)?,
                            row.get::<_, Option<Vec<u8>>>(1)?,
                        ))
                    },
                )?)
            })
            .await?;
        Ok((stored_pin(identity)?, stored_pin(channel)?))
    }

    // Sets both pins to `public_halves`, the identity key's first, or clears both on `None`.
    async fn write_pins(
        &self,
        public_halves: Option<(&[u8; KEY_LENGTH], &[u8; KEY_LENGTH])>,
    ) -> Result<(), WriteError> {
        let (identity, channel) = public_halves.map_or((Value::Null, Value::Null), |halves| {
            (
                Value::Blob(halves.0.to_vec()),
                Value::Blob(halves.1.to_vec()),
            )
        });
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(UPDATE_PINS_SQL),
                bindings: StatementBindings::Named(vec![
                    (Cow::Borrowed("@identityPublicKey"), identity),
                    (Cow::Borrowed("@channelPublicKey"), channel),
                    text_binding("@machineId", self.machine_id.as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
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

    // Records `outcome` for the status read and logs a refusal; a sign-in refused while
    // registered changes nothing and records nothing.
    fn record(&self, outcome: Result<(), &IdentityKeyError>) {
        let recorded = match outcome {
            Ok(()) => KeyOutcome::Held,
            Err(error) => {
                let Some(machine_key) = error.machine_key() else {
                    return;
                };
                tracing::warn!(
                    error = error as &(dyn Error + 'static),
                    state = ?machine_key.state,
                    cause = ?machine_key.cause,
                    action = machine_key.action(),
                    "the machine's key was not minted"
                );
                KeyOutcome::Refused(machine_key)
            }
        };
        self.outcome.send_replace(Some(recorded));
    }
}

/// The last outcome of a read, mint or relink of the keys.
#[derive(Clone, Copy)]
enum KeyOutcome {
    /// The keys are held.
    Held,
    /// No keys are held, for this reason.
    Refused(DaemonMachineKey),
}

impl KeyOutcome {
    // What the status read says: nothing while the keys are held.
    fn machine_key(self) -> Option<DaemonMachineKey> {
        match self {
            Self::Held => None,
            Self::Refused(machine_key) => Some(machine_key),
        }
    }
}

/// Both keys, held for the run until a relink.
struct MachineKeys {
    /// The identity key.
    identity: SigningKey,
    /// The channel key.
    channel: StaticSecret,
    /// Both public halves.
    public_keys: MachinePublicKeys,
}

impl MachineKeys {
    fn new(identity: Resolved<SigningKey>, channel: Resolved<StaticSecret>) -> Self {
        Self {
            public_keys: MachinePublicKeys {
                identity_key: MachineIdentityKey::Ed25519 {
                    public_key: Base64Array::new(identity.public_half),
                },
                channel_key: ChannelPublicKey::X25519 {
                    public_key: Base64Array::new(channel.public_half),
                },
            },
            identity: identity.key,
            channel: channel.key,
        }
    }
}

/// A key the credential store keeps as its seed and this machine's row pins by its public half.
trait PinnedKey: Sized {
    /// The key `seed` makes.
    fn from_seed(seed: &[u8; KEY_LENGTH]) -> Self;

    /// The key's public half, which its pin holds.
    fn public_half(&self) -> [u8; KEY_LENGTH];
}

impl PinnedKey for SigningKey {
    fn from_seed(seed: &[u8; KEY_LENGTH]) -> Self {
        Self::from_bytes(seed)
    }

    fn public_half(&self) -> [u8; KEY_LENGTH] {
        self.verifying_key().to_bytes()
    }
}

impl PinnedKey for StaticSecret {
    fn from_seed(seed: &[u8; KEY_LENGTH]) -> Self {
        Self::from(*seed)
    }

    fn public_half(&self) -> [u8; KEY_LENGTH] {
        PublicKey::from(self).to_bytes()
    }
}

/// A key read or minted, with its public half.
struct Resolved<Key> {
    /// The key.
    key: Key,
    /// Its public half.
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

// Caches `keys` and answers them.
fn cache(cached: &mut Option<Arc<MachineKeys>>, keys: MachineKeys) -> Arc<MachineKeys> {
    Arc::clone(cached.insert(Arc::new(keys)))
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

// A stored pin, `None` while unset. Fails with `StoredPin` when it is not 32 bytes.
fn stored_pin(stored: Option<Vec<u8>>) -> Result<Option<[u8; KEY_LENGTH]>, IdentityKeyError> {
    stored
        .map(|bytes| {
            <[u8; KEY_LENGTH]>::try_from(bytes).map_err(|_bytes| IdentityKeyError::StoredPin)
        })
        .transpose()
}

#[cfg(test)]
mod tests;
