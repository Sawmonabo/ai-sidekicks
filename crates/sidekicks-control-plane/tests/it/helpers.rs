//! What the control plane's tests share: a fresh account file, a relay over it with a scripted
//! verifier and authenticator list, a caller's `DPoP` key, and a call through a router.

use std::future::Future;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, Request, StatusCode};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiff::Timestamp;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_control_plane::account::aasa::build_app_site_association_router;
use sidekicks_control_plane::account::settings::AccountSettings;
use sidekicks_control_plane::account::token::issuer::generate_paserk_keys;
use sidekicks_control_plane::account::webauthn::authenticator_list::{
    AuthenticatorList, AuthenticatorListError,
};
use sidekicks_control_plane::account::webauthn::verifier::{PasskeyVerifier, VerifierError};
use sidekicks_control_plane::account::{AccountRoutes, build_account_router};
use sidekicks_control_plane::account_store::{AccountStore, open_account_file};
use sidekicks_control_plane::rate_limit::enforcement_pipeline::AccountFileAdmission;
use sidekicks_control_plane::rate_limit::limiter::{Clock, read_wall_clock};
use sidekicks_control_plane::server::router::{RequestId, SourceAddress, build_router};
use tempfile::TempDir;
use tokio::sync::Barrier;
use tower_service::Service;

/// An account file in a folder of its own, removed with the folder.
pub(crate) struct AccountFile {
    /// The open file, as the relay shares it.
    pub(crate) connection: Arc<Mutex<Connection>>,
    _folder: TempDir,
}

/// A fresh account file with its schema built.
pub(crate) fn create_account_file() -> AccountFile {
    let folder = tempfile::tempdir().expect("the test can make a folder");
    let connection = open_account_file(&folder.path().join("account.sqlite"))
        .expect("a fresh account file opens");
    AccountFile {
        connection: Arc::new(Mutex::new(connection)),
        _folder: folder,
    }
}

impl AccountFile {
    /// How many requests the file holds counted.
    pub(crate) fn count_held_requests(&self) -> i64 {
        #[derive(serde::Deserialize)]
        struct Count {
            counted: i64,
        }
        let connection = self
            .connection
            .lock()
            .expect("no test panicked holding the file");
        let rows: Vec<Count> = connection
            .query("SELECT COUNT(*) AS counted FROM counted_requests", &[])
            .expect("the count reads");
        rows[0].counted
    }
}

/// Sends `request` through `router` and reads the answer's status, headers and JSON body.
pub(crate) async fn call(
    router: &Router,
    request: Request<Body>,
) -> (StatusCode, HeaderMap, serde_json::Value) {
    let response = router
        .clone()
        .call(request)
        .await
        .expect("a router never fails");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body reads");
    let body = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("a body is JSON")
    };
    (status, headers, body)
}

/// The relying party id every test relay runs under.
pub(crate) const RELYING_PARTY_ID: &str = "relay.example";

/// The relay's origin, the one a response may carry and a `DPoP` proof's `htu` names.
pub(crate) const ORIGIN: &str = "https://relay.example";

/// The relay under test: its router over an account file, the verifier and authenticator list it
/// calls out to, and the token keys it signs with, kept so a second router can share them.
pub(crate) struct Relay {
    /// The router a caller reaches.
    pub(crate) router: Router,
    /// The account file the router keeps its data in.
    pub(crate) account: AccountFile,
    /// The verifier, whose verdicts each test sets.
    pub(crate) verifier: ScriptedVerifier,
    /// The authenticator list, whose text each test sets.
    pub(crate) authenticator_list: FixtureList,
    keys: (String, String),
}

/// A relay over a fresh account file with fresh keys, reading the wall clock.
pub(crate) fn start_relay() -> Relay {
    let account = create_account_file();
    let verifier = ScriptedVerifier::default();
    let authenticator_list = FixtureList::default();
    let keys = generate_paserk_keys();
    let router = build_relay_router(
        &account,
        &verifier,
        &authenticator_list,
        &keys,
        read_wall_clock,
    );
    Relay {
        router,
        account,
        verifier,
        authenticator_list,
        keys,
    }
}

impl Relay {
    /// A second router over the same file, keys, verifier and list, reading `clock`.
    pub(crate) fn with_clock(&self, clock: Clock) -> Router {
        build_relay_router(
            &self.account,
            &self.verifier,
            &self.authenticator_list,
            &self.keys,
            clock,
        )
    }

    /// Runs `statement` on the account file and reads its rows.
    pub(crate) fn query(&self, statement: &str) -> Vec<serde_json::Value> {
        let connection = self
            .account
            .connection
            .lock()
            .expect("no test panicked holding the file");
        connection
            .query(statement, &[])
            .expect("the statement runs")
    }

