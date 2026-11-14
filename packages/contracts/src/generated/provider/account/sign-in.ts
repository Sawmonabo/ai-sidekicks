// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The sign-in side of `provider.account.*`: registering an account, rebuilding an account's credential home, and the brokered interactive sign-in with its code and its cancel.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  deepEqual,
  ucs2length,
} from "../../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../../internal/wire-scalars.js";
import { type KeychainRefusalCause, validateKeychainRefusalCause } from "../../keychain.js";
import { type ProviderId, validateProviderId } from "../id.js";
import {
  type BillingMode,
  type CredentialGeneration,
  type ProviderAccount,
  type ProviderAccountHealthState,
  type ProviderAccountId,
  validateBillingMode,
  validateCredentialGeneration,
  validateProviderAccount,
  validateProviderAccountHealthState,
  validateProviderAccountId,
} from "./record.js";

/** The longest provider verification address, carried verbatim. */
export const PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN = 2048 as const;

/** The longest device code the person types at the verification address. */
export const PROVIDER_SIGN_IN_USER_CODE_MAX_LEN = 64 as const;

/** The longest code a sign-in page shows for the person to paste back. */
export const PROVIDER_SIGN_IN_CODE_MAX_LEN = 1024 as const;

/**
 * The longest pasted token: generous, since the vendor mints it, and bounded so no unbounded
 * body rides in through the one member whose value is never logged.
 */
export const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN = 8192 as const;

/** A pasted token could not be sealed in this machine's keychain, so nothing was stored. */
export const PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE =
  "provider.account.credentialSealRefused" as const;

/**
 * The provider's status output, run on a pasted token, reported no signed-in mode, so
 * nothing is registered, sealed or replaced.
 */
export const PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE =
  "provider.account.tokenNotAccepted" as const;

/**
 * The name given to a token or API-key account repeats another of that provider's account
 * names; a rename refuses on the same code.
 */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE =
  "provider.account.displayLabelTaken" as const;

/** Every way a cancel ends, in declaration order. */
export const PROVIDER_SIGN_IN_CANCEL_STATUSES = ["canceled", "notFound"] as const;

/** Every way a code submit ends, in declaration order. */
export const PROVIDER_SIGN_IN_CODE_SUBMIT_STATUSES = ["submitted", "notFound"] as const;

/**
 * Wire members a request-logging transport redacts before writing a record, listed once so
 * no transport derives the list again: the pasted token and the sign-in page's code.
 */
export const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS = ["nonInteractiveToken", "code"] as const;

/**
 * Registers an account, or re-supplies the token of an existing one. Its name follows the
 * token: a pasted token's new account must be named, a signed-in one is named by its provider,
 * and an `accountId` with nothing to supply is refused.
 */
export type ProviderAccountRegisterRequest =
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * Only an account added from a pasted token carries a name.
       */
      displayLabel?: never;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * Makes it the provider's default.
       */
      makeDefault?: boolean;
      /**
       * A re-supply carries a token.
       */
      accountId?: never;
      /**
       * A sign-in registration carries no token.
       */
      nonInteractiveToken?: never;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The name the person gives the account.
       */
      displayLabel: string;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * Makes it the provider's default.
       */
      makeDefault?: boolean;
      /**
       * A new registration names no account; the daemon mints its id.
       */
      accountId?: never;
      /**
       * The pasted token or API key.
       */
      nonInteractiveToken: string;
    }
  | {
      /**
       * The provider, which must match the stored account's.
       */
      provider: ProviderId;
      /**
       * A new name for the account.
       */
      displayLabel?: string;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * Makes it the provider's default.
       */
      makeDefault?: boolean;
      /**
       * The account whose sealed token is replaced; a selector, not an identity assertion.
       */
      accountId: ProviderAccountId;
      /**
       * The fresh token or API key.
       */
      nonInteractiveToken: string;
    };
/**
 * Which of a provider's sign-in flows runs: the one that calls back to a browser on this machine,
 * or the device-code flow a browser on any device finishes.
 */
export type ProviderSignInArm = "browser" | "deviceCode";
/**
 * Starts the provider's own interactive sign-in, for a registered account or a new one.
 */
