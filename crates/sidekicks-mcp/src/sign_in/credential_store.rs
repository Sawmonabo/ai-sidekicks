//! The keychain custody of each MCP server's sign-in: one item per server, under its canonical
//! address, holding rmcp's stored credentials, access token included, for a `DPoP` sign-in the
//! proof key's scalar, and for a confidential client its secret, written whole by one verified
//! write, so a token is never kept beside another sign-in's key or secret.
//!
//! A server's item is read from the keychain at most once per daemon life: every later read, from
//! any store over the same custody, is served from memory, so a request to the server costs no
//! keychain call. A save writes the keychain first and memory after, so a refused write leaves the
//! sign-in held as it was. A keychain refusal is never remembered, so the next read asks again.
//!
//! The custody also keeps the set of servers that hold a sign-in, written under each server's
//! lock by the save that keeps a sign-in and by every removal, so the set never reads a sign-in
//! that is gone. A sign-out counts on the server, and an attempt's save that began before the
//! latest sign-out is refused, so a sign-out is never undone by a sign-in it raced.
//!
//! Each server has one renewal hold, which every renewal and every sign-out of its sign-in takes
//! before its custody, so a sign-out lands after a renewal under way and removes the token that
//! renewal kept. A renewal's save keeps only over the sign-in the renewal began from, read when
//! rmcp takes the store's refresh guard: once a sign-out or another sign-in replaced it, the save
//! is refused.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rmcp::transport::auth::{
    AuthError, CredentialRefreshGuard, CredentialStore, StoredCredentials,
};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret as _, SecretBox, SecretString};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use subtle::ConstantTimeEq as _;
use tokio::sync::watch;

use crate::sign_in::canonical_server_address;

/// A `DPoP` proof key's 32-byte P-256 scalar, wiped when it drops.
pub(crate) type DpopKeyScalar = SecretBox<[u8; 32]>;

/// A server's sign-in as its keychain item holds it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HeldSignIn {
    /// rmcp's credentials: the client, the token response and its scopes, issuer and time.
    pub(crate) credentials: StoredCredentials,
    /// The proof key the tokens are bound to; `None` for a bearer sign-in.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "dpop_key_text"
    )]
    pub(crate) dpop_key: Option<Arc<DpopKeyScalar>>,
    /// The secret of the confidential client the tokens were issued to, which every renewal
    /// sends; `None` for a public client.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "client_secret_text"
    )]
    pub(crate) client_secret: Option<SecretString>,
}

/// Why a server's sign-in could not be read or kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SignInCustodyError {
    /// The keychain refused the call.
    #[error(transparent)]
    Keychain(#[from] KeychainRefusal),
    /// The item held under the server's address is not a sign-in; the failure names where it
    /// stopped reading and never a value it read.
    #[error("the kept MCP sign-in did not read ({category:?} at line {line}, column {column})")]
    Unreadable {
        /// The kind of failure.
        category: serde_json::error::Category,
        /// The line the read stopped on.
        line: usize,
        /// The column the read stopped on.
        column: usize,
    },
}

// Why an attempt's save was refused: the server was signed out after the attempt began.
#[derive(Debug, thiserror::Error)]
#[error("the MCP server was signed out while this sign-in ran, so it was not kept")]
struct SignedOutSince;

// Why a renewal's save was refused: the sign-in it renewed was signed out or replaced first.
#[derive(Debug, thiserror::Error)]
#[error("the MCP server's sign-in was signed out or replaced while it renewed, so it was not kept")]
struct RenewedSignInGone;

/// How many times a server was signed out, read when a sign-in begins: its save is refused once
/// the server has been signed out again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SignOutGeneration(u64);

/// Every server's sign-in custody over the one keychain service the sign-ins are filed under,
/// shared by every credential store so each server's item is read once per daemon life.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds it for the sign-in and its renewal"
    )
)]
pub(crate) struct SignInCustody {
    /// The sign-ins' keychain service.
    keychain: Arc<dyn SecretKeychain>,
    /// Each server's custody by its canonical address, made at its first store.
    servers: Mutex<HashMap<String, Arc<ServerCustody>>>,
    /// The canonical addresses of the servers a sign-in is held for.
    signed_in_addresses: watch::Sender<BTreeSet<String>>,
    /// Each server's renewal hold by its canonical address, which every renewal and sign-out of
    /// its sign-in takes before its custody.
    pub(super) renewals: KeyedLock<String>,
}

