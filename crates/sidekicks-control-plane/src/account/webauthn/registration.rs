//! The registration ceremony: a signed-in account adds a passkey. The issue leg records a
//! challenge for the caller and answers the options; the verify leg reads the challenge, checks
//! the attestation, then in one step consumes the challenge and writes the passkey, so a refused
//! attestation still spends its challenge and writes nothing else.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::trust_statement::CoseAlgorithm;
use sidekicks_contracts::webauthn::ceremony::{
    AuthenticatorSelection, CEREMONY_TIMEOUT_MS, CredentialDescriptor, CredentialParameter,
    NoAttestation, PublicKeyCredentialType, RegistrationExtensions, RegistrationOptions,
    RelyingPartyEntity, RelyingPartyText, Required, Transports, UserEntity,
    WebAuthnRegistrationOptionsIssueResponse, WebAuthnRegistrationVerifyRequest,
    WebAuthnRegistrationVerifyResponse,
};
use sidekicks_contracts::wire::BoolLiteral;
use strum::VariantArray as _;

use crate::account::settings::AccountSettings;
use crate::account::user_record::read_user;
use crate::account::webauthn::authenticator_list::{AuthenticatorList, read_provider_name};
use crate::account::webauthn::challenge::{
    Ceremony, consume_challenge, issue_challenge, read_challenge,
};
use crate::account::webauthn::credential::{insert_credential, list_credentials};
use crate::account::webauthn::verifier::{
    PasskeyVerifier, RegisteredPasskey, RelyingParty, check_registration,
};
use crate::account::{AccountRoutes, RouteOutcome, settle};
use crate::account_store::{AccountStoreError, SharedAccountStore};
use crate::server::received_json::ReceivedJson;
use crate::server::router::{AuthenticationFault, ControlPlaneRefusal, RequestId, SignedInUser};

/// The relying party's name, which an authenticator may show beside the passkey.
const RELYING_PARTY_NAME: &str = APP_DISPLAY_NAME;

/// Records a registration challenge for the signed-in caller and answers the options its
/// authenticator makes a passkey from, listing the caller's passkeys so one is not made twice.
pub(crate) async fn issue_registration_options<S, V, L>(
    State(routes): State<AccountRoutes<S, V, L>>,
    request_id: Option<Extension<RequestId>>,
    caller: SignedInUser,
    ReceivedJson(EmptyPayload {}): ReceivedJson<EmptyPayload>,
) -> Result<Json<WebAuthnRegistrationOptionsIssueResponse>, ControlPlaneRefusal>
where
    S: SharedAccountStore,
{
    let request_id = request_id.map(|Extension(request_id)| request_id);
    let settings = routes.read_settings(request_id.as_ref())?;
    let outcome = compose_registration_options(&routes, settings, caller).await;
    settle(request_id.as_ref(), outcome).map(Json)
}

// Records the caller's registration challenge and composes the options around it in one step.
async fn compose_registration_options<S, V, L>(
    routes: &AccountRoutes<S, V, L>,
    settings: Arc<AccountSettings>,
    caller: SignedInUser,
) -> RouteOutcome<WebAuthnRegistrationOptionsIssueResponse>
where
    S: SharedAccountStore,
{
    let now = (routes.clock)()?;
    let step = move |store: &S::Store| -> RouteOutcome<WebAuthnRegistrationOptionsIssueResponse> {
        // A token of an account that is gone signs no one in.
        let Some(user) = read_user(store, &caller.user_id)? else {
            return Ok(Err(ControlPlaneRefusal::Unauthenticated(
                AuthenticationFault::TokenInvalid,
            )));
        };
        let mut exclude_credentials = Vec::new();
        for listed in list_credentials(store, &caller.user_id)? {
            let transports = match listed.transports {
                Some(text) => serde_json::from_str(&text).map_err(AccountStoreError::from)?,
                None => Transports::new(Vec::new()).expect("no transports is in bounds"),
            };
            exclude_credentials.push(CredentialDescriptor {
                credential_type: PublicKeyCredentialType::Value,
                id: listed.credential_id,
                transports,
            });
        }
        let issued = issue_challenge(
            store,
            Ceremony::Registration,
            Some(&caller.user_id),
            None,
            now,
        )?;
        Ok(Ok(WebAuthnRegistrationOptionsIssueResponse {
            transaction_id: issued.transaction_id,
            options: RegistrationOptions {
                rp: RelyingPartyEntity {
                    name: RelyingPartyText::new(RELYING_PARTY_NAME.to_owned())
                        .expect("the relying party's name is in bounds"),
                    id: settings.relying_party_id.clone(),
                },
                user: UserEntity {
                    id: user.identity_ref,
                    name: user.display_name.clone(),
                    display_name: user.display_name,
                },
                challenge: issued.challenge,
                pub_key_cred_params: CoseAlgorithm::VARIANTS
                    .iter()
                    .map(|algorithm| CredentialParameter {
                        credential_type: PublicKeyCredentialType::Value,
                        alg: *algorithm,
                    })
                    .collect(),
                timeout: CEREMONY_TIMEOUT_MS,
                exclude_credentials,
                authenticator_selection: AuthenticatorSelection {
                    resident_key: Required::Value,
                    require_resident_key: BoolLiteral,
                    user_verification: Required::Value,
                },
                attestation: NoAttestation::Value,
                extensions: RegistrationExtensions {
                    cred_props: BoolLiteral,
                },
                hints: Vec::new(),
            },
        }))
    };
    routes.store.run_step(step).await
}

