// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The passkey ceremonies the control plane runs as relying party: issuing registration and sign-in options, and verifying what the authenticator answered.
//
// Each issue leg records a single-use challenge and hands back the transaction id its verify leg quotes; a sign-in's verify reply carries a freshly issued token pair bound to the caller's DPoP key.

import type { EmptyPayload } from "../method-descriptor.js";
import type { UserId } from "../session/id.js";
import type { CoseAlgorithm, PasskeyPublicKey, TrustStatementHash } from "../trust-statement.js";

/** How long a ceremony's options stay good, in milliseconds: the challenge's own five minutes. */
export const CEREMONY_TIMEOUT_MS = 300000 as const;

/** The longest base64url part of an authenticator's answer a verify leg reads. */
export const CEREMONY_PART_MAX_LEN = 16384 as const;

/** The longest relying party id or origin: a host name of 253 characters and its scheme. */
export const RELYING_PARTY_TEXT_MAX_LEN = 261 as const;

/** The most transports one credential lists. */
export const CREDENTIAL_TRANSPORTS_MAX = 16 as const;

/**
 * The handle one ceremony's options and its verify share: minted with the challenge,
 * single-use, and good only until the challenge expires.
 */
export type WebAuthnTransactionId = string & { readonly __brand: "WebAuthnTransactionId" };
/**
 * An authenticator's AAGUID as lowercase hyphenated hex: 16 bytes the maker chose, so any
 * version and variant bits; all zeros when the authenticator names none.
 */
export type Aaguid = string;
/**
 * A PASETO v4.public access token.
 */
export type AccessToken = string;
/**
 * A PASETO v4.local refresh token.
 */
export type RefreshToken = string;
/**
 * Where an authenticator sits, as the platform reports it.
 */
export type AuthenticatorAttachment = "platform" | "cross-platform";
/**
 * A hint about which authenticator to offer first; the relying party sends none.
 */
export type PublicKeyCredentialHint = "security-key" | "client-device" | "hybrid";

/**
 * The relying party the options name.
 */
export interface RelyingPartyEntity {
  /**
   * The name an authenticator may show.
   */
  name: string;
  /**
   * The relying party id: the control plane's host.
   */
  id: string;
}
/**
 * The account the passkey is made for.
 */
export interface UserEntity {
  /**
   * The user handle, the account's `identity_ref`.
   */
  id: string;
  /**
   * The account's name, which a password manager shows as the passkey's label.
   */
  name: string;
  /**
   * The account's name again, as `WebAuthn` asks for both.
   */
  displayName: string;
}
/**
 * One algorithm the relying party takes.
 */
export interface CredentialParameter {
  /**
   * The credential type.
   */
  type: "public-key";
  /**
   * The algorithm.
   */
  alg: CoseAlgorithm;
}
/**
 * A passkey the account already holds, so the authenticator does not make a second one.
 */
export interface CredentialDescriptor {
  /**
   * The credential type.
   */
  type: "public-key";
  /**
   * The passkey's credential id.
   */
  id: string;
  /**
   * The transports its authenticator reported.
   *
   * @maxItems 16
   */
  transports:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
}
/**
 * What the relying party asks of the authenticator.
 */
export interface AuthenticatorSelection {
  /**
   * A discoverable credential.
   */
  residentKey: "required";
  /**
   * The same, in the older member.
   */
  requireResidentKey: true;
  /**
   * User verification.
   */
  userVerification: "required";
}
/**
 * The extensions registration asks for.
 */
export interface RegistrationExtensions {
  /**
   * Ask the client to report whether the credential is discoverable.
   */
  credProps: true;
}
/**
 * The options a client passes to `navigator.credentials.create()`, in `WebAuthn`'s JSON form.
 */
