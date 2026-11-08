//! The keychain custody of each MCP server's sign-in: one item per server, under its canonical
//! address, holding rmcp's stored credentials, access token included, for a `DPoP` sign-in the
//! proof key's scalar, for a confidential client its secret, and the authorization server
//! metadata address the sign-in read in place of discovery, written whole by one verified write,
//! so a token is never kept beside another sign-in's key, secret or metadata address.
//!
//! A server's item is read from the keychain at most once per daemon life: every later read, from
//! any store over the same custody, is served from memory, so a request to the server costs no
//! keychain call. A save writes the keychain first and memory after, so a refused write leaves the
//! sign-in held as it was. A keychain refusal is never remembered, so the next read asks again.
//!
//! The custody also keeps the set of servers that hold a sign-in, written under each server's
//! lock by the save that keeps a sign-in, by every removal and by the start's seed from the items
//! the keychain files, which marks only a server not yet read or written, so the set never reads
//! a sign-in that is gone. A sign-out counts on the server, and an attempt's save that began
//! before the latest sign-out is refused, so a sign-out is never undone by a sign-in it raced.
//!
//! Each server has one renewal hold, which every renewal of its sign-in takes before its custody,
//! so two renewals never cross; a sign-out takes none and removes the sign-in at once. A renewal's
//! save keeps only over the sign-in the renewal began from, the one rmcp loaded under the store's
//! refresh guard: once a sign-out or another sign-in replaced it, the save is refused, and the
//! credentials it received are kept aside for the authorizer, which revokes them.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
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
use url::Url;

use crate::sign_in::canonical_server_address;

/// A `DPoP` proof key's 32-byte P-256 scalar, wiped when it drops.
pub(crate) type DpopKeyScalar = SecretBox<[u8; 32]>;

/// A server's sign-in as its keychain item holds it.
#[derive(Serialize, Deserialize)]
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
    /// The address of the authorization server's metadata the sign-in read in place of
    /// discovery, which its revocation reads again; `None` where the sign-in discovered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) authorization_server_metadata_url: Option<String>,
}

// Prints whether a metadata address is held, never the address, which may carry a secret.
impl fmt::Debug for HeldSignIn {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HeldSignIn")
            .field("credentials", &self.credentials)
            .field("dpop_key", &self.dpop_key)
            .field("client_secret", &self.client_secret)
            .field(
                "has_authorization_server_metadata_url",
                &self.authorization_server_metadata_url.is_some(),
            )
            .finish()
    }
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
pub struct SignInCustody {
    /// The sign-ins' keychain service.
    keychain: Arc<dyn SecretKeychain>,
    /// Each server's custody by its canonical address, made at its first store.
    servers: Mutex<HashMap<String, Arc<ServerCustody>>>,
    /// The canonical addresses of the servers a sign-in is held for.
    signed_in_addresses: watch::Sender<BTreeSet<String>>,
    /// Each server's renewal hold by its canonical address, which every renewal of its sign-in
    /// takes before its custody.
    pub(super) renewals: KeyedLock<String>,
}

// One server's custody: its keychain account, what was last read or kept there, how many
// sign-outs it had and the sign-in a refused renewal received, until it is taken to be revoked.
// The state's lock is held across the keychain call, so a read and a write on one server never
// cross, and the count only moves under it.
struct ServerCustody {
    account: String,
    held: tokio::sync::Mutex<HeldState>,
    sign_outs: AtomicU64,
    refused_renewal: Mutex<Option<Arc<HeldSignIn>>>,
}

// What this daemon life knows of a server's item.
enum HeldState {
    Unread,
    Read(Option<Arc<HeldSignIn>>),
}

// What a held sign-in's store knows of the renewal under way: whether rmcp holds its refresh
// guard, and the sign-in its load read under that guard, which the renewal began from.
#[derive(Default)]
struct RenewalState {
    is_guarded: bool,
    began_from: Option<Arc<HeldSignIn>>,
}

// The renewal state a store shares with the guard rmcp holds.
type SharedRenewalState = Arc<Mutex<RenewalState>>;

