//! The authorizer against an axum token endpoint on a loopback port: one renewal however many
//! requests find the token run out, no renewal for a token another request already replaced, a
//! renewal as the client a sign-in kept since names, a sign-out that overtakes a renewal under way
//! and the refresh token that renewal received revoked, a `DPoP` sign-in's renewal signed with its
//! key, its request presenting the token with a proof of that request, which refused renewals
//! forget the sign-in, which expired sign-ins mark the server signed out, and which issuers keep
//! it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use oauth2::TokenResponse as _;
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use rmcp::transport::auth::{AuthorizationMetadata, CredentialStore as _, StoredCredentials};
use rstest::rstest;
use secrecy::SecretBox;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::dpop::DPOP_PROOF_HEADER_NAME;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::test_keychain;
use tempfile::TempDir;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{SignInAuthorizationError, SignInAuthorizer};
use crate::client::http::McpRequestAuthorizer as _;
use crate::oauth::dpop_proof::DpopKey;
use crate::oauth::dpop_proof::tests::{decode_part, proof_thumbprint};
use crate::sign_in::credential_store::{DpopKeyScalar, SignInCustody};
use crate::sign_in::oauth_http_client::OAuthHttpPools;
use crate::sign_in::sign_out::revocation::tests::signed_in;
use crate::sign_in::test_service::NoOwnerClientSecrets;

/// How the fake token endpoint answers a renewal.
#[derive(Clone, Copy)]
enum TokenAnswer {
    /// New tokens, numbered after the requests so far: the second request's are `-3`.
    Rotate,
    /// A 400 naming this `error`.
    Refuse(&'static str),
}

/// What the fake token endpoint received: each renewal's refresh token, the client id its form
/// named and the `DPoP` proof it carried, and each token its revocation endpoint was sent; it
/// tells `arrived` of each renewal and `revoked` of each revocation, and answers only while
/// `answers` is free.
#[derive(Clone, Default)]
struct Renewals {
    refresh_tokens: Arc<Mutex<Vec<String>>>,
    client_ids: Arc<Mutex<Vec<Option<String>>>>,
    proofs: Arc<Mutex<Vec<Option<String>>>>,
    revoked_tokens: Arc<Mutex<Vec<String>>>,
    arrived: Arc<Notify>,
    revoked: Arc<Notify>,
    answers: Arc<tokio::sync::Mutex<()>>,
}

/// A token endpoint on a loopback port answering every renewal with `answer`, beside the metadata
/// naming it and a revocation endpoint; it keeps what each renewal and revocation sent. Returns the
/// endpoint's base address, which the server's own address extends too.
async fn serve_token_endpoint(answer: TokenAnswer) -> (String, Renewals) {
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
    })
    .to_string();
    let renewals = Renewals::default();
    let received = renewals.refresh_tokens.clone();
    let client_ids = renewals.client_ids.clone();
    let proofs = renewals.proofs.clone();
    let revoked_tokens = renewals.revoked_tokens.clone();
    let revoked = renewals.revoked.clone();
    let arrived = renewals.arrived.clone();
    let answers = renewals.answers.clone();
    let router = Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || async move { ([(header::CONTENT_TYPE, "application/json")], metadata) }),
        )
        .route(
            "/revoke",
            post(move |body: String| async move {
                revoked_tokens.lock().expect("never poisoned").extend(
                    url::form_urlencoded::parse(body.as_bytes())
                        .find(|(name, _)| name == "token")
                        .map(|(_, value)| value.into_owned()),
                );
                revoked.notify_one();
                StatusCode::OK
            }),
        )
        .route(
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
                    TokenAnswer::Refuse(error) => {
                        (StatusCode::BAD_REQUEST, json!({ "error": error }))
                    }
                };
                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(answer.to_string()))
                    .expect("a token answer")
            }),
        );
    tokio::spawn(async move { axum::serve(listener, router).await });
    (base, renewals)
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
    let (data_folder, _platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
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
        .test_attempt_store(&address, dpop_key, None)
        .await
        .save(credentials)
        .await
        .expect("the sign-in is kept");
    let authorizer = authorizer_for(&custody, base, issuer).await;
    (data_folder, custody, authorizer)
}

