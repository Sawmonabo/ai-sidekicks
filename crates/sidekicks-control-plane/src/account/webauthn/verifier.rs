//! The passkey verifier seam: what a ceremony's verify leg hands the `WebAuthn` checks and what it
//! reads back. Both cross as JSON, `SimpleWebAuthn`'s own option and result shapes, so the Worker's
//! JavaScript module and any other host of the same library read the same text. A verdict is read
//! only once it says `verified: true`; every other answer, whatever else it carries, is a refusal.

use std::future::Future;

use serde::Serialize;
use serde::de::DeserializeOwned;
use sidekicks_contracts::trust_statement::{CoseAlgorithm, PasskeyId, PasskeyPublicKey};
use sidekicks_contracts::webauthn::ceremony::{
    Aaguid, AuthenticationResponse, RegistrationResponse,
};
use strum::VariantArray as _;

/// Runs the `WebAuthn` checks of a verify leg. Each call takes `SimpleWebAuthn`'s options as JSON
/// and answers its result as JSON; a call that cannot run at all fails, which the route answers as
/// a logged 500.
pub trait PasskeyVerifier: Clone + Send + Sync + 'static {
    /// Checks a new passkey's attestation against `check`, `verifyRegistrationResponse`'s options.
    fn verify_registration(
        &self,
        check: String,
    ) -> impl Future<Output = Result<String, VerifierError>> + Send;

    /// Checks a sign-in's assertion against `check`, `verifyAuthenticationResponse`'s options.
    fn verify_authentication(
        &self,
        check: String,
    ) -> impl Future<Output = Result<String, VerifierError>> + Send;
}

/// Why the verifier gave no verdict: it could not run, or its answer did not read.
#[derive(Debug, thiserror::Error)]
pub enum VerifierError {
    /// The verifier failed to run; its own words are kept.
    #[error("the passkey verifier failed: {0}")]
    Run(String),
    /// A verdict that says it verified did not carry what a verified one carries.
    #[error("the passkey verifier's verdict did not read")]
    Verdict(#[from] serde_json::Error),
}

/// The relying party a verify leg checks against: its id and the exact origins it accepts.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RelyingParty<'a> {
    /// The relying party id, the control plane's host.
    pub(crate) id: &'a str,
    /// Every origin a response may carry, compared exactly.
    pub(crate) origins: &'a [String],
}

/// A passkey the registration checks passed, as the verifier names it.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisteredPasskey {
    /// The credential id the attestation names.
    pub(crate) credential_id: PasskeyId,
    /// The COSE public key and its algorithm.
    pub(crate) public_key: PasskeyPublicKey,
    /// The authenticator's AAGUID.
    pub(crate) aaguid: Aaguid,
    /// The signature counter the authenticator started at.
    pub(crate) counter: u32,
}

/// What a verified sign-in reports.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedAssertion {
    /// The signature counter the assertion presented.
    pub(crate) new_counter: u32,
}

/// The stored passkey a sign-in is checked under.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StoredPasskey<'a> {
    /// The credential id.
    pub(crate) credential_id: &'a str,
    /// The COSE public key as base64url text.
    pub(crate) public_key: &'a str,
    /// The stored signature counter.
    pub(crate) counter: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationCheck<'a> {
    response: &'a RegistrationResponse,
    expected_challenge: &'a str,
    expected_origin: &'a [String],
    #[serde(rename = "expectedRPID")]
    expected_rp_id: &'a str,
    require_user_verification: bool,
    #[serde(rename = "supportedAlgorithmIDs")]
    supported_algorithm_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticationCheck<'a> {
    response: &'a AuthenticationResponse,
    expected_challenge: &'a str,
    expected_origin: &'a [String],
    #[serde(rename = "expectedRPID")]
    expected_rp_id: &'a str,
    credential: CredentialCheck<'a>,
    require_user_verification: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialCheck<'a> {
    id: &'a str,
    public_key: &'a str,
    counter: u32,
}

