//! The `DPoP` proofs (RFC 9449) the daemon signs, and the send that signs one request to an
//! authorization server.
//!
//! - A proof is a JWS assembled here, not by `jwt-simple`, whose header can carry the key only as
//!   a string where the RFC asks for a JWK object. Its header is `{typ, alg, jwk}` with the public
//!   JWK alone; its claims bind the request's method and target, with no query or fragment, and,
//!   on a resource request, the token's hash. The signature is the 64-byte `r‖s` a JWS takes,
//!   never DER.
//! - An authorization server that wants proofs bound to its nonce answers 400 with the error
//!   `use_dpop_nonce` and the nonce in `DPoP-Nonce`; the send keeps the last nonce any response
//!   carried in a slot its caller owns, and sends the request once more with that nonce.

use std::sync::Mutex;
use std::time::{SystemTime, SystemTimeError};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::{Bytes, BytesMut};
use futures::StreamExt as _;
use jwt_simple::prelude::{ES256KeyPair, ES256PublicKey};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use reqwest::header::HeaderMap;
use reqwest::{Method, RequestBuilder, StatusCode, Url};
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::dpop::{
    DPOP_NONCE_HEADER_NAME, DPOP_PROOF_ALGORITHM, DPOP_PROOF_HEADER_NAME, DPOP_PROOF_TYPE,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::random_hex::random_hex;

/// The most bytes of an authorization server's response body the send reads, rmcp's own bound
/// for its OAuth calls.
const MAX_RESPONSE_BODY_BYTES: usize = 1024 * 1024;

/// The random bytes in a proof's `jti`, written as twice as many hex digits.
const JTI_BYTE_COUNT: usize = 16;

/// The error an authorization server answers when it wants a proof bound to its nonce.
const USE_DPOP_NONCE: &str = "use_dpop_nonce";

/// A P-256 key that signs `DPoP` proofs: one per sign-in attempt, never the machine's key. It is
/// kept as its 32-byte scalar ([`DpopKey::to_scalar`]), with its public JWK and that JWK's RFC 7638
/// thumbprint made once. It has no `Debug`, so no print shows the scalar.
pub struct DpopKey {
    signing_key: SigningKey,
    /// The public JWK, with no private member.
    jwk: Value,
    thumbprint: String,
}

impl DpopKey {
    /// A fresh key from the system's secure random source.
    pub fn generate() -> Self {
        let scalar = ES256KeyPair::generate().to_bytes();
        let signing_key =
            SigningKey::from_slice(&scalar).expect("a fresh key pair's scalar is a P-256 key");
        Self::from_signing_key(signing_key)
    }

    /// The key whose scalar is `scalar`, as [`DpopKey::to_scalar`] wrote it. Fails when the bytes
    /// are not a P-256 scalar.
    pub fn from_scalar(scalar: &[u8; 32]) -> Result<Self, DpopKeyError> {
        let signing_key = SigningKey::from_slice(scalar).map_err(DpopKeyError)?;
        Ok(Self::from_signing_key(signing_key))
    }

    /// The key's 32-byte scalar, the form it is kept in.
    pub fn to_scalar(&self) -> [u8; 32] {
        self.signing_key.to_bytes().into()
    }

    /// The RFC 7638 thumbprint of the key's public JWK, base64url: the `dpop_jkt` an authorization
    /// request binds its code to.
    pub fn thumbprint(&self) -> &str {
        &self.thumbprint
    }

    // The key with its public JWK and thumbprint, both from `jwt-simple`'s export, which writes the
    // public members alone.
    fn from_signing_key(signing_key: SigningKey) -> Self {
        let point = signing_key.verifying_key().to_sec1_point(false);
        let public_key = ES256PublicKey::from_bytes(point.as_bytes())
            .expect("a P-256 key's own point is a P-256 public key");
        let jwk = serde_json::from_str(&public_key.to_jwk())
            .expect("jwt-simple writes a JWK as a JSON object");
        Self {
            signing_key,
            jwk,
            thumbprint: public_key.jwk_thumbprint(),
        }
    }
}

/// Why kept bytes are no `DPoP` key: they are not a P-256 scalar.
#[derive(Debug, thiserror::Error)]
#[error("the kept DPoP key is not a P-256 scalar")]
pub struct DpopKeyError(#[source] p256::ecdsa::Error);

/// Why a proof could not be made.
#[derive(Debug, thiserror::Error)]
pub enum DpopProofError {
    /// The system clock reads before 1970, so the proof's `iat` cannot be written.
    #[error("the system clock reads before 1970, so a DPoP proof's time cannot be written")]
    Clock(#[from] SystemTimeError),
    /// The system gave no random bytes for the proof's `jti`.
    #[error("the system gave no random bytes for a DPoP proof's id")]
    Random(#[from] getrandom::Error),
}

/// The proof for one request of `method` to `target`, signed with `key`: `htu` is `target` with
/// no query or fragment, `ath` the base64url SHA-256 of `access_token` when one is presented, and
/// `nonce` the server's nonce when it sent one. Fails when the clock or the random source fails.
pub fn make_proof(
    key: &DpopKey,
    method: &Method,
    target: &Url,
    access_token: Option<&str>,
    nonce: Option<&str>,
) -> Result<String, DpopProofError> {
    let mut htu = target.clone();
    htu.set_query(None);
    htu.set_fragment(None);
    let issued_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_secs();
    let mut claims = Map::new();
    claims.insert("jti".to_owned(), random_hex(JTI_BYTE_COUNT)?.into());
    claims.insert("htm".to_owned(), method.as_str().into());
    claims.insert("htu".to_owned(), htu.as_str().into());
    claims.insert("iat".to_owned(), issued_at.into());
    if let Some(access_token) = access_token {
        let ath = URL_SAFE_NO_PAD.encode(Sha256::digest(access_token));
        claims.insert("ath".to_owned(), ath.into());
    }
    if let Some(nonce) = nonce {
        claims.insert("nonce".to_owned(), nonce.into());
    }
    let mut header = Map::new();
    header.insert("typ".to_owned(), DPOP_PROOF_TYPE.into());
    header.insert("alg".to_owned(), DPOP_PROOF_ALGORITHM.into());
    header.insert("jwk".to_owned(), key.jwk.clone());
    let signed = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(Value::Object(header).to_string()),
        URL_SAFE_NO_PAD.encode(Value::Object(claims).to_string())
    );
    let signature: Signature = key.signing_key.sign(signed.as_bytes());
    Ok(format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

/// An authorization server's whole answer to a signed request, its body read to the end.
pub struct AuthorizationServerResponse {
    /// The response's status.
    pub status: StatusCode,
    /// The response's headers.
    pub headers: HeaderMap,
    /// The response's body, at most 1 MiB.
    pub body: Bytes,
}

/// Why a signed request to an authorization server got no response.
#[derive(Debug, thiserror::Error)]
pub enum DpopSendError {
    /// The request's proof could not be made.
    #[error("the request's DPoP proof could not be made")]
    Proof(#[from] DpopProofError),
    /// The request failed on the network, or its body could not be read.
    #[error("the request to the authorization server failed")]
    Http(#[from] reqwest::Error),
    /// The response's body is past the bound.
    #[error("the authorization server's response body is past {max_bytes} bytes")]
    BodyTooLarge {
        /// The bound, in bytes.
        max_bytes: usize,
    },
}

/// Sends a request of `method` to `target` over `http` with a proof signed by `key` and bound to
/// the nonce in `nonce`, `finish` adding the request's own headers and body; it adds no
/// `Authorization`, as an authorization server's calls carry no access token. Every `DPoP-Nonce` a
/// response carries replaces the slot's nonce; a 400 `use_dpop_nonce` that carries one is sent
/// once more, bound to it, and a second such answer comes back as it is. Fails as the proof, the
/// network or the body's bound fails.
pub async fn send_signed(
    http: &reqwest::Client,
    key: &DpopKey,
    nonce: &Mutex<Option<String>>,
    method: Method,
    target: &Url,
    finish: impl Fn(RequestBuilder) -> RequestBuilder,
) -> Result<AuthorizationServerResponse, DpopSendError> {
    let mut is_resent = false;
    loop {
        let sent_nonce = lock(nonce).clone();
        let proof = make_proof(key, &method, target, None, sent_nonce.as_deref())?;
        let request = http
            .request(method.clone(), target.clone())
            .header(DPOP_PROOF_HEADER_NAME, proof);
        let response = read_response(finish(request).send().await?).await?;
        let received_nonce = response
            .headers
            .get(DPOP_NONCE_HEADER_NAME)
            .and_then(|received| received.to_str().ok())
            .map(str::to_owned);
        let has_nonce = received_nonce.is_some();
        if let Some(received_nonce) = received_nonce {
            *lock(nonce) = Some(received_nonce);
        }
        if is_resent || !has_nonce || !asks_for_dpop_nonce(&response) {
            return Ok(response);
        }
        is_resent = true;
    }
}

// The whole of `response`, its body read to the end within the bound.
async fn read_response(
    response: reqwest::Response,
) -> Result<AuthorizationServerResponse, DpopSendError> {
    let status = response.status();
    let headers = response.headers().clone();
    let mut body = BytesMut::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        if chunk.len() > MAX_RESPONSE_BODY_BYTES - body.len() {
            return Err(DpopSendError::BodyTooLarge {
                max_bytes: MAX_RESPONSE_BODY_BYTES,
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(AuthorizationServerResponse {
        status,
        headers,
        body: body.freeze(),
    })
}

// Whether `response` is a 400 whose JSON body's `error` is `use_dpop_nonce` (RFC 9449 §8).
fn asks_for_dpop_nonce(response: &AuthorizationServerResponse) -> bool {
    response.status == StatusCode::BAD_REQUEST
        && serde_json::from_slice::<Value>(&response.body)
            .is_ok_and(|body| body.get("error").and_then(Value::as_str) == Some(USE_DPOP_NONCE))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse as _, Response};
    use axum::routing::post;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use jwt_simple::prelude::{ECDSAP256PublicKeyLike as _, ES256PublicKey};
    use p256::ecdsa::signature::Verifier as _;
    use p256::ecdsa::{Signature, VerifyingKey};
    use reqwest::{Method, Url};
    use serde_json::{Value, json};
    use sha2::{Digest as _, Sha256};
    use sidekicks_std::mutex_lock::lock;

    use super::{DpopKey, make_proof, send_signed};

    fn decode_part(part: &str) -> Value {
        let bytes = URL_SAFE_NO_PAD.decode(part).expect("a base64url part");
        serde_json::from_slice(&bytes).expect("a JSON part")
    }

    // The nonce claim of the proof in `headers`, `None` when the proof names none.
    fn proof_nonce(headers: &HeaderMap) -> Option<String> {
        let proof = headers
            .get("dpop")
            .and_then(|proof| proof.to_str().ok())
            .expect("a request carries one proof");
        let claims = proof.split('.').nth(1).expect("a proof has claims");
        decode_part(claims)["nonce"].as_str().map(str::to_owned)
    }

    // Mutation: in `make_proof`, keep `target`'s query in `htu`; put the JWK in the header as a
    // string; or put the key pair's own JWK, its private `d` included, in the header. Each fails an
    // assertion below.
    #[test]
    fn a_proof_carries_the_public_jwk_and_binds_its_request() {
        let key = DpopKey::generate();
        let target = Url::parse("https://issuer.test/token?prompt=none#step").expect("a URL");
        let proof = make_proof(
            &key,
            &Method::POST,
            &target,
            Some("access-7f3a"),
            Some("n0"),
        )
        .expect("a proof");
        let parts: Vec<&str> = proof.split('.').collect();
        let [header_part, claims_part, signature_part] = parts[..] else {
            panic!("a proof has three parts");
        };

        let header = decode_part(header_part);
        assert_eq!(header["typ"], "dpop+jwt");
        assert_eq!(header["alg"], "ES256");
        let jwk = header["jwk"].as_object().expect("the jwk is a JSON object");
        assert!(!jwk.contains_key("d"), "the jwk carries no private member");
        let public_key =
            ES256PublicKey::from_jwk(&header["jwk"].to_string()).expect("a public P-256 JWK");
        assert_eq!(public_key.jwk_thumbprint(), key.thumbprint());
        let verifying_key =
            VerifyingKey::from_sec1_bytes(&public_key.public_key().to_bytes_uncompressed())
                .expect("a P-256 point");
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(signature_part)
            .expect("a base64url signature");
        let signature = Signature::from_slice(&signature_bytes).expect("a 64-byte r‖s signature");
        verifying_key
            .verify(
                format!("{header_part}.{claims_part}").as_bytes(),
                &signature,
            )
            .expect("the signature verifies under the header's key");

        let claims = decode_part(claims_part);
        assert_eq!(claims["htm"], "POST");
        assert_eq!(claims["htu"], "https://issuer.test/token");
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(Sha256::digest("access-7f3a"))
        );
        assert_eq!(claims["nonce"], "n0");
        assert!(claims["jti"].as_str().is_some_and(|jti| !jti.is_empty()));
        assert!(claims["iat"].is_u64());

        let bare = make_proof(&key, &Method::GET, &target, None, None).expect("a proof");
        let bare_claims = decode_part(bare.split('.').nth(1).expect("a proof has claims"));
        assert!(bare_claims.get("ath").is_none() && bare_claims.get("nonce").is_none());
    }

    // Mutation: in `send_signed`, resend without the nonce the 400 carried, or resend on every
    // `use_dpop_nonce`; the server's record then shows a resend with no nonce, or a third request.
    #[tokio::test]
    async fn a_nonce_refusal_brings_one_resend_bound_to_its_nonce() {
        let seen_nonces: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let recorded = Arc::clone(&seen_nonces);
        let router = Router::new().route(
            "/token",
            post(move |headers: HeaderMap| async move {
                let count = {
                    let mut seen = lock(&recorded);
                    seen.push(proof_nonce(&headers));
                    seen.len()
                };
                // Past two requests the server answers success, so a third shows as a 200.
                if count > 2 {
                    return StatusCode::OK.into_response();
                }
                Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header("dpop-nonce", "n1")
                    .header("content-type", "application/json")
                    .body(json!({ "error": "use_dpop_nonce" }).to_string().into())
                    .expect("a response")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        let target = Url::parse(&format!("http://{address}/token")).expect("a URL");
        let key = DpopKey::generate();
        let nonce = Mutex::new(None);

        let response = send_signed(
            &reqwest::Client::new(),
            &key,
            &nonce,
            Method::POST,
            &target,
            |request| request.body("grant_type=authorization_code"),
        )
        .await
        .expect("a response");

        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_slice::<Value>(&response.body).expect("a JSON body")["error"],
            "use_dpop_nonce"
        );
        assert_eq!(*lock(&seen_nonces), [None, Some("n1".to_owned())]);
        assert_eq!(lock(&nonce).as_deref(), Some("n1"));
    }
}
