//! The passkey ceremonies the control plane runs as relying party: issuing registration and
//! sign-in options, and verifying what the authenticator answered. Each issue leg records a
//! single-use challenge and hands back the transaction id its verify leg quotes; a sign-in's verify
//! reply carries a freshly issued token pair bound to the caller's DPoP key.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::internal::branded::branded_uuid_id;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::id::UserId;
use crate::trust_statement::{
    ChallengeNonce, CoseAlgorithm, PasskeyId, PasskeyPublicKey, PlatformDescription,
    TrustStatementHash,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::base64::Base64UrlText;
use crate::wire::list::BoundedVec;
use crate::wire::record::JsonRecord;
use crate::wire::text::{BoundedText, FreeFormText, pattern_text};
use crate::wire::{self, True, literal};

ts_constants! {
    /// How long a ceremony's options stay good, in milliseconds: the challenge's own five minutes.
    pub const CEREMONY_TIMEOUT_MS: u32 = 300_000;
    /// The longest base64url part of an authenticator's answer a verify leg reads.
    pub const CEREMONY_PART_MAX_LEN: usize = 16_384;
    /// The longest relying party id or origin: a host name of 253 characters and its scheme.
    pub const RELYING_PARTY_TEXT_MAX_LEN: usize = 261;
    /// The most transports one credential lists.
    pub const CREDENTIAL_TRANSPORTS_MAX: usize = 16;
}

/// The longest transport name an authenticator reports, such as `internal` or `hybrid`.
const TRANSPORT_MAX_LEN: usize = 32;

/// A server-chosen challenge: 32 random bytes, or SHA-256 of a nonce and a statement's hash.
pub type WebAuthnChallenge = Base64UrlText<43, 43>;

/// A user handle: the account's `identity_ref`, at most 64 bytes.
pub type UserHandle = Base64UrlText<1, 86>;

/// One base64url part of an authenticator's answer.
pub type CeremonyPart = Base64UrlText<1, CEREMONY_PART_MAX_LEN>;

/// A relying party id or an origin.
pub type RelyingPartyText = BoundedText<1, RELYING_PARTY_TEXT_MAX_LEN>;

/// A transport an authenticator reports, kept as the platform names it.
pub type TransportName = BoundedText<1, TRANSPORT_MAX_LEN>;

/// The transports one credential lists.
pub type Transports = BoundedVec<TransportName, 0, CREDENTIAL_TRANSPORTS_MAX>;

branded_uuid_id! {
    /// The handle one ceremony's options and its verify share: minted with the challenge,
    /// single-use, and good only until the challenge expires.
    WebAuthnTransactionId
}

pattern_text! {
    /// An authenticator's AAGUID as lowercase hyphenated hex: 16 bytes the maker chose, so any
    /// version and variant bits; all zeros when the authenticator names none.
    pub struct Aaguid("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    /// A PASETO v4.public access token.
    pub struct AccessToken("^v4\\.public\\.[A-Za-z0-9_-]+$") redacted;

    /// A PASETO v4.local refresh token.
    pub struct RefreshToken("^v4\\.local\\.[A-Za-z0-9_-]+$") redacted;
}

literal! {
    /// The credential type every passkey has.
    pub enum PublicKeyCredentialType = "public-key";

    /// The one requirement level the relying party sets: a discoverable credential and user
    /// verification are both required.
    pub enum Required = "required";

    /// The attestation the relying party asks for: none.
    pub enum NoAttestation = "none";
}

/// Where an authenticator sits, as the platform reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AuthenticatorAttachment {
    /// Built into the device.
    Platform,
    /// A security key or a phone reached across devices.
    CrossPlatform,
}

/// A hint about which authenticator to offer first; the relying party sends none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PublicKeyCredentialHint {
    /// A security key.
    SecurityKey,
    /// The device's own authenticator.
    ClientDevice,
    /// A phone reached across devices.
    Hybrid,
}

/// The relying party the options name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelyingPartyEntity {
    /// The name an authenticator may show.
    pub name: RelyingPartyText,
    /// The relying party id: the control plane's host.
    pub id: RelyingPartyText,
}

