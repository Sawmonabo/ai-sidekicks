//! The keychain custody of each MCP server's sign-in: one item per server, under its canonical
//! address, holding rmcp's stored credentials, access token included, and for a DPoP sign-in the
//! proof key's scalar, written whole by one verified write, so a token is never kept beside
//! another sign-in's key.
//!
//! A server's item is read from the keychain at most once per daemon life: every later read, from
//! any store over the same custody, is served from memory, so a request to the server costs no
//! keychain call. A save writes the keychain first and memory after, so a refused write leaves the
//! sign-in held as it was. A keychain refusal is never remembered, so the next read asks again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rmcp::transport::auth::{AuthError, CredentialStore, StoredCredentials};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret as _, SecretBox, SecretString};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use subtle::ConstantTimeEq as _;

use crate::sign_in::canonical_server_address;

/// A DPoP proof key's 32-byte P-256 scalar, wiped when it drops.
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
}

// One server's custody: its keychain account and what was last read or kept there. The state's
// lock is held across the keychain call, so a read and a write on one server never cross.
struct ServerCustody {
    account: String,
    held: tokio::sync::Mutex<HeldState>,
}

// What this daemon life knows of a server's item.
enum HeldState {
    Unread,
    Read(Option<Arc<HeldSignIn>>),
}

// The proof key a store's save keeps beside the credentials it is given.
enum KeyOnSave {
    // The key the held sign-in has, which a renewal keeps.
    Held,
    // A sign-in attempt's own key, or none for a bearer sign-in, which replaces the held one.
    #[expect(
        dead_code,
        reason = "the sign-in's launch builds each attempt's store with it"
    )]
    Attempt(Option<Arc<DpopKeyScalar>>),
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
        })
    }

    /// The credential store of the server at `address` for its held sign-in: a save keeps the
    /// held proof key, as a renewal must.
    pub(crate) fn credential_store(&self, address: &McpServerAddress) -> McpCredentialStore {
        self.store(address, KeyOnSave::Held)
    }

    /// The credential store of one sign-in attempt at `address`: its save replaces the held
    /// sign-in whole, keeping `dpop_key`, the attempt's own key, or none for a bearer sign-in.
    #[expect(
        dead_code,
        reason = "the sign-in's launch builds each attempt's store with it"
    )]
    pub(crate) fn attempt_credential_store(
        &self,
        address: &McpServerAddress,
        dpop_key: Option<DpopKeyScalar>,
    ) -> McpCredentialStore {
        self.store(address, KeyOnSave::Attempt(dpop_key.map(Arc::new)))
    }

    fn store(&self, address: &McpServerAddress, key_on_save: KeyOnSave) -> McpCredentialStore {
        let account = canonical_server_address(address);
        let server = Arc::clone(
            lock(&self.servers)
                .entry(account.clone())
                .or_insert_with(|| {
                    Arc::new(ServerCustody {
                        account,
                        held: tokio::sync::Mutex::new(HeldState::Unread),
                    })
                }),
        );
        McpCredentialStore {
            keychain: Arc::clone(&self.keychain),
            server,
            key_on_save,
        }
    }
}

/// One server's sign-in as rmcp's credential store, over the custody it came from.
pub(crate) struct McpCredentialStore {
    keychain: Arc<dyn SecretKeychain>,
    server: Arc<ServerCustody>,
    key_on_save: KeyOnSave,
}

impl McpCredentialStore {
    /// The server's held sign-in, or `None` when none is kept; the keychain is asked only the
    /// first time in this daemon life. Fails with [`SignInCustodyError`] when the keychain refuses
    /// or its item does not read as a sign-in.
    pub(crate) async fn held(&self) -> Result<Option<Arc<HeldSignIn>>, SignInCustodyError> {
        let mut state = self.server.held.lock().await;
        self.read_through(&mut state).await
    }

    /// Forgets the server's sign-in, from the keychain and then from memory; `false` when none was
    /// kept. Fails with the [`KeychainRefusal`], the sign-in still held, when the keychain refuses.
    pub(crate) async fn remove(&self) -> Result<bool, KeychainRefusal> {
        let mut state = self.server.held.lock().await;
        let was_kept = self.keychain.remove(&self.server.account).await?;
        *state = HeldState::Read(None);
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
        let held = match self.keychain.read(&self.server.account).await? {
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
        let held = self.held().await.map_err(store_error)?;
        Ok(held.map(|held| held.credentials.clone()))
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let mut state = self.server.held.lock().await;
        let dpop_key = match &self.key_on_save {
            KeyOnSave::Held => self
                .read_through(&mut state)
                .await
                .map_err(store_error)?
                .and_then(|held| held.dpop_key.clone()),
            KeyOnSave::Attempt(dpop_key) => dpop_key.clone(),
        };
        let sign_in = HeldSignIn {
            credentials,
            dpop_key,
        };
        let item =
            SecretString::from(serde_json::to_string(&sign_in).expect("a sign-in writes as JSON"));
        self.keychain
            .write_verified(&self.server.account, &item)
            .await
            .map_err(|refusal| store_error(refusal.into()))?;
        *state = HeldState::Read(Some(Arc::new(sign_in)));
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.remove()
            .await
            .map_err(|refusal| store_error(refusal.into()))?;
        Ok(())
    }

    // Only the credentials the authorization server refused are forgotten: a sign-in kept since,
    // by another renewal or a new sign-in, stays.
    async fn on_refresh_token_rejected(
        &self,
        credentials: &StoredCredentials,
    ) -> Result<(), AuthError> {
        let mut state = self.server.held.lock().await;
        let Some(held) = self.read_through(&mut state).await.map_err(store_error)? else {
            return Ok(());
        };
        if !is_same_credentials(&held.credentials, credentials) {
            return Ok(());
        }
        self.keychain
            .remove(&self.server.account)
            .await
            .map_err(|refusal| store_error(refusal.into()))?;
        *state = HeldState::Read(None);
        Ok(())
    }
}

// rmcp's store error, which carries text alone: the refusal's words, which name no value.
fn store_error(error: SignInCustodyError) -> AuthError {
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::future::BoxFuture;
    use rmcp::transport::auth::{AuthError, CredentialStore as _, StoredCredentials};
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
        SignInCustody::new(Arc::clone(&keychain))
            .credential_store(&server_address())
            .save(credentials("test-access-token"))
            .await
            .expect("the earlier life keeps the sign-in");
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
        let store = SignInCustody::new(keychain).credential_store(&server_address());
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
}
