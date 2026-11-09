// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The passkey ceremonies the control plane runs as relying party: issuing registration and sign-in options, and verifying what the authenticator answered.
//
// Each issue leg records a single-use challenge and hands back the transaction id its verify leg quotes; a sign-in's verify reply carries a freshly issued token pair bound to the caller's DPoP key.

import { SCHEMA_FORMATS, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
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

// prettier-ignore
const pattern220 = new RegExp("^[0-9a-f]{64}$", "u");
// prettier-ignore
function validate2256(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationOptionsIssueRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2256.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "statementHash")){validate2256.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.statementHash !== undefined){let data0: any = data.statementHash;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern220.test(data0)){validate2256.errors = [{instancePath:instancePath+"/statementHash",schemaPath:"sidekicks-contracts:trust-statement#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2256.errors = [{instancePath:instancePath+"/statementHash",schemaPath:"sidekicks-contracts:trust-statement#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}}}}else {validate2256.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2256.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2256.errors = null as any[] | null;
// prettier-ignore
validate2256.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4466: any = {"type":"object","additionalProperties":false,"properties":{"challenge":{"type":"string","minLength":43,"maxLength":43,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The challenge."},"rpId":{"type":"string","minLength":1,"maxLength":261,"description":"The relying party id."},"timeout":{"type":"integer","format":"uint32","minimum":0,"description":"How long the ceremony may take, in milliseconds."},"userVerification":{"description":"User verification.","type":"string","enum":["required"]}},"required":["challenge","rpId","timeout","userVerification"],"description":"The options a client passes to `navigator.credentials.get()`, in `WebAuthn`'s JSON form: no\n`allowCredentials`, so the authenticator offers any passkey it holds for the relying party."};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern14 = new RegExp("^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const formats58 = SCHEMA_FORMATS.uint32;
// prettier-ignore
function validate2257(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationOptionsIssueResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2257.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.origin === undefined) && (missing0 = "origin"))) || ((data.options === undefined) && (missing0 = "options"))){validate2257.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "transactionId") || (key0 === "origin")) || (key0 === "options")) || (key0 === "challengeNonce"))){validate2257.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){let data0: any = data.transactionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2257.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2257.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){let data1: any = data.origin;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 261){validate2257.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data1) < 1){validate2257.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2257.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data2: any = data.options;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((((data2.challenge === undefined) && (missing1 = "challenge")) || ((data2.rpId === undefined) && (missing1 = "rpId"))) || ((data2.timeout === undefined) && (missing1 = "timeout"))) || ((data2.userVerification === undefined) && (missing1 = "userVerification"))){validate2257.errors = [{instancePath:instancePath+"/options",schemaPath:"#/$defs/AuthenticationOptions/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data2){if(!((((key1 === "challenge") || (key1 === "rpId")) || (key1 === "timeout")) || (key1 === "userVerification"))){validate2257.errors = [{instancePath:instancePath+"/options",schemaPath:"#/$defs/AuthenticationOptions/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data2.challenge !== undefined){let data3: any = data2.challenge;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 43){validate2257.errors = [{instancePath:instancePath+"/options/challenge",schemaPath:"#/$defs/AuthenticationOptions/properties/challenge/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data3) < 43){validate2257.errors = [{instancePath:instancePath+"/options/challenge",schemaPath:"#/$defs/AuthenticationOptions/properties/challenge/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern14.test(data3)){validate2257.errors = [{instancePath:instancePath+"/options/challenge",schemaPath:"#/$defs/AuthenticationOptions/properties/challenge/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2257.errors = [{instancePath:instancePath+"/options/challenge",schemaPath:"#/$defs/AuthenticationOptions/properties/challenge/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data2.rpId !== undefined){let data4: any = data2.rpId;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) > 261){validate2257.errors = [{instancePath:instancePath+"/options/rpId",schemaPath:"#/$defs/AuthenticationOptions/properties/rpId/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data4) < 1){validate2257.errors = [{instancePath:instancePath+"/options/rpId",schemaPath:"#/$defs/AuthenticationOptions/properties/rpId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2257.errors = [{instancePath:instancePath+"/options/rpId",schemaPath:"#/$defs/AuthenticationOptions/properties/rpId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data2.timeout !== undefined){let data5: any = data2.timeout;const _errs16: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate2257.errors = [{instancePath:instancePath+"/options/timeout",schemaPath:"#/$defs/AuthenticationOptions/properties/timeout/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data5 == "number") && (isFinite(data5))){if(data5 < 0 || isNaN(data5)){validate2257.errors = [{instancePath:instancePath+"/options/timeout",schemaPath:"#/$defs/AuthenticationOptions/properties/timeout/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}else {if(!(formats58.validate(data5))){validate2257.errors = [{instancePath:instancePath+"/options/timeout",schemaPath:"#/$defs/AuthenticationOptions/properties/timeout/format",keyword:"format",params:{format: "uint32"}}];return false;}}}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}if(valid3){if(data2.userVerification !== undefined){let data6: any = data2.userVerification;const _errs18: any = errors;if(typeof data6 !== "string"){validate2257.errors = [{instancePath:instancePath+"/options/userVerification",schemaPath:"#/$defs/AuthenticationOptions/properties/userVerification/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data6 === "required")){validate2257.errors = [{instancePath:instancePath+"/options/userVerification",schemaPath:"#/$defs/AuthenticationOptions/properties/userVerification/enum",keyword:"enum",params:{allowedValues: schema4466.properties.userVerification.enum}}];return false;}var valid3: any = _errs18 === errors;}else {var valid3: any = true;}}}}}}}else {validate2257.errors = [{instancePath:instancePath+"/options",schemaPath:"#/$defs/AuthenticationOptions/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.challengeNonce !== undefined){let data7: any = data.challengeNonce;const _errs20: any = errors;if(errors === _errs20){if(typeof data7 === "string"){if(func1(data7) > 43){validate2257.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data7) < 43){validate2257.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern14.test(data7)){validate2257.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2257.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}}}}}}}else {validate2257.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2257.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2257.errors = null as any[] | null;
// prettier-ignore
validate2257.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4469: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id."},"rawId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id again."},"response":{"$ref":"#/$defs/AssertionResponse","description":"The authenticator's answer."},"authenticatorAttachment":{"$ref":"#/$defs/AuthenticatorAttachment","description":"Where the authenticator sits."},"clientExtensionResults":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"The client's extension outputs, whatever extensions it ran."},"type":{"description":"The credential type.","type":"string","enum":["public-key"]}},"required":["id","rawId","response","clientExtensionResults","type"],"description":"An assertion `get()` made, in `WebAuthn`'s JSON form."};
// prettier-ignore
const schema4471: any = {"description":"Where an authenticator sits, as the platform reports it.","type":"string","enum":["platform","cross-platform"]};
// prettier-ignore
function validate2259(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2259.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.id === undefined) && (missing0 = "id")) || ((data.rawId === undefined) && (missing0 = "rawId"))) || ((data.response === undefined) && (missing0 = "response"))) || ((data.clientExtensionResults === undefined) && (missing0 = "clientExtensionResults"))) || ((data.type === undefined) && (missing0 = "type"))){validate2259.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "rawId")) || (key0 === "response")) || (key0 === "authenticatorAttachment")) || (key0 === "clientExtensionResults")) || (key0 === "type"))){validate2259.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validate2259.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validate2259.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data0)){validate2259.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.rawId !== undefined){let data1: any = data.rawId;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 1364){validate2259.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data1) < 1){validate2259.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data1)){validate2259.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){let data2: any = data.response;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((((data2.clientDataJSON === undefined) && (missing1 = "clientDataJSON")) || ((data2.authenticatorData === undefined) && (missing1 = "authenticatorData"))) || ((data2.signature === undefined) && (missing1 = "signature"))){validate2259.errors = [{instancePath:instancePath+"/response",schemaPath:"#/$defs/AssertionResponse/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data2){if(!(((((key1 === "clientDataJSON") || (key1 === "authenticatorData")) || (key1 === "signature")) || (key1 === "userHandle")) || (key1 === "attestationObject"))){validate2259.errors = [{instancePath:instancePath+"/response",schemaPath:"#/$defs/AssertionResponse/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data2.clientDataJSON !== undefined){let data3: any = data2.clientDataJSON;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 16384){validate2259.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AssertionResponse/properties/clientDataJSON/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data3) < 1){validate2259.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AssertionResponse/properties/clientDataJSON/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data3)){validate2259.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AssertionResponse/properties/clientDataJSON/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AssertionResponse/properties/clientDataJSON/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data2.authenticatorData !== undefined){let data4: any = data2.authenticatorData;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) > 16384){validate2259.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AssertionResponse/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data4) < 1){validate2259.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AssertionResponse/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data4)){validate2259.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AssertionResponse/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AssertionResponse/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data2.signature !== undefined){let data5: any = data2.signature;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 16384){validate2259.errors = [{instancePath:instancePath+"/response/signature",schemaPath:"#/$defs/AssertionResponse/properties/signature/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data5) < 1){validate2259.errors = [{instancePath:instancePath+"/response/signature",schemaPath:"#/$defs/AssertionResponse/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data5)){validate2259.errors = [{instancePath:instancePath+"/response/signature",schemaPath:"#/$defs/AssertionResponse/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/response/signature",schemaPath:"#/$defs/AssertionResponse/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data2.userHandle !== undefined){let data6: any = data2.userHandle;const _errs16: any = errors;if(errors === _errs16){if(typeof data6 === "string"){if(func1(data6) > 86){validate2259.errors = [{instancePath:instancePath+"/response/userHandle",schemaPath:"#/$defs/AssertionResponse/properties/userHandle/maxLength",keyword:"maxLength",params:{limit: 86}}];return false;}else {if(func1(data6) < 1){validate2259.errors = [{instancePath:instancePath+"/response/userHandle",schemaPath:"#/$defs/AssertionResponse/properties/userHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data6)){validate2259.errors = [{instancePath:instancePath+"/response/userHandle",schemaPath:"#/$defs/AssertionResponse/properties/userHandle/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/response/userHandle",schemaPath:"#/$defs/AssertionResponse/properties/userHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data2.attestationObject !== undefined){let data7: any = data2.attestationObject;const _errs18: any = errors;if(errors === _errs18){if(typeof data7 === "string"){if(func1(data7) > 16384){validate2259.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AssertionResponse/properties/attestationObject/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data7) < 1){validate2259.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AssertionResponse/properties/attestationObject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data7)){validate2259.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AssertionResponse/properties/attestationObject/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2259.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AssertionResponse/properties/attestationObject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}}}}}}}}else {validate2259.errors = [{instancePath:instancePath+"/response",schemaPath:"#/$defs/AssertionResponse/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorAttachment !== undefined){let data8: any = data.authenticatorAttachment;const _errs20: any = errors;if(typeof data8 !== "string"){validate2259.errors = [{instancePath:instancePath+"/authenticatorAttachment",schemaPath:"#/$defs/AuthenticatorAttachment/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data8 === "platform") || (data8 === "cross-platform"))){validate2259.errors = [{instancePath:instancePath+"/authenticatorAttachment",schemaPath:"#/$defs/AuthenticatorAttachment/enum",keyword:"enum",params:{allowedValues: schema4471.enum}}];return false;}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientExtensionResults !== undefined){let data9: any = data.clientExtensionResults;const _errs23: any = errors;if(errors === _errs23){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){for(const key2 in data9){const _errs25: any = errors;const _errs26: any = errors;if(typeof key2 !== "string"){const err0: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key2};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid5: any = _errs26 === errors;if(valid5){const _errs28: any = errors;const _errs29: any = errors;const _errs30: any = errors;if("__proto__" !== key2){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid6: any = _errs30 === errors;if(valid6){const err2: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key2};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs29;if(vErrors !== null){if(_errs29){vErrors.length = _errs29;}else {vErrors = null;}}}var valid5: any = _errs28 === errors;}var valid4: any = _errs25 === errors;if(!valid4){const err3: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames",keyword:"propertyNames",params:{propertyName: key2}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2259.errors = vErrors;return false;break;}}if(valid4){for(const key3 in data9){const _errs32: any = errors;var valid7: any = _errs32 === errors;if(!valid7){break;}}}}else {validate2259.errors = [{instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data11: any = data.type;const _errs34: any = errors;if(typeof data11 !== "string"){validate2259.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data11 === "public-key")){validate2259.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema4469.properties.type.enum}}];return false;}var valid0: any = _errs34 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate2259.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2259.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2259.errors = null as any[] | null;
// prettier-ignore
validate2259.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2258(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationVerifyRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2258.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.response === undefined) && (missing0 = "response"))){validate2258.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "transactionId") || (key0 === "response"))){validate2258.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){let data0: any = data.transactionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2258.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2258.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){const _errs6: any = errors;if(!(validate2259.call(this, data.response, {instancePath:instancePath+"/response",parentData:data,parentDataProperty:"response",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2259.errors : vErrors.concat(validate2259.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2258.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2258.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2258.errors = null as any[] | null;
// prettier-ignore
validate2258.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern3123 = new RegExp("^v4\\.public\\.[A-Za-z0-9_-]+$", "u");
// prettier-ignore
const pattern3124 = new RegExp("^v4\\.local\\.[A-Za-z0-9_-]+$", "u");
// prettier-ignore
function validate2261(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationVerifyResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2261.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.userId === undefined) && (missing0 = "userId")) || ((data.accessToken === undefined) && (missing0 = "accessToken"))) || ((data.refreshToken === undefined) && (missing0 = "refreshToken"))){validate2261.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "userId") || (key0 === "accessToken")) || (key0 === "refreshToken"))){validate2261.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.userId !== undefined){let data0: any = data.userId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2261.errors = [{instancePath:instancePath+"/userId",schemaPath:"sidekicks-contracts:session/id#/$defs/UserId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2261.errors = [{instancePath:instancePath+"/userId",schemaPath:"sidekicks-contracts:session/id#/$defs/UserId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.accessToken !== undefined){let data1: any = data.accessToken;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern3123.test(data1)){validate2261.errors = [{instancePath:instancePath+"/accessToken",schemaPath:"#/$defs/AccessToken/pattern",keyword:"pattern",params:{pattern: "^v4\\.public\\.[A-Za-z0-9_-]+$"}}];return false;}}else {validate2261.errors = [{instancePath:instancePath+"/accessToken",schemaPath:"#/$defs/AccessToken/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.refreshToken !== undefined){let data2: any = data.refreshToken;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(!pattern3124.test(data2)){validate2261.errors = [{instancePath:instancePath+"/refreshToken",schemaPath:"#/$defs/RefreshToken/pattern",keyword:"pattern",params:{pattern: "^v4\\.local\\.[A-Za-z0-9_-]+$"}}];return false;}}else {validate2261.errors = [{instancePath:instancePath+"/refreshToken",schemaPath:"#/$defs/RefreshToken/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate2261.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2261.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2261.errors = null as any[] | null;
// prettier-ignore
validate2261.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4478: any = {"type":"object","additionalProperties":false,"properties":{"rp":{"$ref":"#/$defs/RelyingPartyEntity","description":"The relying party."},"user":{"$ref":"#/$defs/UserEntity","description":"The account."},"challenge":{"type":"string","minLength":43,"maxLength":43,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The challenge."},"pubKeyCredParams":{"type":"array","items":{"$ref":"#/$defs/CredentialParameter"},"description":"The algorithms taken: `EdDSA`, ES256 and RS256."},"timeout":{"type":"integer","format":"uint32","minimum":0,"description":"How long the ceremony may take, in milliseconds."},"excludeCredentials":{"type":"array","items":{"$ref":"#/$defs/CredentialDescriptor"},"description":"The account's passkeys."},"authenticatorSelection":{"$ref":"#/$defs/AuthenticatorSelection","description":"What the authenticator must do."},"attestation":{"description":"No attestation.","type":"string","enum":["none"]},"extensions":{"$ref":"#/$defs/RegistrationExtensions","description":"The extensions asked for."},"hints":{"type":"array","items":{"$ref":"#/$defs/PublicKeyCredentialHint"},"description":"No hint."}},"required":["rp","user","challenge","pubKeyCredParams","timeout","excludeCredentials","authenticatorSelection","attestation","extensions","hints"],"description":"The options a client passes to `navigator.credentials.create()`, in `WebAuthn`'s JSON form."};
// prettier-ignore
const schema4483: any = {"type":"object","additionalProperties":false,"properties":{"type":{"description":"The credential type.","type":"string","enum":["public-key"]},"id":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The passkey's credential id."},"transports":{"type":"array","items":{"type":"string","minLength":1,"maxLength":32},"maxItems":16,"description":"The transports its authenticator reported."}},"required":["type","id","transports"],"description":"A passkey the account already holds, so the authenticator does not make a second one."};
// prettier-ignore
const schema4484: any = {"type":"object","additionalProperties":false,"properties":{"residentKey":{"description":"A discoverable credential.","type":"string","enum":["required"]},"requireResidentKey":{"type":"boolean","const":true,"description":"The same, in the older member."},"userVerification":{"description":"User verification.","type":"string","enum":["required"]}},"required":["residentKey","requireResidentKey","userVerification"],"description":"What the relying party asks of the authenticator."};
// prettier-ignore
const schema4486: any = {"description":"A hint about which authenticator to offer first; the relying party sends none.","type":"string","enum":["security-key","client-device","hybrid"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const schema4481: any = {"type":"object","additionalProperties":false,"properties":{"type":{"description":"The credential type.","type":"string","enum":["public-key"]},"alg":{"$ref":"sidekicks-contracts:trust-statement#/$defs/CoseAlgorithm","description":"The algorithm."}},"required":["type","alg"],"description":"One algorithm the relying party takes."};
// prettier-ignore
const schema801: any = {"description":"A COSE algorithm a passkey signs with: EdDSA (-8), ES256 (-7) or RS256 (-257).","type":"integer","enum":[-8,-7,-257]};
// prettier-ignore
function validate2264(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2264.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.type === undefined) && (missing0 = "type")) || ((data.alg === undefined) && (missing0 = "alg"))){validate2264.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "type") || (key0 === "alg"))){validate2264.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs2: any = errors;if(typeof data0 !== "string"){validate2264.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "public-key")){validate2264.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema4481.properties.type.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.alg !== undefined){let data1: any = data.alg;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2264.errors = [{instancePath:instancePath+"/alg",schemaPath:"sidekicks-contracts:trust-statement#/$defs/CoseAlgorithm/type",keyword:"type",params:{type: "integer"}}];return false;}if(!(((data1 === -8) || (data1 === -7)) || (data1 === -257))){validate2264.errors = [{instancePath:instancePath+"/alg",schemaPath:"sidekicks-contracts:trust-statement#/$defs/CoseAlgorithm/enum",keyword:"enum",params:{allowedValues: schema801.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate2264.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2264.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2264.errors = null as any[] | null;
// prettier-ignore
validate2264.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2263(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2263.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.rp === undefined) && (missing0 = "rp")) || ((data.user === undefined) && (missing0 = "user"))) || ((data.challenge === undefined) && (missing0 = "challenge"))) || ((data.pubKeyCredParams === undefined) && (missing0 = "pubKeyCredParams"))) || ((data.timeout === undefined) && (missing0 = "timeout"))) || ((data.excludeCredentials === undefined) && (missing0 = "excludeCredentials"))) || ((data.authenticatorSelection === undefined) && (missing0 = "authenticatorSelection"))) || ((data.attestation === undefined) && (missing0 = "attestation"))) || ((data.extensions === undefined) && (missing0 = "extensions"))) || ((data.hints === undefined) && (missing0 = "hints"))){validate2263.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema4478.properties, key0))){validate2263.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.rp !== undefined){let data0: any = data.rp;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing1: any;if(((data0.name === undefined) && (missing1 = "name")) || ((data0.id === undefined) && (missing1 = "id"))){validate2263.errors = [{instancePath:instancePath+"/rp",schemaPath:"#/$defs/RelyingPartyEntity/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key1 in data0){if(!((key1 === "name") || (key1 === "id"))){validate2263.errors = [{instancePath:instancePath+"/rp",schemaPath:"#/$defs/RelyingPartyEntity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data0.name !== undefined){let data1: any = data0.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 261){validate2263.errors = [{instancePath:instancePath+"/rp/name",schemaPath:"#/$defs/RelyingPartyEntity/properties/name/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data1) < 1){validate2263.errors = [{instancePath:instancePath+"/rp/name",schemaPath:"#/$defs/RelyingPartyEntity/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2263.errors = [{instancePath:instancePath+"/rp/name",schemaPath:"#/$defs/RelyingPartyEntity/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data0.id !== undefined){let data2: any = data0.id;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 261){validate2263.errors = [{instancePath:instancePath+"/rp/id",schemaPath:"#/$defs/RelyingPartyEntity/properties/id/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data2) < 1){validate2263.errors = [{instancePath:instancePath+"/rp/id",schemaPath:"#/$defs/RelyingPartyEntity/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2263.errors = [{instancePath:instancePath+"/rp/id",schemaPath:"#/$defs/RelyingPartyEntity/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2263.errors = [{instancePath:instancePath+"/rp",schemaPath:"#/$defs/RelyingPartyEntity/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.user !== undefined){let data3: any = data.user;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing2: any;if((((data3.id === undefined) && (missing2 = "id")) || ((data3.name === undefined) && (missing2 = "name"))) || ((data3.displayName === undefined) && (missing2 = "displayName"))){validate2263.errors = [{instancePath:instancePath+"/user",schemaPath:"#/$defs/UserEntity/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs13: any = errors;for(const key2 in data3){if(!(((key2 === "id") || (key2 === "name")) || (key2 === "displayName"))){validate2263.errors = [{instancePath:instancePath+"/user",schemaPath:"#/$defs/UserEntity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs13 === errors){if(data3.id !== undefined){let data4: any = data3.id;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) > 86){validate2263.errors = [{instancePath:instancePath+"/user/id",schemaPath:"#/$defs/UserEntity/properties/id/maxLength",keyword:"maxLength",params:{limit: 86}}];return false;}else {if(func1(data4) < 1){validate2263.errors = [{instancePath:instancePath+"/user/id",schemaPath:"#/$defs/UserEntity/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data4)){validate2263.errors = [{instancePath:instancePath+"/user/id",schemaPath:"#/$defs/UserEntity/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2263.errors = [{instancePath:instancePath+"/user/id",schemaPath:"#/$defs/UserEntity/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data3.name !== undefined){let data5: any = data3.name;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) < 1){validate2263.errors = [{instancePath:instancePath+"/user/name",schemaPath:"#/$defs/UserEntity/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate2263.errors = [{instancePath:instancePath+"/user/name",schemaPath:"#/$defs/UserEntity/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2263.errors = [{instancePath:instancePath+"/user/name",schemaPath:"#/$defs/UserEntity/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data3.displayName !== undefined){let data6: any = data3.displayName;const _errs18: any = errors;if(errors === _errs18){if(typeof data6 === "string"){if(func1(data6) < 1){validate2263.errors = [{instancePath:instancePath+"/user/displayName",schemaPath:"#/$defs/UserEntity/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate2263.errors = [{instancePath:instancePath+"/user/displayName",schemaPath:"#/$defs/UserEntity/properties/displayName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2263.errors = [{instancePath:instancePath+"/user/displayName",schemaPath:"#/$defs/UserEntity/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}else {validate2263.errors = [{instancePath:instancePath+"/user",schemaPath:"#/$defs/UserEntity/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.challenge !== undefined){let data7: any = data.challenge;const _errs20: any = errors;if(errors === _errs20){if(typeof data7 === "string"){if(func1(data7) > 43){validate2263.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data7) < 43){validate2263.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern14.test(data7)){validate2263.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2263.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.pubKeyCredParams !== undefined){let data8: any = data.pubKeyCredParams;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data8)){var valid5: any = true;const len0: any = data8.length;for(let i0=0; i0<len0; i0++){const _errs24: any = errors;if(!(validate2264.call(this, data8[i0], {instancePath:instancePath+"/pubKeyCredParams/" + i0,parentData:data8,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2264.errors : vErrors.concat(validate2264.errors);errors = vErrors.length;}var valid5: any = _errs24 === errors;if(!valid5){break;}}}else {validate2263.errors = [{instancePath:instancePath+"/pubKeyCredParams",schemaPath:"#/properties/pubKeyCredParams/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.timeout !== undefined){let data10: any = data.timeout;const _errs25: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate2263.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs25){if((typeof data10 == "number") && (isFinite(data10))){if(data10 < 0 || isNaN(data10)){validate2263.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}else {if(!(formats58.validate(data10))){validate2263.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/format",keyword:"format",params:{format: "uint32"}}];return false;}}}}var valid0: any = _errs25 === errors;}else {var valid0: any = true;}if(valid0){if(data.excludeCredentials !== undefined){let data11: any = data.excludeCredentials;const _errs27: any = errors;if(errors === _errs27){if(Array.isArray(data11)){var valid6: any = true;const len1: any = data11.length;for(let i1=0; i1<len1; i1++){let data12: any = data11[i1];const _errs29: any = errors;const _errs30: any = errors;if(errors === _errs30){if(data12 && typeof data12 == "object" && !Array.isArray(data12)){let missing3: any;if((((data12.type === undefined) && (missing3 = "type")) || ((data12.id === undefined) && (missing3 = "id"))) || ((data12.transports === undefined) && (missing3 = "transports"))){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1,schemaPath:"#/$defs/CredentialDescriptor/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs32: any = errors;for(const key3 in data12){if(!(((key3 === "type") || (key3 === "id")) || (key3 === "transports"))){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1,schemaPath:"#/$defs/CredentialDescriptor/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs32 === errors){if(data12.type !== undefined){let data13: any = data12.type;const _errs33: any = errors;if(typeof data13 !== "string"){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/type",schemaPath:"#/$defs/CredentialDescriptor/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data13 === "public-key")){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/type",schemaPath:"#/$defs/CredentialDescriptor/properties/type/enum",keyword:"enum",params:{allowedValues: schema4483.properties.type.enum}}];return false;}var valid8: any = _errs33 === errors;}else {var valid8: any = true;}if(valid8){if(data12.id !== undefined){let data14: any = data12.id;const _errs35: any = errors;if(errors === _errs35){if(typeof data14 === "string"){if(func1(data14) > 1364){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/id",schemaPath:"#/$defs/CredentialDescriptor/properties/id/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data14) < 1){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/id",schemaPath:"#/$defs/CredentialDescriptor/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data14)){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/id",schemaPath:"#/$defs/CredentialDescriptor/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/id",schemaPath:"#/$defs/CredentialDescriptor/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs35 === errors;}else {var valid8: any = true;}if(valid8){if(data12.transports !== undefined){let data15: any = data12.transports;const _errs37: any = errors;if(errors === _errs37){if(Array.isArray(data15)){if(data15.length > 16){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/transports",schemaPath:"#/$defs/CredentialDescriptor/properties/transports/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {var valid9: any = true;const len2: any = data15.length;for(let i2=0; i2<len2; i2++){let data16: any = data15[i2];const _errs39: any = errors;if(errors === _errs39){if(typeof data16 === "string"){if(func1(data16) > 32){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/transports/" + i2,schemaPath:"#/$defs/CredentialDescriptor/properties/transports/items/maxLength",keyword:"maxLength",params:{limit: 32}}];return false;}else {if(func1(data16) < 1){validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/transports/" + i2,schemaPath:"#/$defs/CredentialDescriptor/properties/transports/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/transports/" + i2,schemaPath:"#/$defs/CredentialDescriptor/properties/transports/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs39 === errors;if(!valid9){break;}}}}else {validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1+"/transports",schemaPath:"#/$defs/CredentialDescriptor/properties/transports/type",keyword:"type",params:{type: "array"}}];return false;}}var valid8: any = _errs37 === errors;}else {var valid8: any = true;}}}}}}else {validate2263.errors = [{instancePath:instancePath+"/excludeCredentials/" + i1,schemaPath:"#/$defs/CredentialDescriptor/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs29 === errors;if(!valid6){break;}}}else {validate2263.errors = [{instancePath:instancePath+"/excludeCredentials",schemaPath:"#/properties/excludeCredentials/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorSelection !== undefined){let data17: any = data.authenticatorSelection;const _errs41: any = errors;const _errs42: any = errors;if(errors === _errs42){if(data17 && typeof data17 == "object" && !Array.isArray(data17)){let missing4: any;if((((data17.residentKey === undefined) && (missing4 = "residentKey")) || ((data17.requireResidentKey === undefined) && (missing4 = "requireResidentKey"))) || ((data17.userVerification === undefined) && (missing4 = "userVerification"))){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection",schemaPath:"#/$defs/AuthenticatorSelection/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs44: any = errors;for(const key4 in data17){if(!(((key4 === "residentKey") || (key4 === "requireResidentKey")) || (key4 === "userVerification"))){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection",schemaPath:"#/$defs/AuthenticatorSelection/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs44 === errors){if(data17.residentKey !== undefined){let data18: any = data17.residentKey;const _errs45: any = errors;if(typeof data18 !== "string"){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection/residentKey",schemaPath:"#/$defs/AuthenticatorSelection/properties/residentKey/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data18 === "required")){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection/residentKey",schemaPath:"#/$defs/AuthenticatorSelection/properties/residentKey/enum",keyword:"enum",params:{allowedValues: schema4484.properties.residentKey.enum}}];return false;}var valid11: any = _errs45 === errors;}else {var valid11: any = true;}if(valid11){if(data17.requireResidentKey !== undefined){let data19: any = data17.requireResidentKey;const _errs47: any = errors;if(typeof data19 !== "boolean"){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection/requireResidentKey",schemaPath:"#/$defs/AuthenticatorSelection/properties/requireResidentKey/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data19){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection/requireResidentKey",schemaPath:"#/$defs/AuthenticatorSelection/properties/requireResidentKey/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid11: any = _errs47 === errors;}else {var valid11: any = true;}if(valid11){if(data17.userVerification !== undefined){let data20: any = data17.userVerification;const _errs49: any = errors;if(typeof data20 !== "string"){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection/userVerification",schemaPath:"#/$defs/AuthenticatorSelection/properties/userVerification/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data20 === "required")){validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection/userVerification",schemaPath:"#/$defs/AuthenticatorSelection/properties/userVerification/enum",keyword:"enum",params:{allowedValues: schema4484.properties.userVerification.enum}}];return false;}var valid11: any = _errs49 === errors;}else {var valid11: any = true;}}}}}}else {validate2263.errors = [{instancePath:instancePath+"/authenticatorSelection",schemaPath:"#/$defs/AuthenticatorSelection/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs41 === errors;}else {var valid0: any = true;}if(valid0){if(data.attestation !== undefined){let data21: any = data.attestation;const _errs51: any = errors;if(typeof data21 !== "string"){validate2263.errors = [{instancePath:instancePath+"/attestation",schemaPath:"#/properties/attestation/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data21 === "none")){validate2263.errors = [{instancePath:instancePath+"/attestation",schemaPath:"#/properties/attestation/enum",keyword:"enum",params:{allowedValues: schema4478.properties.attestation.enum}}];return false;}var valid0: any = _errs51 === errors;}else {var valid0: any = true;}if(valid0){if(data.extensions !== undefined){let data22: any = data.extensions;const _errs53: any = errors;const _errs54: any = errors;if(errors === _errs54){if(data22 && typeof data22 == "object" && !Array.isArray(data22)){let missing5: any;if((data22.credProps === undefined) && (missing5 = "credProps")){validate2263.errors = [{instancePath:instancePath+"/extensions",schemaPath:"#/$defs/RegistrationExtensions/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs56: any = errors;for(const key5 in data22){if(!(key5 === "credProps")){validate2263.errors = [{instancePath:instancePath+"/extensions",schemaPath:"#/$defs/RegistrationExtensions/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs56 === errors){if(data22.credProps !== undefined){let data23: any = data22.credProps;if(typeof data23 !== "boolean"){validate2263.errors = [{instancePath:instancePath+"/extensions/credProps",schemaPath:"#/$defs/RegistrationExtensions/properties/credProps/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data23){validate2263.errors = [{instancePath:instancePath+"/extensions/credProps",schemaPath:"#/$defs/RegistrationExtensions/properties/credProps/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate2263.errors = [{instancePath:instancePath+"/extensions",schemaPath:"#/$defs/RegistrationExtensions/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs53 === errors;}else {var valid0: any = true;}if(valid0){if(data.hints !== undefined){let data24: any = data.hints;const _errs59: any = errors;if(errors === _errs59){if(Array.isArray(data24)){var valid14: any = true;const len3: any = data24.length;for(let i3=0; i3<len3; i3++){let data25: any = data24[i3];const _errs61: any = errors;if(typeof data25 !== "string"){validate2263.errors = [{instancePath:instancePath+"/hints/" + i3,schemaPath:"#/$defs/PublicKeyCredentialHint/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data25 === "security-key") || (data25 === "client-device")) || (data25 === "hybrid"))){validate2263.errors = [{instancePath:instancePath+"/hints/" + i3,schemaPath:"#/$defs/PublicKeyCredentialHint/enum",keyword:"enum",params:{allowedValues: schema4486.enum}}];return false;}var valid14: any = _errs61 === errors;if(!valid14){break;}}}else {validate2263.errors = [{instancePath:instancePath+"/hints",schemaPath:"#/properties/hints/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs59 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validate2263.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2263.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2263.errors = null as any[] | null;
// prettier-ignore
validate2263.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2262(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnRegistrationOptionsIssueResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2262.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.options === undefined) && (missing0 = "options"))){validate2262.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "transactionId") || (key0 === "options"))){validate2262.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){let data0: any = data.transactionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2262.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2262.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){const _errs6: any = errors;if(!(validate2263.call(this, data.options, {instancePath:instancePath+"/options",parentData:data,parentDataProperty:"options",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2263.errors : vErrors.concat(validate2263.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2262.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2262.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2262.errors = null as any[] | null;
// prettier-ignore
validate2262.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4489: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id."},"rawId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id again."},"response":{"$ref":"#/$defs/AttestationResponse","description":"The authenticator's answer."},"authenticatorAttachment":{"$ref":"#/$defs/AuthenticatorAttachment","description":"Where the authenticator sits."},"clientExtensionResults":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"The client's extension outputs, whatever extensions it ran."},"type":{"description":"The credential type.","type":"string","enum":["public-key"]}},"required":["id","rawId","response","clientExtensionResults","type"],"description":"A credential `create()` made, in `WebAuthn`'s JSON form."};
// prettier-ignore
const formats62 = SCHEMA_FORMATS.int64;
// prettier-ignore
function validate2268(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2268.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.id === undefined) && (missing0 = "id")) || ((data.rawId === undefined) && (missing0 = "rawId"))) || ((data.response === undefined) && (missing0 = "response"))) || ((data.clientExtensionResults === undefined) && (missing0 = "clientExtensionResults"))) || ((data.type === undefined) && (missing0 = "type"))){validate2268.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "rawId")) || (key0 === "response")) || (key0 === "authenticatorAttachment")) || (key0 === "clientExtensionResults")) || (key0 === "type"))){validate2268.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validate2268.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validate2268.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data0)){validate2268.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2268.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.rawId !== undefined){let data1: any = data.rawId;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 1364){validate2268.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data1) < 1){validate2268.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data1)){validate2268.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2268.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){let data2: any = data.response;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((data2.clientDataJSON === undefined) && (missing1 = "clientDataJSON")) || ((data2.attestationObject === undefined) && (missing1 = "attestationObject"))){validate2268.errors = [{instancePath:instancePath+"/response",schemaPath:"#/$defs/AttestationResponse/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data2){if(!((((((key1 === "clientDataJSON") || (key1 === "attestationObject")) || (key1 === "authenticatorData")) || (key1 === "transports")) || (key1 === "publicKeyAlgorithm")) || (key1 === "publicKey"))){validate2268.errors = [{instancePath:instancePath+"/response",schemaPath:"#/$defs/AttestationResponse/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data2.clientDataJSON !== undefined){let data3: any = data2.clientDataJSON;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 16384){validate2268.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AttestationResponse/properties/clientDataJSON/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data3) < 1){validate2268.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AttestationResponse/properties/clientDataJSON/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data3)){validate2268.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AttestationResponse/properties/clientDataJSON/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2268.errors = [{instancePath:instancePath+"/response/clientDataJSON",schemaPath:"#/$defs/AttestationResponse/properties/clientDataJSON/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data2.attestationObject !== undefined){let data4: any = data2.attestationObject;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) > 16384){validate2268.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AttestationResponse/properties/attestationObject/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data4) < 1){validate2268.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AttestationResponse/properties/attestationObject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data4)){validate2268.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AttestationResponse/properties/attestationObject/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2268.errors = [{instancePath:instancePath+"/response/attestationObject",schemaPath:"#/$defs/AttestationResponse/properties/attestationObject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data2.authenticatorData !== undefined){let data5: any = data2.authenticatorData;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 16384){validate2268.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AttestationResponse/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data5) < 1){validate2268.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AttestationResponse/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data5)){validate2268.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AttestationResponse/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2268.errors = [{instancePath:instancePath+"/response/authenticatorData",schemaPath:"#/$defs/AttestationResponse/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data2.transports !== undefined){let data6: any = data2.transports;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data6)){if(data6.length > 16){validate2268.errors = [{instancePath:instancePath+"/response/transports",schemaPath:"#/$defs/AttestationResponse/properties/transports/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {var valid3: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs18: any = errors;if(errors === _errs18){if(typeof data7 === "string"){if(func1(data7) > 32){validate2268.errors = [{instancePath:instancePath+"/response/transports/" + i0,schemaPath:"#/$defs/AttestationResponse/properties/transports/items/maxLength",keyword:"maxLength",params:{limit: 32}}];return false;}else {if(func1(data7) < 1){validate2268.errors = [{instancePath:instancePath+"/response/transports/" + i0,schemaPath:"#/$defs/AttestationResponse/properties/transports/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2268.errors = [{instancePath:instancePath+"/response/transports/" + i0,schemaPath:"#/$defs/AttestationResponse/properties/transports/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs18 === errors;if(!valid3){break;}}}}else {validate2268.errors = [{instancePath:instancePath+"/response/transports",schemaPath:"#/$defs/AttestationResponse/properties/transports/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data2.publicKeyAlgorithm !== undefined){let data8: any = data2.publicKeyAlgorithm;const _errs20: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate2268.errors = [{instancePath:instancePath+"/response/publicKeyAlgorithm",schemaPath:"#/$defs/AttestationResponse/properties/publicKeyAlgorithm/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data8 == "number") && (isFinite(data8))){if(!(formats62.validate(data8))){validate2268.errors = [{instancePath:instancePath+"/response/publicKeyAlgorithm",schemaPath:"#/$defs/AttestationResponse/properties/publicKeyAlgorithm/format",keyword:"format",params:{format: "int64"}}];return false;}}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data2.publicKey !== undefined){let data9: any = data2.publicKey;const _errs22: any = errors;if(errors === _errs22){if(typeof data9 === "string"){if(func1(data9) > 16384){validate2268.errors = [{instancePath:instancePath+"/response/publicKey",schemaPath:"#/$defs/AttestationResponse/properties/publicKey/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data9) < 1){validate2268.errors = [{instancePath:instancePath+"/response/publicKey",schemaPath:"#/$defs/AttestationResponse/properties/publicKey/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data9)){validate2268.errors = [{instancePath:instancePath+"/response/publicKey",schemaPath:"#/$defs/AttestationResponse/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2268.errors = [{instancePath:instancePath+"/response/publicKey",schemaPath:"#/$defs/AttestationResponse/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}}}}}}}}}else {validate2268.errors = [{instancePath:instancePath+"/response",schemaPath:"#/$defs/AttestationResponse/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorAttachment !== undefined){let data10: any = data.authenticatorAttachment;const _errs24: any = errors;if(typeof data10 !== "string"){validate2268.errors = [{instancePath:instancePath+"/authenticatorAttachment",schemaPath:"#/$defs/AuthenticatorAttachment/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data10 === "platform") || (data10 === "cross-platform"))){validate2268.errors = [{instancePath:instancePath+"/authenticatorAttachment",schemaPath:"#/$defs/AuthenticatorAttachment/enum",keyword:"enum",params:{allowedValues: schema4471.enum}}];return false;}var valid0: any = _errs24 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientExtensionResults !== undefined){let data11: any = data.clientExtensionResults;const _errs27: any = errors;if(errors === _errs27){if(data11 && typeof data11 == "object" && !Array.isArray(data11)){for(const key2 in data11){const _errs29: any = errors;const _errs30: any = errors;if(typeof key2 !== "string"){const err0: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key2};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid6: any = _errs30 === errors;if(valid6){const _errs32: any = errors;const _errs33: any = errors;const _errs34: any = errors;if("__proto__" !== key2){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid7: any = _errs34 === errors;if(valid7){const err2: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key2};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs33;if(vErrors !== null){if(_errs33){vErrors.length = _errs33;}else {vErrors = null;}}}var valid6: any = _errs32 === errors;}var valid5: any = _errs29 === errors;if(!valid5){const err3: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames",keyword:"propertyNames",params:{propertyName: key2}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2268.errors = vErrors;return false;break;}}if(valid5){for(const key3 in data11){const _errs36: any = errors;var valid8: any = _errs36 === errors;if(!valid8){break;}}}}else {validate2268.errors = [{instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data13: any = data.type;const _errs38: any = errors;if(typeof data13 !== "string"){validate2268.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data13 === "public-key")){validate2268.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema4489.properties.type.enum}}];return false;}var valid0: any = _errs38 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate2268.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2268.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2268.errors = null as any[] | null;
// prettier-ignore
validate2268.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2267(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnRegistrationVerifyRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2267.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.response === undefined) && (missing0 = "response"))){validate2267.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "transactionId") || (key0 === "response"))){validate2267.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){let data0: any = data.transactionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2267.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2267.errors = [{instancePath:instancePath+"/transactionId",schemaPath:"#/$defs/WebAuthnTransactionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){const _errs6: any = errors;if(!(validate2268.call(this, data.response, {instancePath:instancePath+"/response",parentData:data,parentDataProperty:"response",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2268.errors : vErrors.concat(validate2268.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2267.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2267.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2267.errors = null as any[] | null;
// prettier-ignore
validate2267.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern3139 = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u");
// prettier-ignore
function validate2224(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2224.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.coseAlgorithm === undefined) && (missing0 = "coseAlgorithm")) || ((data.coseKey === undefined) && (missing0 = "coseKey"))){validate2224.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "coseAlgorithm") || (key0 === "coseKey"))){validate2224.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.coseAlgorithm !== undefined){let data0: any = data.coseAlgorithm;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate2224.errors = [{instancePath:instancePath+"/coseAlgorithm",schemaPath:"#/$defs/CoseAlgorithm/type",keyword:"type",params:{type: "integer"}}];return false;}if(!(((data0 === -8) || (data0 === -7)) || (data0 === -257))){validate2224.errors = [{instancePath:instancePath+"/coseAlgorithm",schemaPath:"#/$defs/CoseAlgorithm/enum",keyword:"enum",params:{allowedValues: schema801.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.coseKey !== undefined){let data1: any = data.coseKey;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 4096){validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data1)){validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2224.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2224.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2224.errors = null as any[] | null;
// prettier-ignore
validate2224.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2270(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnRegistrationVerifyResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2270.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.passkeyId === undefined) && (missing0 = "passkeyId")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))) || ((data.aaguid === undefined) && (missing0 = "aaguid"))){validate2270.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "passkeyId") || (key0 === "publicKey")) || (key0 === "aaguid")) || (key0 === "providerName"))){validate2270.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.passkeyId !== undefined){let data0: any = data.passkeyId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validate2270.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validate2270.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data0)){validate2270.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2270.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.publicKey !== undefined){const _errs4: any = errors;if(!(validate2224.call(this, data.publicKey, {instancePath:instancePath+"/publicKey",parentData:data,parentDataProperty:"publicKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2224.errors : vErrors.concat(validate2224.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.aaguid !== undefined){let data2: any = data.aaguid;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(!pattern3139.test(data2)){validate2270.errors = [{instancePath:instancePath+"/aaguid",schemaPath:"#/$defs/Aaguid/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}];return false;}}else {validate2270.errors = [{instancePath:instancePath+"/aaguid",schemaPath:"#/$defs/Aaguid/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerName !== undefined){let data3: any = data.providerName;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) > 128){validate2270.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validate2270.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate2270.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2270.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validate2270.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2270.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2270.errors = null as any[] | null;
// prettier-ignore
validate2270.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnAuthenticationOptionsIssueRequest}. */
export const validateWebAuthnAuthenticationOptionsIssueRequest: SchemaCheck<WebAuthnAuthenticationOptionsIssueRequest> =
  validate2256;
/** Checks that a value is a {@link WebAuthnAuthenticationOptionsIssueResponse}. */
export const validateWebAuthnAuthenticationOptionsIssueResponse: SchemaCheck<WebAuthnAuthenticationOptionsIssueResponse> =
  validate2257;
/** Checks that a value is a {@link WebAuthnAuthenticationVerifyRequest}. */
export const validateWebAuthnAuthenticationVerifyRequest: SchemaCheck<WebAuthnAuthenticationVerifyRequest> =
  validate2258;
/** Checks that a value is a {@link WebAuthnAuthenticationVerifyResponse}. */
export const validateWebAuthnAuthenticationVerifyResponse: SchemaCheck<WebAuthnAuthenticationVerifyResponse> =
  validate2261;
/** Checks that a value is a {@link WebAuthnRegistrationOptionsIssueResponse}. */
export const validateWebAuthnRegistrationOptionsIssueResponse: SchemaCheck<WebAuthnRegistrationOptionsIssueResponse> =
  validate2262;
/** Checks that a value is a {@link WebAuthnRegistrationVerifyRequest}. */
export const validateWebAuthnRegistrationVerifyRequest: SchemaCheck<WebAuthnRegistrationVerifyRequest> =
  validate2267;
/** Checks that a value is a {@link WebAuthnRegistrationVerifyResponse}. */
export const validateWebAuthnRegistrationVerifyResponse: SchemaCheck<WebAuthnRegistrationVerifyResponse> =
  validate2270;

/** The methods of {@link WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS}, each with its checks. */
export interface WebauthnCeremonyMethodDescriptors {
  readonly "webauthn.registrationOptions.issue": {
    readonly method: "webauthn.registrationOptions.issue";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<WebAuthnRegistrationOptionsIssueResponse>;
  };
  readonly "webauthn.registration.verify": {
    readonly method: "webauthn.registration.verify";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WebAuthnRegistrationVerifyRequest>;
    readonly responseCheck: SchemaCheck<WebAuthnRegistrationVerifyResponse>;
  };
  readonly "webauthn.authenticationOptions.issue": {
    readonly method: "webauthn.authenticationOptions.issue";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WebAuthnAuthenticationOptionsIssueRequest>;
    readonly responseCheck: SchemaCheck<WebAuthnAuthenticationOptionsIssueResponse>;
  };
  readonly "webauthn.authentication.verify": {
    readonly method: "webauthn.authentication.verify";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WebAuthnAuthenticationVerifyRequest>;
    readonly responseCheck: SchemaCheck<WebAuthnAuthenticationVerifyResponse>;
  };
}
/** The passkey ceremonies the control plane serves, each one POST at `/<method>`. */
export const WEBAUTHN_CEREMONY_METHOD_DESCRIPTORS: WebauthnCeremonyMethodDescriptors =
  Object.freeze({
    "webauthn.registrationOptions.issue": Object.freeze({
      method: "webauthn.registrationOptions.issue",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateEmptyPayload,
      responseCheck: validateWebAuthnRegistrationOptionsIssueResponse,
    }),
    "webauthn.registration.verify": Object.freeze({
      method: "webauthn.registration.verify",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWebAuthnRegistrationVerifyRequest,
      responseCheck: validateWebAuthnRegistrationVerifyResponse,
    }),
    "webauthn.authenticationOptions.issue": Object.freeze({
      method: "webauthn.authenticationOptions.issue",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWebAuthnAuthenticationOptionsIssueRequest,
      responseCheck: validateWebAuthnAuthenticationOptionsIssueResponse,
    }),
    "webauthn.authentication.verify": Object.freeze({
      method: "webauthn.authentication.verify",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWebAuthnAuthenticationVerifyRequest,
      responseCheck: validateWebAuthnAuthenticationVerifyResponse,
    }),
  });