/// The account the passkey is made for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserEntity {
    /// The user handle, the account's `identity_ref`.
    pub id: UserHandle,
    /// The account's name, which a password manager shows as the passkey's label.
    pub name: FreeFormText<{ usize::MAX }>,
    /// The account's name again, as `WebAuthn` asks for both.
    pub display_name: FreeFormText<{ usize::MAX }>,
}

/// One algorithm the relying party takes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialParameter {
    /// The credential type.
    #[serde(rename = "type")]
    pub credential_type: PublicKeyCredentialType,
    /// The algorithm.
    pub alg: CoseAlgorithm,
}

/// A passkey the account already holds, so the authenticator does not make a second one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialDescriptor {
    /// The credential type.
    #[serde(rename = "type")]
    pub credential_type: PublicKeyCredentialType,
    /// The passkey's credential id.
    pub id: PasskeyId,
    /// The transports its authenticator reported.
    pub transports: Transports,
}

/// What the relying party asks of the authenticator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatorSelection {
    /// A discoverable credential.
    pub resident_key: Required,
    /// The same, in the older member.
    pub require_resident_key: True,
    /// User verification.
    pub user_verification: Required,
}

/// The extensions registration asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationExtensions {
    /// Ask the client to report whether the credential is discoverable.
    pub cred_props: True,
}

/// The options a client passes to `navigator.credentials.create()`, in `WebAuthn`'s JSON form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationOptions {
    /// The relying party.
    pub rp: RelyingPartyEntity,
    /// The account.
    pub user: UserEntity,
    /// The challenge.
    pub challenge: WebAuthnChallenge,
    /// The algorithms taken: EdDSA, ES256 and RS256.
    pub pub_key_cred_params: Vec<CredentialParameter>,
    /// How long the ceremony may take, in milliseconds.
    pub timeout: u32,
    /// The account's passkeys.
    pub exclude_credentials: Vec<CredentialDescriptor>,
    /// What the authenticator must do.
    pub authenticator_selection: AuthenticatorSelection,
    /// No attestation.
    pub attestation: NoAttestation,
    /// The extensions asked for.
    pub extensions: RegistrationExtensions,
    /// No hint.
    pub hints: Vec<PublicKeyCredentialHint>,
}

/// The options a client passes to `navigator.credentials.get()`, in `WebAuthn`'s JSON form: no
/// `allowCredentials`, so the authenticator offers any passkey it holds for the relying party.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticationOptions {
    /// The challenge.
    pub challenge: WebAuthnChallenge,
    /// The relying party id.
    pub rp_id: RelyingPartyText,
    /// How long the ceremony may take, in milliseconds.
    pub timeout: u32,
    /// User verification.
    pub user_verification: Required,
}

/// The reply to a registration options issue: the options and the transaction the verify quotes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnRegistrationOptionsIssueResponse {
    /// The transaction.
    pub transaction_id: WebAuthnTransactionId,
    /// The options.
    pub options: RegistrationOptions,
}

/// A sign-in options issue: with a `statementHash`, the challenge binds the statement the passkey
/// is to sign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnAuthenticationOptionsIssueRequest {
    /// The hash of the statement the passkey is to sign.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "TrustStatementHash")]
    pub statement_hash: Option<TrustStatementHash>,
}

/// The reply to a sign-in options issue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnAuthenticationOptionsIssueResponse {
    /// The transaction.
    pub transaction_id: WebAuthnTransactionId,
    /// The origin the assertion is verified against.
    pub origin: RelyingPartyText,
    /// The options.
    pub options: AuthenticationOptions,
    /// With a `statementHash`, the nonce the challenge was made from: SHA-256(nonce ‖ hash).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "ChallengeNonce")]
    pub challenge_nonce: Option<ChallengeNonce>,
}

/// An authenticator's answer to `create()`, in `WebAuthn`'s JSON form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttestationResponse {
    /// The client data.
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: CeremonyPart,
    /// The attestation object.
    pub attestation_object: CeremonyPart,
    /// The authenticator data, which the attestation object also holds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "CeremonyPart")]
    pub authenticator_data: Option<CeremonyPart>,
    /// The transports the authenticator reported.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "Transports")]
    pub transports: Option<Transports>,
    /// The key's COSE algorithm as the client read it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "i64")]
    pub public_key_algorithm: Option<i64>,
    /// The key as the client exported it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "CeremonyPart")]
    pub public_key: Option<CeremonyPart>,
}