/// The authorizer of the server at `base`'s `/mcp` under the sign-in `custody` holds for it,
/// against metadata naming `issuer` and `base`'s endpoints.
async fn authorizer_for(
    custody: &Arc<SignInCustody>,
    base: &str,
    issuer: Option<&str>,
) -> Result<SignInAuthorizer, SignInAuthorizationError> {
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let mut metadata = AuthorizationMetadata::default();
    metadata.issuer = issuer.map(str::to_owned);
    metadata.authorization_endpoint = format!("{base}/authorize");
    metadata.token_endpoint = format!("{base}/token");
    metadata.additional_fields.insert(
        "revocation_endpoint".to_owned(),
        json!(format!("{base}/revoke")),
    );
    SignInAuthorizer::new(
        custody,
        &OAuthHttpPools::new().expect("the pools build"),
        &address,
        metadata,
        Arc::new(NoOwnerClientSecrets),
        CancellationToken::new(),
    )
    .await
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
        .test_held_store(&address)
        .await
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
        .test_held_store(&address)
        .await
        .held()
        .await
        .expect("the keychain answers");
    assert_eq!(held.is_some(), is_kept);
    assert_eq!(
        custody
            .signed_in_servers()
            .borrow()
            .contains(&custody.test_digest(&address).await),
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
    let claims = decode_part(proof.split('.').nth(1).expect("a JWT's claims"));
    assert_eq!(claims["htm"], "POST");
    assert_eq!(claims["htu"], format!("{base}/token"));
}

// Mutations: in `SignInAuthorizer::authorization`, present the token under
// `BEARER_AUTHORIZATION_SCHEME`, hand `make_proof` `None` for the access token or for the nonce,
// or make the key in `SignInAuthorizer::dpop_key` with `DpopKey::generate()` in place of
// `DpopKey::from_scalar`; each fails an assertion below.
#[tokio::test]
async fn a_dpop_sign_in_presents_its_token_with_a_proof_of_the_request() {
    let key = DpopKey::generate();
    let (server, _harness, authorizer) = signed_in(
        StatusCode::OK,
        None,
        Some(Arc::new(SecretBox::new(Box::new(key.to_scalar())))),
    )
    .await;
    let base = &server.base;

    let headers = authorizer
        .authorize(
            &Method::POST,
            &format!("{base}/mcp?page=2"),
            Some("server-nonce-1"),
        )
        .await
        .expect("the request is authorized");

    let header = |name: &str| {
        let (_, value) = headers
            .iter()
            .find(|(header, _)| header.as_str() == name)
            .unwrap_or_else(|| panic!("a {name} header"));
        value.to_str().expect("a text header").to_owned()
    };
    assert_eq!(header(AUTHORIZATION.as_str()), "DPoP test-access-token-1");
    let proof = header(DPOP_PROOF_HEADER_NAME);
    assert_eq!(proof_thumbprint(&proof), key.thumbprint());
    let claims = decode_part(proof.split('.').nth(1).expect("a proof has claims"));
    assert_eq!(claims["htm"], "POST");
    assert_eq!(claims["htu"], format!("{base}/mcp"));
    assert_eq!(
        claims["ath"],
        URL_SAFE_NO_PAD.encode(Sha256::digest("test-access-token-1"))
    );
    assert_eq!(claims["nonce"], "server-nonce-1");
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
        .test_held_store(&address)
        .await
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
        .test_attempt_store(&address, None, None)
        .await
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

/// A sign-out asked while a renewal waits on the token endpoint removes the sign-in at once; the
/// renewal's save is then refused and the refresh token it received is revoked, so the newest
/// token is revoked with no wait, and nothing is held after. Killed by a sign-out that waits for
/// the renewal's hold, and by a refused renewal whose received token is not revoked.
#[tokio::test]
async fn a_sign_out_during_a_renewal_lands_at_once_and_its_rotated_token_is_revoked() {
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
        }
    });
    renewals.arrived.notified().await;
    let digest = custody.test_digest(&address).await;

    let signed_out = tokio::time::timeout(Duration::from_secs(5), custody.sign_out(&digest))
        .await
        .expect("the sign-out lands while the renewal waits")
        .expect("the keychain answers");
    drop(held_answers);

    assert!(signed_out.is_some(), "the sign-in held is removed");
    assert!(matches!(
        renewing.await.expect("the renewal's task ends"),
        Err(SignInAuthorizationError::Renewal(_))
    ));
    tokio::time::timeout(Duration::from_secs(5), renewals.revoked.notified())
        .await
        .expect("the received refresh token is revoked");
    assert_eq!(
        *renewals.revoked_tokens.lock().expect("never poisoned"),
        ["test-refresh-token-2"]
    );
    assert!(
        custody
            .test_held_store(&address)
            .await
            .held()
            .await
            .expect("the keychain answers")
            .is_none()
    );
    assert!(!custody.signed_in_servers().borrow().contains(&digest));
}

