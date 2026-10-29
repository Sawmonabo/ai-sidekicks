//! The sign-out of an MCP server: its held sign-in is read into memory, its keychain item removed,
//! its waiting attempt ended and its address marked signed out; after the reply, its refresh token
//! is revoked where the authorization server publishes a revocation endpoint (RFC 7009).
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
    /// Signs out of `target`'s server: forgets its sign-in, ends its waiting attempt and marks it
    /// signed out, then revokes its refresh token after the reply. A server with no sign-in held
    /// signs out at once. Refuses with `mcp.server.signOutFailed`, carrying the keychain's cause,
    /// when the keychain refuses to read or delete the sign-in, which then stays held and in use.
    pub(crate) async fn sign_out(&self, target: &SignInTarget) -> Result<(), McpRefusal> {
        let Some(server) = addressed_server(target) else {
            return Ok(());
        };
        let refused = |source| McpRefusal::ServerSignOutFailed {
            binding: target.binding.clone(),
            source,
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
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use axum::Router;
    use axum::body::Body;
    use axum::http::StatusCode;
    use axum::response::Response;
    use axum::routing::{get, post};
    use reqwest::Method;
    use reqwest::header::AUTHORIZATION;
    use rmcp::transport::auth::{
        AuthorizationManager, AuthorizationMetadata, CredentialStore as _, StoredCredentials,
    };
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
    use sidekicks_std::keyed_lock::KeyedLock;
    use sidekicks_store::credential_store::SecretKeychain;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use tempfile::TempDir;

    use crate::client::http::McpRequestAuthorizer as _;
    use crate::errors::McpRefusal;
    use crate::schema::schema_parts;
    use crate::sign_in::admitted_client::{
        AdmittedClientStore, MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
    };
    use crate::sign_in::authorizer::SignInAuthorizer;
    use crate::sign_in::canonical_server_address;
    use crate::sign_in::credential_store::SignInCustody;
    use crate::sign_in::oauth_http_client::OAuthHttpPools;
    use crate::sign_in::registration::RELAY_ADDRESS;
    use crate::sign_in::service::{AddressedServer, SignInServer, SignInService, SignInTarget};
    use crate::sign_in::test_keychain::test_keychain;

    /// A bearer sign-in to a fake server, held through the service's custody, with the authorizer
    /// a connection to the server presents its token through.
    struct SignedIn {
        service: Arc<SignInService>,
        authorizer: SignInAuthorizer,
        target: SignInTarget,
        address: McpServerAddress,
        keychain: Arc<dyn SecretKeychain>,
        platform_store: PlatformCredentialStore,
        _data_folder: TempDir,
        _database: TestDatabase,
    }

    // An authorization server on a loopback port that publishes a revocation endpoint answering
    // `revocation_status`, returning its address and the forms the endpoint received.
    async fn serve_authorization_server(
        revocation_status: StatusCode,
    ) -> (String, Arc<Mutex<Vec<Vec<(String, String)>>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let base = format!(
            "http://{}",
            listener.local_addr().expect("the port's address")
        );
        let metadata = json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "revocation_endpoint": format!("{base}/revoke"),
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
        })
        .to_string();
        let revocations = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&revocations);
        let router = Router::new()
            .route(
                "/.well-known/oauth-authorization-server",
                get(move || async move { answer(StatusCode::OK, metadata) }),
            )
            .route(
                "/revoke",
                post(move |body: String| async move {
                    let form = url::form_urlencoded::parse(body.as_bytes())
                        .map(|(name, value)| (name.into_owned(), value.into_owned()))
                        .collect();
                    received.lock().expect("never poisoned").push(form);
                    answer(revocation_status, "{}".to_owned())
                }),
            )
            .fallback(|| async { answer(StatusCode::NOT_FOUND, "{}".to_owned()) });
        tokio::spawn(async move { axum::serve(listener, router).await });
        (base, revocations)
    }

    fn answer(status: StatusCode, body: String) -> Response {
        Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .expect("a response")
    }

    // A service holding a bearer sign-in to the server at `base`, `test-access-token-1` with
    // `test-refresh-token-1`, received now so no request renews it; every token is made up.
    async fn signed_in(base: &str) -> SignedIn {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let admitted_clients = Arc::new(AdmittedClientStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
            )),
            Arc::new(writer),
        ));
        let (data_folder, platform_store, keychain) = test_keychain();
        let custody = SignInCustody::new(Arc::clone(&keychain));
        let address = McpServerAddress::new(base).expect("a server address");
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
        custody
            .credential_store(&address)
            .save(StoredCredentials::new(
                "test-client".to_owned(),
                Some(token_response),
                vec![],
                Some(received_at),
            ))
            .await
            .expect("the sign-in is kept");
        let mut manager = AuthorizationManager::new(address.as_str())
            .await
            .expect("a manager for a loopback server");
        let mut metadata = AuthorizationMetadata::default();
        metadata.authorization_endpoint = format!("{base}/authorize");
        metadata.token_endpoint = format!("{base}/token");
        manager.set_metadata(metadata);
        manager
            .configure_client_id("test-client")
            .expect("the client is configured");
        let authorizer =
            SignInAuthorizer::new(&custody, &address, manager, Arc::new(KeyedLock::default()));
        let service = SignInService::new(
            custody,
            admitted_clients,
            OAuthHttpPools::new().expect("the pools build"),
            &RELAY_ADDRESS,
        );
        let target = SignInTarget {
            binding: McpServerBindingRef::User {
                provider: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
                server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
            },
            server: SignInServer::Address(AddressedServer::new(address.clone(), None)),
        };
        SignedIn {
            service,
            authorizer,
            target,
            address,
            keychain,
            platform_store,
            _data_folder: data_folder,
            _database: database,
        }
    }

    // Whether the authorizer sets an `Authorization` on a request to `base`'s server, and which.
    async fn presented_authorization(signed_in: &SignedIn, base: &str) -> Option<String> {
        let headers = signed_in
            .authorizer
            .authorize(&Method::POST, base, None)
            .await
            .ok()?;
        headers
            .into_iter()
            .find(|(name, _)| *name == AUTHORIZATION)
            .map(|(_, value)| value.to_str().expect("a text header").to_owned())
    }

    // The forms the revocation endpoint received, once one has arrived or five seconds pass.
    async fn received_revocations(
        revocations: &Mutex<Vec<Vec<(String, String)>>>,
    ) -> Vec<Vec<(String, String)>> {
        for _ in 0..200 {
            if !revocations.lock().expect("never poisoned").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        revocations.lock().expect("never poisoned").clone()
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
        let (base, revocations) = serve_authorization_server(revocation_status).await;
        let signed_in = signed_in(&base).await;
        assert_eq!(
            presented_authorization(&signed_in, &base).await.as_deref(),
            Some("Bearer test-access-token-1")
        );

        let signed_out = signed_in.service.sign_out(&signed_in.target).await;

        assert!(signed_out.is_ok(), "the sign-out completes");
        assert!(
            signed_in
                .keychain
                .read(&canonical_server_address(&signed_in.address))
                .await
                .expect("the keychain answers")
                .is_none(),
            "the item, credentials and key alike, is gone"
        );
        assert_eq!(presented_authorization(&signed_in, &base).await, None);
        let form = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect()
        };
        assert_eq!(
            received_revocations(&revocations).await,
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
        let (base, revocations) = serve_authorization_server(StatusCode::OK).await;
        let signed_in = signed_in(&base).await;
        signed_in.platform_store.refuse_next_call(
            KeychainService::McpSignIns.as_str(),
            &canonical_server_address(&signed_in.address),
        );

        let signed_out = signed_in.service.sign_out(&signed_in.target).await;

        let Err(McpRefusal::ServerSignOutFailed { source, .. }) = signed_out else {
            unreachable!("the refused removal refuses the sign-out");
        };
        assert_eq!(source.cause(), KeychainRefusalCause::Unavailable);
        assert_eq!(
            presented_authorization(&signed_in, &base).await.as_deref(),
            Some("Bearer test-access-token-1")
        );
        assert!(
            signed_in
                .keychain
                .read(&canonical_server_address(&signed_in.address))
                .await
                .expect("the keychain answers")
                .is_some(),
            "the item is still kept"
        );
        assert!(revocations.lock().expect("never poisoned").is_empty());
    }
}
