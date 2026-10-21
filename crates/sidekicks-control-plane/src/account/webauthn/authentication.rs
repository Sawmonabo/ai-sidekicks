//! The authentication ceremony: a passkey signs a caller in. The issue leg records a challenge,
//! made from a statement's hash when a passkey is to sign one; the verify leg checks the request's
//! `DPoP` proof before anything is read, reads the challenge and the passkey, checks the assertion,
//! then in one step consumes the challenge, advances the passkey's counter and issues a token
//! pair bound to the proof's key. Every failed check of the passkey answers the one opaque
//! refusal.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, Method, Uri};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::webauthn::ceremony::{
    AuthenticationOptions, CEREMONY_TIMEOUT_MS, Required,
    WebAuthnAuthenticationOptionsIssueRequest, WebAuthnAuthenticationOptionsIssueResponse,
    WebAuthnAuthenticationVerifyRequest, WebAuthnAuthenticationVerifyResponse,
};

use crate::account::settings::AccountSettings;
use crate::account::token::dpop_proof::{ProofForm, check_dpop_proof, record_proof_jti};
use crate::account::token::issuer::{TokenPair, issue_token_pair};
use crate::account::user_record::read_user;
use crate::account::webauthn::challenge::{
    Ceremony, consume_challenge, issue_challenge, read_challenge,
};
use crate::account::webauthn::credential::{StoredCredential, advance_counter, read_credential};
use crate::account::webauthn::verifier::{
    PasskeyVerifier, RelyingParty, StoredPasskey, check_authentication,
};
use crate::account::{AccountRoutes, RouteOutcome, settle};
use crate::account_store::SharedAccountStore;
use crate::server::received_json::ReceivedJson;
use crate::server::router::{AuthenticationFault, ControlPlaneRefusal, RequestId};

/// Records a sign-in challenge and answers its options with the control plane's origin and, for
/// a statement a passkey is to sign, the nonce the challenge was made from.
pub(crate) async fn issue_authentication_options<S, V, L>(
    State(routes): State<AccountRoutes<S, V, L>>,
    request_id: Option<Extension<RequestId>>,
    ReceivedJson(request): ReceivedJson<WebAuthnAuthenticationOptionsIssueRequest>,
) -> Result<Json<WebAuthnAuthenticationOptionsIssueResponse>, ControlPlaneRefusal>
where
    S: SharedAccountStore,
{
    let request_id = request_id.map(|Extension(request_id)| request_id);
    let settings = routes.read_settings(request_id.as_ref())?;
    let outcome = compose_authentication_options(&routes, &settings, request).await;
    settle(request_id.as_ref(), outcome).map(Json)
}

async fn compose_authentication_options<S, V, L>(
    routes: &AccountRoutes<S, V, L>,
    settings: &AccountSettings,
    request: WebAuthnAuthenticationOptionsIssueRequest,
) -> RouteOutcome<WebAuthnAuthenticationOptionsIssueResponse>
where
    S: SharedAccountStore,
{
    let now = (routes.clock)()?;
    let statement_hash = request.statement_hash;
    let issued = routes
        .store
        .run_step(move |store| {
            issue_challenge(
                store,
                Ceremony::Authentication,
                None,
                statement_hash.as_ref(),
                now,
            )
        })
        .await?;
    Ok(Ok(WebAuthnAuthenticationOptionsIssueResponse {
        transaction_id: issued.transaction_id,
        origin: settings.origin_text.clone(),
        options: AuthenticationOptions {
            challenge: issued.challenge,
            rp_id: settings.relying_party_id.clone(),
            timeout: CEREMONY_TIMEOUT_MS,
            user_verification: Required::Value,
        },
        challenge_nonce: issued.nonce,
    }))
}

/// Verifies a sign-in under its challenge and answers the account with a token pair bound to the
/// key of the request's `DPoP` proof, the token-request form, which carries no `ath`.
pub(crate) async fn verify_authentication<S, V, L>(
    State(routes): State<AccountRoutes<S, V, L>>,
    request_id: Option<Extension<RequestId>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ReceivedJson(request): ReceivedJson<WebAuthnAuthenticationVerifyRequest>,
) -> Result<Json<WebAuthnAuthenticationVerifyResponse>, ControlPlaneRefusal>
where
    S: SharedAccountStore,
    V: PasskeyVerifier,
{
    let request_id = request_id.map(|Extension(request_id)| request_id);
    let settings = routes.read_settings(request_id.as_ref())?;
    let proof_request = ProofRequest {
        method: &method,
        uri: &uri,
        headers: &headers,
    };
    let outcome = sign_in(&routes, settings, proof_request, request).await;
    let (user_id, pair) = settle(request_id.as_ref(), outcome)?;
    Ok(Json(WebAuthnAuthenticationVerifyResponse {
        user_id,
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
    }))
}

