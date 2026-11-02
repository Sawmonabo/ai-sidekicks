//! The authorizer against an axum token endpoint on a loopback port: one renewal however many
//! requests find the token run out, no renewal for a token another request already replaced, a
//! renewal as the client a sign-in kept since names, a sign-out that lands after a renewal under
//! way, a `DPoP` sign-in's renewal signed with its key, which refused renewals forget the sign-in,
//! and which issuers keep it.

use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use oauth2::TokenResponse as _;
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use rmcp::transport::auth::{AuthorizationMetadata, CredentialStore as _, StoredCredentials};
use rstest::rstest;
use secrecy::SecretBox;
use serde_json::{Value, json};
use sidekicks_contracts::dpop::DPOP_PROOF_HEADER_NAME;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::{SignInAuthorizationError, SignInAuthorizer};
use crate::client::http::McpRequestAuthorizer as _;
use crate::oauth::dpop_proof::DpopKey;
use crate::sign_in::canonical_server_address;
use crate::sign_in::credential_store::{DpopKeyScalar, SignInCustody};
use crate::sign_in::oauth_http_client::OAuthHttpPools;
use crate::sign_in::test_keychain::test_keychain;

/// How the fake token endpoint answers a renewal.
#[derive(Clone, Copy)]
enum TokenAnswer {
    /// New tokens, numbered after the requests so far: the second request's are `-3`.
    Rotate,
    /// A 400 naming this `error`.
    Refuse(&'static str),
}

/// What the fake token endpoint received: each renewal's refresh token, the client id its form
/// named and the `DPoP` proof it carried; it tells `arrived` of each renewal, and answers only
/// while `answers` is free.
#[derive(Clone, Default)]
struct Renewals {
    refresh_tokens: Arc<Mutex<Vec<String>>>,
    client_ids: Arc<Mutex<Vec<Option<String>>>>,
    proofs: Arc<Mutex<Vec<Option<String>>>>,
    arrived: Arc<Notify>,
    answers: Arc<tokio::sync::Mutex<()>>,
}

/// A token endpoint on a loopback port answering every renewal with `answer`; it keeps what each
/// renewal sent. Returns the endpoint's base address, which the server's own address extends too.
async fn serve_token_endpoint(answer: TokenAnswer) -> (String, Renewals) {
    let renewals = Renewals::default();
    let received = renewals.refresh_tokens.clone();
    let client_ids = renewals.client_ids.clone();
    let proofs = renewals.proofs.clone();
    let arrived = renewals.arrived.clone();
    let answers = renewals.answers.clone();
    let router = Router::new().route(
        "/token",
        post(move |headers: HeaderMap, body: String| async move {
            arrived.notify_one();
            let _answer = answers.lock().await;
            client_ids.lock().expect("never poisoned").push(
                url::form_urlencoded::parse(body.as_bytes())
                    .find(|(name, _)| name == "client_id")
                    .map(|(_, value)| value.into_owned()),
            );
            proofs.lock().expect("never poisoned").push(
                headers
                    .get(DPOP_PROOF_HEADER_NAME)
                    .map(|value| value.to_str().expect("a text header").to_owned()),
            );
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
    (format!("http://{address}"), renewals)
}

/// A bearer sign-in to the server at `base`'s `/mcp`, held as `test-access-token-1` with
/// `test-refresh-token-1` and already run out, renewed at `base`'s `/token`, and the authorizer
/// made for it; every token is made up for the test.
async fn expired_sign_in(base: &str) -> (TempDir, Arc<SignInCustody>, SignInAuthorizer) {
    let (data_folder, custody, authorizer) =
        expired_sign_in_issued_by(base, None, None, None).await;
    (
        data_folder,
        custody,
        authorizer.expect("the authorizer is made"),
    )
}

/// The sign-in [`expired_sign_in`] holds, issued by `held_issuer` and, given `dpop_key`, a
/// `DPoP` sign-in bound to it, and the authorizer made for it against metadata naming `issuer`.
async fn expired_sign_in_issued_by(
    base: &str,
    held_issuer: Option<&str>,
    issuer: Option<&str>,
    dpop_key: Option<Arc<DpopKeyScalar>>,
) -> (
    TempDir,
    Arc<SignInCustody>,
    Result<SignInAuthorizer, SignInAuthorizationError>,
) {
    let (data_folder, _platform_store, keychain) = test_keychain();
    let custody = SignInCustody::new(keychain);
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let token_response = serde_json::from_value(json!({
        "access_token": "test-access-token-1",
        "token_type": if dpop_key.is_some() { "DPoP" } else { "Bearer" },
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
    )
    .with_issuer(held_issuer.map(str::to_owned));
    custody
        .attempt_credential_store(
            &address,
            custody.sign_out_generation(&address),
            dpop_key,
            None,
        )
        .save(credentials)
        .await
        .expect("the sign-in is kept");
    let mut metadata = AuthorizationMetadata::default();
    metadata.issuer = issuer.map(str::to_owned);
    metadata.authorization_endpoint = format!("{base}/authorize");
    metadata.token_endpoint = format!("{base}/token");
    let authorizer = SignInAuthorizer::new(
        &custody,
        &OAuthHttpPools::new().expect("the pools build"),
        &address,
        metadata,
    )
    .await;
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
    let (base, renewals) = serve_token_endpoint(TokenAnswer::Rotate).await;
    let refresh_tokens = renewals.refresh_tokens;
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
    let (base, received) = serve_token_endpoint(TokenAnswer::Refuse(error)).await;
    let refresh_tokens = received.refresh_tokens;
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
    assert_eq!(
        custody
            .signed_in_addresses()
            .borrow()
            .contains(&canonical_server_address(&address)),
        is_kept
    );
}

// Mutations: build the renewal's manager on rmcp's own client, or leave the held key off the
// filtered client's slot; the renewal then carries no proof.
#[tokio::test]
async fn a_dpop_sign_ins_renewal_is_signed_for_the_token_endpoint() {
    let (base, renewals) = serve_token_endpoint(TokenAnswer::Rotate).await;
    let dpop_key: Arc<DpopKeyScalar> =
        Arc::new(SecretBox::new(Box::new(DpopKey::generate().to_scalar())));
    let (_data_folder, _custody, authorizer) =
        expired_sign_in_issued_by(&base, None, None, Some(dpop_key)).await;

    presented_authorization(&authorizer.expect("the authorizer is made"), &base).await;

    let proofs = renewals.proofs.lock().expect("never poisoned").clone();
    let [Some(proof)] = &proofs[..] else {
        panic!("one renewal, carrying a proof: {proofs:?}");
    };
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(proof.split('.').nth(1).expect("a JWT's claims"))
            .expect("base64url claims"),
    )
    .expect("JSON claims");
    assert_eq!(claims["htm"], "POST");
    assert_eq!(claims["htu"], format!("{base}/token"));
}

// Mutations: compare the issuers as exact text in `is_same_issuer`, drop only a slash ending an
// empty path, or keep a sign-in another authorization server issued.
#[rstest]
#[case::a_slash_ending_an_empty_path("https://auth.example.com/", "https://auth.example.com", true)]
#[case::a_slash_ending_a_path(
    "https://auth.example.com/tenant/",
    "https://auth.example.com/tenant",
    true
)]
#[case::another_issuer("https://other.example.com", "https://auth.example.com", false)]
#[tokio::test]
async fn a_sign_in_is_kept_only_for_the_issuer_that_issued_it(
    #[case] held_issuer: &str,
    #[case] issuer: &str,
    #[case] is_kept: bool,
) {
    let (base, _renewals) = serve_token_endpoint(TokenAnswer::Rotate).await;

    let (_data_folder, custody, authorizer) =
        expired_sign_in_issued_by(&base, Some(held_issuer), Some(issuer), None).await;

    if is_kept {
        assert_eq!(
            presented_authorization(&authorizer.expect("the authorizer is made"), &base).await,
            "Bearer test-access-token-2"
        );
    } else {
        assert!(matches!(
            authorizer,
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

/// A sign-in kept since the authorizer was made, under another client, renews as that client.
/// Killed by an authorizer that keeps the client it was made with, whose renewal rmcp refuses as
/// another client's sign-in.
#[tokio::test]
async fn a_sign_in_kept_since_renews_as_its_own_client() {
    let (base, renewals) = serve_token_endpoint(TokenAnswer::Rotate).await;
    let (_data_folder, custody, authorizer) = expired_sign_in(&base).await;
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let token_response = serde_json::from_value(json!({
        "access_token": "test-access-token-1",
        "token_type": "Bearer",
        "refresh_token": "test-refresh-token-1",
        "expires_in": 3600,
    }))
    .expect("a token response reads");
    custody
        .attempt_credential_store(&address, custody.sign_out_generation(&address), None, None)
        .save(StoredCredentials::new(
            "test-other-client".to_owned(),
            Some(token_response),
            vec![],
            Some(1),
        ))
        .await
        .expect("the new sign-in is kept");

    assert_eq!(
        presented_authorization(&authorizer, &base).await,
        "Bearer test-access-token-2"
    );
    assert_eq!(
        *renewals.client_ids.lock().expect("never poisoned"),
        [Some("test-other-client".to_owned())]
    );
}

/// A sign-out asked while a renewal waits on the token endpoint lands after it: it removes the
/// rotated sign-in, so the refresh token revoked is the newest, and nothing is held after. Killed
/// by a sign-out that skips the renewal hold, which removes the token the renewal replaces.
#[tokio::test]
async fn a_sign_out_during_a_renewal_removes_the_rotated_sign_in() {
    let (base, renewals) = serve_token_endpoint(TokenAnswer::Rotate).await;
    let (_data_folder, custody, authorizer) = expired_sign_in(&base).await;
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let held_answers = Arc::clone(&renewals.answers).lock_owned().await;
    let renewing = tokio::spawn({
        let base = base.clone();
        async move {
            authorizer
                .authorization(&Method::POST, &format!("{base}/mcp"), None)
                .await
                .is_ok()
        }
    });
    renewals.arrived.notified().await;
    let store = custody.credential_store(&address);
    let mut signing_out = pin!(store.sign_out());

    let early = tokio::time::timeout(Duration::from_millis(500), &mut signing_out).await;
    assert!(early.is_err(), "the sign-out waits for the renewal");
    drop(held_answers);
    let removed = signing_out
        .await
        .expect("the keychain answers")
        .expect("a sign-in was held");

    assert!(renewing.await.expect("the renewal's task ends"));
    let rotated = removed
        .credentials
        .token_response
        .as_ref()
        .and_then(|token_response| token_response.refresh_token())
        .expect("the removed sign-in holds a refresh token");
    assert_eq!(rotated.secret(), "test-refresh-token-2");
    assert!(store.held().await.expect("the keychain answers").is_none());
    assert!(
        !custody
            .signed_in_addresses()
            .borrow()
            .contains(&canonical_server_address(&address))
    );
}