// One server's custody: its keychain account, what was last read or kept there and how many
// sign-outs it had. The state's lock is held across the keychain call, so a read and a write on
// one server never cross, and the count only moves under it.
struct ServerCustody {
    account: String,
    held: tokio::sync::Mutex<HeldState>,
    sign_outs: AtomicU64,
}

// What this daemon life knows of a server's item.
enum HeldState {
    Unread,
    Read(Option<Arc<HeldSignIn>>),
}

// The sign-in a renewal began from, kept while rmcp holds the store's refresh guard.
type RenewalBase = Arc<Mutex<Option<Arc<HeldSignIn>>>>;

// The proof key and client secret a store's save keeps beside the credentials it is given.
enum SecretsOnSave {
    // The held sign-in's, which a renewal keeps, saved only over the sign-in it began from.
    Held {
        renewing_from: RenewalBase,
    },
    // A sign-in attempt's own, which replace the held ones.
    Attempt {
        // The server's sign-outs when the attempt began; a later one refuses the save.
        since: SignOutGeneration,
        // Its proof key, or none for a bearer sign-in.
        dpop_key: Option<Arc<DpopKeyScalar>>,
        // The secret the server issued its client, or none for a public client.
        client_secret: Option<SecretString>,
    },
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds it for the sign-in and its renewal"
    )
)]
impl SignInCustody {
    /// The custody of sign-ins kept in `keychain`, the `ai-sidekicks-mcp-sign-ins` service.
    pub(crate) fn new(keychain: Arc<dyn SecretKeychain>) -> Arc<Self> {
        Arc::new(Self {
            keychain,
            servers: Mutex::new(HashMap::new()),
            signed_in_addresses: watch::Sender::new(BTreeSet::new()),
            renewals: KeyedLock::new(),
        })
    }

    /// The canonical addresses of the servers that hold a sign-in, as each sign-in is kept or
    /// forgotten.
    pub(crate) fn signed_in_addresses(&self) -> watch::Receiver<BTreeSet<String>> {
        self.signed_in_addresses.subscribe()
    }

    // Marks the server at `canonical_address` as holding no sign-in, under its custody's lock:
    // what every removal of its sign-in, and every request that finds it needs one, writes.
    fn mark_signed_out(&self, canonical_address: &str) {
        self.signed_in_addresses
            .send_if_modified(|addresses| addresses.remove(canonical_address));
    }

    // Marks the server at `canonical_address` as holding a sign-in, which only a kept save writes.
    fn mark_signed_in(&self, canonical_address: &str) {
        self.signed_in_addresses
            .send_if_modified(|addresses| addresses.insert(canonical_address.to_owned()));
    }

    /// How many times the server at `address` has been signed out, which a sign-in beginning now
    /// hands to [`SignInCustody::attempt_credential_store`].
    pub(crate) fn sign_out_generation(&self, address: &McpServerAddress) -> SignOutGeneration {
        SignOutGeneration(self.server(address).sign_outs.load(Ordering::Acquire))
    }

    /// The credential store of the server at `address` for its held sign-in, which renews it: a
    /// save keeps the held proof key and client secret, and is refused unless the sign-in held is
    /// still the one the renewal began from.
    pub(crate) fn credential_store(
        self: &Arc<Self>,
        address: &McpServerAddress,
    ) -> McpCredentialStore {
        self.store(
            address,
            SecretsOnSave::Held {
                renewing_from: RenewalBase::default(),
            },
        )
    }

    /// The credential store of one sign-in attempt at `address` that began at `since`: its save
    /// replaces the held sign-in whole, keeping `dpop_key`, the attempt's own key (the one the
    /// attempt's OAuth client signs with), or none for a bearer sign-in, and `client_secret`, the
    /// secret the server issued the attempt's client, or none for a public client. The save is
    /// refused when the server was signed out after `since`.
    pub(crate) fn attempt_credential_store(
        self: &Arc<Self>,
        address: &McpServerAddress,
        since: SignOutGeneration,
        dpop_key: Option<Arc<DpopKeyScalar>>,
        client_secret: Option<SecretString>,
    ) -> McpCredentialStore {
        self.store(
            address,
            SecretsOnSave::Attempt {
                since,
                dpop_key,
                client_secret,
            },
        )
    }