// The proof key and client secret a store's save keeps beside the credentials it is given.
enum SecretsOnSave {
    // The held sign-in's, which a renewal keeps, saved only over the sign-in it began from.
    Held {
        renewal: SharedRenewalState,
    },
    // A sign-in attempt's own, which replace the held ones.
    Attempt {
        // The server's sign-outs when the attempt began; a later one refuses the save.
        since: SignOutGeneration,
        // Its proof key, or none for a bearer sign-in.
        dpop_key: Option<Arc<DpopKeyScalar>>,
        // The secret the server issued its client, or none for a public client.
        client_secret: Option<SecretString>,
        // The metadata address the attempt read in place of discovery, or none where it
        // discovered.
        authorization_server_metadata_url: Option<String>,
    },
}

impl SignInCustody {
    /// The custody of sign-ins kept in `keychain`, the `ai-sidekicks-mcp-sign-ins` service.
    pub fn new(keychain: Arc<dyn SecretKeychain>) -> Arc<Self> {
        Arc::new(Self {
            keychain,
            servers: Mutex::new(HashMap::new()),
            signed_in_addresses: watch::Sender::new(BTreeSet::new()),
            renewals: KeyedLock::new(),
        })
    }

    /// The canonical addresses of the servers that hold a sign-in, as each sign-in is kept or
    /// forgotten.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the inventory's signed-in mark reads it")
    )]
    pub(crate) fn signed_in_addresses(&self) -> watch::Receiver<BTreeSet<String>> {
        self.signed_in_addresses.subscribe()
    }

    /// Marks signed in every server the keychain files a sign-in for, reading no item: each
    /// server this daemon life has not read or written yet, under its custody's lock, so a seed
    /// that ends after a sign-in, a sign-out or a refused renewal there never undoes it. Fails with
    /// the [`KeychainRefusal`] when the keychain refuses to list its items.
    pub async fn seed_signed_in(&self) -> Result<(), KeychainRefusal> {
        for account in self.keychain.accounts().await? {
            let server = self.server_at(account);
            let state = server.held.lock().await;
            if matches!(*state, HeldState::Unread) {
                self.mark_signed_in(&server.account);
            }
        }
        Ok(())
    }

    // Marks the server at `canonical_address` as holding no sign-in, under its custody's lock:
    // what every removal of its sign-in, and every request that finds it needs one, writes.
    fn mark_signed_out(&self, canonical_address: &str) {
        self.signed_in_addresses
            .send_if_modified(|addresses| addresses.remove(canonical_address));
    }

    // Marks the server at `canonical_address` as holding a sign-in, which a kept save and the
    // start's seed write.
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
                renewal: SharedRenewalState::default(),
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
                authorization_server_metadata_url: None,
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
        self.server_at(canonical_server_address(address))
    }

    // The custody of the server whose canonical address is `account`, made at its first use.
    fn server_at(&self, account: String) -> Arc<ServerCustody> {
        Arc::clone(
            lock(&self.servers)
                .entry(account.clone())
                .or_insert_with(|| {
                    Arc::new(ServerCustody {
                        account,
                        held: tokio::sync::Mutex::new(HeldState::Unread),
                        sign_outs: AtomicU64::new(0),
                        refused_renewal: Mutex::new(None),
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
    /// This store, recording beside the sign-in an attempt's save keeps `metadata_address`, the
    /// authorization server metadata address the attempt read in place of discovery; a held
    /// sign-in's store keeps the address its own sign-in recorded, so it is left as it is.
    pub(crate) fn recording_metadata_address(mut self, metadata_address: Option<&Url>) -> Self {
        if let SecretsOnSave::Attempt {
            authorization_server_metadata_url,
            ..
        } = &mut self.secrets_on_save
        {
            *authorization_server_metadata_url = metadata_address.map(Url::to_string);
        }
        self
    }

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

    /// Signs the server out at once, under one hold of its custody, a renewal under way or not:
    /// reads the held sign-in, removes it from the keychain and memory, counts the sign-out, so a
    /// sign-in begun before it is never kept, and marks the server signed out; a renewal under way
    /// then has its save refused. Answers the sign-in removed, whose tokens are to be revoked, or
    /// `None` when none was kept or the item did not read as a sign-in, which is removed all the
    /// same. Fails with the [`KeychainRefusal`], the sign-in still held and in use, when the
    /// keychain refuses the read or the removal.
    pub(crate) async fn sign_out(&self) -> Result<Option<Arc<HeldSignIn>>, KeychainRefusal> {
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

    /// Takes the sign-in a renewal whose save was refused received, its tokens and the proof key
    /// and client secret of the sign-in it began from, so its refresh token can be revoked; `None`
    /// when no renewal was refused since the last take.
    pub(crate) fn take_refused_renewal(&self) -> Option<Arc<HeldSignIn>> {
        lock(&self.server.refused_renewal).take()
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
    // Under rmcp's refresh guard, the sign-in loaded is the one the renewal begins from.
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let held = self.held().await.map_err(|error| store_error(&error))?;
        if let SecretsOnSave::Held { renewal } = &self.secrets_on_save {
            let mut renewal = lock(renewal);
            if renewal.is_guarded {
                renewal.began_from.clone_from(&held);
            }
        }
        Ok(held.map(|held| held.credentials.clone()))
    }

    // A renewal's save is refused unless the sign-in held is the one it began from, its received
    // credentials kept aside to be revoked, an attempt's once the server was signed out after the
    // attempt began, and a kept save marks the server signed in, all under the custody's lock.
    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let mut state = self.server.held.lock().await;
        let (dpop_key, client_secret, authorization_server_metadata_url) =
            match &self.secrets_on_save {
                SecretsOnSave::Held { renewal } => {
                    let held = self
                        .read_through(&mut state)
                        .await
                        .map_err(|error| store_error(&error))?;
                    let began_from = lock(renewal).began_from.clone();
                    let Some(held) = held.filter(|held| {
                        began_from
                            .as_ref()
                            .is_some_and(|began_from| Arc::ptr_eq(began_from, held))
                    }) else {
                        let (dpop_key, client_secret, authorization_server_metadata_url) =
                            began_from.map_or((None, None, None), |began_from| {
                                (
                                    began_from.dpop_key.clone(),
                                    began_from.client_secret.clone(),
                                    began_from.authorization_server_metadata_url.clone(),
                                )
                            });
                        *lock(&self.server.refused_renewal) = Some(Arc::new(HeldSignIn {
                            credentials,
                            dpop_key,
                            client_secret,
                            authorization_server_metadata_url,
                        }));
                        return Err(AuthError::CredentialStoreError(
                            RenewedSignInGone.to_string(),
                        ));
                    };
                    (
                        held.dpop_key.clone(),
                        held.client_secret.clone(),
                        held.authorization_server_metadata_url.clone(),
                    )
                }
                SecretsOnSave::Attempt {
                    since,
                    dpop_key,
                    client_secret,
                    authorization_server_metadata_url,
                } => {
                    if self.server.sign_outs.load(Ordering::Acquire) != since.0 {
                        return Err(AuthError::CredentialStoreError(SignedOutSince.to_string()));
                    }
                    (
                        dpop_key.clone(),
                        client_secret.clone(),
                        authorization_server_metadata_url.clone(),
                    )
                }
            };
        let sign_in = HeldSignIn {
            credentials,
            dpop_key,
            client_secret,
            authorization_server_metadata_url,
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

    // Marks the renewal begun, so the load under the guard records the sign-in its save must
    // still find, until rmcp drops the guard after the save; an attempt's store guards nothing.
    async fn acquire_refresh_guard(&self) -> Result<Option<CredentialRefreshGuard>, AuthError> {
        let SecretsOnSave::Held { renewal } = &self.secrets_on_save else {
            return Ok(None);
        };
        *lock(renewal) = RenewalState {
            is_guarded: true,
            began_from: None,
        };
        Ok(Some(CredentialRefreshGuard::new(RenewalGuard(Arc::clone(
            renewal,
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

// A renewal's guard, which ends the renewal and forgets the sign-in it began from once rmcp drops
// it.
struct RenewalGuard(SharedRenewalState);

impl Drop for RenewalGuard {
    fn drop(&mut self) {
        *lock(&self.0) = RenewalState::default();
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
mod tests;