/// Checks `response` as a new passkey for `relying_party` under `challenge`, requiring user
/// verification and one of the three algorithms the options offer; `None` for any refusal.
pub(crate) async fn check_registration<V: PasskeyVerifier>(
    verifier: &V,
    response: &RegistrationResponse,
    challenge: &str,
    relying_party: RelyingParty<'_>,
) -> Result<Option<RegisteredPasskey>, VerifierError> {
    let check = RegistrationCheck {
        response,
        expected_challenge: challenge,
        expected_origin: relying_party.origins,
        expected_rp_id: relying_party.id,
        require_user_verification: true,
        supported_algorithm_ids: CoseAlgorithm::VARIANTS
            .iter()
            .map(|algorithm| algorithm.number())
            .collect(),
    };
    let verdict = verifier
        .verify_registration(serde_json::to_string(&check)?)
        .await?;
    read_verdict(&verdict)
}

/// Checks `response` as a sign-in with `passkey` for `relying_party` under `challenge`,
/// requiring user verification; `None` for any refusal.
pub(crate) async fn check_authentication<V: PasskeyVerifier>(
    verifier: &V,
    response: &AuthenticationResponse,
    challenge: &str,
    relying_party: RelyingParty<'_>,
    passkey: StoredPasskey<'_>,
) -> Result<Option<VerifiedAssertion>, VerifierError> {
    let check = AuthenticationCheck {
        response,
        expected_challenge: challenge,
        expected_origin: relying_party.origins,
        expected_rp_id: relying_party.id,
        credential: CredentialCheck {
            id: passkey.credential_id,
            public_key: passkey.public_key,
            counter: passkey.counter,
        },
        require_user_verification: true,
    };
    let verdict = verifier
        .verify_authentication(serde_json::to_string(&check)?)
        .await?;
    read_verdict(&verdict)
}

// Reads nothing of a verdict before its `verified` is exactly `true`: the library's result does
// not narrow on that flag, so a refused verdict may still carry figures.
fn read_verdict<T: DeserializeOwned>(verdict: &str) -> Result<Option<T>, VerifierError> {
    let verdict: serde_json::Value = serde_json::from_str(verdict)?;
    if verdict.get("verified") != Some(&serde_json::Value::Bool(true)) {
        return Ok(None);
    }
    Ok(Some(serde_json::from_value(verdict)?))
}

#[cfg(target_arch = "wasm32")]
pub(crate) use worker_verifier::WorkerPasskeyVerifier;

#[cfg(target_arch = "wasm32")]
mod worker_verifier {
    //! The Worker's verifier: `SimpleWebAuthn` in `js/passkey.mjs`, called through wasm-bindgen.

    use std::future::Future;

    use worker::js_sys::Promise;
    use worker::send::SendFuture;
    use worker::wasm_bindgen::prelude::*;
    use worker::wasm_bindgen_futures::JsFuture;

    use super::{PasskeyVerifier, VerifierError};

    #[wasm_bindgen(module = "/js/passkey.mjs")]
    extern "C" {
        #[wasm_bindgen(js_name = verifyRegistration)]
        fn verify_registration_in_module(check: &str) -> Promise;

        #[wasm_bindgen(js_name = verifyAuthentication)]
        fn verify_authentication_in_module(check: &str) -> Promise;
    }

    /// The Worker's passkey verifier.
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct WorkerPasskeyVerifier;

    impl PasskeyVerifier for WorkerPasskeyVerifier {
        fn verify_registration(
            &self,
            check: String,
        ) -> impl Future<Output = Result<String, VerifierError>> + Send {
            SendFuture::new(async move {
                read_promise_text(verify_registration_in_module(&check)).await
            })
        }

        fn verify_authentication(
            &self,
            check: String,
        ) -> impl Future<Output = Result<String, VerifierError>> + Send {
            SendFuture::new(async move {
                read_promise_text(verify_authentication_in_module(&check)).await
            })
        }
    }

    async fn read_promise_text(promise: Promise) -> Result<String, VerifierError> {
        let answer = JsFuture::from(promise)
            .await
            .map_err(|thrown| VerifierError::Run(format!("{thrown:?}")))?;
        answer
            .as_string()
            .ok_or_else(|| VerifierError::Run("the module answered no text".to_owned()))
    }
}