    fn store(
        self: &Arc<Self>,
        address: &McpServerAddress,
        secrets_on_save: SecretsOnSave,
    ) -> McpCredentialStore {
        McpCredentialStore {
            custody: Arc::clone(self),
            server: self.server(address),
            secrets_on_save,
        }
    }

    // The custody of the server at `address`, made at its first use.
    fn server(&self, address: &McpServerAddress) -> Arc<ServerCustody> {
        let account = canonical_server_address(address);
        Arc::clone(
            lock(&self.servers)
                .entry(account.clone())
                .or_insert_with(|| {
                    Arc::new(ServerCustody {
                        account,
                        held: tokio::sync::Mutex::new(HeldState::Unread),
                        sign_outs: AtomicU64::new(0),
                    })
                }),
        )
    }
}

/// One server's sign-in as rmcp's credential store, over the custody it came from.
pub(crate) struct McpCredentialStore {
    custody: Arc<SignInCustody>,
    server: Arc<ServerCustody>,
    secrets_on_save: SecretsOnSave,
}

impl McpCredentialStore {
    /// The server's held sign-in, or `None` when none is kept; the keychain is asked only the
    /// first time in this daemon life. Fails with [`SignInCustodyError`] when the keychain refuses
    /// or its item does not read as a sign-in.
    pub(crate) async fn held(&self) -> Result<Option<Arc<HeldSignIn>>, SignInCustodyError> {
        let mut state = self.server.held.lock().await;
        self.read_through(&mut state).await
    }

    /// Forgets the server's sign-in, from the keychain and then from memory, and marks the server
    /// signed out; `false` when none was kept. Fails with the [`KeychainRefusal`], the sign-in
    /// still held, when the keychain refuses.
    pub(crate) async fn remove(&self) -> Result<bool, KeychainRefusal> {
        let mut state = self.server.held.lock().await;
        self.forget(&mut state).await
    }

    /// Signs the server out once a renewal under way has landed, under its renewal hold and then
    /// one hold of its custody: reads the held sign-in, removes it from the keychain and memory,
    /// counts the sign-out, so a sign-in begun before it is never kept, and marks the server
    /// signed out. Answers the sign-in removed, whose tokens are to be revoked, or `None` when none
    /// was kept or the item did not read as a sign-in, which is removed all the same. Fails with
    /// the [`KeychainRefusal`], the sign-in still held and in use, when the keychain refuses the
    /// read or the removal.
    pub(crate) async fn sign_out(&self) -> Result<Option<Arc<HeldSignIn>>, KeychainRefusal> {
        let _renewal = self
            .custody
            .renewals
            .acquire(self.server.account.clone())
            .await;
        let mut state = self.server.held.lock().await;
        let held = match self.read_through(&mut state).await {
            Ok(held) => held,
            Err(SignInCustodyError::Keychain(refusal)) => return Err(refusal),
            Err(error @ SignInCustodyError::Unreadable { .. }) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an MCP server's kept sign-in did not read, so it is removed unrevoked"
                );
                None
            }
        };
        self.forget(&mut state).await?;
        self.server.sign_outs.fetch_add(1, Ordering::AcqRel);
        Ok(held)
    }

    /// Marks the server signed out, under its custody's lock, when it holds no sign-in or still
    /// holds `found`, the sign-in a request found needs a new one; a sign-in kept since stays
    /// marked signed in. Fails with [`SignInCustodyError`] when the keychain refuses or its item
    /// does not read as a sign-in.
    pub(crate) async fn mark_needs_sign_in(
        &self,
        found: Option<&Arc<HeldSignIn>>,
    ) -> Result<(), SignInCustodyError> {
        let mut state = self.server.held.lock().await;
        let held = self.read_through(&mut state).await?;
        let is_kept_since = held
            .as_ref()
            .is_some_and(|held| found.is_none_or(|found| !Arc::ptr_eq(found, held)));
        if !is_kept_since {
            self.custody.mark_signed_out(&self.server.account);
        }
        Ok(())
    }

    // Removes the server's item and forgets it in `state`, the custody's lock held, and marks the
    // server signed out.
    async fn forget(&self, state: &mut HeldState) -> Result<bool, KeychainRefusal> {
        let was_kept = self.custody.keychain.remove(&self.server.account).await?;
        *state = HeldState::Read(None);
        self.custody.mark_signed_out(&self.server.account);
        Ok(was_kept)
    }

    // The held sign-in, read from the keychain into `state` when this life has not read it.
    async fn read_through(
        &self,
        state: &mut HeldState,
    ) -> Result<Option<Arc<HeldSignIn>>, SignInCustodyError> {
        if let HeldState::Read(held) = state {
            return Ok(held.clone());
        }
        let held = match self.custody.keychain.read(&self.server.account).await? {
            None => None,
            Some(item) => Some(Arc::new(
                serde_json::from_str::<HeldSignIn>(item.expose_secret()).map_err(|error| {
                    SignInCustodyError::Unreadable {
                        category: error.classify(),
                        line: error.line(),
                        column: error.column(),
                    }
                })?,
            )),
        };
        *state = HeldState::Read(held.clone());
        Ok(held)
    }
}