/// A credential `create()` made, in `WebAuthn`'s JSON form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RegistrationResponse {
    /// The credential id.
    pub id: PasskeyId,
    /// The credential id again.
    pub raw_id: PasskeyId,
    /// The authenticator's answer.
    pub response: AttestationResponse,
    /// Where the authenticator sits.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "AuthenticatorAttachment")]
    pub authenticator_attachment: Option<AuthenticatorAttachment>,
    /// The client's extension outputs, whatever extensions it ran.
    pub client_extension_results: JsonRecord,
    /// The credential type.
    #[serde(rename = "type")]
    pub credential_type: PublicKeyCredentialType,
}

/// A registration verify: the transaction and the credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnRegistrationVerifyRequest {
    /// The transaction the options named.
    pub transaction_id: WebAuthnTransactionId,
    /// The credential.
    pub response: RegistrationResponse,
}

/// The passkey registered: what the device writes into its `account.passkey.added` statement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnRegistrationVerifyResponse {
    /// The credential id.
    pub passkey_id: PasskeyId,
    /// The COSE key and its algorithm.
    pub public_key: PasskeyPublicKey,
    /// The authenticator's AAGUID.
    pub aaguid: Aaguid,
    /// The provider the community AAGUID list names; absent for an all-zero AAGUID, one the list
    /// does not hold, or a list that could not be read.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "PlatformDescription")]
    pub provider_name: Option<PlatformDescription>,
}

/// An authenticator's answer to `get()`, in `WebAuthn`'s JSON form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AssertionResponse {
    /// The client data.
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: CeremonyPart,
    /// The authenticator data.
    pub authenticator_data: CeremonyPart,
    /// The signature.
    pub signature: CeremonyPart,
    /// The user handle the passkey holds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "UserHandle")]
    pub user_handle: Option<UserHandle>,
    /// An attestation object, which an authenticator may add.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "CeremonyPart")]
    pub attestation_object: Option<CeremonyPart>,
}

/// An assertion `get()` made, in `WebAuthn`'s JSON form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AuthenticationResponse {
    /// The credential id.
    pub id: PasskeyId,
    /// The credential id again.
    pub raw_id: PasskeyId,
    /// The authenticator's answer.
    pub response: AssertionResponse,
    /// Where the authenticator sits.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "AuthenticatorAttachment")]
    pub authenticator_attachment: Option<AuthenticatorAttachment>,
    /// The client's extension outputs, whatever extensions it ran.
    pub client_extension_results: JsonRecord,
    /// The credential type.
    #[serde(rename = "type")]
    pub credential_type: PublicKeyCredentialType,
}

/// A sign-in verify: the transaction and the assertion, sent with a DPoP proof (RFC 9449 §5)
/// under the key the token pair is bound to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnAuthenticationVerifyRequest {
    /// The transaction the options named.
    pub transaction_id: WebAuthnTransactionId,
    /// The assertion.
    pub response: AuthenticationResponse,
}

/// A verified sign-in: the account and a token pair bound to the proof's key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnAuthenticationVerifyResponse {
    /// The account signed in to.
    pub user_id: UserId,
    /// The access token, good for fifteen minutes.
    pub access_token: AccessToken,
    /// The refresh token, good until sign-out or revocation.
    pub refresh_token: RefreshToken,
}

