//! The keyed digest a signed-in server is kept under, in place of its address: HMAC-SHA256 of the
//! address's canonical form under one 32-byte key. Every row that names a signed-in server (a
//! binding's last declared address, an owed sign-out, an admitted client) and the account of each
//! sign-in's keychain item hold the digest, so no stored value and no keychain attribute holds a
//! server address, whose user name, password and query are credentials; the address itself is kept
//! only inside the sign-in's keychain secret.
//!
//! The key is one item of the sign-ins' keychain service, under its own account, made from the
//! system's random source the first time it is needed, read once per daemon life and wiped when it
//! drops. It is never logged. A keychain that cannot give the key refuses the call that needed it,
//! and nothing is read or written under a digest no key made.
//!
//! - A key item that holds no key is refused and left as it is, never replaced, since every item
//!   filed under its digests would be lost with it.
//! - A key that is gone while sign-ins are filed is made again, and each sign-in is filed under
//!   the new key's digest of the address its secret holds before the new key is written, so a stop
//!   part-way leaves the key gone and the next life finishes the move. The rows that follow a
//!   moved sign-in, the owed sign-outs, are rewritten from each old digest to its new one in the
//!   same step, before the key is written, so a later life's move takes them on from there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use futures::future::BoxFuture;

use hmac::{Hmac, KeyInit as _, Mac as _};
use secrecy::{ExposeSecret as _, SecretBox};
use sha2::Sha256;
use sidekicks_contracts::mcp::governance::{McpAddressKeyCause, McpBindingStoreUnavailableCause};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_provider::driver::mcp_server::address::fold_server_address;
use sidekicks_store::credential_store::seed_item::{
    SEED_LENGTH, Seed, encode_seed, item_seed, random_seed,
};
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::writer::WriteError;

use crate::errors::McpRefusal;
use crate::sign_in::credential_store::read_held_sign_in;

/// The address key's one account in the sign-ins' keychain service, which files no sign-in.
pub(crate) const ADDRESS_KEY_ACCOUNT: &str = "address-key";

/// A signed-in server's keyed digest, in lowercase hex: what its rows and its keychain item are
/// kept under. It names the server without holding its address.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct ServerAddressDigest(String);

impl ServerAddressDigest {
    /// The digest a row or a keychain account stores as `text`, which a digest wrote, so it is
    /// not checked again.
    pub(crate) fn from_stored(text: String) -> Self {
        Self(text)
    }

    /// The digest as stored.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// The 32-byte key every server's digest is keyed with, wiped when it drops.
pub(crate) struct ServerAddressKey(SecretBox<[u8; SEED_LENGTH]>);

impl ServerAddressKey {
    /// The digest of `address`: HMAC-SHA256 of its canonical form, so two spellings of one server
    /// (`HTTPS://Docs.Example.com/mcp/` and `https://docs.example.com/mcp`) have one digest.
    pub(crate) fn digest(&self, address: &McpServerAddress) -> ServerAddressDigest {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.0.expose_secret())
            .expect("HMAC takes a key of any length");
        mac.update(fold_server_address(address).as_bytes());
        ServerAddressDigest(base16ct::lower::encode_string(&mac.finalize().into_bytes()))
    }

    /// A key whose 32 bytes are all `fill`, for a test's digests.
    #[cfg(test)]
    pub(crate) fn of_test_fill(fill: u8) -> Self {
        Self(SecretBox::new(Box::new([fill; SEED_LENGTH])))
    }

    // The key `seed` is, copied straight into its wiped box.
    fn of_seed(seed: &Seed) -> Self {
        Self(SecretBox::init_with_mut(|key: &mut [u8; SEED_LENGTH]| {
            key.copy_from_slice(seed.as_slice());
        }))
    }
}