export interface RegistrationOptions {
  /**
   * The relying party.
   */
  rp: RelyingPartyEntity;
  /**
   * The account.
   */
  user: UserEntity;
  /**
   * The challenge.
   */
  challenge: string;
  /**
   * The algorithms taken: `EdDSA`, ES256 and RS256.
   */
  pubKeyCredParams: CredentialParameter[];
  /**
   * How long the ceremony may take, in milliseconds.
   */
  timeout: number;
  /**
   * The account's passkeys.
   */
  excludeCredentials: CredentialDescriptor[];
  /**
   * What the authenticator must do.
   */
  authenticatorSelection: AuthenticatorSelection;
  /**
   * No attestation.
   */
  attestation: "none";
  /**
   * The extensions asked for.
   */
  extensions: RegistrationExtensions;
  /**
   * No hint.
   */
  hints: PublicKeyCredentialHint[];
}
/**
 * The options a client passes to `navigator.credentials.get()`, in `WebAuthn`'s JSON form: no
 * `allowCredentials`, so the authenticator offers any passkey it holds for the relying party.
 */
export interface AuthenticationOptions {
  /**
   * The challenge.
   */
  challenge: string;
  /**
   * The relying party id.
   */
  rpId: string;
  /**
   * How long the ceremony may take, in milliseconds.
   */
  timeout: number;
  /**
   * User verification.
   */
  userVerification: "required";
}
/**
 * The reply to a registration options issue: the options and the transaction the verify quotes.
 */
export interface WebAuthnRegistrationOptionsIssueResponse {
  /**
   * The transaction.
   */
  transactionId: WebAuthnTransactionId;
  /**
   * The options.
   */
  options: RegistrationOptions;
}
/**
 * A sign-in options issue: with a `statementHash`, the challenge binds the statement the passkey
 * is to sign.
 */
export interface WebAuthnAuthenticationOptionsIssueRequest {
  /**
   * The hash of the statement the passkey is to sign.
   */
  statementHash?: TrustStatementHash;
}
/**
 * The reply to a sign-in options issue.
 */
export interface WebAuthnAuthenticationOptionsIssueResponse {
  /**
   * The transaction.
   */
  transactionId: WebAuthnTransactionId;
  /**
   * The origin the assertion is verified against.
   */
  origin: string;
  /**
   * The options.
   */
  options: AuthenticationOptions;
  /**
   * With a `statementHash`, the nonce the challenge was made from: SHA-256(nonce ‖ hash).
   */
  challengeNonce?: string;
}
/**
 * An authenticator's answer to `create()`, in `WebAuthn`'s JSON form.
 */
export interface AttestationResponse {
  /**
   * The client data.
   */
  clientDataJSON: string;
  /**
   * The attestation object.
   */
  attestationObject: string;
  /**
   * The authenticator data, which the attestation object also holds.
   */
  authenticatorData?: string;
  /**
   * The transports the authenticator reported.
   *
   * @maxItems 16
   */
  transports?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  /**
   * The key's COSE algorithm as the client read it.
   */
  publicKeyAlgorithm?: number;
  /**
   * The key as the client exported it.
   */
  publicKey?: string;
}
/**
 * A credential `create()` made, in `WebAuthn`'s JSON form.
 */
export interface RegistrationResponse {
  /**
   * The credential id.
   */
  id: string;
  /**
   * The credential id again.
   */
  rawId: string;
  /**
   * The authenticator's answer.
   */
  response: AttestationResponse;
  /**
   * Where the authenticator sits.
   */
  authenticatorAttachment?: AuthenticatorAttachment;
  /**
   * The client's extension outputs, whatever extensions it ran.
   */
  clientExtensionResults: {
    [k: string]: unknown | undefined;
  };
  /**
   * The credential type.
   */
  type: "public-key";
}
/**
 * A registration verify: the transaction and the credential.
 */
export interface WebAuthnRegistrationVerifyRequest {
  /**
   * The transaction the options named.
   */
  transactionId: WebAuthnTransactionId;
  /**
   * The credential.
   */
  response: RegistrationResponse;
}
/**
 * The passkey registered: what the device writes into its `account.passkey.added` statement.
 */
export interface WebAuthnRegistrationVerifyResponse {
  /**
   * The credential id.
   */
  passkeyId: string;
  /**
   * The COSE key and its algorithm.
   */
  publicKey: PasskeyPublicKey;
  /**
   * The authenticator's AAGUID.
   */
  aaguid: Aaguid;
  /**
   * The provider the community AAGUID list names; absent for an all-zero AAGUID, one the list
   * does not hold, or a list that could not be read.
   */
  providerName?: string;
}
/**
 * An authenticator's answer to `get()`, in `WebAuthn`'s JSON form.
 */
