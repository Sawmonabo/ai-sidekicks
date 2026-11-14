//! The keychain custody of each MCP server's sign-in: one item per server, filed under the
//! server's keyed digest, never its address, holding the server's address as its binding declared
//! it, rmcp's stored credentials, access token included, for a `DPoP` sign-in the proof key's
//! scalar, for a confidential client the server issued its secret, for a client the server's
//! owner issued the binding its secret is read through again at each renewal and revocation, never
//! the secret itself, and the authorization server metadata address the sign-in read in place of
//! discovery, written whole by one verified write, so a token is never kept beside another
//! sign-in's key, secret or metadata address.
//!
//! A server's item is read from the keychain at most once per daemon life: every later read, from
//! any store over the same custody, is served from memory, so a request to the server costs no
//! keychain call. A save writes the keychain first and memory after, so a refused write leaves the
//! sign-in held as it was. A keychain refusal is never remembered, so the next read asks again.
//!
//! The custody also keeps the set of servers, by digest, that hold a sign-in, written under each server's
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
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use subtle::ConstantTimeEq as _;
use tokio::sync::watch;
use url::Url;

use crate::sign_in::address_digest::{
    ADDRESS_KEY_ACCOUNT, ServerAddressDigest, ServerAddressKey, ServerAddressKeyError,
    ServerAddressKeys, ServerDigestRows,
};

/// A `DPoP` proof key's 32-byte P-256 scalar, wiped when it drops.
pub(crate) type DpopKeyScalar = SecretBox<[u8; 32]>;

/// A server's sign-in as its keychain item holds it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HeldSignIn {
    /// The server's address as its binding declared it when it signed in, its user name and query
    /// kept, which the revocation discovers the metadata at: the one place the address is kept.
    pub(crate) server_address: McpServerAddress,
    /// rmcp's credentials: the client, the token response and its scopes, issuer and time.
    pub(crate) credentials: StoredCredentials,
    /// The proof key the tokens are bound to; `None` for a bearer sign-in.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "dpop_key_text"
    )]
    pub(crate) dpop_key: Option<Arc<DpopKeyScalar>>,
    /// The secret the server issued the confidential client the tokens were issued to, which
    /// every renewal sends; `None` for a public client and for a client its owner issued.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "client_secret_text"
    )]
    pub(crate) client_secret: Option<SecretString>,
    /// The binding whose entry names the client the server's owner issued, where the tokens were
    /// issued to that client: its secret is read again through the binding's provider at each
    /// renewal and revocation, so a rotated secret is sent and none is kept here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner_client_binding: Option<McpServerBindingRef>,
    /// The address of the authorization server's metadata the sign-in read in place of
    /// discovery, which its revocation reads again; `None` where the sign-in discovered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) authorization_server_metadata_url: Option<String>,
}

// Prints whether a metadata address is held, never it or the server's address, either of which
// may carry a secret.
impl fmt::Debug for HeldSignIn {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HeldSignIn")
            .field("credentials", &self.credentials)
            .field("dpop_key", &self.dpop_key)
            .field("client_secret", &self.client_secret)
            .field("owner_client_binding", &self.owner_client_binding)
            .field(
                "has_authorization_server_metadata_url",
                &self.authorization_server_metadata_url.is_some(),
            )
            .finish_non_exhaustive()
    }
}

/// Why a server's sign-in could not be read or kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SignInCustodyError {
    /// The keychain refused the call.
    #[error(transparent)]
    Keychain(#[from] KeychainRefusal),
    /// The address key the server's item is filed under could not be read or made.
    #[error(transparent)]
    AddressKey(#[from] ServerAddressKeyError),
    /// The item held under the server's digest is not a sign-in; the failure names where it
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
    /// The key every server's digest is keyed with, an item of the same service.
    keys: ServerAddressKeys,
    /// Each server's custody by its digest, made at its first store.
    servers: Mutex<HashMap<ServerAddressDigest, Arc<ServerCustody>>>,
    /// The digests of the servers a sign-in is held for.
    signed_in_servers: watch::Sender<BTreeSet<ServerAddressDigest>>,
    /// Each server's renewal hold by its digest, which every renewal of its sign-in takes before
    /// its custody.
    pub(super) renewals: KeyedLock<ServerAddressDigest>,
}

// One server's custody: its keychain account, its digest, what was last read or kept there, how many
// sign-outs it had and the sign-in a refused renewal received, until it is taken to be revoked.
// The state's lock is held across the keychain call, so a read and a write on one server never
// cross, and the count only moves under it.
struct ServerCustody {
    account: ServerAddressDigest,
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
        // The server's address as its binding declares it, kept in the item.
        server_address: McpServerAddress,
        // Its proof key, or none for a bearer sign-in.
        dpop_key: Option<Arc<DpopKeyScalar>>,
        // The secret the server issued its client, or none for a public client and an owner's.
        client_secret: Option<SecretString>,
        // The binding naming the owner's client the attempt signs in as, or none for any other.
        owner_client_binding: Option<McpServerBindingRef>,
        // The metadata address the attempt read in place of discovery, or none where it
        // discovered.
        authorization_server_metadata_url: Option<String>,
    },
}