export type ProviderAccountSignInRequest =
  | {
      /**
       * The account.
       */
      accountId: ProviderAccountId;
      /**
       * The arm to run. Absent, it is the browser arm at this machine and device code from another
       * device, where `browser` is refused.
       */
      arm?: ProviderSignInArm;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The arm to run. Absent, it is the browser arm at this machine and device code from another
       * device, where `browser` is refused.
       */
      arm?: ProviderSignInArm;
    };
/**
 * How a cancel ended. `notFound` covers an attempt that already ended or never existed; it is
 * no error, so a client racing a completion sees no refusal for losing.
 */
export type ProviderSignInCancelStatus = "canceled" | "notFound";
/**
 * How a code submit ended. `notFound` covers an attempt that is not waiting for a code; it is
 * no error, as a cancel's is not.
 */
export type ProviderSignInCodeSubmitStatus = "submitted" | "notFound";

/**
 * The registered, or token-replaced, account.
 */
export interface ProviderAccountRegisterResponse {
  /**
   * The account.
   */
  account: ProviderAccount;
}
/**
 * The details of a seal refusal.
 */
export interface ProviderAccountCredentialSealRefusedDetails {
  /**
   * Why the keychain could not be used.
   */
  cause: KeychainRefusalCause;
}
/**
 * Rebuilds an account's credential home from empty so the person can sign in again. It raises
 * the credential generation; the identity and stored quota readings survive, and the stored
 * health is dropped, so the reply carries the new one.
 */
export interface ProviderAccountCredentialHomeResetRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * The account's new credential generation and health after the rebuild.
 */
export interface ProviderAccountCredentialHomeResetResponse {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * The generation after the rebuild, greater than the one before.
   */
  credentialGeneration: CredentialGeneration;
  /**
   * `reauthRequired` until the person signs in.
   */
  healthState: ProviderAccountHealthState;
}
/**
 * What the person needs to finish the sign-in, and the key to cancel it.
 */
export interface ProviderAccountSignInResponse {
  /**
   * Opaque, daemon-minted and single-use: the key for cancel and for completion.
   */
  attemptId: string;
  /**
   * Where the person finishes the flow: the provider's own `https:` address, verbatim, since
   * the person opens it.
   */
  verificationUri: string;
  /**
   * The device code the person types at the address, on a device-code flow.
   */
  userCode?: string;
  /**
   * Where the provider bounds the attempt; absent when it published no bound or the value
   * failed the daemon's check.
   */
  expiresAt?: WireInstant;
  /**
   * Whether the provider opened the address in a browser itself: the client then opens
   * nothing, and still draws `Open the sign-in page` with the address.
   */
  isBrowserOpenedByProvider: boolean;
}
/**
 * The sign-in a `provider.account.signInInFlight` refusal names: the open attempt and the account
 * it signs in.
 */
export interface ProviderAccountSignInInFlightDetails {
  /**
   * The account the open attempt signs in.
   */
  accountId: ProviderAccountId;
  /**
   * The open attempt, which `provider.account.signInAttempt.cancel` cancels.
   */
  attemptId: string;
}
/**
 * Cancels one sign-in attempt by the id its `provider.account.signIn` reply returned.
 */
export interface ProviderAccountSignInAttemptCancelRequest {
  /**
   * The attempt.
   */
  attemptId: string;
}
/**
 * How the cancel ended.
 */
export interface ProviderAccountSignInAttemptCancelResponse {
  /**
   * The outcome.
   */
  status: ProviderSignInCancelStatus;
}
/**
 * Sends the code a Claude Code sign-in page shows to the sign-in waiting for it, after
 * `signInCodeRequested`. The code goes to that sign-in's input and nowhere else; `Debug` prints
 * only a marker in its place.
 */
export interface ProviderAccountSignInCodeSubmitRequest {
  /**
   * The attempt.
   */
  attemptId: string;
  /**
   * The code, as the person pasted it.
   */
  code: string;
}
/**
 * How the code submit ended.
 */