    /// Runs `statement`, which returns no rows, on the account file.
    pub(crate) fn execute(&self, statement: &str) {
        let connection = self
            .account
            .connection
            .lock()
            .expect("no test panicked holding the file");
        AccountStore::execute(&*connection, statement, &[]).expect("the statement runs");
    }

    /// Adds a user with `id` and the base64url user handle `identity_ref`, holding the passkey
    /// `credential_id` at signature counter `counter`.
    pub(crate) fn add_user_with_passkey(
        &self,
        id: &str,
        identity_ref: &str,
        credential_id: &str,
        counter: i64,
    ) {
        self.execute(&format!(
            "INSERT INTO users (id, display_name, identity_ref) VALUES ('{id}', 'Sam', \
             '{identity_ref}')"
        ));
        self.execute(&format!(
            "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, aaguid, \
             signature_counter) VALUES ('{id}', '{credential_id}', x'a5010203', \
             '00000000-0000-0000-0000-000000000000', {counter})"
        ));
    }
}

fn build_relay_router(
    account: &AccountFile,
    verifier: &ScriptedVerifier,
    authenticator_list: &FixtureList,
    (signing, encryption): &(String, String),
    clock: Clock,
) -> Router {
    let settings = AccountSettings::read(|name| match name {
        "RELYING_PARTY_ID" => Some(RELYING_PARTY_ID.to_owned()),
        "RELYING_PARTY_ORIGINS" => Some(ORIGIN.to_owned()),
        "TOKEN_SIGNING_KEY" => Some(signing.clone()),
        "TOKEN_ENCRYPTION_KEY" => Some(encryption.clone()),
        _ => None,
    });
    let routes = AccountRoutes::new(
        account.connection.clone(),
        verifier.clone(),
        authenticator_list.clone(),
        settings,
        clock,
    );
    let admission = AccountFileAdmission::new(account.connection.clone(), clock);
    build_router(
        build_account_router(routes, admission),
        build_app_site_association_router(Some("TEAM.app.example".to_owned())),
    )
}

/// A verifier whose verdicts the test sets, which records each check it is handed and, with a
/// gate, holds every call until as many calls wait as the gate counts.
#[derive(Clone, Default)]
pub(crate) struct ScriptedVerifier {
    verdict: Arc<Mutex<String>>,
    checks: Arc<Mutex<Vec<serde_json::Value>>>,
    gate: Arc<Mutex<Option<Arc<Barrier>>>>,
}

impl ScriptedVerifier {
    /// Answers every later call with `verdict`.
    pub(crate) fn answer(&self, verdict: &serde_json::Value) {
        *self.verdict.lock().expect("no test panicked") = verdict.to_string();
    }

    /// Holds each later call until `calls` calls wait together.
    pub(crate) fn gate(&self, calls: usize) {
        *self.gate.lock().expect("no test panicked") = Some(Arc::new(Barrier::new(calls)));
    }

    /// Every check handed to the verifier so far.
    pub(crate) fn checks(&self) -> Vec<serde_json::Value> {
        self.checks.lock().expect("no test panicked").clone()
    }

    async fn run(&self, check: String) -> Result<String, VerifierError> {
        self.checks
            .lock()
            .expect("no test panicked")
            .push(serde_json::from_str(&check).expect("a check is JSON"));
        let gate = self.gate.lock().expect("no test panicked").clone();
        if let Some(gate) = gate {
            gate.wait().await;
        }
        Ok(self.verdict.lock().expect("no test panicked").clone())
    }
}

impl PasskeyVerifier for ScriptedVerifier {
    fn verify_registration(
        &self,
        check: String,
    ) -> impl Future<Output = Result<String, VerifierError>> + Send {
        let verifier = self.clone();
        async move { verifier.run(check).await }
    }

    fn verify_authentication(
        &self,
        check: String,
    ) -> impl Future<Output = Result<String, VerifierError>> + Send {
        let verifier = self.clone();
        async move { verifier.run(check).await }
    }
}

/// An authenticator list whose text the test sets; it starts empty of entries, as a retired list.
#[derive(Clone)]
pub(crate) struct FixtureList(Arc<Mutex<String>>);

impl Default for FixtureList {
    fn default() -> Self {
        Self(Arc::new(Mutex::new("{}".to_owned())))
    }
}

impl FixtureList {
    /// Answers every later fetch with `list`.
    pub(crate) fn hold(&self, list: &str) {
        list.clone_into(&mut self.0.lock().expect("no test panicked"));
    }
}

impl AuthenticatorList for FixtureList {
    fn fetch_list(&self) -> impl Future<Output = Result<String, AuthenticatorListError>> + Send {
        let list = self.0.lock().expect("no test panicked").clone();
        async move { Ok(list) }
    }
}

