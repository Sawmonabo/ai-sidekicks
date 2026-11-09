//! The authorizer of each request to an MCP server the daemon is signed in to: it presents the
//! held access token as `Bearer`, or as `DPoP` with a fresh proof bound to the request and to the
//! server's last nonce, by the token type the sign-in holds, and renews the token when it runs out
//! or the server refuses it.
//!
//! - One renewal per server at a time: every authorizer of a server reads its token under the
//!   server's renewal hold, which the custody keeps, so a caller that waited reads the token the
//!   first one renewed and renews nothing. A sign-out takes no hold: a renewal it overtakes has
//!   its save refused, and the authorizer revokes the refresh token that renewal received, on a
//!   task the daemon's stop ends, where the authorization server publishes a revocation endpoint.
//! - A 401 `invalid_token` renews only while the held token is still the refused one; when another
//!   request has replaced it, the request is sent again with the held token.
//! - Before a read or renewal of a sign-in it has not renewed as yet, the authorizer sets its
//!   manager to renew as the client that sign-in names, its secret included, and to sign with the
//!   sign-in's proof key for a `DPoP` sign-in, since a sign-in kept since the authorizer was made
//!   may hold another client or key; a request that finds the server needs a sign-in while another
//!   sign-in was kept since its read is tried once more as that sign-in. It renews against the
//!   server's metadata, through the server's filtered OAuth client. A
//!   sign-in another authorization server issued is forgotten when the authorizer is made, its
//!   issuer compared equal but for a slash ending either, so a slash alone never forgets a sign-in.
//! - A request that finds the server needs a sign-in marks it signed out, under the server's
//!   custody, unless another sign-in was kept since, so the signed-in set never lists a server
//!   whose every call needs a new sign-in and never drops one a new sign-in just kept.
//! - A renewal refused with `invalid_grant` forgets the sign-in, through the credential store's
//!   rejection hook, and the server needs a sign-in. One refused with `invalid_dpop_proof` is
//!   tried once more with a fresh proof, then fails the request with the sign-in kept, as a
//!   network failure or a 5xx does.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the fronted route builds an authorizer for each signed-in server's connection"
    )
)]

use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use oauth2::TokenResponse as _;
use reqwest::header::{AUTHORIZATION, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadata, OAuthClientConfig, OAuthHttpClient,
};
use secrecy::ExposeSecret as _;
use sidekicks_contracts::dpop::{DPOP_AUTHORIZATION_SCHEME, DPOP_PROOF_HEADER_NAME};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::mutex_lock::lock;
use subtle::ConstantTimeEq as _;
use tokio::sync::{MappedMutexGuard, MutexGuard};
use tokio_util::sync::CancellationToken;

use crate::client::http::{
    AuthorizationResult, BEARER_AUTHORIZATION_SCHEME, McpRequestAuthorizer, RefusalAnswer,
};
use crate::oauth::dpop_proof::{DpopKey, DpopKeyError, DpopProofError, make_proof};
use crate::sign_in::address_digest::ServerAddressDigest;
use crate::sign_in::credential_store::{
    DpopKeyScalar, HeldSignIn, McpCredentialStore, SignInCustody, SignInCustodyError,
};
use crate::sign_in::oauth_http_client::{OAuthHttpPools, ServerOAuthHttpClient};
use crate::sign_in::sign_out::revocation::revoke_on_task;

/// The `error` a server's challenge names for a token it no longer takes (RFC 6750 §3.1).
const INVALID_TOKEN: &str = "invalid_token";

/// The `error` an authorization server answers a proof it refuses with (RFC 9449 §5).
const INVALID_DPOP_PROOF: &str = "invalid_dpop_proof";

/// How the OAuth library under rmcp writes an authorization server's error answer, before its
/// `error` code; rmcp hands a failed renewal on only as this text.
const SERVER_ERROR_ANSWER_PREFIX: &str = "Server returned error response: ";

