//! The credentials the daemon puts on its own control-plane calls: the provider that mints them
//! for one request, the request they are minted for, the headers it hands back, and the check
//! that refuses headers which would not carry a DPoP-bound token.
//!
//! The calls use `DPoP`, not a bearer token. A bearer token works for anyone who holds it, so a
//! logged header, a proxy buffer or a crash dump would hand out something replayable; `DPoP` binds
//! the token to a key the sender proves it holds on every request. Two headers travel together,
//! both the provider's to produce:
//!
//! - `Authorization: DPoP <token>`. `Bearer` is no other spelling of it: a server that accepts the
//!   token under `Bearer` skips the proof check.
//! - `DPoP: <proof>`, a proof made for one request, binding its method (`htm`), its target URI
//!   (`htu`) and a hash of the token.
//!
//! The token's claims, the proof's contents, the key's custody and the server's nonce exchange
//! are the provider's; what is fixed here is the operation, the two header names and the scheme.

use std::error::Error;

use futures::future::BoxFuture;
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::SessionId;
use url::Url;

/// The header carrying the per-request `DPoP` proof; header names are case-insensitive, so it is
/// held in the lowercase form `HeaderMap` keys by.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's signed control-plane calls (a push notice, the account services, \
                  the machine's registration and its certificate challenge) \
                  check the proof header through it"
    )
)]
pub(crate) const DPOP_PROOF_HEADER_NAME: HeaderName = HeaderName::from_static("dpop");

/// The `Authorization` scheme of a DPoP-bound token; `Bearer` is refused.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's signed control-plane calls (a push notice, the account services, \
                  the machine's registration and its certificate challenge) \
                  check the scheme through it"
    )
)]
pub(crate) const DPOP_AUTHORIZATION_SCHEME: &str = "DPoP";

/// The request a credential is minted for: the session and machine scope the authority claimed, and
/// the method and URI are the ones the proof binds.
#[expect(
    dead_code,
    reason = "the daemon's signed control-plane calls (a push notice, the account services, \
              the machine's registration and its certificate challenge) \
              mint their credentials with it"
)]
pub(crate) struct DaemonCredentialAttempt {
    /// The session this call is about.
    pub(crate) session_id: SessionId,
    /// The calling daemon's machine, the identity the control plane attributes the write to.
    pub(crate) machine_id: MachineId,
    /// The method of the request these headers will travel on.
    pub(crate) htm: Method,
    /// The absolute URI of that same request, with no query and no fragment; a mismatch produces
    /// headers the control plane refuses.
    pub(crate) htu: Url,
}

/// The headers a provider hands back to merge into the outbound request, a map so a provider can
/// add more (a nonce echo) without a signature change. Every value is marked sensitive, so no
/// debug print or log shows it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's signed control-plane calls (a push notice, the account services, \
                  the machine's registration and its certificate challenge) \
                  receive their headers in it"
    )
)]
pub(crate) struct DaemonCredentialMaterial {
    headers: HeaderMap,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's signed control-plane calls (a push notice, the account services, \
                  the machine's registration and its certificate challenge) \
                  build and read it"
    )
)]
impl DaemonCredentialMaterial {
    /// The material of `headers`, each value marked sensitive here, so no provider can forget to.
    pub(crate) fn new(mut headers: HeaderMap) -> Self {
        for value in headers.values_mut() {
            value.set_sensitive(true);
        }
        Self { headers }
    }

    /// The headers to merge into the outbound request.
    pub(crate) fn headers(&self) -> &HeaderMap {
        &self.headers
    }
}

/// Mints the outbound credential headers for one control-plane call. It is called once per
/// attempt, inside the retry loop: a proof is bound to one request, so a retry needs a new one.
#[expect(
    dead_code,
    reason = "the daemon's signed control-plane calls (a push notice, the account services, \
              the machine's registration and its certificate challenge) \
              mint their credentials through it"
)]
pub(crate) trait DaemonCredentialProvider: Send + Sync {
    /// The headers for `attempt`; fails when the provider cannot mint them.
    fn mint_for_attempt(
        &self,
        attempt: DaemonCredentialAttempt,
    ) -> BoxFuture<'_, Result<DaemonCredentialMaterial, Box<dyn Error + Send + Sync>>>;
}

/// Why credential material would not carry a DPoP-bound token. No message holds any part of a
/// header's value, not even its scheme, since a caller may log or store the error.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's signed control-plane calls (a push notice, the account services, \
                  the machine's registration and its certificate challenge) \
                  refuse their headers with it"
    )
)]
#[derive(Debug, thiserror::Error)]
pub(crate) enum DpopCredentialRefusal {
    /// No `Authorization` header, or an empty one.
    #[error(
        "the credential provider returned no Authorization header: the control-plane call is an \
         authenticated write, and an unauthenticated attempt would surface as a generic \
         control-plane 401 naming the wrong cause"
    )]
    MissingAuthorization,
    /// An `Authorization` header with no space after a scheme.
    #[error(
        "the credential provider returned an Authorization header with no scheme separator, so \
         it names no scheme and carries no token (`{scheme} <token>` is required); the value is \
         withheld, since such a header is most often the bare token",
        scheme = DPOP_AUTHORIZATION_SCHEME
    )]
    NoSchemeSeparator,
    /// An `Authorization` scheme other than `DPoP`, `Bearer` among them.
    #[error(
        "the credential provider returned an Authorization header that is not \
         {scheme}-schemed: a bearer credential on this path is replayable by anyone who reads it \
         from a log, a proxy buffer or a crash dump; the scheme is withheld, since it is a prefix \
         of a credential",
        scheme = DPOP_AUTHORIZATION_SCHEME
    )]
    NotDpopScheme,
    /// A `DPoP` scheme with no token after it.
    #[error(
        "the credential provider returned a bare {scheme} Authorization scheme with no \
         token after it: an empty credential would surface as a generic control-plane 401 naming \
         the wrong cause",
        scheme = DPOP_AUTHORIZATION_SCHEME
    )]
    BareScheme,
    /// A DPoP-schemed token with no proof header, or an empty one.
    #[error(
        "the credential provider returned a {scheme}-schemed token with no {scheme} proof \
         header: without the proof the token is a bearer token in practice while claiming \
         otherwise",
        scheme = DPOP_AUTHORIZATION_SCHEME
    )]
    MissingProof,
}