/// A caller's `DPoP` key, which signs the proofs its requests carry.
pub(crate) struct DpopKey(SigningKey);

impl DpopKey {
    /// A fresh P-256 key.
    pub(crate) fn generate() -> Self {
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).expect("the system's random source works");
        Self(SigningKey::from_slice(&secret).expect("32 random bytes are a P-256 key"))
    }

    /// The key's public JWK.
    pub(crate) fn jwk(&self) -> serde_json::Value {
        let point = self.0.verifying_key().to_sec1_point(false);
        let bytes = point.as_bytes();
        json!({
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(&bytes[1..33]),
            "y": URL_SAFE_NO_PAD.encode(&bytes[33..65]),
        })
    }

    /// A proof of `claims` under `header`, signed with this key.
    pub(crate) fn sign(&self, header: &serde_json::Value, claims: &serde_json::Value) -> String {
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let signature: Signature = self.0.sign(signed.as_bytes());
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    /// The header a proof by this key carries.
    pub(crate) fn header(&self) -> serde_json::Value {
        json!({ "typ": "dpop+jwt", "alg": "ES256", "jwk": self.jwk() })
    }

    /// A fresh proof for a POST to `path` now, with `ath` the hash of `access_token` when one is
    /// presented.
    pub(crate) fn prove(&self, path: &str, access_token: Option<&str>) -> String {
        self.sign(&self.header(), &build_proof_claims(path, access_token))
    }
}

/// The claims of a fresh proof for a POST to `path` now: a new `jti`, and `ath` the hash of
/// `access_token` when one is presented.
pub(crate) fn build_proof_claims(path: &str, access_token: Option<&str>) -> serde_json::Value {
    let mut claims = json!({
        "jti": mint_uuid_v7().to_string(),
        "htm": "POST",
        "htu": format!("{ORIGIN}{path}"),
        "iat": Timestamp::now().as_second(),
    });
    if let Some(access_token) = access_token {
        claims["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(access_token)));
    }
    claims
}

/// A POST of `body` as JSON to `path` with `headers`, from an address no other request uses, so
/// no test meets the sign-in routes' limit.
pub(crate) fn post(
    path: &str,
    body: &serde_json::Value,
    headers: &[(&str, &str)],
) -> Request<Body> {
    static NEXT_ADDRESS: AtomicU32 = AtomicU32::new(0x0a00_0001);
    let address = Ipv4Addr::from(NEXT_ADDRESS.fetch_add(1, Ordering::SeqCst));
    let mut request = Request::post(path).header(CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let mut request = request
        .body(Body::from(body.to_string()))
        .expect("the request builds");
    request
        .extensions_mut()
        .insert(SourceAddress(address.to_string()));
    request
        .extensions_mut()
        .insert(RequestId("ray-test".to_owned()));
    request
}

/// A sign-in's issued challenge: its transaction id and the challenge itself.
pub(crate) async fn issue_sign_in_challenge(router: &Router) -> (String, String) {
    let (status, _, body) = call(
        router,
        post("/webauthn.authenticationOptions.issue", &json!({}), &[]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["transactionId"].as_str().expect("an id").to_owned(),
        body["options"]["challenge"]
            .as_str()
            .expect("a challenge")
            .to_owned(),
    )
}

/// The body of a sign-in verify of `credential_id` under `transaction_id`, its assertion carrying
/// `user_handle`.
pub(crate) fn build_assertion(
    transaction_id: &str,
    credential_id: &str,
    user_handle: Option<&str>,
) -> serde_json::Value {
    let mut response = json!({
        "clientDataJSON": "AA",
        "authenticatorData": "AA",
        "signature": "AA",
    });
    if let Some(user_handle) = user_handle {
        response["userHandle"] = json!(user_handle);
    }
    json!({
        "transactionId": transaction_id,
        "response": {
            "id": credential_id,
            "rawId": credential_id,
            "type": "public-key",
            "clientExtensionResults": {},
            "response": response,
        },
    })
}

/// Signs `credential_id` in with `key` under a fresh challenge, the verifier answering
/// `new_counter`, and reads the reply.
pub(crate) async fn sign_in(
    relay: &Relay,
    router: &Router,
    key: &DpopKey,
    credential_id: &str,
    user_handle: &str,
    new_counter: u32,
) -> (StatusCode, HeaderMap, serde_json::Value) {
    relay
        .verifier
        .answer(&json!({ "verified": true, "newCounter": new_counter }));
    let (transaction_id, _) = issue_sign_in_challenge(router).await;
    let path = "/webauthn.authentication.verify";
    let proof = key.prove(path, None);
    let body = build_assertion(&transaction_id, credential_id, Some(user_handle));
    call(router, post(path, &body, &[("DPoP", &proof)])).await
}