/// The parts of a request its `DPoP` proof is checked against.
#[derive(Clone, Copy)]
struct ProofRequest<'a> {
    method: &'a Method,
    uri: &'a Uri,
    headers: &'a HeaderMap,
}

/// The passkey a sign-in names and the user holding it, read before the assertion is checked.
struct PasskeyHolder {
    credential: StoredCredential,
    user_id: UserId,
    identity_ref: String,
}

async fn sign_in<S, V, L>(
    routes: &AccountRoutes<S, V, L>,
    settings: Arc<AccountSettings>,
    proof_request: ProofRequest<'_>,
    request: WebAuthnAuthenticationVerifyRequest,
) -> RouteOutcome<(UserId, TokenPair)>
where
    S: SharedAccountStore,
    V: PasskeyVerifier,
{
    let now = (routes.clock)()?;
    let mut target = settings.origin.clone();
    target.set_path(proof_request.uri.path());
    let Ok(proof) = check_dpop_proof(
        proof_request.headers,
        proof_request.method,
        &target,
        now,
        ProofForm::TokenRequest,
    ) else {
        return Ok(Err(refuse_proof()));
    };

    let transaction_id = request.transaction_id;
    let credential_id = request.response.id.as_str().to_owned();
    let jkt = proof.jkt.clone();
    // The proof's single use is spent before the challenge is read, so a replay leaves it.
    let read_step = {
        let credential_id = credential_id.clone();
        move |store: &S::Store| -> RouteOutcome<(String, Option<PasskeyHolder>)> {
            if !record_proof_jti(store, &proof, now)? {
                return Ok(Err(refuse_proof()));
            }
            let challenge =
                read_challenge(store, &transaction_id, Ceremony::Authentication, None, now)?;
            let Some(challenge) = challenge else {
                return Ok(Err(ControlPlaneRefusal::refuse_passkey_challenge()));
            };
            let holder = match read_credential(store, &credential_id)? {
                Some(credential) => {
                    read_user(store, &credential.user_id)?.map(|user| PasskeyHolder {
                        credential,
                        user_id: user.id,
                        identity_ref: user.identity_ref.as_str().to_owned(),
                    })
                }
                None => None,
            };
            Ok(Ok((challenge, holder)))
        }
    };
    let (challenge, holder) = match routes.store.run_step(read_step).await? {
        Ok(read) => read,
        Err(refusal) => return Ok(Err(refusal)),
    };

    let verdict = match holder {
        Some(holder) if is_user_handle_of(&request, &holder) => {
            let public_key = URL_SAFE_NO_PAD.encode(&holder.credential.public_key);
            let passkey = StoredPasskey {
                credential_id: &credential_id,
                public_key: &public_key,
                counter: u32::try_from(holder.credential.signature_counter)
                    .expect("a stored counter was written from a u32"),
            };
            let relying_party = RelyingParty {
                id: settings.relying_party_id.as_str(),
                origins: &settings.relying_party_origins,
            };
            check_authentication(
                &routes.verifier,
                &request.response,
                &challenge,
                relying_party,
                passkey,
            )
            .await?
            .map(|assertion| (assertion, holder))
        }
        _ => None,
    };

    // Read after the verifier's wait, so a challenge that expired during it is not consumed.
    let now = (routes.clock)()?;
    let commit_step = move |store: &S::Store| -> RouteOutcome<(UserId, TokenPair)> {
        let is_consumed = consume_challenge(
            store,
            &challenge,
            &transaction_id,
            Ceremony::Authentication,
            None,
            now,
        )?;
        if !is_consumed {
            return Ok(Err(ControlPlaneRefusal::refuse_passkey_challenge()));
        }
        let Some((assertion, holder)) = verdict else {
            return Ok(Err(ControlPlaneRefusal::refuse_passkey_verification()));
        };
        let holder_id = &holder.credential.user_id;
        // Matches only while the passkey is still the holder's and its counter is below the
        // presented one, so a revoke or a racing sign-in in between refuses this one.
        if !advance_counter(store, &credential_id, holder_id, assertion.new_counter, now)? {
            return Ok(Err(ControlPlaneRefusal::refuse_passkey_verification()));
        }
        let pair = issue_token_pair(store, &settings.token_keys, holder_id, &jkt, now)?;
        Ok(Ok((holder.user_id, pair)))
    };
    routes.store.run_step(commit_step).await
}

// The assertion names the holder: its user handle is present and is the holder's.
fn is_user_handle_of(
    request: &WebAuthnAuthenticationVerifyRequest,
    holder: &PasskeyHolder,
) -> bool {
    request
        .response
        .response
        .user_handle
        .as_ref()
        .is_some_and(|user_handle| user_handle.as_str() == holder.identity_ref)
}

fn refuse_proof() -> ControlPlaneRefusal {
    ControlPlaneRefusal::Unauthenticated(AuthenticationFault::ProofInvalid)
}