export interface ProviderAccountSignInCodeSubmitResponse {
  /**
   * The outcome.
   */
  status: ProviderSignInCodeSubmitStatus;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ProviderAccountRegisterRequest}. */
// prettier-ignore
export const validateProviderAccountRegisterRequest: CompiledSchemaCheck<ProviderAccountRegisterRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountRegisterRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountRegisterRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.billingMode === undefined) && (missing0 = "billingMode"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((((key0 === "provider") || (key0 === "displayLabel")) || (key0 === "billingMode")) || (key0 === "makeDefault")) || (key0 === "accountId")) || (key0 === "nonInteractiveToken"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.provider !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.displayLabel !== undefined){const _errs5: any = errors;const err2: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/0/properties/displayLabel/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;var valid1: any = _errs5 === errors;}else {var valid1: any = true;}if(valid1){if(data.billingMode !== undefined){const _errs8: any = errors;if(!(validateBillingMode.call(this, data.billingMode, {instancePath:instancePath+"/billingMode",parentData:data,parentDataProperty:"billingMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBillingMode.errors : vErrors.concat(validateBillingMode.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.makeDefault !== undefined){const _errs9: any = errors;if(typeof data.makeDefault !== "boolean"){const err3: any = {instancePath:instancePath+"/makeDefault",schemaPath:"#/anyOf/0/properties/makeDefault/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}if(valid1){if(data.accountId !== undefined){const _errs11: any = errors;const err4: any = {instancePath:instancePath+"/accountId",schemaPath:"#/anyOf/0/properties/accountId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;var valid1: any = _errs11 === errors;}else {var valid1: any = true;}if(valid1){if(data.nonInteractiveToken !== undefined){const _errs14: any = errors;const err5: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/0/properties/nonInteractiveToken/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;var valid1: any = _errs14 === errors;}else {var valid1: any = true;}}}}}}}}}else {const err6: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.provider === undefined) && (missing1 = "provider")) || ((data.displayLabel === undefined) && (missing1 = "displayLabel"))) || ((data.billingMode === undefined) && (missing1 = "billingMode"))) || ((data.nonInteractiveToken === undefined) && (missing1 = "nonInteractiveToken"))){const err7: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {const _errs19: any = errors;for(const key1 in data){if(!((((((key1 === "provider") || (key1 === "displayLabel")) || (key1 === "billingMode")) || (key1 === "makeDefault")) || (key1 === "accountId")) || (key1 === "nonInteractiveToken"))){const err8: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;break;}}if(_errs19 === errors){if(data.provider !== undefined){const _errs20: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data.displayLabel !== undefined){let data7: any = data.displayLabel;const _errs21: any = errors;if(errors === _errs21){if(typeof data7 === "string"){if(func1(data7) > 256){const err9: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/1/properties/displayLabel/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {if(func1(data7) < 1){const err10: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/1/properties/displayLabel/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(!pattern5.test(data7)){const err11: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/1/properties/displayLabel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}}}else {const err12: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/1/properties/displayLabel/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}var valid2: any = _errs21 === errors;}else {var valid2: any = true;}if(valid2){if(data.billingMode !== undefined){const _errs23: any = errors;if(!(validateBillingMode.call(this, data.billingMode, {instancePath:instancePath+"/billingMode",parentData:data,parentDataProperty:"billingMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBillingMode.errors : vErrors.concat(validateBillingMode.errors);errors = vErrors.length;}var valid2: any = _errs23 === errors;}else {var valid2: any = true;}if(valid2){if(data.makeDefault !== undefined){const _errs24: any = errors;if(typeof data.makeDefault !== "boolean"){const err13: any = {instancePath:instancePath+"/makeDefault",schemaPath:"#/anyOf/1/properties/makeDefault/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}var valid2: any = _errs24 === errors;}else {var valid2: any = true;}if(valid2){if(data.accountId !== undefined){const _errs26: any = errors;const err14: any = {instancePath:instancePath+"/accountId",schemaPath:"#/anyOf/1/properties/accountId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;var valid2: any = _errs26 === errors;}else {var valid2: any = true;}if(valid2){if(data.nonInteractiveToken !== undefined){let data11: any = data.nonInteractiveToken;const _errs29: any = errors;if(errors === _errs29){if(typeof data11 === "string"){if(func1(data11) > 8192){const err15: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/1/properties/nonInteractiveToken/maxLength",keyword:"maxLength",params:{limit: 8192}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(func1(data11) < 1){const err16: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/1/properties/nonInteractiveToken/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}else {if(!pattern5.test(data11)){const err17: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/1/properties/nonInteractiveToken/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}}}else {const err18: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/1/properties/nonInteractiveToken/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var valid2: any = _errs29 === errors;}else {var valid2: any = true;}}}}}}}}}else {const err19: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var _valid0: any = _errs17 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs31: any = errors;if(errors === _errs31){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.provider === undefined) && (missing2 = "provider")) || ((data.billingMode === undefined) && (missing2 = "billingMode"))) || ((data.accountId === undefined) && (missing2 = "accountId"))) || ((data.nonInteractiveToken === undefined) && (missing2 = "nonInteractiveToken"))){const err20: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}else {const _errs33: any = errors;for(const key2 in data){if(!((((((key2 === "provider") || (key2 === "displayLabel")) || (key2 === "billingMode")) || (key2 === "makeDefault")) || (key2 === "accountId")) || (key2 === "nonInteractiveToken"))){const err21: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;break;}}if(_errs33 === errors){if(data.provider !== undefined){const _errs34: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid3: any = _errs34 === errors;}else {var valid3: any = true;}if(valid3){if(data.displayLabel !== undefined){let data13: any = data.displayLabel;const _errs35: any = errors;if(errors === _errs35){if(typeof data13 === "string"){if(func1(data13) > 256){const err22: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/2/properties/displayLabel/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}else {if(func1(data13) < 1){const err23: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/2/properties/displayLabel/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}else {if(!pattern5.test(data13)){const err24: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/2/properties/displayLabel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}}}else {const err25: any = {instancePath:instancePath+"/displayLabel",schemaPath:"#/anyOf/2/properties/displayLabel/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}}var valid3: any = _errs35 === errors;}else {var valid3: any = true;}if(valid3){if(data.billingMode !== undefined){const _errs37: any = errors;if(!(validateBillingMode.call(this, data.billingMode, {instancePath:instancePath+"/billingMode",parentData:data,parentDataProperty:"billingMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBillingMode.errors : vErrors.concat(validateBillingMode.errors);errors = vErrors.length;}var valid3: any = _errs37 === errors;}else {var valid3: any = true;}if(valid3){if(data.makeDefault !== undefined){const _errs38: any = errors;if(typeof data.makeDefault !== "boolean"){const err26: any = {instancePath:instancePath+"/makeDefault",schemaPath:"#/anyOf/2/properties/makeDefault/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}var valid3: any = _errs38 === errors;}else {var valid3: any = true;}if(valid3){if(data.accountId !== undefined){const _errs40: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid3: any = _errs40 === errors;}else {var valid3: any = true;}if(valid3){if(data.nonInteractiveToken !== undefined){let data17: any = data.nonInteractiveToken;const _errs41: any = errors;if(errors === _errs41){if(typeof data17 === "string"){if(func1(data17) > 8192){const err27: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/2/properties/nonInteractiveToken/maxLength",keyword:"maxLength",params:{limit: 8192}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}else {if(func1(data17) < 1){const err28: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/2/properties/nonInteractiveToken/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}else {if(!pattern5.test(data17)){const err29: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/2/properties/nonInteractiveToken/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}}}else {const err30: any = {instancePath:instancePath+"/nonInteractiveToken",schemaPath:"#/anyOf/2/properties/nonInteractiveToken/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}}var valid3: any = _errs41 === errors;}else {var valid3: any = true;}}}}}}}}}else {const err31: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}}var _valid0: any = _errs31 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err32: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;validateProviderAccountRegisterRequest.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateProviderAccountRegisterRequest.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateProviderAccountRegisterRequest.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountRegisterResponse}. */
// prettier-ignore
export const validateProviderAccountRegisterResponse: CompiledSchemaCheck<ProviderAccountRegisterResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountRegisterResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountRegisterResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.account === undefined) && (missing0 = "account")){validateProviderAccountRegisterResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "account")){validateProviderAccountRegisterResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.account !== undefined){if(!(validateProviderAccount.call(this, data.account, {instancePath:instancePath+"/account",parentData:data,parentDataProperty:"account",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccount.errors : vErrors.concat(validateProviderAccount.errors);errors = vErrors.length;}}}}}else {validateProviderAccountRegisterResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountRegisterResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountRegisterResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountCredentialSealRefusedDetails}. */
// prettier-ignore
export const validateProviderAccountCredentialSealRefusedDetails: CompiledSchemaCheck<ProviderAccountCredentialSealRefusedDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountCredentialSealRefusedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountCredentialSealRefusedDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validateProviderAccountCredentialSealRefusedDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validateProviderAccountCredentialSealRefusedDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){if(!(validateKeychainRefusalCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateKeychainRefusalCause.errors : vErrors.concat(validateKeychainRefusalCause.errors);errors = vErrors.length;}}}}}else {validateProviderAccountCredentialSealRefusedDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountCredentialSealRefusedDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountCredentialSealRefusedDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountCredentialHomeResetRequest}. */
// prettier-ignore
export const validateProviderAccountCredentialHomeResetRequest: CompiledSchemaCheck<ProviderAccountCredentialHomeResetRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountCredentialHomeResetRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountCredentialHomeResetRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){validateProviderAccountCredentialHomeResetRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accountId")){validateProviderAccountCredentialHomeResetRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}}}}}else {validateProviderAccountCredentialHomeResetRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountCredentialHomeResetRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountCredentialHomeResetRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountCredentialHomeResetResponse}. */
// prettier-ignore
export const validateProviderAccountCredentialHomeResetResponse: CompiledSchemaCheck<ProviderAccountCredentialHomeResetResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountCredentialHomeResetResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountCredentialHomeResetResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.accountId === undefined) && (missing0 = "accountId")) || ((data.credentialGeneration === undefined) && (missing0 = "credentialGeneration"))) || ((data.healthState === undefined) && (missing0 = "healthState"))){validateProviderAccountCredentialHomeResetResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "accountId") || (key0 === "credentialGeneration")) || (key0 === "healthState"))){validateProviderAccountCredentialHomeResetResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.credentialGeneration !== undefined){const _errs3: any = errors;if(!(validateCredentialGeneration.call(this, data.credentialGeneration, {instancePath:instancePath+"/credentialGeneration",parentData:data,parentDataProperty:"credentialGeneration",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCredentialGeneration.errors : vErrors.concat(validateCredentialGeneration.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.healthState !== undefined){const _errs4: any = errors;if(!(validateProviderAccountHealthState.call(this, data.healthState, {instancePath:instancePath+"/healthState",parentData:data,parentDataProperty:"healthState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountHealthState.errors : vErrors.concat(validateProviderAccountHealthState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateProviderAccountCredentialHomeResetResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountCredentialHomeResetResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountCredentialHomeResetResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema965: any = {"description":"Which of a provider's sign-in flows runs: the one that calls back to a browser on this machine,\nor the device-code flow a browser on any device finishes.","type":"string","enum":["browser","deviceCode"]};
/** Checks that a value is a {@link ProviderSignInArm}. */
// prettier-ignore
export const validateProviderSignInArm: CompiledSchemaCheck<ProviderSignInArm> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderSignInArm {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderSignInArm.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProviderSignInArm.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "browser") || (data === "deviceCode"))){validateProviderSignInArm.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema965.enum}}];return false;}validateProviderSignInArm.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderSignInArm.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountSignInRequest}. */
// prettier-ignore
export const validateProviderAccountSignInRequest: CompiledSchemaCheck<ProviderAccountSignInRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((key0 === "accountId") || (key0 === "arm"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.accountId !== undefined){const _errs4: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.arm !== undefined){const _errs5: any = errors;if(!(validateProviderSignInArm.call(this, data.arm, {instancePath:instancePath+"/arm",parentData:data,parentDataProperty:"arm",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderSignInArm.errors : vErrors.concat(validateProviderSignInArm.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;}else {var valid1: any = true;}}}}}else {const err2: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.provider === undefined) && (missing1 = "provider")){const err3: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {const _errs8: any = errors;for(const key1 in data){if(!((key1 === "provider") || (key1 === "arm"))){const err4: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;break;}}if(_errs8 === errors){if(data.provider !== undefined){const _errs9: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.arm !== undefined){const _errs10: any = errors;if(!(validateProviderSignInArm.call(this, data.arm, {instancePath:instancePath+"/arm",parentData:data,parentDataProperty:"arm",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderSignInArm.errors : vErrors.concat(validateProviderSignInArm.errors);errors = vErrors.length;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}}}}}else {const err5: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var _valid0: any = _errs6 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err6: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;validateProviderAccountSignInRequest.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateProviderAccountSignInRequest.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInRequest.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
/** Checks that a value is a {@link ProviderAccountSignInResponse}. */
// prettier-ignore
export const validateProviderAccountSignInResponse: CompiledSchemaCheck<ProviderAccountSignInResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.attemptId === undefined) && (missing0 = "attemptId")) || ((data.verificationUri === undefined) && (missing0 = "verificationUri"))) || ((data.isBrowserOpenedByProvider === undefined) && (missing0 = "isBrowserOpenedByProvider"))){validateProviderAccountSignInResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "attemptId") || (key0 === "verificationUri")) || (key0 === "userCode")) || (key0 === "expiresAt")) || (key0 === "isBrowserOpenedByProvider"))){validateProviderAccountSignInResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attemptId !== undefined){let data0: any = data.attemptId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.verificationUri !== undefined){let data1: any = data.verificationUri;const _errs4: any = errors;if(errors === _errs4){if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 2048){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/verificationUri",schemaPath:"#/properties/verificationUri/maxLength",keyword:"maxLength",params:{limit: 2048}}];return false;}else {if(!pattern33.test(data1)){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/verificationUri",schemaPath:"#/properties/verificationUri/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data1))){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/verificationUri",schemaPath:"#/properties/verificationUri/format",keyword:"format",params:{format: "https-url"}}];return false;}}}}else {validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/verificationUri",schemaPath:"#/properties/verificationUri/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.userCode !== undefined){let data2: any = data.userCode;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 64){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/userCode",schemaPath:"#/properties/userCode/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(func1(data2) < 1){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/userCode",schemaPath:"#/properties/userCode/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/userCode",schemaPath:"#/properties/userCode/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/userCode",schemaPath:"#/properties/userCode/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.expiresAt !== undefined){const _errs8: any = errors;if(!(validateWireInstant.call(this, data.expiresAt, {instancePath:instancePath+"/expiresAt",parentData:data,parentDataProperty:"expiresAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.isBrowserOpenedByProvider !== undefined){const _errs9: any = errors;if(typeof data.isBrowserOpenedByProvider !== "boolean"){validateProviderAccountSignInResponse.errors = [{instancePath:instancePath+"/isBrowserOpenedByProvider",schemaPath:"#/properties/isBrowserOpenedByProvider/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}else {validateProviderAccountSignInResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountSignInResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountSignInInFlightDetails}. */
// prettier-ignore
export const validateProviderAccountSignInInFlightDetails: CompiledSchemaCheck<ProviderAccountSignInInFlightDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInInFlightDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInInFlightDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.accountId === undefined) && (missing0 = "accountId")) || ((data.attemptId === undefined) && (missing0 = "attemptId"))){validateProviderAccountSignInInFlightDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "accountId") || (key0 === "attemptId"))){validateProviderAccountSignInInFlightDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptId !== undefined){let data1: any = data.attemptId;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateProviderAccountSignInInFlightDetails.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateProviderAccountSignInInFlightDetails.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProviderAccountSignInInFlightDetails.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountSignInInFlightDetails.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProviderAccountSignInInFlightDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountSignInInFlightDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInInFlightDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountSignInAttemptCancelRequest}. */
// prettier-ignore
export const validateProviderAccountSignInAttemptCancelRequest: CompiledSchemaCheck<ProviderAccountSignInAttemptCancelRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInAttemptCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInAttemptCancelRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.attemptId === undefined) && (missing0 = "attemptId")){validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "attemptId")){validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attemptId !== undefined){let data0: any = data.attemptId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateProviderAccountSignInAttemptCancelRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountSignInAttemptCancelRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInAttemptCancelRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema959: any = {"description":"How a cancel ended. `notFound` covers an attempt that already ended or never existed; it is\nno error, so a client racing a completion sees no refusal for losing.","type":"string","enum":["canceled","notFound"]};
/** Checks that a value is a {@link ProviderSignInCancelStatus}. */
// prettier-ignore
export const validateProviderSignInCancelStatus: CompiledSchemaCheck<ProviderSignInCancelStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderSignInCancelStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderSignInCancelStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProviderSignInCancelStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "canceled") || (data === "notFound"))){validateProviderSignInCancelStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema959.enum}}];return false;}validateProviderSignInCancelStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderSignInCancelStatus.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountSignInAttemptCancelResponse}. */
// prettier-ignore
export const validateProviderAccountSignInAttemptCancelResponse: CompiledSchemaCheck<ProviderAccountSignInAttemptCancelResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInAttemptCancelResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInAttemptCancelResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.status === undefined) && (missing0 = "status")){validateProviderAccountSignInAttemptCancelResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "status")){validateProviderAccountSignInAttemptCancelResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.status !== undefined){if(!(validateProviderSignInCancelStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderSignInCancelStatus.errors : vErrors.concat(validateProviderSignInCancelStatus.errors);errors = vErrors.length;}}}}}else {validateProviderAccountSignInAttemptCancelResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountSignInAttemptCancelResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInAttemptCancelResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountSignInCodeSubmitRequest}. */
// prettier-ignore
export const validateProviderAccountSignInCodeSubmitRequest: CompiledSchemaCheck<ProviderAccountSignInCodeSubmitRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInCodeSubmitRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInCodeSubmitRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.attemptId === undefined) && (missing0 = "attemptId")) || ((data.code === undefined) && (missing0 = "code"))){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "attemptId") || (key0 === "code"))){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.attemptId !== undefined){let data0: any = data.attemptId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.code !== undefined){let data1: any = data.code;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 1024){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data1) < 1){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateProviderAccountSignInCodeSubmitRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountSignInCodeSubmitRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInCodeSubmitRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema962: any = {"description":"How a code submit ended. `notFound` covers an attempt that is not waiting for a code; it is\nno error, as a cancel's is not.","type":"string","enum":["submitted","notFound"]};
/** Checks that a value is a {@link ProviderSignInCodeSubmitStatus}. */
// prettier-ignore
export const validateProviderSignInCodeSubmitStatus: CompiledSchemaCheck<ProviderSignInCodeSubmitStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderSignInCodeSubmitStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderSignInCodeSubmitStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProviderSignInCodeSubmitStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "submitted") || (data === "notFound"))){validateProviderSignInCodeSubmitStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema962.enum}}];return false;}validateProviderSignInCodeSubmitStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderSignInCodeSubmitStatus.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountSignInCodeSubmitResponse}. */
// prettier-ignore
export const validateProviderAccountSignInCodeSubmitResponse: CompiledSchemaCheck<ProviderAccountSignInCodeSubmitResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountSignInCodeSubmitResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountSignInCodeSubmitResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.status === undefined) && (missing0 = "status")){validateProviderAccountSignInCodeSubmitResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "status")){validateProviderAccountSignInCodeSubmitResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.status !== undefined){if(!(validateProviderSignInCodeSubmitStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderSignInCodeSubmitStatus.errors : vErrors.concat(validateProviderSignInCodeSubmitStatus.errors);errors = vErrors.length;}}}}}else {validateProviderAccountSignInCodeSubmitResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountSignInCodeSubmitResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountSignInCodeSubmitResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