#[async_trait]
impl CredentialStore for McpCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let held = self.held().await.map_err(|error| store_error(&error))?;
        Ok(held.map(|held| held.credentials.clone()))
    }

    // A renewal's save is refused unless the sign-in held is the one it began from, an attempt's
    // once the server was signed out after the attempt began, and a kept save marks the server
    // signed in, all under the custody's lock.
    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let mut state = self.server.held.lock().await;
        let (dpop_key, client_secret) = match &self.secrets_on_save {
            SecretsOnSave::Held { renewing_from } => {
                let held = self
                    .read_through(&mut state)
                    .await
                    .map_err(|error| store_error(&error))?;
                let began_from = lock(renewing_from).clone();
                let Some(held) = held.filter(|held| {
                    began_from
                        .as_ref()
                        .is_some_and(|began_from| Arc::ptr_eq(began_from, held))
                }) else {
                    return Err(AuthError::CredentialStoreError(
                        RenewedSignInGone.to_string(),
                    ));
                };
                (held.dpop_key.clone(), held.client_secret.clone())
            }
            SecretsOnSave::Attempt {
                since,
                dpop_key,
                client_secret,
            } => {
                if self.server.sign_outs.load(Ordering::Acquire) != since.0 {
                    return Err(AuthError::CredentialStoreError(SignedOutSince.to_string()));
                }
                (dpop_key.clone(), client_secret.clone())
            }
        };
        let sign_in = HeldSignIn {
            credentials,
            dpop_key,
            client_secret,
        };
        let item =
            SecretString::from(serde_json::to_string(&sign_in).expect("a sign-in writes as JSON"));
        self.custody
            .keychain
            .write_verified(&self.server.account, &item)
            .await
            .map_err(|refusal| store_error(&SignInCustodyError::from(refusal)))?;
        *state = HeldState::Read(Some(Arc::new(sign_in)));
        self.custody.mark_signed_in(&self.server.account);
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.remove()
            .await
            .map_err(|refusal| store_error(&SignInCustodyError::from(refusal)))?;
        Ok(())
    }

    // Keeps the sign-in held as the renewal begins, which its save must still find, until rmcp
    // drops the guard after the save; an attempt's store guards nothing.
    async fn acquire_refresh_guard(&self) -> Result<Option<CredentialRefreshGuard>, AuthError> {
        let SecretsOnSave::Held { renewing_from } = &self.secrets_on_save else {
            return Ok(None);
        };
        let held = self.held().await.map_err(|error| store_error(&error))?;
        *lock(renewing_from) = held;
        Ok(Some(CredentialRefreshGuard::new(RenewalGuard(Arc::clone(
            renewing_from,
        )))))
    }

    // Only the credentials the authorization server refused are forgotten: a sign-in kept since,
    // by another renewal or a new sign-in, stays.
    async fn on_refresh_token_rejected(
        &self,
        credentials: &StoredCredentials,
    ) -> Result<(), AuthError> {
        let mut state = self.server.held.lock().await;
        let Some(held) = self
            .read_through(&mut state)
            .await
            .map_err(|error| store_error(&error))?
        else {
            return Ok(());
        };
        if !is_same_credentials(&held.credentials, credentials) {
            return Ok(());
        }
        self.forget(&mut state)
            .await
            .map_err(|refusal| store_error(&SignInCustodyError::from(refusal)))?;
        Ok(())
    }
}

