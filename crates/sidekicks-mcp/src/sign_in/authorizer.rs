//! The authorizer of each request to an MCP server the daemon is signed in to: it presents the
//! held access token as `Bearer`, or as `DPoP` with a fresh proof bound to the request and to the
//! server's last nonce, by the token type the sign-in holds, and renews the token when it runs out
//! or the server refuses it.
//!
//! - One renewal per server at a time: every authorizer of a server reads its token under the
//!   server's hold in one lock the daemon shares, so a caller that waited reads the token the
//!   first one renewed and renews nothing.
//! - A 401 `invalid_token` renews only while the held token is still the refused one; when another
//!   request has replaced it, the request is sent again with the held token.
//! - A renewal refused with `invalid_grant` forgets the sign-in, through the credential store's
//!   rejection hook, and the server needs a sign-in. One refused with `invalid_dpop_proof` is
//!   tried once more with a fresh proof, then fails the request with the sign-in kept, as a
//!   network failure or a 5xx does.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the sign-in's composition builds an authorizer for each signed-in server's \
                  connection"
    )
)]

use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use oauth2::TokenResponse as _;
use reqwest::header::{AUTHORIZATION, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use rmcp::transport::auth::{AuthError, AuthorizationManager};
use secrecy::ExposeSecret as _;
use sidekicks_contracts::dpop::{DPOP_AUTHORIZATION_SCHEME, DPOP_PROOF_HEADER_NAME};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use subtle::ConstantTimeEq as _;

use crate::client::http::{
    AuthorizationResult, BEARER_AUTHORIZATION_SCHEME, McpRequestAuthorizer, RefusalAnswer,
};
use crate::oauth::dpop_proof::{DpopKey, DpopKeyError, DpopProofError, make_proof};
use crate::sign_in::canonical_server_address;
use crate::sign_in::credential_store::{
    DpopKeyScalar, HeldSignIn, McpCredentialStore, SignInCustody, SignInCustodyError,
};

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
    HeaderValue,
}

/// The authorizer of one server's requests under the sign-in the daemon holds for it.
pub(crate) struct SignInAuthorizer {
    /// rmcp's manager of the server's sign-in, which reads and renews its token.
    manager: AuthorizationManager,
    /// The server's custody, for the held token type and proof key.
    store: McpCredentialStore,
    /// The daemon's one renewal lock, keyed by each server's canonical address.
    renewals: Arc<KeyedLock<String>>,
    /// The server's canonical address.
    account: String,
    /// The proof key last read from the held scalar, made again only when the scalar changes.
    dpop_key: Mutex<Option<(Arc<DpopKeyScalar>, Arc<DpopKey>)>>,
}

impl SignInAuthorizer {
    /// The authorizer of the server at `address` through `manager`, which holds the server's
    /// metadata and client and is given the server's store in `custody` here; `renewals` is the
    /// daemon's one renewal lock, shared by every authorizer.
    pub(crate) fn new(
        custody: &SignInCustody,
        address: &McpServerAddress,
        mut manager: AuthorizationManager,
        renewals: Arc<KeyedLock<String>>,
    ) -> Self {
        manager.set_credential_store(custody.credential_store(address));
        Self {
            manager,
            store: custody.credential_store(address),
            renewals,
            account: canonical_server_address(address),
            dpop_key: Mutex::new(None),
        }
    }
}

impl SignInAuthorizer {
    // The held access token, renewed first when it runs out, and the sign-in it was read with,
    // both read under the server's hold.
    async fn current_token(&self) -> Result<(String, Arc<HeldSignIn>), SignInAuthorizationError> {
        let _hold = self.renewals.acquire(self.account.clone()).await;
        let access_token = retry_refused_proof(|| self.manager.get_access_token()).await?;
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
                HeaderValue::from_str(&proof).map_err(|_| SignInAuthorizationError::HeaderValue)?,
            ),
        ])
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
        let _hold = self.renewals.acquire(self.account.clone()).await;
        let Some(held) = self.store.held().await? else {
            return Ok(false);
        };
        let Some(token_response) = held.credentials.token_response.as_ref() else {
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
        match retry_refused_proof(|| self.manager.refresh_token()).await {
            Ok(_) => Ok(true),
            Err(error) if matches!(error, SignInAuthorizationError::SignInRequired) => Ok(false),
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

// The `Authorization` value presenting `access_token` under `scheme`, kept out of any print.
fn authorization_value(
    scheme: &str,
    access_token: &str,
) -> Result<HeaderValue, SignInAuthorizationError> {
    let mut value = HeaderValue::from_str(&format!("{scheme} {access_token}"))
        .map_err(|_| SignInAuthorizationError::HeaderValue)?;
    value.set_sensitive(true);
    Ok(value)
}

#[cfg(test)]
mod tests;