/// Keeps a bearer sign-in to the server at `address` holding `access_token` and, where given,
/// `refresh_token`, received at the epoch's first second so the hour it lasted is long over.
async fn keep_run_out_sign_in(
    custody: &Arc<SignInCustody>,
    address: &McpServerAddress,
    access_token: &str,
    refresh_token: Option<&str>,
) {
    let mut token_response = json!({
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": 3600,
    });
    if let Some(refresh_token) = refresh_token {
        token_response["refresh_token"] = json!(refresh_token);
    }
    custody
        .test_attempt_store(address, None, None)
        .await
        .save(StoredCredentials::new(
            "test-client".to_owned(),
            Some(serde_json::from_value(token_response).expect("a token response reads")),
            vec![],
            Some(1),
        ))
        .await
        .expect("the sign-in is kept");
}

/// A request that finds a run-out sign-in holding no refresh token marks the server signed out,
/// while a sign-in kept between a request's read and its mark stays listed. Killed by a mark that
/// skips the held sign-in's identity either way: always marking, or never.
#[tokio::test]
async fn only_the_sign_in_a_request_found_unrenewable_is_marked_signed_out() {
    let (base, renewals) = serve_token_endpoint(TokenAnswer::Rotate).await;
    let (_data_folder, _platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
    let custody = SignInCustody::new(keychain);
    let address = McpServerAddress::new(&format!("{base}/mcp")).expect("a server address");
    let digest = custody.test_digest(&address).await;
    keep_run_out_sign_in(&custody, &address, "test-access-token-1", None).await;
    let authorizer = authorizer_for(&custody, &base, None)
        .await
        .expect("the authorizer is made");

    let refused = authorizer
        .authorization(&Method::POST, &format!("{base}/mcp"), None)
        .await;

    assert!(matches!(
        refused,
        Err(SignInAuthorizationError::SignInRequired)
    ));
    assert!(
        renewals
            .refresh_tokens
            .lock()
            .expect("never poisoned")
            .is_empty()
    );
    assert!(!custody.signed_in_servers().borrow().contains(&digest));

    let store = custody.test_held_store(&address).await;
    let found = store.held().await.expect("the keychain answers");
    keep_run_out_sign_in(
        &custody,
        &address,
        "test-access-token-2",
        Some("test-refresh-token-2"),
    )
    .await;
    store
        .mark_needs_sign_in(found.as_ref())
        .await
        .expect("the keychain answers");

    assert!(custody.signed_in_servers().borrow().contains(&digest));
}
