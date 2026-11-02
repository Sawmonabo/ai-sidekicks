//! The sign-out of an MCP server: its held sign-in is read into memory, its keychain item removed,
//! its waiting attempt or provider's flow ended and its address marked signed out; after the
//! reply, its refresh token is revoked where the authorization server publishes a revocation
//! endpoint (RFC 7009).
//!
//! - A removal the keychain refuses refuses the sign-out, and the sign-in stays held and in use:
//!   nothing after the removal runs.
//! - The removal also forgets the sign-in the custody keeps in memory, so the next request to the
//!   server carries no token; an authorizer's manager reads its token from that custody on every
//!   request, and the waiting attempt's manager ends with the attempt.
//! - The revocation runs on a task the service owns, within the OAuth call bound, and ends at the
//!   daemon's stop; a failure is logged with no token and never returned, since the sign-in is
//!   already forgotten.

use std::sync::Arc;

use oauth2::TokenResponse as _;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use rmcp::transport::auth::{AuthError, AuthorizationManager, OAuthHttpClient};
use sidekicks_contracts::mcp::server::config::McpServerAddress;

use crate::errors::McpRefusal;
use crate::sign_in::credential_store::{HeldSignIn, SignInCustodyError};
use crate::sign_in::oauth_http_client::{
    CALL_TIMEOUT, OAuthCall, OAuthCallError, ServerOAuthHttpClient,
};
use crate::sign_in::service::{SignInService, SignInTarget, addressed_server};

/// The metadata field (RFC 8414 §2) naming the authorization server's revocation endpoint.
const REVOCATION_ENDPOINT: &str = "revocation_endpoint";

/// The `token_type_hint` (RFC 7009 §2.1) a revocation of a refresh token names.
const REFRESH_TOKEN_HINT: &str = "refresh_token";

/// Why a refresh token was not revoked at sign-out.
#[derive(Debug, thiserror::Error)]
enum RevocationError {
    /// The server's authorization metadata could not be read.
    #[error("the MCP server's authorization metadata could not be read")]
    Metadata(#[source] AuthError),
    /// The published revocation endpoint is not a web address.
    #[error("the MCP server's revocation endpoint is not a web address")]
    Endpoint(#[source] url::ParseError),
    /// The revocation request got no response.
    #[error(transparent)]
    Call(#[from] OAuthCallError),
    /// The revocation endpoint refused the request.
    #[error("the MCP server's revocation endpoint answered {0}")]
    Refused(StatusCode),
    /// The revocation did not finish within the OAuth call bound.
    #[error("the MCP server's revocation did not finish in time")]
    TimedOut,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the mcp.server.signOut handler calls it")
)]
impl SignInService {
    /// Signs out of `target`'s server: forgets its sign-in, ends its waiting attempt or provider's
    /// flow and marks it signed out, then revokes its refresh token after the reply. A server with
    /// no sign-in held signs out at once. Refuses with `mcp.server.signOutFailed`, carrying the
    /// keychain's cause, when the keychain refuses to read or delete the sign-in, which then stays
    /// held and in use.
    pub(crate) async fn sign_out(&self, target: &SignInTarget) -> Result<(), McpRefusal> {
        let Some(server) = addressed_server(target) else {
            return Ok(());
        };
        let refused = |source| McpRefusal::ServerSignOutFailed {
            binding: Box::new(target.binding.clone()),
            source: Box::new(source),
        };
        let store = self.custody.credential_store(&server.address);
        let held = match store.held().await {
            Ok(held) => held,
            Err(SignInCustodyError::Keychain(refusal)) => return Err(refused(refusal)),
            // An item that is no sign-in holds no token to revoke; it is still removed.
            Err(error @ SignInCustodyError::Unreadable { .. }) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an MCP server's kept sign-in did not read, so it is removed unrevoked"
                );
                None
            }
        };
        store.remove().await.map_err(refused)?;
        if let Some(attempt) = self.take_attempt(&server.canonical_address, None) {
            attempt.end();
        }
        self.end_provider_flow(&server.canonical_address, None);
        self.signed_in_addresses
            .send_if_modified(|addresses| addresses.remove(&server.canonical_address));
        if let Some(held) = held {
            self.revoke_after_reply(server.address.clone(), held);
        }
        Ok(())
    }

