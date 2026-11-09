//! The sign-out of an MCP server, at once, a renewal under way or not: under one hold of the
//! server's custody its held sign-in is read, its keychain item removed, the sign-out counted and
//! the server marked signed out; then its waiting attempt or provider's flow is ended, and after
//! the reply its refresh token is revoked where the authorization server publishes a revocation
//! endpoint (RFC 7009), a confidential client authenticating by the method the revocation
//! endpoint's metadata names.
//!
//! - A removal the keychain refuses refuses the sign-out, and the sign-in stays held and in use:
//!   nothing after the removal runs.
//! - The removal also forgets the sign-in the custody keeps in memory, so the next request to the
//!   server carries no token; an authorizer's manager reads its token from that custody on every
//!   request, and the waiting attempt's manager ends with the attempt.
//! - A renewal the sign-out overtook has its save refused, and the authorizer revokes the refresh
//!   token that renewal received the same way, so the newest token is revoked with no wait.
//! - A revocation runs on a task the daemon's stop ends, within the OAuth call bound; a failure is
//!   logged with no token and never returned, since the sign-in is already forgotten.
//! - The revocation endpoint is read from the metadata at the address the sign-in recorded, with
//!   no protected-resource request and no entry read, so a sign-out after the entry's removal
//!   still revokes; a sign-in that recorded none discovers it, and a recorded address that does
//!   not read revokes nothing, since the sign-in is already forgotten and no other address is
//!   known to name its authorization server.

use std::sync::Arc;

use oauth2::TokenResponse as _;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadata, OAuthHttpClient,
};
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_store::credential_store::KeychainRefusal;
use tokio_util::sync::CancellationToken;

use crate::errors::McpRefusal;
use crate::oauth::client_authentication::{
    ClientSecretAuthentication, ClientSecretMethod, REVOCATION_ENDPOINT_AUTH_METHODS,
};
use crate::sign_in::address_digest::ServerAddressDigest;
use crate::sign_in::credential_store::HeldSignIn;
use crate::sign_in::oauth_http_client::{
    CALL_TIMEOUT, OAuthCall, OAuthCallError, ServerOAuthHttpClient,
};
use crate::sign_in::service::{NamedMetadataError, SignInService, read_named_metadata};

/// The metadata field (RFC 8414 §2) naming the authorization server's revocation endpoint.
const REVOCATION_ENDPOINT: &str = "revocation_endpoint";

/// The `token_type_hint` (RFC 7009 §2.1) a revocation of a refresh token names.
const REFRESH_TOKEN_HINT: &str = "refresh_token";

