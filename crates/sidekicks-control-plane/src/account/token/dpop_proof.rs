//! The `DPoP` proof checks (RFC 9449), one parser for both forms: a token request's proof (§5),
//! which carries no `ath`, and a resource request's (§4.3), whose `ath` hashes the access token it
//! comes with. A proof's `jti` is single-use while its `iat` window is open, recorded in
//! `dpop_proof_jtis`.

use axum::http::{HeaderMap, Method};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiff::Timestamp;
use jwt_simple::prelude::{ECDSAP256PublicKeyLike as _, ES256PublicKey};
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer};
use sha2::{Digest as _, Sha256};
use url::Url;

use crate::account_store::{AccountStore, AccountStoreError, SqlValue};

/// The header a proof travels in.
pub(crate) const DPOP_HEADER: &str = "DPoP";

/// How far a proof's `iat` may sit from the control plane's clock either way, in seconds; a
/// recorded `jti` is kept that long past its `iat`.
const PROOF_WINDOW_SECONDS: i64 = 60;

/// The longest proof read: a header with a P-256 key, a short payload and a signature fit in far
/// less.
const PROOF_MAX_BYTES: usize = 8192;

/// The longest `jti` kept; the service sends a UUID of 36 characters.
const JTI_MAX_BYTES: usize = 128;

/// Which proof a route takes.
#[derive(Clone, Copy, Debug)]
pub(crate) enum ProofForm<'a> {
    /// A request for a token: `ath` must be absent.
    TokenRequest,
    /// A request presenting `access_token`: `ath` must be its SHA-256.
    ResourceRequest {
        /// The access token the request presents.
        access_token: &'a str,
    },
}

/// A proof that passed every check but its `jti`'s single use, which [`record_proof_jti`]
/// decides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckedProof {
    /// The JWK SHA-256 thumbprint of the proof's key (RFC 7638), the `cnf.jkt` a token binds.
    pub(crate) jkt: String,
    /// The proof's id.
    pub(crate) jti: String,
    /// When the proof says it was made, in Unix seconds.
    pub(crate) issued_at: i64,
}

/// Why a proof was refused; every one answers `auth.dpopMismatch`, which names none of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProofFault {
    /// No `DPoP` header, or more than one.
    #[error("the request carries no single DPoP header")]
    NotOneHeader,
    /// The proof is not a compact JWS of a readable header and payload.
    #[error("the DPoP proof is not a well-formed JWT")]
    Malformed,
    /// `typ` is not `dpop+jwt` or `alg` not `ES256`.
    #[error("the DPoP proof's type or algorithm is not the one taken")]
    WrongType,
    /// The header names critical extensions, none of which this check understands.
    #[error("the DPoP proof's header carries crit")]
    CriticalExtension,
    /// The `jwk` is not a public P-256 key.
    #[error("the DPoP proof's key is not a public P-256 key")]
    BadKey,
    /// The signature does not verify under the `jwk`.
    #[error("the DPoP proof's signature does not verify")]
    BadSignature,
    /// `htm` or `htu` names another request.
    #[error("the DPoP proof was made for another request")]
    OtherRequest,
    /// `iat` is not a date an `i64` of seconds holds, or is outside the window.
    #[error("the DPoP proof's iat is outside the window")]
    OutsideWindow,
    /// `ath` is present on a token request, or absent or wrong on a resource request.
    #[error("the DPoP proof's ath does not fit the request")]
    WrongAth,
    /// The `jti` is missing or too long.
    #[error("the DPoP proof's jti is missing or too long")]
    BadJti,
}

#[derive(Deserialize)]
struct ProofHeader {
    typ: String,
    alg: String,
    jwk: serde_json::Map<String, serde_json::Value>,
    // RFC 7515 §4.1.11: a recipient refuses a critical extension it does not understand, and
    // this check understands none, so any `crit` member, `null` included, refuses the proof.
    #[serde(default, rename = "crit", deserialize_with = "read_presence")]
    has_crit: bool,
}