// A renewal's guard, which forgets the sign-in the renewal began from once rmcp drops it.
struct RenewalGuard(RenewalBase);

impl Drop for RenewalGuard {
    fn drop(&mut self) {
        *lock(&self.0) = None;
    }
}

// rmcp's store error, which carries text alone: the refusal's words, which name no value.
fn store_error(error: &SignInCustodyError) -> AuthError {
    AuthError::CredentialStoreError(error.to_string())
}

// Whether two credentials are the same, their tokens compared in constant time.
fn is_same_credentials(left: &StoredCredentials, right: &StoredCredentials) -> bool {
    let text = |credentials| {
        Zeroizing::new(serde_json::to_vec(credentials).expect("credentials write as JSON"))
    };
    bool::from(text(left).ct_eq(&text(right)))
}

// The proof key in the item, as base64url text with no padding.
mod dpop_key_text {
    use std::sync::Arc;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::{DecodeSliceError, Engine as _};
    use secrecy::zeroize::Zeroizing;
    use secrecy::{ExposeSecret as _, ExposeSecretMut as _};
    use serde::de::Error as _;
    use serde::{Deserialize as _, Deserializer, Serializer};

    use super::DpopKeyScalar;

    #[expect(
        clippy::ref_option,
        reason = "serde's `serialize_with` hands the field by reference"
    )]
    pub(super) fn serialize<S: Serializer>(
        dpop_key: &Option<Arc<DpopKeyScalar>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match dpop_key {
            Some(dpop_key) => serializer.serialize_some(
                Zeroizing::new(URL_SAFE_NO_PAD.encode(dpop_key.expose_secret())).as_str(),
            ),
            None => serializer.serialize_none(),
        }
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Arc<DpopKeyScalar>>, D::Error> {
        let Some(text) = Option::<String>::deserialize(deserializer)?.map(Zeroizing::new) else {
            return Ok(None);
        };
        let mut dpop_key = DpopKeyScalar::default();
        let length = URL_SAFE_NO_PAD
            .decode_slice(text.as_bytes(), dpop_key.expose_secret_mut())
            // The decoder's own error quotes the symbol it refused, a piece of the key, so only
            // its kind is kept.
            .map_err(|error| match error {
                DecodeSliceError::OutputSliceTooSmall => {
                    D::Error::custom("a proof key longer than 32 bytes")
                }
                DecodeSliceError::DecodeError(_) => {
                    D::Error::custom("a proof key that is not base64url")
                }
            })?;
        if length != dpop_key.expose_secret().len() {
            return Err(D::Error::custom("a proof key shorter than 32 bytes"));
        }
        Ok(Some(Arc::new(dpop_key)))
    }
}

// The client secret in the item, as its own text, read through a buffer wiped when it drops.
mod client_secret_text {
    use secrecy::zeroize::Zeroizing;
    use secrecy::{ExposeSecret as _, SecretString};
    use serde::{Deserialize as _, Deserializer, Serializer};

