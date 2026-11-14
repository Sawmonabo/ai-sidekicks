// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The passkey ceremonies the control plane runs as relying party: issuing registration and sign-in options, and verifying what the authenticator answered.
//
// Each issue leg records a single-use challenge and hands back the transaction id its verify leg quotes; a sign-in's verify reply carries a freshly issued token pair bound to the caller's DPoP key.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  ucs2length,
} from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type UserId, validateUserId } from "../session/id.js";
import {
  type CoseAlgorithm,
  type PasskeyPublicKey,
  type TrustStatementHash,
  validateCoseAlgorithm,
  validatePasskeyPublicKey,
  validateTrustStatementHash,
} from "../trust-statement.js";

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
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link WebAuthnTransactionId}. */
// prettier-ignore
export const validateWebAuthnTransactionId: CompiledSchemaCheck<WebAuthnTransactionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnTransactionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnTransactionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWebAuthnTransactionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWebAuthnTransactionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWebAuthnTransactionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnTransactionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern925 = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u");
/** Checks that a value is a {@link Aaguid}. */
// prettier-ignore
export const validateAaguid: CompiledSchemaCheck<Aaguid> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Aaguid {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAaguid.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern925.test(data)){validateAaguid.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}];return false;}}else {validateAaguid.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateAaguid.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAaguid.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern911 = new RegExp("^v4\\.public\\.[A-Za-z0-9_-]+$", "u");
/** Checks that a value is a {@link AccessToken}. */
// prettier-ignore
export const validateAccessToken: CompiledSchemaCheck<AccessToken> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AccessToken {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAccessToken.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern911.test(data)){validateAccessToken.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^v4\\.public\\.[A-Za-z0-9_-]+$"}}];return false;}}else {validateAccessToken.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateAccessToken.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAccessToken.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern912 = new RegExp("^v4\\.local\\.[A-Za-z0-9_-]+$", "u");
/** Checks that a value is a {@link RefreshToken}. */
// prettier-ignore
export const validateRefreshToken: CompiledSchemaCheck<RefreshToken> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RefreshToken {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRefreshToken.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern912.test(data)){validateRefreshToken.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^v4\\.local\\.[A-Za-z0-9_-]+$"}}];return false;}}else {validateRefreshToken.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateRefreshToken.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRefreshToken.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1388: any = {"description":"Where an authenticator sits, as the platform reports it.","type":"string","enum":["platform","cross-platform"]};
/** Checks that a value is a {@link AuthenticatorAttachment}. */
// prettier-ignore
export const validateAuthenticatorAttachment: CompiledSchemaCheck<AuthenticatorAttachment> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AuthenticatorAttachment {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAuthenticatorAttachment.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAuthenticatorAttachment.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "platform") || (data === "cross-platform"))){validateAuthenticatorAttachment.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1388.enum}}];return false;}validateAuthenticatorAttachment.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAuthenticatorAttachment.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1400: any = {"description":"A hint about which authenticator to offer first; the relying party sends none.","type":"string","enum":["security-key","client-device","hybrid"]};
/** Checks that a value is a {@link PublicKeyCredentialHint}. */
// prettier-ignore
export const validatePublicKeyCredentialHint: CompiledSchemaCheck<PublicKeyCredentialHint> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PublicKeyCredentialHint {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePublicKeyCredentialHint.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePublicKeyCredentialHint.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "security-key") || (data === "client-device")) || (data === "hybrid"))){validatePublicKeyCredentialHint.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1400.enum}}];return false;}validatePublicKeyCredentialHint.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePublicKeyCredentialHint.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link RelyingPartyEntity}. */
// prettier-ignore
export const validateRelyingPartyEntity: CompiledSchemaCheck<RelyingPartyEntity> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RelyingPartyEntity {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRelyingPartyEntity.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.name === undefined) && (missing0 = "name")) || ((data.id === undefined) && (missing0 = "id"))){validateRelyingPartyEntity.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "name") || (key0 === "id"))){validateRelyingPartyEntity.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 261){validateRelyingPartyEntity.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data0) < 1){validateRelyingPartyEntity.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateRelyingPartyEntity.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 261){validateRelyingPartyEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data1) < 1){validateRelyingPartyEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateRelyingPartyEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateRelyingPartyEntity.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRelyingPartyEntity.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRelyingPartyEntity.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern10 = new RegExp("^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$", "u");
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link UserEntity}. */
// prettier-ignore
export const validateUserEntity: CompiledSchemaCheck<UserEntity> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is UserEntity {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateUserEntity.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.id === undefined) && (missing0 = "id")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.displayName === undefined) && (missing0 = "displayName"))){validateUserEntity.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "id") || (key0 === "name")) || (key0 === "displayName"))){validateUserEntity.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 86){validateUserEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 86}}];return false;}else {if(func1(data0) < 1){validateUserEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateUserEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateUserEntity.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateUserEntity.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateUserEntity.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateUserEntity.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data2: any = data.displayName;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validateUserEntity.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateUserEntity.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateUserEntity.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateUserEntity.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateUserEntity.errors = vErrors;return errors === 0;};
// prettier-ignore
validateUserEntity.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1396: any = {"type":"object","additionalProperties":false,"properties":{"type":{"description":"The credential type.","type":"string","enum":["public-key"]},"alg":{"$ref":"sidekicks-contracts:trust-statement#/$defs/CoseAlgorithm","description":"The algorithm."}},"required":["type","alg"],"description":"One algorithm the relying party takes."};
/** Checks that a value is a {@link CredentialParameter}. */
// prettier-ignore
export const validateCredentialParameter: CompiledSchemaCheck<CredentialParameter> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CredentialParameter {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCredentialParameter.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.type === undefined) && (missing0 = "type")) || ((data.alg === undefined) && (missing0 = "alg"))){validateCredentialParameter.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "type") || (key0 === "alg"))){validateCredentialParameter.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs2: any = errors;if(typeof data0 !== "string"){validateCredentialParameter.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "public-key")){validateCredentialParameter.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema1396.properties.type.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.alg !== undefined){const _errs4: any = errors;if(!(validateCoseAlgorithm.call(this, data.alg, {instancePath:instancePath+"/alg",parentData:data,parentDataProperty:"alg",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCoseAlgorithm.errors : vErrors.concat(validateCoseAlgorithm.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateCredentialParameter.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCredentialParameter.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCredentialParameter.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1397: any = {"type":"object","additionalProperties":false,"properties":{"type":{"description":"The credential type.","type":"string","enum":["public-key"]},"id":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The passkey's credential id."},"transports":{"type":"array","items":{"type":"string","minLength":1,"maxLength":32},"maxItems":16,"description":"The transports its authenticator reported."}},"required":["type","id","transports"],"description":"A passkey the account already holds, so the authenticator does not make a second one."};
/** Checks that a value is a {@link CredentialDescriptor}. */
// prettier-ignore
export const validateCredentialDescriptor: CompiledSchemaCheck<CredentialDescriptor> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CredentialDescriptor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCredentialDescriptor.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.type === undefined) && (missing0 = "type")) || ((data.id === undefined) && (missing0 = "id"))) || ((data.transports === undefined) && (missing0 = "transports"))){validateCredentialDescriptor.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "type") || (key0 === "id")) || (key0 === "transports"))){validateCredentialDescriptor.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs2: any = errors;if(typeof data0 !== "string"){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "public-key")){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema1397.properties.type.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 1364){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data1) < 1){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data1)){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateCredentialDescriptor.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.transports !== undefined){let data2: any = data.transports;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data2)){if(data2.length > 16){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/transports",schemaPath:"#/properties/transports/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){let data3: any = data2[i0];const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) > 32){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/transports/" + i0,schemaPath:"#/properties/transports/items/maxLength",keyword:"maxLength",params:{limit: 32}}];return false;}else {if(func1(data3) < 1){validateCredentialDescriptor.errors = [{instancePath:instancePath+"/transports/" + i0,schemaPath:"#/properties/transports/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateCredentialDescriptor.errors = [{instancePath:instancePath+"/transports/" + i0,schemaPath:"#/properties/transports/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs8 === errors;if(!valid1){break;}}}}else {validateCredentialDescriptor.errors = [{instancePath:instancePath+"/transports",schemaPath:"#/properties/transports/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateCredentialDescriptor.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCredentialDescriptor.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCredentialDescriptor.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1398: any = {"type":"object","additionalProperties":false,"properties":{"residentKey":{"description":"A discoverable credential.","type":"string","enum":["required"]},"requireResidentKey":{"type":"boolean","const":true,"description":"The same, in the older member."},"userVerification":{"description":"User verification.","type":"string","enum":["required"]}},"required":["residentKey","requireResidentKey","userVerification"],"description":"What the relying party asks of the authenticator."};
/** Checks that a value is a {@link AuthenticatorSelection}. */
// prettier-ignore
export const validateAuthenticatorSelection: CompiledSchemaCheck<AuthenticatorSelection> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AuthenticatorSelection {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAuthenticatorSelection.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.residentKey === undefined) && (missing0 = "residentKey")) || ((data.requireResidentKey === undefined) && (missing0 = "requireResidentKey"))) || ((data.userVerification === undefined) && (missing0 = "userVerification"))){validateAuthenticatorSelection.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "residentKey") || (key0 === "requireResidentKey")) || (key0 === "userVerification"))){validateAuthenticatorSelection.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.residentKey !== undefined){let data0: any = data.residentKey;const _errs2: any = errors;if(typeof data0 !== "string"){validateAuthenticatorSelection.errors = [{instancePath:instancePath+"/residentKey",schemaPath:"#/properties/residentKey/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "required")){validateAuthenticatorSelection.errors = [{instancePath:instancePath+"/residentKey",schemaPath:"#/properties/residentKey/enum",keyword:"enum",params:{allowedValues: schema1398.properties.residentKey.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.requireResidentKey !== undefined){let data1: any = data.requireResidentKey;const _errs4: any = errors;if(typeof data1 !== "boolean"){validateAuthenticatorSelection.errors = [{instancePath:instancePath+"/requireResidentKey",schemaPath:"#/properties/requireResidentKey/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateAuthenticatorSelection.errors = [{instancePath:instancePath+"/requireResidentKey",schemaPath:"#/properties/requireResidentKey/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.userVerification !== undefined){let data2: any = data.userVerification;const _errs6: any = errors;if(typeof data2 !== "string"){validateAuthenticatorSelection.errors = [{instancePath:instancePath+"/userVerification",schemaPath:"#/properties/userVerification/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "required")){validateAuthenticatorSelection.errors = [{instancePath:instancePath+"/userVerification",schemaPath:"#/properties/userVerification/enum",keyword:"enum",params:{allowedValues: schema1398.properties.userVerification.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateAuthenticatorSelection.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAuthenticatorSelection.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAuthenticatorSelection.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RegistrationExtensions}. */
// prettier-ignore
export const validateRegistrationExtensions: CompiledSchemaCheck<RegistrationExtensions> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RegistrationExtensions {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRegistrationExtensions.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.credProps === undefined) && (missing0 = "credProps")){validateRegistrationExtensions.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "credProps")){validateRegistrationExtensions.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.credProps !== undefined){let data0: any = data.credProps;if(typeof data0 !== "boolean"){validateRegistrationExtensions.errors = [{instancePath:instancePath+"/credProps",schemaPath:"#/properties/credProps/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validateRegistrationExtensions.errors = [{instancePath:instancePath+"/credProps",schemaPath:"#/properties/credProps/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validateRegistrationExtensions.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRegistrationExtensions.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRegistrationExtensions.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1393: any = {"type":"object","additionalProperties":false,"properties":{"rp":{"$ref":"#/$defs/RelyingPartyEntity","description":"The relying party."},"user":{"$ref":"#/$defs/UserEntity","description":"The account."},"challenge":{"type":"string","minLength":43,"maxLength":43,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The challenge."},"pubKeyCredParams":{"type":"array","items":{"$ref":"#/$defs/CredentialParameter"},"description":"The algorithms taken: `EdDSA`, ES256 and RS256."},"timeout":{"type":"integer","format":"uint32","minimum":0,"description":"How long the ceremony may take, in milliseconds."},"excludeCredentials":{"type":"array","items":{"$ref":"#/$defs/CredentialDescriptor"},"description":"The account's passkeys."},"authenticatorSelection":{"$ref":"#/$defs/AuthenticatorSelection","description":"What the authenticator must do."},"attestation":{"description":"No attestation.","type":"string","enum":["none"]},"extensions":{"$ref":"#/$defs/RegistrationExtensions","description":"The extensions asked for."},"hints":{"type":"array","items":{"$ref":"#/$defs/PublicKeyCredentialHint"},"description":"No hint."}},"required":["rp","user","challenge","pubKeyCredParams","timeout","excludeCredentials","authenticatorSelection","attestation","extensions","hints"],"description":"The options a client passes to `navigator.credentials.create()`, in `WebAuthn`'s JSON form."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const formats22 = SCHEMA_FORMATS.uint32;
/** Checks that a value is a {@link RegistrationOptions}. */
// prettier-ignore
export const validateRegistrationOptions: CompiledSchemaCheck<RegistrationOptions> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RegistrationOptions {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRegistrationOptions.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.rp === undefined) && (missing0 = "rp")) || ((data.user === undefined) && (missing0 = "user"))) || ((data.challenge === undefined) && (missing0 = "challenge"))) || ((data.pubKeyCredParams === undefined) && (missing0 = "pubKeyCredParams"))) || ((data.timeout === undefined) && (missing0 = "timeout"))) || ((data.excludeCredentials === undefined) && (missing0 = "excludeCredentials"))) || ((data.authenticatorSelection === undefined) && (missing0 = "authenticatorSelection"))) || ((data.attestation === undefined) && (missing0 = "attestation"))) || ((data.extensions === undefined) && (missing0 = "extensions"))) || ((data.hints === undefined) && (missing0 = "hints"))){validateRegistrationOptions.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1393.properties, key0))){validateRegistrationOptions.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.rp !== undefined){const _errs2: any = errors;if(!(validateRelyingPartyEntity.call(this, data.rp, {instancePath:instancePath+"/rp",parentData:data,parentDataProperty:"rp",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRelyingPartyEntity.errors : vErrors.concat(validateRelyingPartyEntity.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.user !== undefined){const _errs3: any = errors;if(!(validateUserEntity.call(this, data.user, {instancePath:instancePath+"/user",parentData:data,parentDataProperty:"user",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserEntity.errors : vErrors.concat(validateUserEntity.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.challenge !== undefined){let data2: any = data.challenge;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 43){validateRegistrationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data2) < 43){validateRegistrationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern10.test(data2)){validateRegistrationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateRegistrationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.pubKeyCredParams !== undefined){let data3: any = data.pubKeyCredParams;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validateCredentialParameter.call(this, data3[i0], {instancePath:instancePath+"/pubKeyCredParams/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCredentialParameter.errors : vErrors.concat(validateCredentialParameter.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}else {validateRegistrationOptions.errors = [{instancePath:instancePath+"/pubKeyCredParams",schemaPath:"#/properties/pubKeyCredParams/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.timeout !== undefined){let data5: any = data.timeout;const _errs9: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateRegistrationOptions.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data5 == "number") && (isFinite(data5))){if(data5 < 0 || isNaN(data5)){validateRegistrationOptions.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}else {if(!(formats22.validate(data5))){validateRegistrationOptions.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/format",keyword:"format",params:{format: "uint32"}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.excludeCredentials !== undefined){let data6: any = data.excludeCredentials;const _errs11: any = errors;if(errors === _errs11){if(Array.isArray(data6)){var valid2: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){const _errs13: any = errors;if(!(validateCredentialDescriptor.call(this, data6[i1], {instancePath:instancePath+"/excludeCredentials/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCredentialDescriptor.errors : vErrors.concat(validateCredentialDescriptor.errors);errors = vErrors.length;}var valid2: any = _errs13 === errors;if(!valid2){break;}}}else {validateRegistrationOptions.errors = [{instancePath:instancePath+"/excludeCredentials",schemaPath:"#/properties/excludeCredentials/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorSelection !== undefined){const _errs14: any = errors;if(!(validateAuthenticatorSelection.call(this, data.authenticatorSelection, {instancePath:instancePath+"/authenticatorSelection",parentData:data,parentDataProperty:"authenticatorSelection",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAuthenticatorSelection.errors : vErrors.concat(validateAuthenticatorSelection.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.attestation !== undefined){let data9: any = data.attestation;const _errs15: any = errors;if(typeof data9 !== "string"){validateRegistrationOptions.errors = [{instancePath:instancePath+"/attestation",schemaPath:"#/properties/attestation/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data9 === "none")){validateRegistrationOptions.errors = [{instancePath:instancePath+"/attestation",schemaPath:"#/properties/attestation/enum",keyword:"enum",params:{allowedValues: schema1393.properties.attestation.enum}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.extensions !== undefined){const _errs17: any = errors;if(!(validateRegistrationExtensions.call(this, data.extensions, {instancePath:instancePath+"/extensions",parentData:data,parentDataProperty:"extensions",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRegistrationExtensions.errors : vErrors.concat(validateRegistrationExtensions.errors);errors = vErrors.length;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.hints !== undefined){let data11: any = data.hints;const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data11)){var valid3: any = true;const len2: any = data11.length;for(let i2=0; i2<len2; i2++){const _errs20: any = errors;if(!(validatePublicKeyCredentialHint.call(this, data11[i2], {instancePath:instancePath+"/hints/" + i2,parentData:data11,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePublicKeyCredentialHint.errors : vErrors.concat(validatePublicKeyCredentialHint.errors);errors = vErrors.length;}var valid3: any = _errs20 === errors;if(!valid3){break;}}}else {validateRegistrationOptions.errors = [{instancePath:instancePath+"/hints",schemaPath:"#/properties/hints/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validateRegistrationOptions.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRegistrationOptions.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRegistrationOptions.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1384: any = {"type":"object","additionalProperties":false,"properties":{"challenge":{"type":"string","minLength":43,"maxLength":43,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The challenge."},"rpId":{"type":"string","minLength":1,"maxLength":261,"description":"The relying party id."},"timeout":{"type":"integer","format":"uint32","minimum":0,"description":"How long the ceremony may take, in milliseconds."},"userVerification":{"description":"User verification.","type":"string","enum":["required"]}},"required":["challenge","rpId","timeout","userVerification"],"description":"The options a client passes to `navigator.credentials.get()`, in `WebAuthn`'s JSON form: no\n`allowCredentials`, so the authenticator offers any passkey it holds for the relying party."};
/** Checks that a value is a {@link AuthenticationOptions}. */
// prettier-ignore
export const validateAuthenticationOptions: CompiledSchemaCheck<AuthenticationOptions> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AuthenticationOptions {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAuthenticationOptions.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.challenge === undefined) && (missing0 = "challenge")) || ((data.rpId === undefined) && (missing0 = "rpId"))) || ((data.timeout === undefined) && (missing0 = "timeout"))) || ((data.userVerification === undefined) && (missing0 = "userVerification"))){validateAuthenticationOptions.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "challenge") || (key0 === "rpId")) || (key0 === "timeout")) || (key0 === "userVerification"))){validateAuthenticationOptions.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.challenge !== undefined){let data0: any = data.challenge;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 43){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data0) < 43){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern10.test(data0)){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAuthenticationOptions.errors = [{instancePath:instancePath+"/challenge",schemaPath:"#/properties/challenge/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.rpId !== undefined){let data1: any = data.rpId;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 261){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/rpId",schemaPath:"#/properties/rpId/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data1) < 1){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/rpId",schemaPath:"#/properties/rpId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateAuthenticationOptions.errors = [{instancePath:instancePath+"/rpId",schemaPath:"#/properties/rpId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.timeout !== undefined){let data2: any = data.timeout;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 < 0 || isNaN(data2)){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}else {if(!(formats22.validate(data2))){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/timeout",schemaPath:"#/properties/timeout/format",keyword:"format",params:{format: "uint32"}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.userVerification !== undefined){let data3: any = data.userVerification;const _errs8: any = errors;if(typeof data3 !== "string"){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/userVerification",schemaPath:"#/properties/userVerification/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data3 === "required")){validateAuthenticationOptions.errors = [{instancePath:instancePath+"/userVerification",schemaPath:"#/properties/userVerification/enum",keyword:"enum",params:{allowedValues: schema1384.properties.userVerification.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validateAuthenticationOptions.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAuthenticationOptions.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAuthenticationOptions.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnRegistrationOptionsIssueResponse}. */
// prettier-ignore
export const validateWebAuthnRegistrationOptionsIssueResponse: CompiledSchemaCheck<WebAuthnRegistrationOptionsIssueResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnRegistrationOptionsIssueResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnRegistrationOptionsIssueResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.options === undefined) && (missing0 = "options"))){validateWebAuthnRegistrationOptionsIssueResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "transactionId") || (key0 === "options"))){validateWebAuthnRegistrationOptionsIssueResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){const _errs2: any = errors;if(!(validateWebAuthnTransactionId.call(this, data.transactionId, {instancePath:instancePath+"/transactionId",parentData:data,parentDataProperty:"transactionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWebAuthnTransactionId.errors : vErrors.concat(validateWebAuthnTransactionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){const _errs3: any = errors;if(!(validateRegistrationOptions.call(this, data.options, {instancePath:instancePath+"/options",parentData:data,parentDataProperty:"options",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRegistrationOptions.errors : vErrors.concat(validateRegistrationOptions.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWebAuthnRegistrationOptionsIssueResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnRegistrationOptionsIssueResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnRegistrationOptionsIssueResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnAuthenticationOptionsIssueRequest}. */
// prettier-ignore
export const validateWebAuthnAuthenticationOptionsIssueRequest: CompiledSchemaCheck<WebAuthnAuthenticationOptionsIssueRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationOptionsIssueRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnAuthenticationOptionsIssueRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "statementHash")){validateWebAuthnAuthenticationOptionsIssueRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.statementHash !== undefined){if(!(validateTrustStatementHash.call(this, data.statementHash, {instancePath:instancePath+"/statementHash",parentData:data,parentDataProperty:"statementHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}}}}else {validateWebAuthnAuthenticationOptionsIssueRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnAuthenticationOptionsIssueRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnAuthenticationOptionsIssueRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnAuthenticationOptionsIssueResponse}. */
// prettier-ignore
export const validateWebAuthnAuthenticationOptionsIssueResponse: CompiledSchemaCheck<WebAuthnAuthenticationOptionsIssueResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationOptionsIssueResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnAuthenticationOptionsIssueResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.origin === undefined) && (missing0 = "origin"))) || ((data.options === undefined) && (missing0 = "options"))){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "transactionId") || (key0 === "origin")) || (key0 === "options")) || (key0 === "challengeNonce"))){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){const _errs2: any = errors;if(!(validateWebAuthnTransactionId.call(this, data.transactionId, {instancePath:instancePath+"/transactionId",parentData:data,parentDataProperty:"transactionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWebAuthnTransactionId.errors : vErrors.concat(validateWebAuthnTransactionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){let data1: any = data.origin;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 261){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/maxLength",keyword:"maxLength",params:{limit: 261}}];return false;}else {if(func1(data1) < 1){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/properties/origin/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){const _errs5: any = errors;if(!(validateAuthenticationOptions.call(this, data.options, {instancePath:instancePath+"/options",parentData:data,parentDataProperty:"options",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAuthenticationOptions.errors : vErrors.concat(validateAuthenticationOptions.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.challengeNonce !== undefined){let data3: any = data.challengeNonce;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) > 43){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data3) < 43){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern10.test(data3)){validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/properties/challengeNonce/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateWebAuthnAuthenticationOptionsIssueResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnAuthenticationOptionsIssueResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnAuthenticationOptionsIssueResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const formats26 = SCHEMA_FORMATS.int64;
/** Checks that a value is a {@link AttestationResponse}. */
// prettier-ignore
export const validateAttestationResponse: CompiledSchemaCheck<AttestationResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttestationResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttestationResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.clientDataJSON === undefined) && (missing0 = "clientDataJSON")) || ((data.attestationObject === undefined) && (missing0 = "attestationObject"))){validateAttestationResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "clientDataJSON") || (key0 === "attestationObject")) || (key0 === "authenticatorData")) || (key0 === "transports")) || (key0 === "publicKeyAlgorithm")) || (key0 === "publicKey"))){validateAttestationResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientDataJSON !== undefined){let data0: any = data.clientDataJSON;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 16384){validateAttestationResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data0) < 1){validateAttestationResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateAttestationResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAttestationResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attestationObject !== undefined){let data1: any = data.attestationObject;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 16384){validateAttestationResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data1) < 1){validateAttestationResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data1)){validateAttestationResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAttestationResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorData !== undefined){let data2: any = data.authenticatorData;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 16384){validateAttestationResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data2) < 1){validateAttestationResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data2)){validateAttestationResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAttestationResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.transports !== undefined){let data3: any = data.transports;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data3)){if(data3.length > 16){validateAttestationResponse.errors = [{instancePath:instancePath+"/transports",schemaPath:"#/properties/transports/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){let data4: any = data3[i0];const _errs10: any = errors;if(errors === _errs10){if(typeof data4 === "string"){if(func1(data4) > 32){validateAttestationResponse.errors = [{instancePath:instancePath+"/transports/" + i0,schemaPath:"#/properties/transports/items/maxLength",keyword:"maxLength",params:{limit: 32}}];return false;}else {if(func1(data4) < 1){validateAttestationResponse.errors = [{instancePath:instancePath+"/transports/" + i0,schemaPath:"#/properties/transports/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateAttestationResponse.errors = [{instancePath:instancePath+"/transports/" + i0,schemaPath:"#/properties/transports/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs10 === errors;if(!valid1){break;}}}}else {validateAttestationResponse.errors = [{instancePath:instancePath+"/transports",schemaPath:"#/properties/transports/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.publicKeyAlgorithm !== undefined){let data5: any = data.publicKeyAlgorithm;const _errs12: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateAttestationResponse.errors = [{instancePath:instancePath+"/publicKeyAlgorithm",schemaPath:"#/properties/publicKeyAlgorithm/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data5 == "number") && (isFinite(data5))){if(!(formats26.validate(data5))){validateAttestationResponse.errors = [{instancePath:instancePath+"/publicKeyAlgorithm",schemaPath:"#/properties/publicKeyAlgorithm/format",keyword:"format",params:{format: "int64"}}];return false;}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.publicKey !== undefined){let data6: any = data.publicKey;const _errs14: any = errors;if(errors === _errs14){if(typeof data6 === "string"){if(func1(data6) > 16384){validateAttestationResponse.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/properties/publicKey/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data6) < 1){validateAttestationResponse.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/properties/publicKey/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data6)){validateAttestationResponse.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAttestationResponse.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateAttestationResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttestationResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttestationResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1402: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id."},"rawId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id again."},"response":{"$ref":"#/$defs/AttestationResponse","description":"The authenticator's answer."},"authenticatorAttachment":{"$ref":"#/$defs/AuthenticatorAttachment","description":"Where the authenticator sits."},"clientExtensionResults":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"The client's extension outputs, whatever extensions it ran."},"type":{"description":"The credential type.","type":"string","enum":["public-key"]}},"required":["id","rawId","response","clientExtensionResults","type"],"description":"A credential `create()` made, in `WebAuthn`'s JSON form."};
/** Checks that a value is a {@link RegistrationResponse}. */
// prettier-ignore
export const validateRegistrationResponse: CompiledSchemaCheck<RegistrationResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RegistrationResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRegistrationResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.id === undefined) && (missing0 = "id")) || ((data.rawId === undefined) && (missing0 = "rawId"))) || ((data.response === undefined) && (missing0 = "response"))) || ((data.clientExtensionResults === undefined) && (missing0 = "clientExtensionResults"))) || ((data.type === undefined) && (missing0 = "type"))){validateRegistrationResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "rawId")) || (key0 === "response")) || (key0 === "authenticatorAttachment")) || (key0 === "clientExtensionResults")) || (key0 === "type"))){validateRegistrationResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validateRegistrationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validateRegistrationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateRegistrationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateRegistrationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.rawId !== undefined){let data1: any = data.rawId;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 1364){validateRegistrationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data1) < 1){validateRegistrationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data1)){validateRegistrationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateRegistrationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){const _errs6: any = errors;if(!(validateAttestationResponse.call(this, data.response, {instancePath:instancePath+"/response",parentData:data,parentDataProperty:"response",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttestationResponse.errors : vErrors.concat(validateAttestationResponse.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorAttachment !== undefined){const _errs7: any = errors;if(!(validateAuthenticatorAttachment.call(this, data.authenticatorAttachment, {instancePath:instancePath+"/authenticatorAttachment",parentData:data,parentDataProperty:"authenticatorAttachment",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAuthenticatorAttachment.errors : vErrors.concat(validateAuthenticatorAttachment.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientExtensionResults !== undefined){let data4: any = data.clientExtensionResults;const _errs8: any = errors;if(errors === _errs8){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs10: any = errors;const _errs11: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs11 === errors;if(valid2){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs15 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid2: any = _errs13 === errors;}var valid1: any = _errs10 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateRegistrationResponse.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data4){const _errs17: any = errors;var valid4: any = _errs17 === errors;if(!valid4){break;}}}}else {validateRegistrationResponse.errors = [{instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data6: any = data.type;const _errs19: any = errors;if(typeof data6 !== "string"){validateRegistrationResponse.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data6 === "public-key")){validateRegistrationResponse.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema1402.properties.type.enum}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateRegistrationResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRegistrationResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRegistrationResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnRegistrationVerifyRequest}. */
// prettier-ignore
export const validateWebAuthnRegistrationVerifyRequest: CompiledSchemaCheck<WebAuthnRegistrationVerifyRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnRegistrationVerifyRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnRegistrationVerifyRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.response === undefined) && (missing0 = "response"))){validateWebAuthnRegistrationVerifyRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "transactionId") || (key0 === "response"))){validateWebAuthnRegistrationVerifyRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){const _errs2: any = errors;if(!(validateWebAuthnTransactionId.call(this, data.transactionId, {instancePath:instancePath+"/transactionId",parentData:data,parentDataProperty:"transactionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWebAuthnTransactionId.errors : vErrors.concat(validateWebAuthnTransactionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){const _errs3: any = errors;if(!(validateRegistrationResponse.call(this, data.response, {instancePath:instancePath+"/response",parentData:data,parentDataProperty:"response",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRegistrationResponse.errors : vErrors.concat(validateRegistrationResponse.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWebAuthnRegistrationVerifyRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnRegistrationVerifyRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnRegistrationVerifyRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnRegistrationVerifyResponse}. */
// prettier-ignore
export const validateWebAuthnRegistrationVerifyResponse: CompiledSchemaCheck<WebAuthnRegistrationVerifyResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnRegistrationVerifyResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnRegistrationVerifyResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.passkeyId === undefined) && (missing0 = "passkeyId")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))) || ((data.aaguid === undefined) && (missing0 = "aaguid"))){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "passkeyId") || (key0 === "publicKey")) || (key0 === "aaguid")) || (key0 === "providerName"))){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.passkeyId !== undefined){let data0: any = data.passkeyId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.publicKey !== undefined){const _errs4: any = errors;if(!(validatePasskeyPublicKey.call(this, data.publicKey, {instancePath:instancePath+"/publicKey",parentData:data,parentDataProperty:"publicKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePasskeyPublicKey.errors : vErrors.concat(validatePasskeyPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.aaguid !== undefined){const _errs5: any = errors;if(!(validateAaguid.call(this, data.aaguid, {instancePath:instancePath+"/aaguid",parentData:data,parentDataProperty:"aaguid",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAaguid.errors : vErrors.concat(validateAaguid.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerName !== undefined){let data3: any = data.providerName;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) > 128){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath:instancePath+"/providerName",schemaPath:"#/properties/providerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateWebAuthnRegistrationVerifyResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnRegistrationVerifyResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnRegistrationVerifyResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AssertionResponse}. */
// prettier-ignore
export const validateAssertionResponse: CompiledSchemaCheck<AssertionResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AssertionResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAssertionResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.clientDataJSON === undefined) && (missing0 = "clientDataJSON")) || ((data.authenticatorData === undefined) && (missing0 = "authenticatorData"))) || ((data.signature === undefined) && (missing0 = "signature"))){validateAssertionResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "clientDataJSON") || (key0 === "authenticatorData")) || (key0 === "signature")) || (key0 === "userHandle")) || (key0 === "attestationObject"))){validateAssertionResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.clientDataJSON !== undefined){let data0: any = data.clientDataJSON;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 16384){validateAssertionResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data0) < 1){validateAssertionResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateAssertionResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAssertionResponse.errors = [{instancePath:instancePath+"/clientDataJSON",schemaPath:"#/properties/clientDataJSON/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorData !== undefined){let data1: any = data.authenticatorData;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 16384){validateAssertionResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data1) < 1){validateAssertionResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data1)){validateAssertionResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAssertionResponse.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.signature !== undefined){let data2: any = data.signature;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 16384){validateAssertionResponse.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/properties/signature/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data2) < 1){validateAssertionResponse.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data2)){validateAssertionResponse.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAssertionResponse.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.userHandle !== undefined){let data3: any = data.userHandle;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) > 86){validateAssertionResponse.errors = [{instancePath:instancePath+"/userHandle",schemaPath:"#/properties/userHandle/maxLength",keyword:"maxLength",params:{limit: 86}}];return false;}else {if(func1(data3) < 1){validateAssertionResponse.errors = [{instancePath:instancePath+"/userHandle",schemaPath:"#/properties/userHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data3)){validateAssertionResponse.errors = [{instancePath:instancePath+"/userHandle",schemaPath:"#/properties/userHandle/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAssertionResponse.errors = [{instancePath:instancePath+"/userHandle",schemaPath:"#/properties/userHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.attestationObject !== undefined){let data4: any = data.attestationObject;const _errs10: any = errors;if(errors === _errs10){if(typeof data4 === "string"){if(func1(data4) > 16384){validateAssertionResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data4) < 1){validateAssertionResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data4)){validateAssertionResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAssertionResponse.errors = [{instancePath:instancePath+"/attestationObject",schemaPath:"#/properties/attestationObject/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}else {validateAssertionResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAssertionResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAssertionResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1386: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id."},"rawId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The credential id again."},"response":{"$ref":"#/$defs/AssertionResponse","description":"The authenticator's answer."},"authenticatorAttachment":{"$ref":"#/$defs/AuthenticatorAttachment","description":"Where the authenticator sits."},"clientExtensionResults":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"The client's extension outputs, whatever extensions it ran."},"type":{"description":"The credential type.","type":"string","enum":["public-key"]}},"required":["id","rawId","response","clientExtensionResults","type"],"description":"An assertion `get()` made, in `WebAuthn`'s JSON form."};
/** Checks that a value is a {@link AuthenticationResponse}. */
// prettier-ignore
export const validateAuthenticationResponse: CompiledSchemaCheck<AuthenticationResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AuthenticationResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAuthenticationResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.id === undefined) && (missing0 = "id")) || ((data.rawId === undefined) && (missing0 = "rawId"))) || ((data.response === undefined) && (missing0 = "response"))) || ((data.clientExtensionResults === undefined) && (missing0 = "clientExtensionResults"))) || ((data.type === undefined) && (missing0 = "type"))){validateAuthenticationResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "rawId")) || (key0 === "response")) || (key0 === "authenticatorAttachment")) || (key0 === "clientExtensionResults")) || (key0 === "type"))){validateAuthenticationResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAuthenticationResponse.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.rawId !== undefined){let data1: any = data.rawId;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 1364){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data1) < 1){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data1)){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateAuthenticationResponse.errors = [{instancePath:instancePath+"/rawId",schemaPath:"#/properties/rawId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){const _errs6: any = errors;if(!(validateAssertionResponse.call(this, data.response, {instancePath:instancePath+"/response",parentData:data,parentDataProperty:"response",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAssertionResponse.errors : vErrors.concat(validateAssertionResponse.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.authenticatorAttachment !== undefined){const _errs7: any = errors;if(!(validateAuthenticatorAttachment.call(this, data.authenticatorAttachment, {instancePath:instancePath+"/authenticatorAttachment",parentData:data,parentDataProperty:"authenticatorAttachment",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAuthenticatorAttachment.errors : vErrors.concat(validateAuthenticatorAttachment.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientExtensionResults !== undefined){let data4: any = data.clientExtensionResults;const _errs8: any = errors;if(errors === _errs8){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs10: any = errors;const _errs11: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs11 === errors;if(valid2){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs15 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid2: any = _errs13 === errors;}var valid1: any = _errs10 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateAuthenticationResponse.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data4){const _errs17: any = errors;var valid4: any = _errs17 === errors;if(!valid4){break;}}}}else {validateAuthenticationResponse.errors = [{instancePath:instancePath+"/clientExtensionResults",schemaPath:"#/properties/clientExtensionResults/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data6: any = data.type;const _errs19: any = errors;if(typeof data6 !== "string"){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data6 === "public-key")){validateAuthenticationResponse.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema1386.properties.type.enum}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateAuthenticationResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAuthenticationResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAuthenticationResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnAuthenticationVerifyRequest}. */
// prettier-ignore
export const validateWebAuthnAuthenticationVerifyRequest: CompiledSchemaCheck<WebAuthnAuthenticationVerifyRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationVerifyRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnAuthenticationVerifyRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.transactionId === undefined) && (missing0 = "transactionId")) || ((data.response === undefined) && (missing0 = "response"))){validateWebAuthnAuthenticationVerifyRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "transactionId") || (key0 === "response"))){validateWebAuthnAuthenticationVerifyRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.transactionId !== undefined){const _errs2: any = errors;if(!(validateWebAuthnTransactionId.call(this, data.transactionId, {instancePath:instancePath+"/transactionId",parentData:data,parentDataProperty:"transactionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWebAuthnTransactionId.errors : vErrors.concat(validateWebAuthnTransactionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.response !== undefined){const _errs3: any = errors;if(!(validateAuthenticationResponse.call(this, data.response, {instancePath:instancePath+"/response",parentData:data,parentDataProperty:"response",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAuthenticationResponse.errors : vErrors.concat(validateAuthenticationResponse.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWebAuthnAuthenticationVerifyRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnAuthenticationVerifyRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnAuthenticationVerifyRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebAuthnAuthenticationVerifyResponse}. */
// prettier-ignore
export const validateWebAuthnAuthenticationVerifyResponse: CompiledSchemaCheck<WebAuthnAuthenticationVerifyResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnAuthenticationVerifyResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnAuthenticationVerifyResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.userId === undefined) && (missing0 = "userId")) || ((data.accessToken === undefined) && (missing0 = "accessToken"))) || ((data.refreshToken === undefined) && (missing0 = "refreshToken"))){validateWebAuthnAuthenticationVerifyResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "userId") || (key0 === "accessToken")) || (key0 === "refreshToken"))){validateWebAuthnAuthenticationVerifyResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.userId !== undefined){const _errs2: any = errors;if(!(validateUserId.call(this, data.userId, {instancePath:instancePath+"/userId",parentData:data,parentDataProperty:"userId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserId.errors : vErrors.concat(validateUserId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.accessToken !== undefined){const _errs3: any = errors;if(!(validateAccessToken.call(this, data.accessToken, {instancePath:instancePath+"/accessToken",parentData:data,parentDataProperty:"accessToken",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAccessToken.errors : vErrors.concat(validateAccessToken.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.refreshToken !== undefined){const _errs4: any = errors;if(!(validateRefreshToken.call(this, data.refreshToken, {instancePath:instancePath+"/refreshToken",parentData:data,parentDataProperty:"refreshToken",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRefreshToken.errors : vErrors.concat(validateRefreshToken.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWebAuthnAuthenticationVerifyResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnAuthenticationVerifyResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnAuthenticationVerifyResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