export interface AssertionResponse {
  /**
   * The client data.
   */
  clientDataJSON: string;
  /**
   * The authenticator data.
   */
  authenticatorData: string;
  /**
   * The signature.
   */
  signature: string;
  /**
   * The user handle the passkey holds.
   */
  userHandle?: string;
  /**
   * An attestation object, which an authenticator may add.
   */
  attestationObject?: string;
}
/**
 * An assertion `get()` made, in `WebAuthn`'s JSON form.
 */
export interface AuthenticationResponse {
  /**
   * The credential id.
   */
  id: string;
  /**
   * The credential id again.
   */
  rawId: string;
  /**
   * The authenticator's answer.
   */
  response: AssertionResponse;
  /**
   * Where the authenticator sits.
   */
  authenticatorAttachment?: AuthenticatorAttachment;
  /**
   * The client's extension outputs, whatever extensions it ran.
   */
  clientExtensionResults: {
    [k: string]: unknown | undefined;
  };
  /**
   * The credential type.
   */
  type: "public-key";
}
/**
 * A sign-in verify: the transaction and the assertion, sent with a `DPoP` proof (RFC 9449 §5)
 * under the key the token pair is bound to.
 */
export interface WebAuthnAuthenticationVerifyRequest {
  /**
   * The transaction the options named.
   */
  transactionId: WebAuthnTransactionId;
  /**
   * The assertion.
   */
  response: AuthenticationResponse;
}
/**
 * A verified sign-in: the account and a token pair bound to the proof's key.
 */
export interface WebAuthnAuthenticationVerifyResponse {
  /**
   * The account signed in to.
   */
  userId: UserId;
  /**
   * The access token, good for fifteen minutes.
   */
  accessToken: AccessToken;
  /**
   * The refresh token, good until sign-out or revocation.
   */
  refreshToken: RefreshToken;
}

/** The methods of {@link WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS}, each with its kind. */
export interface WebauthnCeremonyMethodDescriptors {
  readonly "webauthn.registrationOptions.issue": {
    readonly method: "webauthn.registrationOptions.issue";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "webauthn.registration.verify": {
    readonly method: "webauthn.registration.verify";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "webauthn.authenticationOptions.issue": {
    readonly method: "webauthn.authenticationOptions.issue";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "webauthn.authentication.verify": {
    readonly method: "webauthn.authentication.verify";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS}. */
export interface WebauthnCeremonyMethodTypes {
  readonly "webauthn.registrationOptions.issue": {
    readonly params: EmptyPayload;
    readonly result: WebAuthnRegistrationOptionsIssueResponse;
  };
  readonly "webauthn.registration.verify": {
    readonly params: WebAuthnRegistrationVerifyRequest;
    readonly result: WebAuthnRegistrationVerifyResponse;
  };
  readonly "webauthn.authenticationOptions.issue": {
    readonly params: WebAuthnAuthenticationOptionsIssueRequest;
    readonly result: WebAuthnAuthenticationOptionsIssueResponse;
  };
  readonly "webauthn.authentication.verify": {
    readonly params: WebAuthnAuthenticationVerifyRequest;
    readonly result: WebAuthnAuthenticationVerifyResponse;
  };
}
/** The passkey ceremonies the control plane serves, each one POST at `/<method>`. */
export const WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS: WebauthnCeremonyMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "webauthn.registrationOptions.issue": /* @__PURE__ */ Object.freeze({
      method: "webauthn.registrationOptions.issue",
      procedureType: "mutation",
      mutating: true,
    }),
    "webauthn.registration.verify": /* @__PURE__ */ Object.freeze({
      method: "webauthn.registration.verify",
      procedureType: "mutation",
      mutating: true,
    }),
    "webauthn.authenticationOptions.issue": /* @__PURE__ */ Object.freeze({
      method: "webauthn.authenticationOptions.issue",
      procedureType: "mutation",
      mutating: true,
    }),
    "webauthn.authentication.verify": /* @__PURE__ */ Object.freeze({
      method: "webauthn.authentication.verify",
      procedureType: "mutation",
      mutating: true,
    }),
  });
