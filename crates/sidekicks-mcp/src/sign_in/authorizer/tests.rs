//! The authorizer against an axum token endpoint on a loopback port: one renewal however many
//! requests find the token run out, no renewal for a token another request already replaced, and
//! which refused renewals forget the sign-in.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::routing::post;
use oauth2::TokenResponse as _;
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationMetadata, CredentialStore as _, StoredCredentials,
};
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::keyed_lock::KeyedLock;
use tempfile::TempDir;

use super::{SignInAuthorizationError, SignInAuthorizer};
use crate::client::http::McpRequestAuthorizer as _;
use crate::sign_in::credential_store::SignInCustody;
use crate::sign_in::test_keychain::test_keychain;

/// How the fake token endpoint answers a renewal.
#[derive(Clone, Copy)]
enum TokenAnswer {
    /// New tokens, numbered after the requests so far: the second request's are `-3`.
    Rotate,
    /// A 400 naming this `error`.
    Refuse(&'static str),
}

/// A token endpoint on a loopback port answering every renewal with `answer`; it keeps the
/// refresh token each renewal sent. Returns the endpoint's base address, which the server's own
/// address extends too.
async fn serve_token_endpoint(answer: TokenAnswer) -> (String, Arc<Mutex<Vec<String>>>) {
    let refresh_tokens = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&refresh_tokens);
    let router = Router::new().route(
        "/token",
        post(move |body: String| async move {
            let refresh_token = url::form_urlencoded::parse(body.as_bytes())
                .find(|(name, _)| name == "refresh_token")
                .map(|(_, value)| value.into_owned())
                .expect("a renewal sends its refresh token");
            let count = {
                let mut received = received.lock().expect("never poisoned");
                received.push(refresh_token);
                received.len()
            };
            let (status, answer) = match answer {
                TokenAnswer::Rotate => (
                    StatusCode::OK,
                    json!({
                        "access_token": format!("test-access-token-{}", count + 1),
                        "token_type": "Bearer",
                        "refresh_token": format!("test-refresh-token-{}", count + 1),
                        "expires_in": 3600,
                    }),
                ),
                TokenAnswer::Refuse(error) => (StatusCode::BAD_REQUEST, json!({ "error": error })),
            };
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(answer.to_string()))
                .expect("a token answer")
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    (format!("http://{address}"), refresh_tokens)
}

/// A bearer sign-in to the server at `base`'s `/mcp`, held as `test-access-token-1` with
/// `test-refresh-token-1` and already run out, renewed at `base`'s `/token`; every token is made
/// up for the test.
async fn expired_sign_in(base: &str) -> (TempDir, Arc<SignInCustody>, SignInAuthorizer) {
    let (data_folder, _platform_store, keychain) = test_keychain();
    let custody = SignInCustody::new(keychain);
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let token_response = serde_json::from_value(json!({
        "access_token": "test-access-token-1",
        "token_type": "Bearer",
        "refresh_token": "test-refresh-token-1",
        "expires_in": 3600,
    }))
    .expect("a token response reads");
    // Received at the epoch's first second, so the hour it lasted is long over.
    let credentials = StoredCredentials::new(
        "test-client".to_owned(),
        Some(token_response),
        vec![],
        Some(1),
    );
    custody
        .credential_store(&address)
        .save(credentials)
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
    (data_folder, custody, authorizer)
}

/// The `Authorization` value `authorizer` sets on a request to `base`'s server.
async fn presented_authorization(authorizer: &SignInAuthorizer, base: &str) -> HeaderValue {
    let headers = authorizer
        .authorize(&Method::POST, &format!("{base}/mcp"), None)
        .await
        .expect("the request is authorized");
    headers
        .into_iter()
        .find(|(name, _)| *name == AUTHORIZATION)
        .map(|(_, value)| value)
        .expect("an Authorization header")
}

// Mutations: take no hold around the token's read in `SignInAuthorizer::current_token`, or renew
// in `SignInAuthorizer::renew_refused` without comparing the refused token with the held one.
#[tokio::test]
async fn one_renewal_serves_every_request_that_found_the_token_run_out() {
    let (base, refresh_tokens) = serve_token_endpoint(TokenAnswer::Rotate).await;
    let (_data_folder, custody, authorizer) = expired_sign_in(&base).await;

    let (first, second) = tokio::join!(
        presented_authorization(&authorizer, &base),
        presented_authorization(&authorizer, &base),
    );

    assert_eq!(first, "Bearer test-access-token-2");
    assert_eq!(second, "Bearer test-access-token-2");
    assert_eq!(
        *refresh_tokens.lock().expect("never poisoned"),
        ["test-refresh-token-1"]
    );
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let held = custody
        .credential_store(&address)
        .held()
        .await
        .expect("the keychain answers")
        .expect("the sign-in is held");
    let rotated = held
        .credentials
        .token_response
        .as_ref()
        .and_then(|token_response| token_response.refresh_token())
        .expect("a refresh token is held");
    assert_eq!(rotated.secret(), "test-refresh-token-2");

    let refused = HeaderValue::from_static("Bearer test-access-token-1");
    let is_resent = authorizer
        .answer_refusal(Some(&refused), Some("invalid_token"))
        .await
        .expect("the refusal is answered");

    assert!(is_resent, "the request goes again with the renewed token");
    assert_eq!(refresh_tokens.lock().expect("never poisoned").len(), 1);
    assert_eq!(
        presented_authorization(&authorizer, &base).await,
        "Bearer test-access-token-2"
    );
}

// Mutation: in `retry_refused_proof` or the credential store, forget the sign-in on
// `invalid_dpop_proof`.
#[rstest]
#[case::a_refused_proof_twice("invalid_dpop_proof", 2, true)]
#[case::a_refused_grant("invalid_grant", 1, false)]
#[tokio::test]
async fn only_a_refused_grant_forgets_the_sign_in(
    #[case] error: &'static str,
    #[case] renewals: usize,
    #[case] is_kept: bool,
) {
    let (base, refresh_tokens) = serve_token_endpoint(TokenAnswer::Refuse(error)).await;
    let (_data_folder, custody, authorizer) = expired_sign_in(&base).await;

    let refused = authorizer
        .authorization(&Method::POST, &format!("{base}/mcp"), None)
        .await;

    assert_eq!(
        refresh_tokens.lock().expect("never poisoned").len(),
        renewals
    );
    if is_kept {
        assert!(matches!(refused, Err(SignInAuthorizationError::Renewal(_))));
    } else {
        assert!(matches!(
            refused,
            Err(SignInAuthorizationError::SignInRequired)
        ));
    }
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let held = custody
        .credential_store(&address)
        .held()
        .await
        .expect("the keychain answers");
    assert_eq!(held.is_some(), is_kept);
}