#[derive(Deserialize)]
struct ProofClaims {
    jti: String,
    htm: String,
    htu: String,
    // A NumericDate (RFC 7519 §2), which may carry a fraction.
    iat: serde_json::Number,
    #[serde(default)]
    ath: Option<String>,
}

/// Checks the request's one `DPoP` header as a proof of `form` for `method` at `target`, the
/// control plane's own origin with the request's path, at `now`; refuses with the first fault.
pub(crate) fn check_dpop_proof(
    headers: &HeaderMap,
    method: &Method,
    target: &Url,
    now: Timestamp,
    form: ProofForm<'_>,
) -> Result<CheckedProof, ProofFault> {
    let mut values = headers.get_all(DPOP_HEADER).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return Err(ProofFault::NotOneHeader);
    };
    if value.len() > PROOF_MAX_BYTES {
        return Err(ProofFault::Malformed);
    }
    let proof = value.to_str().map_err(|_error| ProofFault::Malformed)?;
    let mut parts = proof.split('.');
    let (Some(header_part), Some(payload_part), Some(signature_part), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ProofFault::Malformed);
    };
    let header: ProofHeader = read_part(header_part)?;
    if header.typ != "dpop+jwt" || header.alg != "ES256" {
        return Err(ProofFault::WrongType);
    }
    if header.has_crit {
        return Err(ProofFault::CriticalExtension);
    }
    let (verifying_key, jkt) = read_proof_key(&header.jwk)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_part)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or(ProofFault::BadSignature)?;
    let signed = &proof[..header_part.len() + 1 + payload_part.len()];
    verifying_key
        .verify(signed.as_bytes(), &signature)
        .map_err(|_error| ProofFault::BadSignature)?;

    let claims: ProofClaims = read_part(payload_part)?;
    if claims.jti.is_empty() || claims.jti.len() > JTI_MAX_BYTES {
        return Err(ProofFault::BadJti);
    }
    if claims.htm != method.as_str() || !is_same_target(&claims.htu, target) {
        return Err(ProofFault::OtherRequest);
    }
    let issued_at = read_numeric_date(&claims.iat).ok_or(ProofFault::OutsideWindow)?;
    if issued_at.abs_diff(now.as_second()) > PROOF_WINDOW_SECONDS.unsigned_abs() {
        return Err(ProofFault::OutsideWindow);
    }
    let is_ath_right = match form {
        ProofForm::TokenRequest => claims.ath.is_none(),
        ProofForm::ResourceRequest { access_token } => claims
            .ath
            .is_some_and(|ath| ath == URL_SAFE_NO_PAD.encode(Sha256::digest(access_token))),
    };
    if !is_ath_right {
        return Err(ProofFault::WrongAth);
    }
    Ok(CheckedProof {
        jkt,
        jti: claims.jti,
        issued_at,
    })
}

/// Records `proof`'s `jti` for its window inside the caller's step, first dropping every `jti`
/// whose window has closed at `now`; `Ok(false)` when the `jti` is already recorded, a replay.
pub(crate) fn record_proof_jti<S: AccountStore>(
    store: &S,
    proof: &CheckedProof,
    now: Timestamp,
) -> Result<bool, AccountStoreError> {
    store.execute(
        "DELETE FROM dpop_proof_jtis WHERE expires_at <= ?1",
        &[SqlValue::Integer(now.as_second())],
    )?;
    let recorded: Vec<serde_json::Value> = store.query(
        "INSERT INTO dpop_proof_jtis (jti, expires_at) VALUES (?1, ?2) \
         ON CONFLICT(jti) DO NOTHING RETURNING jti",
        &[
            SqlValue::Text(proof.jti.clone()),
            SqlValue::Integer(proof.issued_at + PROOF_WINDOW_SECONDS),
        ],
    )?;
    Ok(!recorded.is_empty())
}