/// Why the address key could not be read or made; nothing was kept under a digest.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ServerAddressKeyError {
    /// The keychain is locked or cannot be used.
    #[error(transparent)]
    Keychain(#[from] KeychainRefusal),
    /// The system gave no random bytes for a new key.
    #[error("the system gave no random bytes for the MCP address key")]
    Random(#[from] getrandom::Error),
    /// The key's item holds no key; it is left as it is, so the sign-ins filed under it stay.
    #[error("the MCP address key's keychain item holds no key, so it is left as it is")]
    Damaged,
    /// The rows naming a moved sign-in's old digest were not rewritten; the key is not written,
    /// so the next read moves the sign-ins and the rows again.
    #[error("the rows naming a moved MCP sign-in were not rewritten under the new address key")]
    Rows(#[source] WriteError),
}

impl From<ServerAddressKeyError> for McpRefusal {
    /// A key the keychain cannot give fails the call closed, naming the keychain's cause.
    fn from(error: ServerAddressKeyError) -> Self {
        let cause = match &error {
            ServerAddressKeyError::Keychain(refusal) => {
                Some(McpBindingStoreUnavailableCause::Keychain(refusal.cause()))
            }
            ServerAddressKeyError::Damaged => Some(McpBindingStoreUnavailableCause::AddressKey(
                McpAddressKeyCause::AddressKeyDamaged,
            )),
            ServerAddressKeyError::Random(_) | ServerAddressKeyError::Rows(_) => None,
        };
        Self::BindingStoreUnavailable {
            cause,
            source: Some(Box::new(error)),
        }
    }
}

/// A sign-in filed under a new address key: the digest it was filed under and its new one.
pub(crate) type MovedDigest = (ServerAddressDigest, ServerAddressDigest);

/// The rows that name a server by its digest and follow its sign-in to a new address key.
pub(crate) trait ServerDigestRows: Send + Sync {
    /// Rewrites each row naming an old digest of `moved` to its new one, in one write. Fails as
    /// the writer fails, rewriting none.
    fn rewrite_digests<'a>(
        &'a self,
        moved: &'a [MovedDigest],
    ) -> BoxFuture<'a, Result<(), WriteError>>;
}

/// The address key kept in the sign-ins' keychain service; see the module doc.
pub(crate) struct ServerAddressKeys {
    keychain: Arc<dyn SecretKeychain>,
    // The key once read or made; only a success is kept.
    key: tokio::sync::Mutex<Option<Arc<ServerAddressKey>>>,
    // The rows rewritten when a new key moves the sign-ins, once the daemon has given them.
    rows: OnceLock<Arc<dyn ServerDigestRows>>,
    // Whether this life has logged the key's item as damaged, which it does once.
    is_damage_logged: AtomicBool,
}

impl ServerAddressKeys {
    /// The key kept in `keychain`, the sign-ins' service; nothing is read until the first
    /// [`Self::read`].
    pub(crate) fn new(keychain: Arc<dyn SecretKeychain>) -> Self {
        Self {
            keychain,
            key: tokio::sync::Mutex::new(None),
            rows: OnceLock::new(),
            is_damage_logged: AtomicBool::new(false),
        }
    }

    /// Has `rows` rewritten whenever a new key moves the sign-ins; only the first rows given are
    /// kept.
    pub(crate) fn follow_moves_with(&self, rows: Arc<dyn ServerDigestRows>) {
        self.rows.get_or_init(|| rows);
    }

    /// The address key: the one held, else the keychain's item, else a new one, every sign-in
    /// filed again under it and the rows that follow them rewritten, then written and read back.
    /// Fails with [`ServerAddressKeyError::Damaged`], writing nothing, when the item holds no key,
    /// and otherwise as the keychain, the random source or the rows' write fails, holding nothing.
    pub(crate) async fn read(&self) -> Result<Arc<ServerAddressKey>, ServerAddressKeyError> {
        let mut held = self.key.lock().await;
        if let Some(key) = held.as_ref() {
            return Ok(Arc::clone(key));
        }
        let key = if let Some(item) = self.keychain.read(ADDRESS_KEY_ACCOUNT).await? {
            let Some(seed) = item_seed(&item) else {
                if !self.is_damage_logged.swap(true, Ordering::Relaxed) {
                    tracing::error!(
                        "the MCP address key's keychain item holds no key; it is left as it is, \
                         and no MCP change is made until it is repaired or removed"
                    );
                }
                return Err(ServerAddressKeyError::Damaged);
            };
            ServerAddressKey::of_seed(&seed)
        } else {
            let seed = random_seed()?;
            let key = ServerAddressKey::of_seed(&seed);
            let moved = self.file_sign_ins_under(&key).await?;
            if let Some(rows) = self.rows.get()
                && !moved.is_empty()
            {
                rows.rewrite_digests(&moved)
                    .await
                    .map_err(ServerAddressKeyError::Rows)?;
            }
            self.keychain
                .write_verified(ADDRESS_KEY_ACCOUNT, &encode_seed(&seed))
                .await?;
            key
        };
        Ok(Arc::clone(held.insert(Arc::new(key))))
    }

    // Files each sign-in under `key`'s digest of the address its secret holds, written there
    // before its old item is removed, so a stop part-way leaves it under one account or both, and
    // answers each one moved. An item that does not read as a sign-in names no address and is left
    // where it is.
    async fn file_sign_ins_under(
        &self,
        key: &ServerAddressKey,
    ) -> Result<Vec<MovedDigest>, KeychainRefusal> {
        let mut moved = Vec::new();
        for account in self.keychain.accounts().await? {
            if account == ADDRESS_KEY_ACCOUNT {
                continue;
            }
            let Some(item) = self.keychain.read(&account).await? else {
                continue;
            };
            let sign_in = match read_held_sign_in(&item) {
                Ok(sign_in) => sign_in,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a kept MCP sign-in did not read, so it is not filed under the new \
                         address key"
                    );
                    continue;
                }
            };
            let digest = key.digest(&sign_in.server_address);
            if digest.as_str() == account {
                continue;
            }
            self.keychain.write_verified(digest.as_str(), &item).await?;
            self.keychain.remove(&account).await?;
            moved.push((ServerAddressDigest::from_stored(account), digest));
        }
        Ok(moved)
    }

    /// The digest of `address` under the address key. Fails as [`Self::read`] fails.
    pub(crate) async fn digest(
        &self,
        address: &McpServerAddress,
    ) -> Result<ServerAddressDigest, ServerAddressKeyError> {
        Ok(self.read().await?.digest(address))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::test_keychain::{CountingKeychain, test_keychain};

    use super::{ADDRESS_KEY_ACCOUNT, ServerAddressKeyError, ServerAddressKeys};

    fn address(text: &str) -> McpServerAddress {
        McpServerAddress::new(text).expect("a web address")
    }

    // The key is made once and read back by a later life, so a digest is the same across
    // restarts, two spellings of one server share it and two servers do not, and a keychain that
    // refuses gives no digest and makes no key. Killed by a key made fresh each life (the second
    // life's digest differs), by the address digested unfolded, and by a refused read answered
    // with a new key.
    #[tokio::test]
    async fn the_address_key_is_made_once_and_kept_across_lives() {
        let (_data_folder, _credentials, keychain) = test_keychain(KeychainService::McpSignIns);
        let refusing = Arc::new(CountingKeychain::new(Arc::clone(&keychain)));
        refusing.set_read_refusal(Some(KeychainRefusalCause::Locked));
        assert!(matches!(
            ServerAddressKeys::new(Arc::clone(&refusing) as _)
                .digest(&address("https://docs.example.test/mcp"))
                .await,
            Err(ServerAddressKeyError::Keychain(_))
        ));
        assert!(
            keychain
                .read(ADDRESS_KEY_ACCOUNT)
                .await
                .expect("the keychain reads")
                .is_none()
        );

        let digest = ServerAddressKeys::new(Arc::clone(&keychain))
            .digest(&address("https://docs.example.test/mcp"))
            .await
            .expect("the key is made");
        let second_life = ServerAddressKeys::new(Arc::clone(&keychain));
        assert_eq!(
            second_life
                .digest(&address("HTTPS://Docs.Example.test/mcp/"))
                .await
                .expect("the key is read back"),
            digest
        );
        assert_ne!(
            second_life
                .digest(&address("https://other.example.test/mcp"))
                .await
                .expect("the key is held"),
            digest
        );
    }
}
