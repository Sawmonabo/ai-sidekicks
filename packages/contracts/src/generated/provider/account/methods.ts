// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `provider.account.*` methods not in the sign-in module (update, delete, current update, probe, memory import, usage list) and the namespace's method table.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  ucs2length,
} from "../../../schema-check.js";
import {
  type WireDate,
  type WireInstant,
  validateWireDate,
  validateWireInstant,
} from "../../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../../jsonrpc/streaming.js";
import { type KeychainRefusalCause, validateKeychainRefusalCause } from "../../keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "../../method-descriptor.js";
import { type UsdMicros, validateUsdMicros } from "../../session/cost.js";
import { type SessionId, validateSessionId } from "../../session/id.js";
import { type WorkflowRunId, validateWorkflowRunId } from "../../workflow/run/id.js";
import { type ProviderId, validateProviderId } from "../id.js";
import {
  type BillingMode,
  type CredentialGeneration,
  type ProviderAccount,
  type ProviderAccountHealthState,
  type ProviderAccountId,
  type ProviderAccountListRequest,
  type ProviderAccountListResponse,
  type ProviderAccountMemoryImportOutcome,
  type ProviderAccountNotification,
  type ProviderSignInExpiredRemedy,
  validateBillingMode,
  validateCredentialGeneration,
  validateProviderAccount,
  validateProviderAccountHealthState,
  validateProviderAccountId,
  validateProviderAccountListRequest,
  validateProviderAccountListResponse,
  validateProviderAccountMemoryImportOutcome,
  validateProviderAccountNotification,
  validateProviderSignInExpiredRemedy,
} from "./record.js";
import {
  type ProviderAccountCredentialHomeResetRequest,
  type ProviderAccountCredentialHomeResetResponse,
  type ProviderAccountRegisterRequest,
  type ProviderAccountRegisterResponse,
  type ProviderAccountSignInAttemptCancelRequest,
  type ProviderAccountSignInAttemptCancelResponse,
  type ProviderAccountSignInCodeSubmitRequest,
  type ProviderAccountSignInCodeSubmitResponse,
  type ProviderAccountSignInRequest,
  type ProviderAccountSignInResponse,
  validateProviderAccountCredentialHomeResetRequest,
  validateProviderAccountCredentialHomeResetResponse,
  validateProviderAccountRegisterRequest,
  validateProviderAccountRegisterResponse,
  validateProviderAccountSignInAttemptCancelRequest,
  validateProviderAccountSignInAttemptCancelResponse,
  validateProviderAccountSignInCodeSubmitRequest,
  validateProviderAccountSignInCodeSubmitResponse,
  validateProviderAccountSignInRequest,
  validateProviderAccountSignInResponse,
} from "./sign-in.js";

/** The longest model id on a usage row, as the provider names it. */
export const PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN = 128 as const;

/** The longest reason the wake helper did not install, in the installer's own words. */
export const PROVIDER_WAKE_HELPER_REASON_MAX_LEN = 1024 as const;

/**
 * The update renamed an account the person did not name: only an account added from a
 * pasted token or API key carries a typed name.
 */
export const PROVIDER_ACCOUNT_RENAME_REFUSED_CODE = "provider.account.renameRefused" as const;

/** No account is registered for the provider a run needs, so the run is not admitted. */
export const PROVIDER_ACCOUNT_NOT_REGISTERED_CODE = "provider.account.notRegistered" as const;

/**
 * The provider has accounts but none is current, so a run's account is ambiguous and it is
 * not admitted.
 */
export const PROVIDER_ACCOUNT_CURRENT_NOT_SET_CODE = "provider.account.current.notSet" as const;

/**
 * A run bound to the account is live, or a workflow step waits on it, so it is not removed;
 * the refusal names the sessions or the workflow runs.
 */
export const PROVIDER_ACCOUNT_IN_USE_CODE = "provider.account.inUse" as const;

/**
 * The place the daemon keeps its secrets would not destroy the account's token, so the
 * removal stopped; the account no longer reads as registered and the next start finishes it.
 */
export const PROVIDER_ACCOUNT_CREDENTIAL_DESTROY_REFUSED_CODE =
  "provider.account.credentialDestroyRefused" as const;

/**
 * The named account is not signed in, so it is refused as a switch target before anything
 * moves.
 */
export const PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE = "provider.account.notAuthenticated" as const;