/// Verifies the signed-in caller's new passkey under its registration challenge and adds it to
/// the account, answering its id, key, AAGUID and the provider name the authenticator list gives.
pub(crate) async fn verify_registration<S, V, L>(
    State(routes): State<AccountRoutes<S, V, L>>,
    request_id: Option<Extension<RequestId>>,
    caller: SignedInUser,
    ReceivedJson(request): ReceivedJson<WebAuthnRegistrationVerifyRequest>,
) -> Result<Json<WebAuthnRegistrationVerifyResponse>, ControlPlaneRefusal>
where
    S: SharedAccountStore,
    V: PasskeyVerifier,
    L: AuthenticatorList,
{
    let request_id = request_id.map(|Extension(request_id)| request_id);
    let settings = routes.read_settings(request_id.as_ref())?;
    let relying_party = RelyingParty {
        id: settings.relying_party_id.as_str(),
        origins: &settings.relying_party_origins,
    };
    let outcome = register_passkey(&routes, caller, request, relying_party).await;
    let passkey = settle(request_id.as_ref(), outcome)?;
    let provider_name = read_provider_name(
        &routes.authenticator_list,
        &passkey.aaguid,
        request_id.as_ref().map(|request_id| request_id.0.as_str()),
    )
    .await;
    Ok(Json(WebAuthnRegistrationVerifyResponse {
        passkey_id: passkey.credential_id,
        public_key: passkey.public_key,
        aaguid: passkey.aaguid,
        provider_name,
    }))
}

async fn register_passkey<S, V, L>(
    routes: &AccountRoutes<S, V, L>,
    caller: SignedInUser,
    request: WebAuthnRegistrationVerifyRequest,
    relying_party: RelyingParty<'_>,
) -> RouteOutcome<RegisteredPasskey>
where
    S: SharedAccountStore,
    V: PasskeyVerifier,
{
    let now = (routes.clock)()?;
    let user_id = caller.user_id;
    let transaction_id = request.transaction_id;
    let challenge = routes
        .store
        .run_step({
            let user_id = user_id.clone();
            move |store| {
                read_challenge(
                    store,
                    &transaction_id,
                    Ceremony::Registration,
                    Some(user_id.as_str()),
                    now,
                )
            }
        })
        .await?;
    let Some(challenge) = challenge else {
        return Ok(Err(ControlPlaneRefusal::refuse_passkey_challenge()));
    };
    let verdict = check_registration(
        &routes.verifier,
        &request.response,
        &challenge,
        relying_party,
    )
    .await?
    // The attestation must name the credential the response says it made.
    .filter(|passkey| passkey.credential_id == request.response.id);
    // Read after the verifier's wait, so a challenge that expired during it is not consumed.
    let now = (routes.clock)()?;
    let transports = request.response.response.transports;
    let step = move |store: &S::Store| -> RouteOutcome<RegisteredPasskey> {
        let is_consumed = consume_challenge(
            store,
            &challenge,
            &transaction_id,
            Ceremony::Registration,
            Some(user_id.as_str()),
            now,
        )?;
        if !is_consumed {
            return Ok(Err(ControlPlaneRefusal::refuse_passkey_challenge()));
        }
        let Some(passkey) = verdict else {
            return Ok(Err(ControlPlaneRefusal::refuse_passkey_verification()));
        };
        if !insert_credential(store, &user_id, &passkey, transports.as_ref(), now)? {
            return Ok(Err(ControlPlaneRefusal::refuse_passkey_verification()));
        }
        Ok(Ok(passkey))
    };
    routes.store.run_step(step).await
}