methods! {
    /// The passkey ceremonies the control plane serves, each one POST at `/<method>`.
    pub const WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS = [
        /// Issues registration options for a passkey added to the signed-in account.
        WebAuthnRegistrationOptionsIssue = mutation "webauthn.registrationOptions.issue" {
            mutating: true,
            params: EmptyPayload,
            result: WebAuthnRegistrationOptionsIssueResponse,
            refusals: [AuthTokenExpired, AuthTokenInvalid, AuthDpopMismatch],
        },
        /// Verifies a new passkey and adds it to the signed-in account.
        WebAuthnRegistrationVerify = mutation "webauthn.registration.verify" {
            mutating: true,
            params: WebAuthnRegistrationVerifyRequest,
            result: WebAuthnRegistrationVerifyResponse,
            refusals: [
                AuthTokenExpired,
                AuthTokenInvalid,
                AuthDpopMismatch,
                AccountPasskeyChallengeInvalid,
                AccountPasskeyVerificationFailed,
            ],
        },
        /// Issues sign-in options; needs no sign-in.
        WebAuthnAuthenticationOptionsIssue = mutation "webauthn.authenticationOptions.issue" {
            mutating: true,
            params: WebAuthnAuthenticationOptionsIssueRequest,
            result: WebAuthnAuthenticationOptionsIssueResponse,
            refusals: [],
        },
        /// Verifies a sign-in and issues a token pair bound to the proof's key.
        WebAuthnAuthenticationVerify = mutation "webauthn.authentication.verify" {
            mutating: true,
            params: WebAuthnAuthenticationVerifyRequest,
            result: WebAuthnAuthenticationVerifyResponse,
            refusals: [
                AuthDpopMismatch,
                AccountPasskeyChallengeInvalid,
                AccountPasskeyVerificationFailed,
            ],
        },
    ];
}

/// The TypeScript module of the passkey ceremonies.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "webauthn/ceremony",
    doc: "The passkey ceremonies the control plane runs as relying party: issuing registration and \
          sign-in options, and verifying what the authenticator answered.\n\nEach issue leg \
          records a single-use challenge and hands back the transaction id its verify leg quotes; \
          a sign-in's verify reply carries a freshly issued token pair bound to the caller's DPoP \
          key.",
    definitions: &[
        Definition::read::<WebAuthnTransactionId>(),
        Definition::read::<Aaguid>(),
        Definition::read::<AccessToken>(),
        Definition::read::<RefreshToken>(),
        Definition::read::<AuthenticatorAttachment>(),
        Definition::read::<PublicKeyCredentialHint>(),
        Definition::read::<RelyingPartyEntity>(),
        Definition::read::<UserEntity>(),
        Definition::read::<CredentialParameter>(),
        Definition::read::<CredentialDescriptor>(),
        Definition::read::<AuthenticatorSelection>(),
        Definition::read::<RegistrationExtensions>(),
        Definition::read::<RegistrationOptions>(),
        Definition::read::<AuthenticationOptions>(),
        Definition::read::<WebAuthnRegistrationOptionsIssueResponse>().checked(),
        Definition::read::<WebAuthnAuthenticationOptionsIssueRequest>().checked(),
        Definition::read::<WebAuthnAuthenticationOptionsIssueResponse>().checked(),
        Definition::read::<AttestationResponse>(),
        Definition::read::<RegistrationResponse>(),
        Definition::read::<WebAuthnRegistrationVerifyRequest>().checked(),
        Definition::read::<WebAuthnRegistrationVerifyResponse>().checked(),
        Definition::read::<AssertionResponse>(),
        Definition::read::<AuthenticationResponse>(),
        Definition::read::<WebAuthnAuthenticationVerifyRequest>().checked(),
        Definition::read::<WebAuthnAuthenticationVerifyResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::WebAuthnAuthenticationVerifyRequest;
    use crate::wire::attachment::parse_received;

    /// A browser's `toJSON()` assertion, with an extension output and the optional members a
    /// platform adds, reads; an unknown member beside them is refused.
    #[test]
    fn a_browser_assertion_reads_and_an_unknown_member_is_refused() {
        let mut request = json!({
            "transactionId": "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e",
            "response": {
                "id": "AQID",
                "rawId": "AQID",
                "type": "public-key",
                "authenticatorAttachment": "platform",
                "clientExtensionResults": { "credProps": { "rk": true } },
                "response": {
                    "clientDataJSON": "eyJ9",
                    "authenticatorData": "AAAA",
                    "signature": "AAAA",
                    "userHandle": "dXNlcg",
                },
            },
        });
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(parse_received::<WebAuthnAuthenticationVerifyRequest>(&bytes, Vec::new()).is_ok());

        request["response"]["response"]["extra"] = json!(1);
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(parse_received::<WebAuthnAuthenticationVerifyRequest>(&bytes, Vec::new()).is_err());
    }
}