    #[expect(
        clippy::ref_option,
        reason = "serde's `serialize_with` hands the field by reference"
    )]
    pub(super) fn serialize<S: Serializer>(
        client_secret: &Option<SecretString>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match client_secret {
            Some(client_secret) => serializer.serialize_some(client_secret.expose_secret()),
            None => serializer.serialize_none(),
        }
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<SecretString>, D::Error> {
        let text = Option::<String>::deserialize(deserializer)?.map(Zeroizing::new);
        Ok(text.map(|text| SecretString::from(text.as_str())))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::future::BoxFuture;
    use rmcp::transport::auth::{AuthError, CredentialStore as _, StoredCredentials};
    use rstest::rstest;
    use secrecy::SecretString;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};

    use super::SignInCustody;
    use crate::sign_in::canonical_server_address;
    use crate::sign_in::test_keychain::test_keychain;

    fn server_address() -> McpServerAddress {
        McpServerAddress::new("https://docs.example.com/mcp").expect("a server address")
    }

    /// Credentials whose access token is `access_token`; every token is made up for the test.
    fn credentials(access_token: &str) -> StoredCredentials {
        let token_response = serde_json::from_value(serde_json::json!({
            "access_token": access_token,
            "token_type": "Bearer",
            "refresh_token": "test-refresh-token",
            "expires_in": 3600,
        }))
        .expect("a token response reads");
        StoredCredentials::new(
            "test-client".to_owned(),
            Some(token_response),
            vec![],
            Some(1),
        )
    }

    /// Keeps a sign-in whose access token is `access_token` for the server at `address`, as a
    /// sign-in attempt begun now does.
    async fn keep(custody: &Arc<SignInCustody>, address: &McpServerAddress, access_token: &str) {
        custody
            .attempt_credential_store(address, custody.sign_out_generation(address), None, None)
            .save(credentials(access_token))
            .await
            .expect("the sign-in is kept");
    }

    fn access_token(credentials: &StoredCredentials) -> serde_json::Value {
        serde_json::to_value(credentials).expect("credentials write as JSON")["token_response"]
            ["access_token"]
            .clone()
    }

    /// A keychain counting the reads that reach the one under it.
    struct CountingKeychain {
        inner: Arc<dyn SecretKeychain>,
        reads: AtomicUsize,
    }

    impl SecretKeychain for CountingKeychain {
        fn write<'call>(
            &'call self,
            account: &'call str,
            value: &'call SecretString,
        ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
            self.inner.write(account, value)
        }

        fn read<'call>(
            &'call self,
            account: &'call str,
        ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.read(account)
        }

        fn remove<'call>(
            &'call self,
            account: &'call str,
        ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
            self.inner.remove(account)
        }

        fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
            self.inner.accounts()
        }
    }

    /// A sign-in an earlier daemon life kept is read from the keychain once, however many stores
    /// rmcp's managers build for the server load it after. Killed by reading the keychain on every
    /// load, and by a cache kept per store rather than per custody.
    #[tokio::test]
    async fn a_kept_sign_in_is_read_from_the_keychain_once() {
        let (_data_folder, _credentials, keychain) = test_keychain();
        keep(
            &SignInCustody::new(Arc::clone(&keychain)),
            &server_address(),
            "test-access-token",
        )
        .await;
        let counting = Arc::new(CountingKeychain {
            inner: keychain,
            reads: AtomicUsize::new(0),
        });
        let custody = SignInCustody::new(Arc::clone(&counting) as _);

        for _ in 0..11 {
            let loaded = custody
                .credential_store(&server_address())
                .load()
                .await
                .expect("the keychain answers")
                .expect("the sign-in is kept");
            assert_eq!(access_token(&loaded), "test-access-token");
        }

        assert_eq!(counting.reads.load(Ordering::SeqCst), 1);
    }

    /// A save the keychain refuses comes back refused, and the server's sign-in stays the one held
    /// before it. Killed by writing memory before the keychain.
    #[tokio::test]
    async fn a_refused_save_keeps_the_sign_in_held_before_it() {
        let (_data_folder, platform_store, keychain) = test_keychain();
        let custody = SignInCustody::new(keychain);
        let address = server_address();
        let store = custody.attempt_credential_store(
            &address,
            custody.sign_out_generation(&address),
            None,
            None,
        );
        store
            .save(credentials("test-access-token-1"))
            .await
            .expect("the first sign-in is kept");
        platform_store.refuse_next_call(
            KeychainService::McpSignIns.as_str(),
            &canonical_server_address(&server_address()),
        );

        let refused = store.save(credentials("test-access-token-2")).await;

        assert!(
            matches!(refused, Err(AuthError::CredentialStoreError(_))),
            "the refused write is returned"
        );
        let loaded = store
            .load()
            .await
            .expect("the held sign-in is read")
            .expect("the sign-in is still held");
        assert_eq!(access_token(&loaded), "test-access-token-1");
    }

    /// An attempt that began before a sign-out never keeps its sign-in: its save is refused, the
    /// keychain holds nothing and the server reads signed out, while an attempt begun after the
    /// sign-out keeps its own. Killed by a save that skips the sign-out count, by a sign-out that
    /// does not count, and by a refused save that still marks the server signed in.
    #[tokio::test]
    async fn a_sign_in_begun_before_a_sign_out_is_never_kept() {
        let (_data_folder, _platform_store, keychain) = test_keychain();
        let custody = SignInCustody::new(Arc::clone(&keychain));
        let address = server_address();
        let canonical_address = canonical_server_address(&address);
        keep(&custody, &address, "test-access-token-1").await;
        let begun_before = custody.attempt_credential_store(
            &address,
            custody.sign_out_generation(&address),
            None,
            None,
        );

        custody
            .credential_store(&address)
            .sign_out()
            .await
            .expect("the sign-out removes the sign-in");
        let refused = begun_before.save(credentials("test-access-token-2")).await;

        assert!(matches!(refused, Err(AuthError::CredentialStoreError(_))));
        assert!(
            keychain
                .read(&canonical_address)
                .await
                .expect("the keychain answers")
                .is_none()
        );
        assert!(
            !custody
                .signed_in_addresses()
                .borrow()
                .contains(&canonical_address)
        );

        custody
            .attempt_credential_store(&address, custody.sign_out_generation(&address), None, None)
            .save(credentials("test-access-token-3"))
            .await
            .expect("a sign-in begun after the sign-out is kept");
        assert!(
            custody
                .signed_in_addresses()
                .borrow()
                .contains(&canonical_address)
        );
    }

    /// The sign-out answers the sign-in it removed, the last one kept, and leaves nothing held in
    /// memory or the keychain. Killed by answering an earlier sign-in, and by a sign-out that
    /// leaves the item or the memory behind.
    #[tokio::test]
    async fn a_sign_out_answers_the_sign_in_it_removed() {
        let (_data_folder, _platform_store, keychain) = test_keychain();
        let custody = SignInCustody::new(Arc::clone(&keychain));
        let address = server_address();
        keep(&custody, &address, "test-access-token-1").await;
        keep(&custody, &address, "test-access-token-2").await;
        let store = custody.credential_store(&address);

        let removed = store
            .sign_out()
            .await
            .expect("the keychain answers")
            .expect("a sign-in was held");

        assert_eq!(access_token(&removed.credentials), "test-access-token-2");
        assert!(store.load().await.expect("the custody answers").is_none());
        assert!(
            keychain
                .read(&canonical_server_address(&address))
                .await
                .expect("the keychain answers")
                .is_none()
        );
    }

    /// A renewal's save keeps its tokens only over the sign-in the renewal began from: one a
    /// sign-out removed stays out and the server reads signed out, and one a new sign-in replaced
    /// stays the new sign-in. Killed by a renewal's save that writes over whatever is held, or
    /// over nothing.
    #[rstest]
    #[case::a_sign_out(true)]
    #[case::a_new_sign_in(false)]
    #[tokio::test]
    async fn a_renewal_keeps_nothing_once_its_sign_in_is_gone(#[case] is_signed_out: bool) {
        let (_data_folder, _platform_store, keychain) = test_keychain();
        let custody = SignInCustody::new(Arc::clone(&keychain));
        let address = server_address();
        let canonical_address = canonical_server_address(&address);
        keep(&custody, &address, "test-access-token-1").await;
        let renewal = custody.credential_store(&address);
        let guard = renewal
            .acquire_refresh_guard()
            .await
            .expect("the custody answers");

        if is_signed_out {
            custody
                .credential_store(&address)
                .sign_out()
                .await
                .expect("the sign-out removes the sign-in");
        } else {
            keep(&custody, &address, "test-access-token-3").await;
        }
        let refused = renewal.save(credentials("test-access-token-2")).await;
        drop(guard);

        assert!(matches!(refused, Err(AuthError::CredentialStoreError(_))));
        let held = renewal.load().await.expect("the custody answers");
        assert_eq!(
            held.as_ref().map(access_token),
            (!is_signed_out).then(|| serde_json::json!("test-access-token-3"))
        );
        assert_eq!(
            custody
                .signed_in_addresses()
                .borrow()
                .contains(&canonical_address),
            !is_signed_out
        );
    }
}