/// Refuses material that would not carry a DPoP-bound token: a missing, bare or non-`DPoP`
/// `Authorization` header, or a missing proof. It cannot check the token's form, nor that the
/// proof binds the request's method, URI and token.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's signed control-plane calls (a push notice, the account services, \
                  the machine's registration and its certificate challenge) \
                  check each minted credential with it"
    )
)]
pub(crate) fn check_dpop_credential_material(
    material: &DaemonCredentialMaterial,
) -> Result<(), DpopCredentialRefusal> {
    let headers = material.headers();
    let authorization = headers
        .get(AUTHORIZATION)
        .map(HeaderValue::as_bytes)
        .filter(|value| !value.is_empty())
        .ok_or(DpopCredentialRefusal::MissingAuthorization)?;
    // Nothing below copies `authorization` or a slice of it into a refusal.
    let separator = authorization
        .iter()
        .position(|&byte| byte == b' ')
        .ok_or(DpopCredentialRefusal::NoSchemeSeparator)?;
    let (scheme, after_scheme) = authorization.split_at(separator);
    // Scheme names are case-insensitive, so `dpop` passes; the token is left as it is.
    if !scheme.eq_ignore_ascii_case(DPOP_AUTHORIZATION_SCHEME.as_bytes()) {
        return Err(DpopCredentialRefusal::NotDpopScheme);
    }
    // A scheme with nothing after it passes the checks above while carrying no credential.
    if after_scheme.trim_ascii().is_empty() {
        return Err(DpopCredentialRefusal::BareScheme);
    }
    match headers.get(DPOP_PROOF_HEADER_NAME) {
        Some(proof) if !proof.as_bytes().is_empty() => Ok(()),
        Some(_) | None => Err(DpopCredentialRefusal::MissingProof),
    }
}

#[cfg(test)]
mod tests {
    use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
    use rstest::rstest;

    use super::{
        DPOP_PROOF_HEADER_NAME, DaemonCredentialMaterial, DpopCredentialRefusal,
        check_dpop_credential_material,
    };

    // The token every case carries somewhere, and a scheme no refusal names.
    const TOKEN: &str = "sekrit";
    const FOREIGN_SCHEME: &str = "Xauth7f3a";

    #[rstest]
    #[case::not_dpop(
        Some("Xauth7f3a sekrit-7f3a"),
        Some("proof-7f3a"),
        Some(DpopCredentialRefusal::NotDpopScheme),
        &[TOKEN, FOREIGN_SCHEME],
    )]
    #[case::no_separator(
        Some("sekrit-7f3a"),
        Some("proof-7f3a"),
        Some(DpopCredentialRefusal::NoSchemeSeparator),
        &[TOKEN, FOREIGN_SCHEME],
    )]
    #[case::bare_scheme(
        Some("DPoP "),
        Some("sekrit-7f3a"),
        Some(DpopCredentialRefusal::BareScheme),
        &[TOKEN],
    )]
    #[case::no_proof(
        Some("DPoP sekrit-7f3a"),
        None,
        Some(DpopCredentialRefusal::MissingProof),
        &[TOKEN],
    )]
    #[case::no_authorization(
        None,
        Some("sekrit-7f3a"),
        Some(DpopCredentialRefusal::MissingAuthorization),
        &[TOKEN, FOREIGN_SCHEME],
    )]
    #[case::lowercase_scheme(Some("dpop sekrit-7f3a"), Some("proof-7f3a"), None, &[])]
    fn no_credential_refusal_echoes_the_header(
        #[case] authorization: Option<&'static str>,
        #[case] proof: Option<&'static str>,
        #[case] expected_refusal: Option<DpopCredentialRefusal>,
        #[case] withheld: &[&str],
    ) {
        let mut headers = HeaderMap::new();
        if let Some(authorization) = authorization {
            headers.insert(AUTHORIZATION, HeaderValue::from_static(authorization));
        }
        if let Some(proof) = proof {
            headers.insert(DPOP_PROOF_HEADER_NAME, HeaderValue::from_static(proof));
        }

        let checked = check_dpop_credential_material(&DaemonCredentialMaterial::new(headers));

        match expected_refusal {
            None => assert!(checked.is_ok()),
            Some(expected_refusal) => {
                let refusal = checked.expect_err("the material is refused");
                let message = refusal.to_string();
                assert_eq!(
                    std::mem::discriminant(&refusal),
                    std::mem::discriminant(&expected_refusal)
                );
                for text in withheld {
                    assert!(!message.contains(text), "{message:?} echoes {text:?}");
                }
            }
        }
    }
}