/// Why a request to a signed-in MCP server could not be authorized. The route reads
/// [`SignInAuthorizationError::SignInRequired`] from a failed call's source chain.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SignInAuthorizationError {
    /// No sign-in is held for the server, or its renewal was refused for good.
    #[error("the MCP server needs a sign-in")]
    SignInRequired,
    /// The token could not be renewed: the network, the authorization server's answer or a proof
    /// it refused twice. The sign-in is kept.
    #[error("the MCP server's sign-in could not be renewed")]
    Renewal(#[source] AuthError),
    /// The kept sign-in could not be read.
    #[error("the MCP server's kept sign-in could not be read")]
    Custody(#[from] SignInCustodyError),
    /// The sign-in's token type is neither `Bearer` nor `DPoP`.
    #[error("the MCP server's sign-in holds a token type the daemon cannot present")]
    TokenType,
    /// A `DPoP` sign-in holds no proof key.
    #[error("the MCP server's DPoP sign-in holds no proof key")]
    DpopKeyMissing,
    /// The held proof key is not a P-256 key.
    #[error(transparent)]
    DpopKey(#[from] DpopKeyError),
    /// The request's proof could not be made.
    #[error(transparent)]
    Proof(#[from] DpopProofError),
    /// The request's address is not a web address a proof can be bound to.
    #[error("the MCP request's address is not a web address")]
    Address(#[from] url::ParseError),
    /// The access token holds bytes a header cannot carry.
    #[error("the MCP server's access token cannot be sent in a header")]
    HeaderValue(#[source] reqwest::header::InvalidHeaderValue),
    /// The server's metadata names an authorization or token endpoint that is not a web address.
    #[error("the MCP server's authorization metadata names an endpoint that is not a web address")]
    Metadata(#[source] AuthError),
}

/// The authorizer of one server's requests under the sign-in the daemon holds for it.
pub(crate) struct SignInAuthorizer {
    /// rmcp's manager of the server's sign-in, which reads and renews its token, set to the held
    /// sign-in's client under the server's renewal hold.
    manager: tokio::sync::Mutex<RenewingManager>,
    /// The manager's filtered OAuth client, whose key slot signs a `DPoP` sign-in's renewal.
    http_client: Arc<ServerOAuthHttpClient>,
    /// The filtered pools a refused renewal's revocation takes its own client from.
    pools: OAuthHttpPools,
    /// Ends a refused renewal's revocation at the daemon's stop.
    stop: CancellationToken,
    /// Every server's custody, which keeps each server's renewal hold.
    custody: Arc<SignInCustody>,
    /// The server's custody, for the held token type and proof key.
    store: McpCredentialStore,
    /// The server's address, which stands in for the redirect address of the renewal's client.
    address: McpServerAddress,
    /// The digest the server's sign-in is kept under.
    digest: ServerAddressDigest,
    /// The proof key last read from the held scalar, made again only when the scalar changes.
    dpop_key: Mutex<Option<(Arc<DpopKeyScalar>, Arc<DpopKey>)>>,
    /// The server's metadata the authorizer was made with, which a refused renewal's revocation
    /// reads its endpoint from.
    metadata: AuthorizationMetadata,
}

/// rmcp's manager and the sign-in it was last set to renew as, held weakly so a sign-in forgotten
/// since leaves no token in memory, and compared by identity.
struct RenewingManager {
    /// The manager.
    manager: AuthorizationManager,
    /// The sign-in the manager's client and the OAuth client's key slot were last set from.
    configured_for: Weak<HeldSignIn>,
}

impl SignInAuthorizer {
    /// The authorizer of the server at `address` under the sign-in `custody` holds for it,
    /// renewing against the server's `metadata` as the client the held sign-in names, its secret
    /// included, through a client of `pools` that signs with the held proof key, under the
    /// server's renewal hold `custody` keeps; `stop` ends the revocation of a refused renewal's
    /// refresh token. Fails with
    /// [`SignInAuthorizationError::SignInRequired`], the server marked signed out, when no
    /// sign-in is held, or the held one was issued by another authorization server than
    /// `metadata` names and is forgotten.
    pub(crate) async fn new(
        custody: &Arc<SignInCustody>,
        pools: &OAuthHttpPools,
        address: &McpServerAddress,
        metadata: AuthorizationMetadata,
        stop: CancellationToken,
    ) -> Result<Self, SignInAuthorizationError> {
        let digest = custody
            .digest(address)
            .await
            .map_err(SignInCustodyError::from)?;
        let store = custody.credential_store(&digest, address);
        {
            let _hold = custody.renewals.acquire(digest.clone()).await;
            let Some(held) = store.held().await? else {
                store.mark_needs_sign_in(None).await?;
                return Err(SignInAuthorizationError::SignInRequired);
            };
            if let (Some(held_issuer), Some(issuer)) = (
                held.credentials.issuer.as_deref(),
                metadata.issuer.as_deref(),
            ) && !is_same_issuer(held_issuer, issuer)
            {
                tracing::warn!(
                    "an MCP server's authorization server changed, so its sign-in is forgotten"
                );
                store.remove().await.map_err(SignInCustodyError::from)?;
                return Err(SignInAuthorizationError::SignInRequired);
            }
        }
        let http_client = Arc::new(pools.server_client(address));
        let mut manager = AuthorizationManager::new_with_oauth_http_client(
            address.as_str(),
            Arc::clone(&http_client) as Arc<dyn OAuthHttpClient>,
        )
        .await
        .expect("a server address is a web address");
        manager.set_metadata(metadata.clone());
        manager.set_credential_store(custody.credential_store(&digest, address));
        Ok(Self {
            manager: tokio::sync::Mutex::new(RenewingManager {
                manager,
                configured_for: Weak::new(),
            }),
            http_client,
            pools: pools.clone(),
            stop,
            custody: Arc::clone(custody),
            store,
            address: address.clone(),
            digest,
            dpop_key: Mutex::new(None),
            metadata,
        })
    }
}

impl SignInAuthorizer {
    // The held access token, renewed first when it runs out, and the sign-in it was read with,
    // both read under the server's renewal hold. rmcp reads the sign-in held when it renews, so a
    // sign-in kept since the first read, which found the server needs a sign-in, is tried once
    // more; a server still found to need one is marked so.
    async fn current_token(&self) -> Result<(String, Arc<HeldSignIn>), SignInAuthorizationError> {
        let _hold = self.custody.renewals.acquire(self.digest.clone()).await;
        let mut found = self.store.held().await?;
        let mut token = self.token_of(found.as_ref()).await;
        if matches!(token, Err(SignInAuthorizationError::SignInRequired))
            && let Some(kept_since) = self
                .store
                .held()
                .await?
                .filter(|held| found.as_ref().is_none_or(|found| !Arc::ptr_eq(found, held)))
        {
            token = self.token_of(Some(&kept_since)).await;
            found = Some(kept_since);
        }
        if matches!(token, Err(SignInAuthorizationError::SignInRequired)) {
            self.store.mark_needs_sign_in(found.as_ref()).await?;
        }
        token
    }

    // The access token of `found`, the sign-in held, renewed first when it runs out as the client
    // `found` names, and the sign-in held after.
    async fn token_of(
        &self,
        found: Option<&Arc<HeldSignIn>>,
    ) -> Result<(String, Arc<HeldSignIn>), SignInAuthorizationError> {
        let found = found.ok_or(SignInAuthorizationError::SignInRequired)?;
        let manager = self.renewing_as(found).await?;
        let access_token = retry_refused_proof(|| manager.get_access_token()).await;
        drop(manager);
        self.revoke_refused_renewal();
        let access_token = access_token?;
        let held = self
            .store
            .held()
            .await?
            .ok_or(SignInAuthorizationError::SignInRequired)?;
        Ok((access_token, held))
    }

    // The headers presenting the held token on a request of `method` to `uri`.
    async fn authorization(
        &self,
        method: &Method,
        uri: &str,
        dpop_nonce: Option<&str>,
    ) -> Result<Vec<(HeaderName, HeaderValue)>, SignInAuthorizationError> {
        let (access_token, held) = self.current_token().await?;
        let token_type = held
            .credentials
            .token_response
            .as_ref()
            .ok_or(SignInAuthorizationError::SignInRequired)?
            .token_type()
            .as_ref()
            .to_owned();
        if token_type.eq_ignore_ascii_case(BEARER_AUTHORIZATION_SCHEME) {
            return Ok(vec![(
                AUTHORIZATION,
                authorization_value(BEARER_AUTHORIZATION_SCHEME, &access_token)?,
            )]);
        }
        if !token_type.eq_ignore_ascii_case(DPOP_AUTHORIZATION_SCHEME) {
            return Err(SignInAuthorizationError::TokenType);
        }
        let key = self.dpop_key(&held)?;
        let proof = make_proof(
            &key,
            method,
            &Url::parse(uri)?,
            Some(&access_token),
            dpop_nonce,
        )?;
        Ok(vec![
            (
                AUTHORIZATION,
                authorization_value(DPOP_AUTHORIZATION_SCHEME, &access_token)?,
            ),
            (
                HeaderName::from_static(DPOP_PROOF_HEADER_NAME),
                HeaderValue::from_str(&proof).map_err(SignInAuthorizationError::HeaderValue)?,
            ),
        ])
    }

    // The manager, set under the server's renewal hold to renew as the client `held` names, its
    // secret included, and to sign its renewals with the proof key `held` keeps, or none for a
    // bearer sign-in, unless it was last set from `held` itself: a sign-in kept since the
    // authorizer was made may hold another client or key.
    async fn renewing_as(
        &self,
        held: &Arc<HeldSignIn>,
    ) -> Result<MappedMutexGuard<'_, AuthorizationManager>, SignInAuthorizationError> {
        let mut renewing = self.manager.lock().await;
        if !std::ptr::eq(renewing.configured_for.as_ptr(), Arc::as_ptr(held)) {
            // rmcp configures a client only with a redirect address, and a renewal sends none, so
            // the server's address stands in, as rmcp's own `configure_client_id` does.
            let mut client =
                OAuthClientConfig::new(held.credentials.client_id.clone(), self.address.as_str());
            if let Some(client_secret) = &held.client_secret {
                client = client.with_client_secret(client_secret.expose_secret());
            }
            renewing
                .manager
                .configure_client(client)
                .map_err(SignInAuthorizationError::Metadata)?;
            self.http_client.set_dpop_key(held.dpop_key.clone());
            renewing.configured_for = Arc::downgrade(held);
        }
        Ok(MutexGuard::map(renewing, |renewing| &mut renewing.manager))
    }

    // Revokes the refresh token a renewal whose save was refused received, a sign-out or a new
    // sign-in having replaced the sign-in it renewed, on a task `stop` ends, through a client of
    // its own so the manager's key slot is left alone.
    fn revoke_refused_renewal(&self) {
        if let Some(refused) = self.store.take_refused_renewal() {
            revoke_on_task(
                Arc::new(self.pools.server_client(&self.address)),
                self.address.clone(),
                refused,
                Some(self.metadata.clone()),
                self.stop.clone(),
            );
        }
    }

    // The proof key `held` keeps, made from its scalar only when it differs from the last one.
    fn dpop_key(&self, held: &HeldSignIn) -> Result<Arc<DpopKey>, SignInAuthorizationError> {
        let scalar = held
            .dpop_key
            .as_ref()
            .ok_or(SignInAuthorizationError::DpopKeyMissing)?;
        let mut cached = lock(&self.dpop_key);
        if let Some((cached_scalar, key)) = cached.as_ref()
            && Arc::ptr_eq(cached_scalar, scalar)
        {
            return Ok(Arc::clone(key));
        }
        let key = Arc::new(DpopKey::from_scalar(scalar.expose_secret())?);
        *cached = Some((Arc::clone(scalar), Arc::clone(&key)));
        Ok(key)
    }

    // Whether a request refused with `challenge_error` while carrying `sent_authorization` is
    // sent again: only for `invalid_token`, renewing under the server's hold when the held token
    // is still the refused one. A sign-in that is gone, or whose renewal was refused for good,
    // answers no, so the refusal reaches the route as the sign-in it asks for.
    async fn renew_refused(
        &self,
        sent_authorization: Option<&HeaderValue>,
        challenge_error: Option<&str>,
    ) -> Result<bool, SignInAuthorizationError> {
        if challenge_error != Some(INVALID_TOKEN) {
            return Ok(false);
        }
        let _hold = self.custody.renewals.acquire(self.digest.clone()).await;
        let Some(held) = self.store.held().await? else {
            self.store.mark_needs_sign_in(None).await?;
            return Ok(false);
        };
        let Some(token_response) = held.credentials.token_response.as_ref() else {
            self.store.mark_needs_sign_in(Some(&held)).await?;
            return Ok(false);
        };
        let held_token = token_response.access_token().secret();
        let refused_token = sent_authorization
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split_once(' '))
            .map(|(_, token)| token.trim());
        let is_held_token_refused = refused_token
            .is_some_and(|refused| bool::from(refused.as_bytes().ct_eq(held_token.as_bytes())));
        if !is_held_token_refused {
            return Ok(true);
        }
        let manager = self.renewing_as(&held).await?;
        let renewed = retry_refused_proof(|| manager.refresh_token()).await;
        drop(manager);
        self.revoke_refused_renewal();
        match renewed {
            Ok(_) => Ok(true),
            Err(SignInAuthorizationError::SignInRequired) => {
                self.store.mark_needs_sign_in(Some(&held)).await?;
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
}

impl McpRequestAuthorizer for SignInAuthorizer {
    fn authorize(
        &self,
        method: &Method,
        uri: &str,
        dpop_nonce: Option<&str>,
    ) -> BoxFuture<'_, AuthorizationResult> {
        let method = method.clone();
        let uri = uri.to_owned();
        let dpop_nonce = dpop_nonce.map(str::to_owned);
        Box::pin(async move {
            Ok(self
                .authorization(&method, &uri, dpop_nonce.as_deref())
                .await?)
        })
    }

    fn answer_refusal<'call>(
        &'call self,
        sent_authorization: Option<&'call HeaderValue>,
        challenge_error: Option<&'call str>,
    ) -> BoxFuture<'call, RefusalAnswer> {
        Box::pin(async move {
            Ok(self
                .renew_refused(sent_authorization, challenge_error)
                .await?)
        })
    }
}

// Runs `attempt`, a read or renewal of the token, once more when the authorization server
// refused its proof, since a fresh proof may pass where a stale clock or nonce failed; a sign-in
// that is gone or whose renewal was refused for good needs a sign-in.
async fn retry_refused_proof<Answer, Attempt>(
    attempt: impl Fn() -> Attempt,
) -> Result<Answer, SignInAuthorizationError>
where
    Attempt: Future<Output = Result<Answer, AuthError>>,
{
    let mut answer = attempt().await;
    if answer.as_ref().is_err_and(is_refused_proof) {
        answer = attempt().await;
    }
    answer.map_err(|error| {
        if matches!(
            error,
            AuthError::AuthorizationRequired | AuthError::TokenRefreshRejected(_)
        ) {
            SignInAuthorizationError::SignInRequired
        } else {
            SignInAuthorizationError::Renewal(error)
        }
    })
}

// Whether a failed renewal is the authorization server's `invalid_dpop_proof`, read from the
// text rmcp keeps of its answer: the error code follows the prefix and ends at a `:` before a
// description, a space before a link, or the text's end.
fn is_refused_proof(error: &AuthError) -> bool {
    let AuthError::TokenRefreshFailed(text) = error else {
        return false;
    };
    text.strip_prefix(SERVER_ERROR_ANSWER_PREFIX)
        .and_then(|answer| answer.split([':', ' ']).next())
        == Some(INVALID_DPOP_PROOF)
}

// Whether `left` and `right` name one authorization server: equal once a slash ending either is
// dropped, whatever its path, since a provider may keep an issuer with or without one.
fn is_same_issuer(left: &str, right: &str) -> bool {
    left.strip_suffix('/').unwrap_or(left) == right.strip_suffix('/').unwrap_or(right)
}

// The `Authorization` value presenting `access_token` under `scheme`, kept out of any print.
fn authorization_value(
    scheme: &str,
    access_token: &str,
) -> Result<HeaderValue, SignInAuthorizationError> {
    let mut value = HeaderValue::from_str(&format!("{scheme} {access_token}"))
        .map_err(SignInAuthorizationError::HeaderValue)?;
    value.set_sensitive(true);
    Ok(value)
}

#[cfg(test)]
mod tests;