// The proof's public key and its RFC 7638 thumbprint. `from_jwk` refuses a private member,
// another key type or curve, a coordinate not 32 bytes and an oversized key; the point is checked
// on the curve.
fn read_proof_key(
    jwk: &serde_json::Map<String, serde_json::Value>,
) -> Result<(VerifyingKey, String), ProofFault> {
    let jwk = serde_json::to_string(jwk).map_err(|_error| ProofFault::BadKey)?;
    let key = ES256PublicKey::from_jwk(&jwk).map_err(|_error| ProofFault::BadKey)?;
    let verifying_key = VerifyingKey::from_sec1_bytes(&key.public_key().to_bytes_uncompressed())
        .map_err(|_error| ProofFault::BadKey)?;
    Ok((verifying_key, key.jwk_thumbprint()))
}

// Reads a member's presence, whatever its value.
fn read_presence<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    IgnoredAny::deserialize(deserializer)?;
    Ok(true)
}

// A NumericDate as whole seconds, its fraction floored; `None` for one no `i64` holds.
fn read_numeric_date(date: &serde_json::Number) -> Option<i64> {
    if let Some(seconds) = date.as_i64() {
        return Some(seconds);
    }
    let seconds = date.as_f64()?.floor();
    // -2^63 and 2^63 are exact in an f64; a value outside them, or not a number, is refused.
    let bound = 2_f64.powi(63);
    if !(-bound..bound).contains(&seconds) {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the value is whole and inside the i64 range, checked just before"
    )]
    let whole = seconds as i64;
    Some(whole)
}

fn read_part<T: serde::de::DeserializeOwned>(part: &str) -> Result<T, ProofFault> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_error| ProofFault::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_error| ProofFault::Malformed)
}

// RFC 9449 §4.3: the proof's `htu` matches the request's URI with query and fragment ignored,
// after syntax- and scheme-based normalization, which `url`'s parse applies.
fn is_same_target(htu: &str, target: &Url) -> bool {
    Url::parse(htu).is_ok_and(|htu| {
        htu.scheme() == target.scheme()
            && htu.host_str() == target.host_str()
            && htu.port_or_known_default() == target.port_or_known_default()
            && htu.path() == target.path()
    })
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use serde_json::json;

    use super::{CheckedProof, read_proof_key, record_proof_jti};
    use crate::account_store::{AccountStore, open_account_file};

    #[test]
    fn a_proof_key_reads_with_its_rfc_9449_thumbprint() {
        // RFC 9449's example key, whose thumbprint its section 6.1 gives.
        let jwk = json!({
            "kty": "EC",
            "x": "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
            "y": "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA",
            "crv": "P-256",
        });
        let (_, jkt) = read_proof_key(jwk.as_object().unwrap()).unwrap();
        assert_eq!(jkt, "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I");
    }

    #[test]
    fn a_jti_past_its_window_is_gone_after_the_next_record() {
        let folder = tempfile::tempdir().unwrap();
        let store = open_account_file(&folder.path().join("account.sqlite")).unwrap();
        let proof = |jti: &str, issued_at: i64| CheckedProof {
            jkt: "key".to_owned(),
            jti: jti.to_owned(),
            issued_at,
        };
        let record = |checked: &CheckedProof, now: i64| {
            store.write_step(|step| {
                record_proof_jti(step, checked, Timestamp::from_second(now).unwrap())
            })
        };
        assert!(record(&proof("old", 1_000), 1_000).unwrap());
        assert!(
            !record(&proof("old", 1_000), 1_030).unwrap(),
            "a replay inside the window is refused"
        );
        assert!(record(&proof("new", 1_061), 1_061).unwrap());
        let left: Vec<serde_json::Value> =
            store.query("SELECT jti FROM dpop_proof_jtis", &[]).unwrap();
        assert_eq!(left, vec![serde_json::json!({ "jti": "new" })]);
    }
}