/// Why a refresh token was not revoked.
#[derive(Debug, thiserror::Error)]
enum RevocationError {
    /// The server's authorization metadata could not be discovered.
    #[error("the MCP server's authorization metadata could not be read")]
    Metadata(#[source] AuthError),
    /// The metadata at the address the sign-in recorded could not be read.
    #[error("the MCP server's authorization metadata could not be read at its recorded address")]
    RecordedMetadata(#[source] NamedMetadataError),
    /// The recorded metadata address is not a web address.
    #[error("the MCP server's recorded metadata address is not a web address")]
    RecordedAddress(#[source] url::ParseError),
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

impl SignInService {
    /// Signs out of the server `digest` names for `binding`'s press at once, a renewal under way
    /// or not, as [`SignInService::sign_out_at`] does. Refuses `mcp.server.signOutFailed`,
    /// carrying the keychain's cause, when the keychain refuses to read or delete the sign-in,
    /// which then stays held and in use.
    pub(crate) async fn sign_out(
        &self,
        binding: &McpServerBindingRef,
        digest: &ServerAddressDigest,
    ) -> Result<(), McpRefusal> {
        self.sign_out_at(digest)
            .await
            .map_err(|source| McpRefusal::ServerSignOutFailed {
                binding: Box::new(binding.clone()),
                source: Box::new(source),
            })
    }

    /// Signs out of the server `digest` names at once, a renewal under way or not: forgets its
    /// sign-in, ends its waiting attempt or provider's flow and marks it signed out, then revokes
    /// its refresh token after the reply, discovering at the address its item holds as its
    /// binding declared it; a server that holds nothing costs at most one keychain read and one
    /// removal. Fails with the [`KeychainRefusal`] when the keychain refuses to read or delete the
    /// sign-in, which then stays held and in use.
    pub(crate) async fn sign_out_at(
        &self,
        digest: &ServerAddressDigest,
    ) -> Result<(), KeychainRefusal> {
        let held = self.custody.sign_out(digest).await?;
        if let Some(attempt) = self.take_attempt(digest, None) {
            attempt.end();
        }
        self.end_provider_flow(digest, None);
        if let Some(held) = held {
            let address = held.server_address.clone();
            revoke_on_task(
                Arc::new(self.pools.server_client(&address)),
                address,
                held,
                None,
                self.revocations.token().clone(),
            );
        }
        Ok(())
    }
}

/// Revokes `held`'s refresh token at `address`'s authorization server through `client`, on a task
/// `stop` ends, logging a revocation that fails or runs past the OAuth call bound. The server's
/// `metadata` is the caller's where it has it; with `None` the task reads it at the address `held`
/// recorded, or discovers it where `held` recorded none.
pub(crate) fn revoke_on_task(
    client: Arc<ServerOAuthHttpClient>,
    address: McpServerAddress,
    held: Arc<HeldSignIn>,
    metadata: Option<AuthorizationMetadata>,
    stop: CancellationToken,
) {
    tokio::spawn(async move {
        tokio::select! {
            () = stop.cancelled() => {}
            revoked = tokio::time::timeout(
                CALL_TIMEOUT,
                revoke(client, &address, &held, metadata),
            ) => {
                let failure = match revoked {
                    Ok(Ok(())) => return,
                    Ok(Err(failure)) => failure,
                    Err(_elapsed) => RevocationError::TimedOut,
                };
                tracing::warn!(
                    error = &failure as &(dyn std::error::Error + 'static),
                    "an MCP server's refresh token was not revoked"
                );
            }
        }
    });
}

// Posts `held`'s refresh token to the revocation endpoint the server's metadata publishes, through
// `client`, signed with the sign-in's proof key when it holds one and authenticated with its
// client's secret when it holds one; no refresh token or no published endpoint sends nothing. The
// metadata is `metadata` where given, else read at `held`'s recorded address, else discovered at
// `address`.
async fn revoke(
    client: Arc<ServerOAuthHttpClient>,
    address: &McpServerAddress,
    held: &HeldSignIn,
    metadata: Option<AuthorizationMetadata>,
) -> Result<(), RevocationError> {
    let Some(refresh_token) = held
        .credentials
        .token_response
        .as_ref()
        .and_then(|tokens| tokens.refresh_token())
    else {
        return Ok(());
    };
    let metadata = match (metadata, &held.authorization_server_metadata_url) {
        (Some(metadata), _) => metadata,
        (None, Some(recorded)) => {
            let recorded = Url::parse(recorded).map_err(RevocationError::RecordedAddress)?;
            read_named_metadata(&client, &recorded)
                .await
                .map_err(RevocationError::RecordedMetadata)?
        }
        (None, None) => {
            let manager = AuthorizationManager::new_with_oauth_http_client(
                address.as_str(),
                Arc::clone(&client) as Arc<dyn OAuthHttpClient>,
            )
            .await
            .map_err(RevocationError::Metadata)?;
            manager
                .resolve_metadata()
                .await
                .map_err(RevocationError::Metadata)?
                .metadata
        }
    };
    let Some(endpoint) = metadata
        .additional_fields
        .get(REVOCATION_ENDPOINT)
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    let endpoint = Url::parse(endpoint).map_err(RevocationError::Endpoint)?;
    client.set_dpop_key(held.dpop_key.clone());
    let mut body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", refresh_token.secret())
        .append_pair("token_type_hint", REFRESH_TOKEN_HINT)
        .append_pair("client_id", &held.credentials.client_id)
        .finish();
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    if let Some(client_secret) = &held.client_secret {
        ClientSecretAuthentication {
            client_id: &held.credentials.client_id,
            client_secret,
            method: ClientSecretMethod::from_metadata(
                &metadata.additional_fields,
                REVOCATION_ENDPOINT_AUTH_METHODS,
            ),
        }
        .authenticate(&mut body, &mut headers);
    }
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
pub(crate) mod tests {
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use axum::http::StatusCode;
    use reqwest::header::AUTHORIZATION;
    use reqwest::{Method, Url};
    use rmcp::transport::auth::{CredentialStore as _, StoredCredentials};
    use rstest::rstest;
    use secrecy::{SecretBox, SecretString};
    use serde_json::json;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_std::mutex_lock::lock;

    use crate::client::http::McpRequestAuthorizer as _;
    use crate::oauth::dpop_proof::DpopKey;
    use crate::oauth::dpop_proof::tests::{decode_part, proof_thumbprint};
    use crate::sign_in::authorizer::SignInAuthorizer;
    use crate::sign_in::credential_store::DpopKeyScalar;
    use crate::sign_in::test_service::{
        FakeAuthorizationServer, FakeServerAnswers, Harness, NAMED_METADATA_PATH, TokenForm,
        addressed_target, harness, serve_authorization_server,
    };

    /// The secret of the confidential client a sign-in may hold; made up for the test.
    const CLIENT_SECRET: &str = "test-client-secret";

    /// A harness holding a sign-in to a fake server whose revocation endpoint answers
    /// `revocation_status`, `test-access-token-1` with `test-refresh-token-1`, received now so no
    /// request renews it, issued to a client holding `client_secret` where one is given, a `DPoP`
    /// sign-in bound to `dpop_key` where one is given and a bearer one otherwise, with the
    /// authorizer a connection to the server presents its token through; every token is made up.
    pub(crate) async fn signed_in(
        revocation_status: StatusCode,
        client_secret: Option<&str>,
        dpop_key: Option<Arc<DpopKeyScalar>>,
    ) -> (FakeAuthorizationServer, Harness, SignInAuthorizer) {
        sign_in_to_fake(revocation_status, client_secret, dpop_key, false).await
    }

    // A sign-in as `signed_in` keeps one; where `is_metadata_recorded`, the fake refuses
    // discovery and the sign-in records the address the fake serves its metadata at.
    async fn sign_in_to_fake(
        revocation_status: StatusCode,
        client_secret: Option<&str>,
        dpop_key: Option<Arc<DpopKeyScalar>>,
        is_metadata_recorded: bool,
    ) -> (FakeAuthorizationServer, Harness, SignInAuthorizer) {
        let server = serve_authorization_server(FakeServerAnswers {
            revocation_status,
            is_discovery_refused: is_metadata_recorded,
            ..FakeServerAnswers::default()
        })
        .await;
        let metadata_address = is_metadata_recorded
            .then(|| Url::parse(&format!("{}{NAMED_METADATA_PATH}", server.base)).expect("a URL"));
        let harness = harness().await;
        let token_response = serde_json::from_value(json!({
            "access_token": "test-access-token-1",
            "token_type": if dpop_key.is_some() { "DPoP" } else { "Bearer" },
            "refresh_token": "test-refresh-token-1",
            "expires_in": 3600,
        }))
        .expect("a token response reads");
        let received_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is past the epoch")
            .as_secs();
        let custody = &harness.service.custody;
        custody
            .test_attempt_store(
                &address(&server),
                dpop_key,
                client_secret.map(SecretString::from),
            )
            .await
            .recording_metadata_address(metadata_address.as_ref())
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

    /// The address of `server`, as a sign-in to it is kept.
    pub(crate) fn address(server: &FakeAuthorizationServer) -> McpServerAddress {
        McpServerAddress::new(&server.base).expect("a server address")
    }

    /// Whether the authorizer sets an `Authorization` on a request to `base`'s server, and which.
    pub(crate) async fn presented_authorization(
        authorizer: &SignInAuthorizer,
        base: &str,
    ) -> Option<String> {
        let headers = authorizer.authorize(&Method::POST, base, None).await.ok()?;
        headers
            .into_iter()
            .find(|(name, _)| *name == AUTHORIZATION)
            .map(|(_, value)| value.to_str().expect("a text header").to_owned())
    }

    /// The forms the revocation endpoint received, once one has arrived or five seconds pass.
    pub(crate) async fn received_revocations(server: &FakeAuthorizationServer) -> Vec<TokenForm> {
        for _ in 0..200 {
            if !lock(&server.revocation_forms).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        lock(&server.revocation_forms).clone()
    }

    // Mutations: remove the item before reading it (nothing is left to revoke); keep the item, so
    // the proof key it holds stays; return the revocation's failure from `sign_out`; leave the
    // server marked signed in; send a confidential client's revocation with no secret, or in the
    // form where the metadata names no method; drop `client.set_dpop_key(..)` from `revoke`, so a
    // `DPoP` sign-in's revocation goes out unsigned; have `revoke` discover, or read the metadata
    // address from the target, whose entry names none, in place of the sign-in's record
    // (`a_recorded_metadata_address`, whose server refuses discovery, reaches no `/revoke`).
    #[rstest]
    #[case::revoked(StatusCode::OK, None, false, false)]
    #[case::revocation_refused(StatusCode::INTERNAL_SERVER_ERROR, None, false, false)]
    #[case::a_confidential_client(StatusCode::OK, Some(CLIENT_SECRET), false, false)]
    #[case::a_dpop_sign_in(StatusCode::OK, None, true, false)]
    #[case::a_recorded_metadata_address(StatusCode::OK, None, false, true)]
    #[tokio::test]
    async fn a_sign_out_forgets_the_sign_in_and_revokes_the_refresh_token_it_held(
        #[case] revocation_status: StatusCode,
        #[case] client_secret: Option<&str>,
        #[case] is_dpop: bool,
        #[case] is_metadata_recorded: bool,
    ) {
        let key = DpopKey::generate();
        let dpop_key = is_dpop.then(|| Arc::new(SecretBox::new(Box::new(key.to_scalar()))));
        let (server, harness, authorizer) = sign_in_to_fake(
            revocation_status,
            client_secret,
            dpop_key,
            is_metadata_recorded,
        )
        .await;
        let scheme = if is_dpop { "DPoP" } else { "Bearer" };
        let digest = harness.service.custody.test_digest(&address(&server)).await;
        assert!(
            harness
                .service
                .custody
                .signed_in_servers()
                .borrow()
                .contains(&digest)
        );
        assert_eq!(
            presented_authorization(&authorizer, &server.base)
                .await
                .as_deref(),
            Some(format!("{scheme} test-access-token-1").as_str())
        );

        let signed_out = harness
            .service
            .sign_out(&addressed_target(&server.base).binding, &digest)
            .await;

        assert!(signed_out.is_ok(), "the sign-out completes");
        assert!(
            harness
                .keychain
                .read(digest.as_str())
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
        assert_eq!(
            *lock(&server.revocation_authorizations),
            [client_secret.map(|_| "Basic dGVzdC1jbGllbnQ6dGVzdC1jbGllbnQtc2VjcmV0".to_owned())]
        );
        let proofs = lock(&server.revocation_proofs).clone();
        if is_dpop {
            let [Some(proof)] = &proofs[..] else {
                panic!("one revocation, carrying a proof: {proofs:?}");
            };
            assert_eq!(proof_thumbprint(proof), key.thumbprint());
            let claims = decode_part(proof.split('.').nth(1).expect("a proof has claims"));
            assert_eq!(claims["htm"], "POST");
            assert_eq!(claims["htu"], format!("{}/revoke", server.base));
            assert!(
                claims.get("ath").is_none(),
                "a revocation presents no access token"
            );
        } else {
            assert_eq!(proofs, [None]);
        }
        assert!(
            !harness
                .service
                .custody
                .signed_in_servers()
                .borrow()
                .contains(&digest)
        );
    }
}