impl SignInCustody {
    /// The custody of sign-ins kept in `keychain`, the `ai-sidekicks-mcp-sign-ins` service, which
    /// the operating system's store files under that word and the install's mark.
    pub fn new(keychain: Arc<dyn SecretKeychain>) -> Arc<Self> {
        Arc::new(Self {
            keys: ServerAddressKeys::new(Arc::clone(&keychain)),
            keychain,
            servers: Mutex::new(HashMap::new()),
            signed_in_servers: watch::Sender::new(BTreeSet::new()),
            renewals: KeyedLock::new(),
        })
    }

    /// The digests of the servers that hold a sign-in, as each sign-in is kept or forgotten.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the inventory's signed-in mark reads it")
    )]
    pub(crate) fn signed_in_servers(&self) -> watch::Receiver<BTreeSet<ServerAddressDigest>> {
        self.signed_in_servers.subscribe()
    }

    /// The digest the sign-in of the server at `address` is kept under. Fails with
    /// [`ServerAddressKeyError`] when the keychain cannot give the address key.
    pub(crate) async fn digest(
        &self,
        address: &McpServerAddress,
    ) -> Result<ServerAddressDigest, ServerAddressKeyError> {
        self.keys.digest(address).await
    }

    /// Has `rows` rewritten whenever a lost address key's replacement moves the sign-ins to new
    /// digests; only the first rows given are kept.
    pub(crate) fn follow_moves_with(&self, rows: Arc<dyn ServerDigestRows>) {
        self.keys.follow_moves_with(rows);
    }

    /// The address key every server's digest is made with, for a caller that digests many
    /// addresses at once. Fails with [`ServerAddressKeyError`] when the keychain cannot give it.
    pub(crate) async fn address_key(&self) -> Result<Arc<ServerAddressKey>, ServerAddressKeyError> {
        self.keys.read().await
    }

    /// Marks signed in every server the keychain files a sign-in for, reading no item: each
    /// server this daemon life has not read or written yet, under its custody's lock, so a seed
    /// that ends after a sign-in, a sign-out or a refused renewal there never undoes it. Where a
    /// sign-in is filed the address key is read first and the items listed again, so a lost key's
    /// sign-ins are listed once filed under the new one; where none is, no key is read or made.
    /// Fails with [`SignInCustodyError`] when the address key cannot be read or the keychain
    /// refuses to list its items.
    pub(crate) async fn seed_signed_in(&self) -> Result<(), SignInCustodyError> {
        let is_sign_in = |account: &String| account != ADDRESS_KEY_ACCOUNT;
        if !self.keychain.accounts().await?.iter().any(is_sign_in) {
            return Ok(());
        }
        self.keys.read().await?;
        for account in self.keychain.accounts().await? {
            if !is_sign_in(&account) {
                continue;
            }
            let server = self.server(&ServerAddressDigest::from_stored(account));
            let state = server.held.lock().await;
            if matches!(*state, HeldState::Unread) {
                self.mark_signed_in(&server.account);
            }
        }
        Ok(())
    }

    // Marks the server `digest` names as holding no sign-in, under its custody's lock: what every
    // removal of its sign-in, and every request that finds it needs one, writes.
    fn mark_signed_out(&self, digest: &ServerAddressDigest) {
        self.signed_in_servers
            .send_if_modified(|servers| servers.remove(digest));
    }

    // Marks the server `digest` names as holding a sign-in, which a kept save and the start's seed
    // write.
    fn mark_signed_in(&self, digest: &ServerAddressDigest) {
        self.signed_in_servers
            .send_if_modified(|servers| servers.insert(digest.clone()));
    }

    /// How many times the server `digest` names has been signed out, which a sign-in beginning
    /// now hands to [`SignInCustody::attempt_credential_store`].
    pub(crate) fn sign_out_generation(&self, digest: &ServerAddressDigest) -> SignOutGeneration {
        SignOutGeneration(self.server(digest).sign_outs.load(Ordering::Acquire))
    }

    /// The credential store of the server at `address`, whose digest is `digest`, for its held
    /// sign-in, which renews it: a save keeps the held proof key and client secret, and is refused
    /// unless the sign-in held is still the one the renewal began from.
    pub(crate) fn credential_store(
        self: &Arc<Self>,
        digest: &ServerAddressDigest,
        address: &McpServerAddress,
    ) -> McpCredentialStore {
        self.store(
            digest,
            address,
            SecretsOnSave::Held {
                renewal: SharedRenewalState::default(),
            },
        )
    }

    /// The credential store of one sign-in attempt at `address`, whose digest is `digest`, that
    /// began at `since`: its save replaces the held sign-in whole, keeping `address`, `dpop_key`,
    /// the attempt's own key (the one the attempt's OAuth client signs with), or none for a bearer
    /// sign-in, and `client_secret`, the secret the server issued the attempt's client, or none
    /// for a public client. The save is refused when the server was signed out after `since`.
    pub(crate) fn attempt_credential_store(
        self: &Arc<Self>,
        digest: &ServerAddressDigest,
        address: &McpServerAddress,
        since: SignOutGeneration,
        dpop_key: Option<Arc<DpopKeyScalar>>,
        client_secret: Option<SecretString>,
    ) -> McpCredentialStore {
        self.store(
            digest,
            address,
            SecretsOnSave::Attempt {
                since,
                server_address: address.clone(),
                dpop_key,
                client_secret,
                owner_client_binding: None,
                authorization_server_metadata_url: None,
            },
        )
    }

    /// Signs the server `digest` names out at once, under one hold of its custody, a renewal under
    /// way or not: reads the held sign-in, removes it from the keychain and memory, counts the
    /// sign-out, so a sign-in begun before it is never kept, and marks the server signed out; a
    /// renewal under way then has its save refused. Answers the sign-in removed, whose tokens are
    /// to be revoked and whose address it holds, or `None` when none was kept or the item did not
    /// read as a sign-in, which is removed all the same. Fails with the [`KeychainRefusal`], the
    /// sign-in still held and in use, when the keychain refuses the read or the removal.
    pub(crate) async fn sign_out(
        &self,
        digest: &ServerAddressDigest,
    ) -> Result<Option<Arc<HeldSignIn>>, KeychainRefusal> {
        let server = self.server(digest);
        let mut state = server.held.lock().await;
        let held = match self.read_through(&server, &mut state).await {
            Ok(held) => held,
            Err(SignInCustodyError::Keychain(refusal)) => return Err(refusal),
            Err(
                error @ (SignInCustodyError::Unreadable { .. } | SignInCustodyError::AddressKey(_)),
            ) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an MCP server's kept sign-in did not read, so it is removed unrevoked"
                );
                None
            }
        };
        self.forget(&server, &mut state).await?;
        server.sign_outs.fetch_add(1, Ordering::AcqRel);
        Ok(held)
    }

    /// A test's store of a sign-in attempt at `address` begun now, as
    /// [`Self::attempt_credential_store`] makes it under the address's digest.
    #[cfg(test)]
    pub(crate) async fn test_attempt_store(
        self: &Arc<Self>,
        address: &McpServerAddress,
        dpop_key: Option<Arc<DpopKeyScalar>>,
        client_secret: Option<SecretString>,
    ) -> McpCredentialStore {
        let digest = self.test_digest(address).await;
        self.attempt_credential_store(
            &digest,
            address,
            self.sign_out_generation(&digest),
            dpop_key,
            client_secret,
        )
    }

    /// A test's store of the sign-in held for `address`, as [`Self::credential_store`] makes it.
    #[cfg(test)]
    pub(crate) async fn test_held_store(
        self: &Arc<Self>,
        address: &McpServerAddress,
    ) -> McpCredentialStore {
        let digest = self.test_digest(address).await;
        self.credential_store(&digest, address)
    }

    /// A test's digest of `address`, the address key made where none is kept.
    #[cfg(test)]
    pub(crate) async fn test_digest(&self, address: &McpServerAddress) -> ServerAddressDigest {
        self.digest(address).await.expect("the address key is made")
    }

    fn store(
        self: &Arc<Self>,
        digest: &ServerAddressDigest,
        address: &McpServerAddress,
        secrets_on_save: SecretsOnSave,
    ) -> McpCredentialStore {
        McpCredentialStore {
            custody: Arc::clone(self),
            server: self.server(digest),
            address: address.clone(),
            secrets_on_save,
        }
    }

    // Removes the server's item and forgets it in `state`, the custody's lock held, and marks the
    // server signed out.
    async fn forget(
        &self,
        server: &ServerCustody,
        state: &mut HeldState,
    ) -> Result<bool, KeychainRefusal> {
        let was_kept = self.keychain.remove(server.account.as_str()).await?;
        *state = HeldState::Read(None);
        self.mark_signed_out(&server.account);
        Ok(was_kept)
    }

    // The held sign-in, read from the keychain into `state` when this life has not read it.
    async fn read_through(
        &self,
        server: &ServerCustody,
        state: &mut HeldState,
    ) -> Result<Option<Arc<HeldSignIn>>, SignInCustodyError> {
        if let HeldState::Read(held) = state {
            return Ok(held.clone());
        }
        let held = match self.keychain.read(server.account.as_str()).await? {
            None => None,
            Some(item) => Some(Arc::new(read_held_sign_in(&item)?)),
        };
        *state = HeldState::Read(held.clone());
        Ok(held)
    }

    // The custody of the server `digest` names, made at its first use.
    fn server(&self, digest: &ServerAddressDigest) -> Arc<ServerCustody> {
        Arc::clone(
            lock(&self.servers)
                .entry(digest.clone())
                .or_insert_with(|| {
                    Arc::new(ServerCustody {
                        account: digest.clone(),
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
    // The server's address the store was made for, which a refused renewal with no sign-in to
    // begin from keeps.
    address: McpServerAddress,
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

    /// This store, recording beside the sign-in an attempt's save keeps that its client is the
    /// one the server's owner issued, which `binding`'s entry names, where one is given: the
    /// secret is then read again through the binding's provider at each renewal and revocation,
    /// so the attempt's copy of it is not kept. A held sign-in's store is left as it is.
    pub(crate) fn signing_in_as_owner_client(
        mut self,
        binding: Option<&McpServerBindingRef>,
    ) -> Self {
        if let (
            SecretsOnSave::Attempt {
                client_secret,
                owner_client_binding,
                ..
            },
            Some(binding),
        ) = (&mut self.secrets_on_save, binding)
        {
            *client_secret = None;
            *owner_client_binding = Some(binding.clone());
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

    async fn forget(&self, state: &mut HeldState) -> Result<bool, KeychainRefusal> {
        self.custody.forget(&self.server, state).await
    }

    async fn read_through(
        &self,
        state: &mut HeldState,
    ) -> Result<Option<Arc<HeldSignIn>>, SignInCustodyError> {
        self.custody.read_through(&self.server, state).await
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
        let (
            server_address,
            dpop_key,
            client_secret,
            owner_client_binding,
            authorization_server_metadata_url,
        ) = match &self.secrets_on_save {
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
                    let (
                        server_address,
                        dpop_key,
                        client_secret,
                        owner_client_binding,
                        authorization_server_metadata_url,
                    ) = began_from.map_or(
                        (self.address.clone(), None, None, None, None),
                        |began_from| {
                            (
                                began_from.server_address.clone(),
                                began_from.dpop_key.clone(),
                                began_from.client_secret.clone(),
                                began_from.owner_client_binding.clone(),
                                began_from.authorization_server_metadata_url.clone(),
                            )
                        },
                    );
                    *lock(&self.server.refused_renewal) = Some(Arc::new(HeldSignIn {
                        server_address,
                        credentials,
                        dpop_key,
                        client_secret,
                        owner_client_binding,
                        authorization_server_metadata_url,
                    }));
                    return Err(AuthError::CredentialStoreError(
                        RenewedSignInGone.to_string(),
                    ));
                };
                (
                    held.server_address.clone(),
                    held.dpop_key.clone(),
                    held.client_secret.clone(),
                    held.owner_client_binding.clone(),
                    held.authorization_server_metadata_url.clone(),
                )
            }
            SecretsOnSave::Attempt {
                since,
                server_address,
                dpop_key,
                client_secret,
                owner_client_binding,
                authorization_server_metadata_url,
            } => {
                if self.server.sign_outs.load(Ordering::Acquire) != since.0 {
                    return Err(AuthError::CredentialStoreError(SignedOutSince.to_string()));
                }
                (
                    server_address.clone(),
                    dpop_key.clone(),
                    client_secret.clone(),
                    owner_client_binding.clone(),
                    authorization_server_metadata_url.clone(),
                )
            }
        };
        let sign_in = HeldSignIn {
            server_address,
            credentials,
            dpop_key,
            client_secret,
            owner_client_binding,
            authorization_server_metadata_url,
        };
        let item =
            SecretString::from(serde_json::to_string(&sign_in).expect("a sign-in writes as JSON"));
        self.custody
            .keychain
            .write_verified(self.server.account.as_str(), &item)
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

/// The sign-in a keychain item holds. Fails with [`SignInCustodyError::Unreadable`], naming no
/// value it read, when the item is not a sign-in.
pub(crate) fn read_held_sign_in(item: &SecretString) -> Result<HeldSignIn, SignInCustodyError> {
    serde_json::from_str(item.expose_secret()).map_err(|error: serde_json::Error| {
        SignInCustodyError::Unreadable {
            category: error.classify(),
            line: error.line(),
            column: error.column(),
        }
    })
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