    // Revokes `held`'s refresh token at `address`'s authorization server on a task the service
    // ends at its stop, logging a revocation that fails or runs past the OAuth call bound.
    fn revoke_after_reply(&self, address: McpServerAddress, held: Arc<HeldSignIn>) {
        let client = Arc::new(self.pools.server_client(&address));
        let stop = self.revocations.token().clone();
        tokio::spawn(async move {
            tokio::select! {
                () = stop.cancelled() => {}
                revoked = tokio::time::timeout(CALL_TIMEOUT, revoke(client, &address, &held)) => {
                    let failure = match revoked {
                        Ok(Ok(())) => return,
                        Ok(Err(failure)) => failure,
                        Err(_elapsed) => RevocationError::TimedOut,
                    };
                    tracing::warn!(
                        error = &failure as &(dyn std::error::Error + 'static),
                        "an MCP server's refresh token was not revoked at sign-out"
                    );
                }
            }
        });
    }
}

// Posts `held`'s refresh token to the revocation endpoint `address`'s metadata publishes, through
// `client`, signed with the sign-in's proof key when it holds one; no refresh token or no
// published endpoint sends nothing.
async fn revoke(
    client: Arc<ServerOAuthHttpClient>,
    address: &McpServerAddress,
    held: &HeldSignIn,
) -> Result<(), RevocationError> {
    let Some(refresh_token) = held
        .credentials
        .token_response
        .as_ref()
        .and_then(|tokens| tokens.refresh_token())
    else {
        return Ok(());
    };
    let manager = AuthorizationManager::new_with_oauth_http_client(
        address.as_str(),
        Arc::clone(&client) as Arc<dyn OAuthHttpClient>,
    )
    .await
    .map_err(RevocationError::Metadata)?;
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(RevocationError::Metadata)?;
    let Some(endpoint) = resolution
        .metadata
        .additional_fields
        .get(REVOCATION_ENDPOINT)
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    let endpoint = Url::parse(endpoint).map_err(RevocationError::Endpoint)?;
    if let Some(dpop_key) = &held.dpop_key {
        client.set_dpop_key(Arc::clone(dpop_key));
    }
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", refresh_token.secret())
        .append_pair("token_type_hint", REFRESH_TOKEN_HINT)
        .append_pair("client_id", &held.credentials.client_id)
        .finish();
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    // A redirect is not followed: a 307 would carry the refresh token to wherever it points.
    let response = client
        .call(OAuthCall {
            method: Method::POST,
            url: endpoint,
            headers,
            body: body.into_bytes(),
            is_following_redirects: false,
            timeout: CALL_TIMEOUT,
        })
        .await?;
    if response.status.is_success() {
        Ok(())
    } else {
        Err(RevocationError::Refused(response.status))
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use axum::http::StatusCode;
    use reqwest::Method;
    use reqwest::header::AUTHORIZATION;
    use rmcp::transport::auth::{CredentialStore as _, StoredCredentials};
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::credential_store::service::KeychainService;

    use crate::client::http::McpRequestAuthorizer as _;
    use crate::errors::McpRefusal;
    use crate::sign_in::authorizer::SignInAuthorizer;
    use crate::sign_in::canonical_server_address;
    use crate::sign_in::test_service::{
        FakeAuthorizationServer, FakeServerAnswers, Harness, TokenForm, addressed_target, harness,
        serve_authorization_server,
    };

    /// A harness holding a bearer sign-in to a fake server whose revocation endpoint answers
    /// `revocation_status`, `test-access-token-1` with `test-refresh-token-1`, received now so no
    /// request renews it, with the authorizer a connection to the server presents its token
    /// through; every token is made up.
    async fn signed_in(
        revocation_status: StatusCode,
    ) -> (FakeAuthorizationServer, Harness, SignInAuthorizer) {
        let server = serve_authorization_server(FakeServerAnswers {
            revocation_status,
            ..FakeServerAnswers::default()
        })
        .await;
        let harness = harness().await;
        let token_response = serde_json::from_value(json!({
            "access_token": "test-access-token-1",
            "token_type": "Bearer",
            "refresh_token": "test-refresh-token-1",
            "expires_in": 3600,
        }))
        .expect("a token response reads");
        let received_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is past the epoch")
            .as_secs();
        harness
            .service
            .custody
            .credential_store(&address(&server))
            .save(StoredCredentials::new(
                "test-client".to_owned(),
                Some(token_response),
                vec![],
                Some(received_at),
            ))
            .await
            .expect("the sign-in is kept");
        let authorizer = harness.authorizer(&server.base).await;
        (server, harness, authorizer)
    }

    fn address(server: &FakeAuthorizationServer) -> McpServerAddress {
        McpServerAddress::new(&server.base).expect("a server address")
    }

    // Whether the authorizer sets an `Authorization` on a request to `base`'s server, and which.
    async fn presented_authorization(authorizer: &SignInAuthorizer, base: &str) -> Option<String> {
        let headers = authorizer.authorize(&Method::POST, base, None).await.ok()?;
        headers
            .into_iter()
            .find(|(name, _)| *name == AUTHORIZATION)
            .map(|(_, value)| value.to_str().expect("a text header").to_owned())
    }

    // The forms the revocation endpoint received, once one has arrived or five seconds pass.
    async fn received_revocations(server: &FakeAuthorizationServer) -> Vec<TokenForm> {
        for _ in 0..200 {
            if !lock(&server.revocation_forms).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        lock(&server.revocation_forms).clone()
    }

    // Mutations: remove the item before reading it (nothing is left to revoke); keep the item, so
    // the proof key it holds stays; return the revocation's failure from `sign_out`.
    #[rstest]
    #[case::revoked(StatusCode::OK)]
    #[case::revocation_refused(StatusCode::INTERNAL_SERVER_ERROR)]
    #[tokio::test]
    async fn a_sign_out_forgets_the_sign_in_and_revokes_the_refresh_token_it_held(
        #[case] revocation_status: StatusCode,
    ) {
        let (server, harness, authorizer) = signed_in(revocation_status).await;
        assert_eq!(
            presented_authorization(&authorizer, &server.base)
                .await
                .as_deref(),
            Some("Bearer test-access-token-1")
        );

        let signed_out = harness
            .service
            .sign_out(&addressed_target(&server.base))
            .await;

        assert!(signed_out.is_ok(), "the sign-out completes");
        assert!(
            harness
                .keychain
                .read(&canonical_server_address(&address(&server)))
                .await
                .expect("the keychain answers")
                .is_none(),
            "the item, credentials and key alike, is gone"
        );
        assert_eq!(
            presented_authorization(&authorizer, &server.base).await,
            None
        );
        let form = |pairs: &[(&str, &str)]| -> TokenForm {
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect()
        };
        assert_eq!(
            received_revocations(&server).await,
            [form(&[
                ("token", "test-refresh-token-1"),
                ("token_type_hint", "refresh_token"),
                ("client_id", "test-client"),
            ])]
        );
    }

    // Mutation: report a sign-out the keychain refused, or forget the sign-in in memory first.
    #[tokio::test]
    async fn a_sign_out_the_keychain_refuses_keeps_the_sign_in_in_use() {
        let (server, harness, authorizer) = signed_in(StatusCode::OK).await;
        harness.platform_store.refuse_next_call(
            KeychainService::McpSignIns.as_str(),
            &canonical_server_address(&address(&server)),
        );

        let signed_out = harness
            .service
            .sign_out(&addressed_target(&server.base))
            .await;

        let Err(McpRefusal::ServerSignOutFailed { source, .. }) = signed_out else {
            unreachable!("the refused removal refuses the sign-out");
        };
        assert_eq!(source.cause(), KeychainRefusalCause::Unavailable);
        assert_eq!(
            presented_authorization(&authorizer, &server.base)
                .await
                .as_deref(),
            Some("Bearer test-access-token-1")
        );
        assert!(
            harness
                .keychain
                .read(&canonical_server_address(&address(&server)))
                .await
                .expect("the keychain answers")
                .is_some(),
            "the item is still kept"
        );
        assert!(lock(&server.revocation_forms).is_empty());
    }
}