/** The account's one memory import has already run, so it is not run again. */
export const PROVIDER_ACCOUNT_MEMORY_ALREADY_IMPORTED_CODE =
  "provider.account.memory.alreadyImported" as const;

/**
 * Where the helper that wakes this computer for a window start stands. The update reply reads
 * `installed` or `notInstalled`, one that did not install leaving the switch off and giving its
 * reason; `daemon.status.read` reads `installed`, `turnedOff` (turned off in the system's login
 * items) or `missing`.
 */
export type ProviderWakeHelperState =
  | {
      state: "installed";
    }
  | {
      state: "notInstalled";
      /**
       * Why, in the installer's own words.
       */
      reason: string;
    }
  | {
      state: "turnedOff";
    }
  | {
      state: "missing";
    };
/**
 * What holds the account a removal refused: the sessions whose live runs are on it, or the
 * workflow runs with a step parked waiting on it; at least one is named either way.
 */
export type ProviderAccountInUseDetails =
  | {
      heldBy: "sessions";
      /**
       * The sessions.
       *
       * @minItems 1
       */
      sessionIds: [SessionId, ...SessionId[]];
    }
  | {
      heldBy: "waitingSteps";
      /**
       * The workflow runs.
       *
       * @minItems 1
       */
      workflowRunIds: [WorkflowRunId, ...WorkflowRunId[]];
    };
/**
 * The account now current and the sessions the switch is moving.
 */
export type ProviderAccountCurrentUpdateResponse = {
  account?: {
    isDefault?: true;
  };
} & {
  /**
   * The account now current, so it carries the default mark.
   */
  account: ProviderAccount;
  /**
   * The sessions the switch is moving; empty when nothing ran on that provider or the account
   * was already current.
   */
  movingSessions: ProviderAccountMovingSession[];
};
/**
 * The accounts a usage read covers: one account, or every account of one provider.
 */
export type ProviderAccountUsageScope =
  | {
      /**
       * The account.
       */
      accountId: ProviderAccountId;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
    };
/**
 * How a usage read splits its figures: by calendar day, or by model.
 */
export type ProviderAccountUsageGrouping = "day" | "model";

/**
 * Edits an account's descriptive settings; an omitted member is unchanged. The provider, the
 * credential home, the credential generation and the default mark are not changed here.
 */
export interface ProviderAccountUpdateRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * Renames an account added from a pasted token or API key; refused on any other.
   */
  displayLabel?: string;
  /**
   * How `unknown` is resolved to a declared mode.
   */
  billingMode?: BillingMode;
  /**
   * The lasting per-account opt-out for the background observer; on by default.
   */
  probeEnabled?: boolean;
  /**
   * Start each usage window as soon as it opens; it does nothing while the observer is off,
   * and turning it on then is kept rather than refused.
   */
  windowStartEnabled?: boolean;
  /**
   * Wake this computer for a window that resets while it sleeps; the first account turned on
   * installs the wake helper and the last one turned off removes it.
   */
  wakeForWindowStartEnabled?: boolean;
}
/**
 * The updated account.
 */
export interface ProviderAccountUpdateResponse {
  /**
   * The account.
   */
  account: ProviderAccount;
  /**
   * Present when the request changed the wake switch on a machine that uses the helper.
   */
  wakeHelper?: ProviderWakeHelperState;
}
/**
 * Removes one account.
 */
export interface ProviderAccountDeleteRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * The removed account's id.
 */
export interface ProviderAccountDeleteResponse {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * Always `true`: removal has no partial success, and every refusal is a typed error.
   */
  removed: true;
}
/**
 * The details of a refused destroy of the account's sealed token.
 */
export interface ProviderAccountCredentialDestroyRefusedDetails {
  /**
   * Why the keychain could not be used.
   */
  cause: KeychainRefusalCause;
}
/**
 * Makes this account its provider's current account, the one the default mark sits on. New
 * sessions on that provider start on it and every running session there not pinned to an
 * account moves to it; no credential is touched.
 */
export interface ProviderAccountCurrentUpdateRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * One running session the switch is moving, in place, at its next provider request.
 */
export interface ProviderAccountMovingSession {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The refused account's own remedy, so the refusal points at the one way back for it.
 */
export interface ProviderAccountNotAuthenticatedDetails {
  /**
   * The remedy.
   */
  remedy: ProviderSignInExpiredRemedy;
}
/**
 * Checks one account's health now.
 */
export interface ProviderAccountProbeRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * The account's health as the probe read it.
 */
export interface ProviderAccountProbeResponse {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * The health read.
   */
  healthState: ProviderAccountHealthState;
  /**
   * The generation the probe saw; a later rise makes this reading stale.
   */
  credentialGeneration: CredentialGeneration;
}
/**
 * Copies the person's own provider memory into this account's home, once, never overwriting a
 * file, and answers with the outcome the account keeps; a repeat is refused and copies nothing.
 */
export interface ProviderAccountMemoryImportRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * Reads tokens and spend per account from the per-turn records; a subscription account's tokens
 * are priced at the provider's published per-token rates.
 */
export interface ProviderAccountUsageListRequest {
  /**
   * The accounts read.
   */
  scope: ProviderAccountUsageScope;
  /**
   * The inclusive start; absent reads from the first recorded turn.
   */
  from?: WireInstant;
  /**
   * The exclusive end; absent reads to now.
   */
  to?: WireInstant;
  /**
   * How the figures split; absent gives one row for the whole range.
   */
  groupBy?: ProviderAccountUsageGrouping;
}
/**
 * One figure: the tokens and what they cost, in whole micro-dollars. `day` is set on a row
 * grouped by day and `model` on a row grouped by model.
 */
export interface ProviderAccountUsageRow {
  /**
   * The calendar day.
   */
  day?: WireDate;
  /**
   * The model, as the provider names it.
   */
  model?: string;
  /**
   * The tokens.
   */
  tokens: number;
  /**
   * What they cost.
   */
  costUsdMicros: UsdMicros;
}
/**
 * The usage rows for the requested range and grouping.
 */
export interface ProviderAccountUsageListResponse {
  /**
   * The rows.
   */
  rows: ProviderAccountUsageRow[];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ProviderAccountUpdateRequest}. */
// prettier-ignore
export const validateProviderAccountUpdateRequest: CompiledSchemaCheck<ProviderAccountUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){validateProviderAccountUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "accountId") || (key0 === "displayLabel")) || (key0 === "billingMode")) || (key0 === "probeEnabled")) || (key0 === "windowStartEnabled")) || (key0 === "wakeForWindowStartEnabled"))){validateProviderAccountUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayLabel !== undefined){let data1: any = data.displayLabel;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/displayLabel",schemaPath:"#/properties/displayLabel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/displayLabel",schemaPath:"#/properties/displayLabel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/displayLabel",schemaPath:"#/properties/displayLabel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/displayLabel",schemaPath:"#/properties/displayLabel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.billingMode !== undefined){const _errs5: any = errors;if(!(validateBillingMode.call(this, data.billingMode, {instancePath:instancePath+"/billingMode",parentData:data,parentDataProperty:"billingMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBillingMode.errors : vErrors.concat(validateBillingMode.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.probeEnabled !== undefined){const _errs6: any = errors;if(typeof data.probeEnabled !== "boolean"){validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/probeEnabled",schemaPath:"#/properties/probeEnabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.windowStartEnabled !== undefined){const _errs8: any = errors;if(typeof data.windowStartEnabled !== "boolean"){validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/windowStartEnabled",schemaPath:"#/properties/windowStartEnabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.wakeForWindowStartEnabled !== undefined){const _errs10: any = errors;if(typeof data.wakeForWindowStartEnabled !== "boolean"){validateProviderAccountUpdateRequest.errors = [{instancePath:instancePath+"/wakeForWindowStartEnabled",schemaPath:"#/properties/wakeForWindowStartEnabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateProviderAccountUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderWakeHelperState}. */
// prettier-ignore
export const validateProviderWakeHelperState: CompiledSchemaCheck<ProviderWakeHelperState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderWakeHelperState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderWakeHelperState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "installed"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.state === undefined) && (missing0 = "state")){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "state")){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;if(typeof data0 !== "string"){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("installed" !== data0){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "installed"}}];return false;}}}}}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "notInstalled"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.state === undefined) && (missing1 = "state")) || ((data.reason === undefined) && (missing1 = "reason"))){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!((key1 === "state") || (key1 === "reason"))){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.state !== undefined){let data1: any = data.state;const _errs10: any = errors;if(typeof data1 !== "string"){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("notInstalled" !== data1){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "notInstalled"}}];return false;}var valid4: any = _errs10 === errors;}else {var valid4: any = true;}if(valid4){if(data.reason !== undefined){let data2: any = data.reason;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(func1(data2) > 1024){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data2) < 1){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}}}}}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "turnedOff"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.state === undefined) && (missing2 = "state")){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(key2 === "state")){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.state !== undefined){let data3: any = data.state;if(typeof data3 !== "string"){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("turnedOff" !== data3){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "turnedOff"}}];return false;}}}}}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "missing"){const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.state === undefined) && (missing3 = "state")){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs21: any = errors;for(const key3 in data){if(!(key3 === "state")){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs21 === errors){if(data.state !== undefined){let data4: any = data.state;if(typeof data4 !== "string"){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("missing" !== data4){validateProviderWakeHelperState.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "missing"}}];return false;}}}}}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs19 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key4 in data){if(!props0 || !props0[key4]){validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validateProviderWakeHelperState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderWakeHelperState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderWakeHelperState.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountUpdateResponse}. */
// prettier-ignore
export const validateProviderAccountUpdateResponse: CompiledSchemaCheck<ProviderAccountUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.account === undefined) && (missing0 = "account")){validateProviderAccountUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "account") || (key0 === "wakeHelper"))){validateProviderAccountUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.account !== undefined){const _errs2: any = errors;if(!(validateProviderAccount.call(this, data.account, {instancePath:instancePath+"/account",parentData:data,parentDataProperty:"account",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccount.errors : vErrors.concat(validateProviderAccount.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.wakeHelper !== undefined){const _errs3: any = errors;if(!(validateProviderWakeHelperState.call(this, data.wakeHelper, {instancePath:instancePath+"/wakeHelper",parentData:data,parentDataProperty:"wakeHelper",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderWakeHelperState.errors : vErrors.concat(validateProviderWakeHelperState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProviderAccountUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountDeleteRequest}. */
// prettier-ignore
export const validateProviderAccountDeleteRequest: CompiledSchemaCheck<ProviderAccountDeleteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountDeleteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){validateProviderAccountDeleteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accountId")){validateProviderAccountDeleteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}}}}}else {validateProviderAccountDeleteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountDeleteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountDeleteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountDeleteResponse}. */
// prettier-ignore
export const validateProviderAccountDeleteResponse: CompiledSchemaCheck<ProviderAccountDeleteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountDeleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountDeleteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.accountId === undefined) && (missing0 = "accountId")) || ((data.removed === undefined) && (missing0 = "removed"))){validateProviderAccountDeleteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "accountId") || (key0 === "removed"))){validateProviderAccountDeleteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.removed !== undefined){let data1: any = data.removed;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateProviderAccountDeleteResponse.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateProviderAccountDeleteResponse.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProviderAccountDeleteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountDeleteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountDeleteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountInUseDetails}. */
// prettier-ignore
export const validateProviderAccountInUseDetails: CompiledSchemaCheck<ProviderAccountInUseDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountInUseDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountInUseDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.heldBy;if(typeof tag0 == "string"){if(tag0 === "sessions"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.heldBy === undefined) && (missing0 = "heldBy")) || ((data.sessionIds === undefined) && (missing0 = "sessionIds"))){validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "heldBy") || (key0 === "sessionIds"))){validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.heldBy !== undefined){let data0: any = data.heldBy;const _errs5: any = errors;if(typeof data0 !== "string"){validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/heldBy",schemaPath:"#/oneOf/0/properties/heldBy/type",keyword:"type",params:{type: "string"}}];return false;}if("sessions" !== data0){validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/heldBy",schemaPath:"#/oneOf/0/properties/heldBy/const",keyword:"const",params:{allowedValue: "sessions"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionIds !== undefined){let data1: any = data.sessionIds;const _errs7: any = errors;if(errors === _errs7){if(Array.isArray(data1)){if(data1.length < 1){validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/sessionIds",schemaPath:"#/oneOf/0/properties/sessionIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs9: any = errors;if(!(validateSessionId.call(this, data1[i0], {instancePath:instancePath+"/sessionIds/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid3: any = _errs9 === errors;if(!valid3){break;}}}}else {validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/sessionIds",schemaPath:"#/oneOf/0/properties/sessionIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "waitingSteps"){const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.heldBy === undefined) && (missing1 = "heldBy")) || ((data.workflowRunIds === undefined) && (missing1 = "workflowRunIds"))){validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs12: any = errors;for(const key1 in data){if(!((key1 === "heldBy") || (key1 === "workflowRunIds"))){validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs12 === errors){if(data.heldBy !== undefined){let data3: any = data.heldBy;const _errs13: any = errors;if(typeof data3 !== "string"){validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/heldBy",schemaPath:"#/oneOf/1/properties/heldBy/type",keyword:"type",params:{type: "string"}}];return false;}if("waitingSteps" !== data3){validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/heldBy",schemaPath:"#/oneOf/1/properties/heldBy/const",keyword:"const",params:{allowedValue: "waitingSteps"}}];return false;}var valid5: any = _errs13 === errors;}else {var valid5: any = true;}if(valid5){if(data.workflowRunIds !== undefined){let data4: any = data.workflowRunIds;const _errs15: any = errors;if(errors === _errs15){if(Array.isArray(data4)){if(data4.length < 1){validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/workflowRunIds",schemaPath:"#/oneOf/1/properties/workflowRunIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid6: any = true;const len1: any = data4.length;for(let i1=0; i1<len1; i1++){const _errs17: any = errors;if(!(validateWorkflowRunId.call(this, data4[i1], {instancePath:instancePath+"/workflowRunIds/" + i1,parentData:data4,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid6: any = _errs17 === errors;if(!valid6){break;}}}}else {validateProviderAccountInUseDetails.errors = [{instancePath:instancePath+"/workflowRunIds",schemaPath:"#/oneOf/1/properties/workflowRunIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}}}}}else {validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs10 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else {validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "heldBy", tagValue: tag0}}];return false;}}else {validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "heldBy", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateProviderAccountInUseDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountInUseDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountInUseDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountCredentialDestroyRefusedDetails}. */
// prettier-ignore
export const validateProviderAccountCredentialDestroyRefusedDetails: CompiledSchemaCheck<ProviderAccountCredentialDestroyRefusedDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountCredentialDestroyRefusedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountCredentialDestroyRefusedDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validateProviderAccountCredentialDestroyRefusedDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validateProviderAccountCredentialDestroyRefusedDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){if(!(validateKeychainRefusalCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateKeychainRefusalCause.errors : vErrors.concat(validateKeychainRefusalCause.errors);errors = vErrors.length;}}}}}else {validateProviderAccountCredentialDestroyRefusedDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountCredentialDestroyRefusedDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountCredentialDestroyRefusedDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountCurrentUpdateRequest}. */
// prettier-ignore
export const validateProviderAccountCurrentUpdateRequest: CompiledSchemaCheck<ProviderAccountCurrentUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountCurrentUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountCurrentUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){validateProviderAccountCurrentUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accountId")){validateProviderAccountCurrentUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}}}}}else {validateProviderAccountCurrentUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountCurrentUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountCurrentUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountMovingSession}. */
// prettier-ignore
export const validateProviderAccountMovingSession: CompiledSchemaCheck<ProviderAccountMovingSession> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountMovingSession {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountMovingSession.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateProviderAccountMovingSession.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateProviderAccountMovingSession.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateProviderAccountMovingSession.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountMovingSession.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountMovingSession.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountCurrentUpdateResponse}. */
// prettier-ignore
export const validateProviderAccountCurrentUpdateResponse: CompiledSchemaCheck<ProviderAccountCurrentUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountCurrentUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountCurrentUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){if(data.account !== undefined){let data0: any = data.account;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){if(data0.isDefault !== undefined){if(true !== data0.isDefault){validateProviderAccountCurrentUpdateResponse.errors = [{instancePath:instancePath+"/account/isDefault",schemaPath:"#/allOf/0/properties/account/properties/isDefault/const",keyword:"const",params:{allowedValue: true}}];return false;}}}else {validateProviderAccountCurrentUpdateResponse.errors = [{instancePath:instancePath+"/account",schemaPath:"#/allOf/0/properties/account/type",keyword:"type",params:{type: "object"}}];return false;}}}}else {validateProviderAccountCurrentUpdateResponse.errors = [{instancePath,schemaPath:"#/allOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.account === undefined) && (missing0 = "account")) || ((data.movingSessions === undefined) && (missing0 = "movingSessions"))){validateProviderAccountCurrentUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs6: any = errors;for(const key0 in data){if(!((key0 === "account") || (key0 === "movingSessions"))){validateProviderAccountCurrentUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs6 === errors){if(data.account !== undefined){const _errs7: any = errors;if(!(validateProviderAccount.call(this, data.account, {instancePath:instancePath+"/account",parentData:data,parentDataProperty:"account",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccount.errors : vErrors.concat(validateProviderAccount.errors);errors = vErrors.length;}var valid3: any = _errs7 === errors;}else {var valid3: any = true;}if(valid3){if(data.movingSessions !== undefined){let data3: any = data.movingSessions;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data3)){var valid4: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs10: any = errors;if(!(validateProviderAccountMovingSession.call(this, data3[i0], {instancePath:instancePath+"/movingSessions/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountMovingSession.errors : vErrors.concat(validateProviderAccountMovingSession.errors);errors = vErrors.length;}var valid4: any = _errs10 === errors;if(!valid4){break;}}}else {validateProviderAccountCurrentUpdateResponse.errors = [{instancePath:instancePath+"/movingSessions",schemaPath:"#/properties/movingSessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid3: any = _errs8 === errors;}else {var valid3: any = true;}}}}}else {validateProviderAccountCurrentUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountCurrentUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountCurrentUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountNotAuthenticatedDetails}. */
// prettier-ignore
export const validateProviderAccountNotAuthenticatedDetails: CompiledSchemaCheck<ProviderAccountNotAuthenticatedDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountNotAuthenticatedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountNotAuthenticatedDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.remedy === undefined) && (missing0 = "remedy")){validateProviderAccountNotAuthenticatedDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "remedy")){validateProviderAccountNotAuthenticatedDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.remedy !== undefined){if(!(validateProviderSignInExpiredRemedy.call(this, data.remedy, {instancePath:instancePath+"/remedy",parentData:data,parentDataProperty:"remedy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderSignInExpiredRemedy.errors : vErrors.concat(validateProviderSignInExpiredRemedy.errors);errors = vErrors.length;}}}}}else {validateProviderAccountNotAuthenticatedDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountNotAuthenticatedDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountNotAuthenticatedDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountProbeRequest}. */
// prettier-ignore
export const validateProviderAccountProbeRequest: CompiledSchemaCheck<ProviderAccountProbeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountProbeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountProbeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){validateProviderAccountProbeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accountId")){validateProviderAccountProbeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}}}}}else {validateProviderAccountProbeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountProbeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountProbeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountProbeResponse}. */
// prettier-ignore
export const validateProviderAccountProbeResponse: CompiledSchemaCheck<ProviderAccountProbeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountProbeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountProbeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.accountId === undefined) && (missing0 = "accountId")) || ((data.healthState === undefined) && (missing0 = "healthState"))) || ((data.credentialGeneration === undefined) && (missing0 = "credentialGeneration"))){validateProviderAccountProbeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "accountId") || (key0 === "healthState")) || (key0 === "credentialGeneration"))){validateProviderAccountProbeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.healthState !== undefined){const _errs3: any = errors;if(!(validateProviderAccountHealthState.call(this, data.healthState, {instancePath:instancePath+"/healthState",parentData:data,parentDataProperty:"healthState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountHealthState.errors : vErrors.concat(validateProviderAccountHealthState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.credentialGeneration !== undefined){const _errs4: any = errors;if(!(validateCredentialGeneration.call(this, data.credentialGeneration, {instancePath:instancePath+"/credentialGeneration",parentData:data,parentDataProperty:"credentialGeneration",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCredentialGeneration.errors : vErrors.concat(validateCredentialGeneration.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateProviderAccountProbeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountProbeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountProbeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountMemoryImportRequest}. */
// prettier-ignore
export const validateProviderAccountMemoryImportRequest: CompiledSchemaCheck<ProviderAccountMemoryImportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountMemoryImportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountMemoryImportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){validateProviderAccountMemoryImportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accountId")){validateProviderAccountMemoryImportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accountId !== undefined){if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}}}}}else {validateProviderAccountMemoryImportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountMemoryImportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountMemoryImportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountUsageScope}. */
// prettier-ignore
export const validateProviderAccountUsageScope: CompiledSchemaCheck<ProviderAccountUsageScope> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUsageScope {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUsageScope.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accountId === undefined) && (missing0 = "accountId")){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(key0 === "accountId")){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.accountId !== undefined){if(!(validateProviderAccountId.call(this, data.accountId, {instancePath:instancePath+"/accountId",parentData:data,parentDataProperty:"accountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}}}}}else {const err2: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.provider === undefined) && (missing1 = "provider")){const err3: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {const _errs7: any = errors;for(const key1 in data){if(!(key1 === "provider")){const err4: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;break;}}if(_errs7 === errors){if(data.provider !== undefined){if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}}}}}else {const err5: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var _valid0: any = _errs5 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err6: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;validateProviderAccountUsageScope.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateProviderAccountUsageScope.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateProviderAccountUsageScope.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema935: any = {"description":"How a usage read splits its figures: by calendar day, or by model.","type":"string","enum":["day","model"]};
/** Checks that a value is a {@link ProviderAccountUsageGrouping}. */
// prettier-ignore
export const validateProviderAccountUsageGrouping: CompiledSchemaCheck<ProviderAccountUsageGrouping> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUsageGrouping {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUsageGrouping.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProviderAccountUsageGrouping.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "day") || (data === "model"))){validateProviderAccountUsageGrouping.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema935.enum}}];return false;}validateProviderAccountUsageGrouping.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountUsageGrouping.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountUsageListRequest}. */
// prettier-ignore
export const validateProviderAccountUsageListRequest: CompiledSchemaCheck<ProviderAccountUsageListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUsageListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUsageListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.scope === undefined) && (missing0 = "scope")){validateProviderAccountUsageListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "scope") || (key0 === "from")) || (key0 === "to")) || (key0 === "groupBy"))){validateProviderAccountUsageListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.scope !== undefined){const _errs2: any = errors;if(!(validateProviderAccountUsageScope.call(this, data.scope, {instancePath:instancePath+"/scope",parentData:data,parentDataProperty:"scope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountUsageScope.errors : vErrors.concat(validateProviderAccountUsageScope.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.from !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.from, {instancePath:instancePath+"/from",parentData:data,parentDataProperty:"from",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.to !== undefined){const _errs4: any = errors;if(!(validateWireInstant.call(this, data.to, {instancePath:instancePath+"/to",parentData:data,parentDataProperty:"to",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.groupBy !== undefined){const _errs5: any = errors;if(!(validateProviderAccountUsageGrouping.call(this, data.groupBy, {instancePath:instancePath+"/groupBy",parentData:data,parentDataProperty:"groupBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountUsageGrouping.errors : vErrors.concat(validateProviderAccountUsageGrouping.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateProviderAccountUsageListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountUsageListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountUsageListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountUsageRow}. */
// prettier-ignore
export const validateProviderAccountUsageRow: CompiledSchemaCheck<ProviderAccountUsageRow> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUsageRow {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUsageRow.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.tokens === undefined) && (missing0 = "tokens")) || ((data.costUsdMicros === undefined) && (missing0 = "costUsdMicros"))){validateProviderAccountUsageRow.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "day") || (key0 === "model")) || (key0 === "tokens")) || (key0 === "costUsdMicros"))){validateProviderAccountUsageRow.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.day !== undefined){const _errs2: any = errors;if(!(validateWireDate.call(this, data.day, {instancePath:instancePath+"/day",parentData:data,parentDataProperty:"day",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireDate.errors : vErrors.concat(validateWireDate.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.model !== undefined){let data1: any = data.model;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokens !== undefined){let data2: any = data.tokens;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateProviderAccountUsageRow.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.costUsdMicros !== undefined){const _errs7: any = errors;if(!(validateUsdMicros.call(this, data.costUsdMicros, {instancePath:instancePath+"/costUsdMicros",parentData:data,parentDataProperty:"costUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateProviderAccountUsageRow.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountUsageRow.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountUsageRow.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderAccountUsageListResponse}. */
// prettier-ignore
export const validateProviderAccountUsageListResponse: CompiledSchemaCheck<ProviderAccountUsageListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderAccountUsageListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderAccountUsageListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.rows === undefined) && (missing0 = "rows")){validateProviderAccountUsageListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "rows")){validateProviderAccountUsageListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.rows !== undefined){let data0: any = data.rows;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateProviderAccountUsageRow.call(this, data0[i0], {instancePath:instancePath+"/rows/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountUsageRow.errors : vErrors.concat(validateProviderAccountUsageRow.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateProviderAccountUsageListResponse.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateProviderAccountUsageListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderAccountUsageListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderAccountUsageListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link PROVIDER_ACCOUNT_METHOD_DESCRIPTORS}, each with its checks. */
export interface ProviderAccountMethodDescriptors {
  readonly "provider.account.list": {
    readonly method: "provider.account.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderAccountListRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountListResponse>;
  };
  readonly "provider.account.subscribe": {
    readonly method: "provider.account.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProviderAccountNotification>;
  };
  readonly "provider.account.register": {
    readonly method: "provider.account.register";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountRegisterRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountRegisterResponse>;
  };
  readonly "provider.account.update": {
    readonly method: "provider.account.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountUpdateResponse>;
  };
  readonly "provider.account.delete": {
    readonly method: "provider.account.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountDeleteRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountDeleteResponse>;
  };
  readonly "provider.account.current.update": {
    readonly method: "provider.account.current.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountCurrentUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountCurrentUpdateResponse>;
  };
  readonly "provider.account.probe": {
    readonly method: "provider.account.probe";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountProbeRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountProbeResponse>;
  };
  readonly "provider.account.credentialHome.reset": {
    readonly method: "provider.account.credentialHome.reset";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountCredentialHomeResetRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountCredentialHomeResetResponse>;
  };
  readonly "provider.account.signIn": {
    readonly method: "provider.account.signIn";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountSignInRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountSignInResponse>;
  };
  readonly "provider.account.signInCode.submit": {
    readonly method: "provider.account.signInCode.submit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountSignInCodeSubmitRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountSignInCodeSubmitResponse>;
  };
  readonly "provider.account.signInAttempt.cancel": {
    readonly method: "provider.account.signInAttempt.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountSignInAttemptCancelRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountSignInAttemptCancelResponse>;
  };
  readonly "provider.account.memory.import": {
    readonly method: "provider.account.memory.import";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountMemoryImportRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountMemoryImportOutcome>;
  };
  readonly "provider.account.usage.list": {
    readonly method: "provider.account.usage.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderAccountUsageListRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountUsageListResponse>;
  };
}
/** Every `provider.account.*` method: its name, how it answers, and its shapes. */
export const PROVIDER_ACCOUNT_METHOD_DESCRIPTORS: ProviderAccountMethodDescriptors = Object.freeze({
  "provider.account.list": Object.freeze({
    method: "provider.account.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProviderAccountListRequest,
    responseCheck: validateProviderAccountListResponse,
  }),
  "provider.account.subscribe": Object.freeze({
    method: "provider.account.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateProviderAccountNotification,
  }),
  "provider.account.register": Object.freeze({
    method: "provider.account.register",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountRegisterRequest,
    responseCheck: validateProviderAccountRegisterResponse,
  }),
  "provider.account.update": Object.freeze({
    method: "provider.account.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountUpdateRequest,
    responseCheck: validateProviderAccountUpdateResponse,
  }),
  "provider.account.delete": Object.freeze({
    method: "provider.account.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountDeleteRequest,
    responseCheck: validateProviderAccountDeleteResponse,
  }),
  "provider.account.current.update": Object.freeze({
    method: "provider.account.current.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountCurrentUpdateRequest,
    responseCheck: validateProviderAccountCurrentUpdateResponse,
  }),
  "provider.account.probe": Object.freeze({
    method: "provider.account.probe",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountProbeRequest,
    responseCheck: validateProviderAccountProbeResponse,
  }),
  "provider.account.credentialHome.reset": Object.freeze({
    method: "provider.account.credentialHome.reset",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountCredentialHomeResetRequest,
    responseCheck: validateProviderAccountCredentialHomeResetResponse,
  }),
  "provider.account.signIn": Object.freeze({
    method: "provider.account.signIn",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountSignInRequest,
    responseCheck: validateProviderAccountSignInResponse,
  }),
  "provider.account.signInCode.submit": Object.freeze({
    method: "provider.account.signInCode.submit",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountSignInCodeSubmitRequest,
    responseCheck: validateProviderAccountSignInCodeSubmitResponse,
  }),
  "provider.account.signInAttempt.cancel": Object.freeze({
    method: "provider.account.signInAttempt.cancel",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountSignInAttemptCancelRequest,
    responseCheck: validateProviderAccountSignInAttemptCancelResponse,
  }),
  "provider.account.memory.import": Object.freeze({
    method: "provider.account.memory.import",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderAccountMemoryImportRequest,
    responseCheck: validateProviderAccountMemoryImportOutcome,
  }),
  "provider.account.usage.list": Object.freeze({
    method: "provider.account.usage.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProviderAccountUsageListRequest,
    responseCheck: validateProviderAccountUsageListResponse,
  }),
});
