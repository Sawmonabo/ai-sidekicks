// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's work in its provider's own cloud: a task with attempts, or a cloud session.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  ucs2length,
} from "../schema-check.js";
import { type NonBlankText, validateNonBlankText } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type ProviderId, validateProviderId } from "./provider/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";

/** The longest cloud task id the daemon accepts. */
export const CLOUD_TASK_ID_MAX_LEN = 256 as const;

/** The longest cloud environment label the daemon accepts. */
export const CLOUD_ENVIRONMENT_LABEL_MAX_LEN = 256 as const;

/** The most attempts one cloud task runs: its provider's own bound. */
export const CLOUD_TASK_ATTEMPTS_MAX = 4 as const;

/** Every reason an account is not entitled to the cloud, for the session menu that shows why. */
export const CLOUD_ACCOUNT_NOT_ENTITLED_REASONS = [
  "signInKindNotEntitled",
  "subscriptionRequired",
] as const;

/**
 * The id the provider gave its cloud work: a task's id, or a cloud session's id.
 */
export type CloudTaskId = string & { readonly __brand: "CloudTaskId" };
/**
 * Why the account is not entitled to the provider's cloud: it is signed in a way that lacks it,
 * or it lacks the subscription it needs.
 */
export type CloudAccountNotEntitledReason = "signInKindNotEntitled" | "subscriptionRequired";
/**
 * What the provider reported when a task's attempt was applied to the session's folder: all of
 * it, part of it with the paths it skipped and the paths in conflict, or an error in the
 * provider's own words.
 */
export type CloudBringBack =
  | {
      outcome: "applied";
    }
  | {
      outcome: "partial";
      /**
       * The paths it skipped.
       */
      skippedPaths: string[];
      /**
       * The paths in conflict.
       */
      conflictingPaths: string[];
    }
  | {
      outcome: "error";
      /**
       * The provider's message.
       */
      message: string;
    };
/**
 * A state of a cloud task its provider reported without an error.
 */
export type CloudTaskState = "pending" | "ready" | "applied";
/**
 * One piece of a session's cloud work, with only the state its provider reported.
 */
export type CloudWork =
  | {
      /**
       * Always `task`.
       */
      kind: "task";
      /**
       * The task.
       */
      taskId: CloudTaskId;
      /**
       * The session that sent it.
       */
      sessionId: SessionId;
      /**
       * The provider whose cloud runs it.
       */
      provider: ProviderId;
      /**
       * The environment it runs in.
       */
      environment: string;
      /**
       * How many attempts it runs.
       */
      attempts: number;
      /**
       * The last bring-back of this task, or `null` before the first.
       */
      bringBack: CloudBringBack | null;
      /**
       * Its state.
       */
      state: CloudTaskState;
    }
  | {
      /**
       * Always `task`.
       */
      kind: "task";
      /**
       * The task.
       */
      taskId: CloudTaskId;
      /**
       * The session that sent it.
       */
      sessionId: SessionId;
      /**
       * The provider whose cloud runs it.
       */
      provider: ProviderId;
      /**
       * The environment it runs in.
       */
      environment: string;
      /**
       * How many attempts it runs.
       */
      attempts: number;
      /**
       * The last bring-back of this task, or `null` before the first.
       */
      bringBack: CloudBringBack | null;
      /**
       * Always `error`.
       */
      state: "error";
      /**
       * The provider's own message.
       */
      errorMessage: string;
    }
  | {
      /**
       * Always `session`.
       */
      kind: "session";
      /**
       * The cloud session.
       */
      taskId: CloudTaskId;
      /**
       * The session that sent it.
       */
      sessionId: SessionId;
      /**
       * The provider whose cloud holds it.
       */
      provider: ProviderId;
      /**
       * Always `submitted`.
       */
      state: "submitted";
      /**
       * Its address on the provider's site.
       */
      url: string;
    };
/**
 * What bringing cloud work back did: for a task, what the apply reported; for a cloud session,
 * the new session the returned work opened as.
 */
export type CloudTaskApplyResponse =
  | {
      kind: "task";
      /**
       * What the apply reported.
       */
      bringBack: CloudBringBack;
    }
  | {
      kind: "session";
      /**
       * The new session.
       */
      sessionId: SessionId;
    };

/**
 * The `cloud.accountNotEntitled` refusal's details: why, and the session's provider, so the
 * screen draws that provider's own sentence and remedy.
 */
export interface CloudAccountNotEntitledDetails {
  /**
   * Why.
   */
  reason: CloudAccountNotEntitledReason;
  /**
   * The session's provider.
   */
  provider: ProviderId;
}
/**
 * `cloud.task.start`: sends one message to the session's provider's cloud instead of to the
 * agent. `environment` and `attempts` belong to a task with attempts: the environment's label and
 * how many attempts to run.
 */
export interface CloudTaskStartRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The message.
   */
  prompt: NonBlankText;
  /**
   * The environment's label.
   */
  environment?: string;
  /**
   * How many attempts to run.
   */
  attempts?: number;
}
/**
 * The new work's id.
 */
export interface CloudTaskStartResponse {
  /**
   * The new work.
   */
  taskId: CloudTaskId;
}
/**
 * `cloud.task.subscribe`: the session whose cloud work the subscription follows.
 */
export interface CloudTaskSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The session's whole set of cloud work, sent first on subscribing and again on each change, so a
 * subscriber never composes changes into a set of its own.
 */
export interface CloudTaskSubscribeFrame {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its cloud work.
   */
  tasks: CloudWork[];
}
/**
 * `cloud.task.read`: the cloud work to read.
 */
export interface CloudTaskReadRequest {
  /**
   * The work.
   */
  taskId: CloudTaskId;
}
/**
 * `cloud.task.diff.read` and `cloud.task.apply`: one task's attempt, `attempt` picking one of a
 * task's several; for `cloud.task.apply` on a cloud session, the session to pull back.
 */
export interface CloudTaskAttemptRequest {
  /**
   * The work.
   */
  taskId: CloudTaskId;
  /**
   * The attempt.
   */
  attempt?: number;
}
/**
 * The attempt's diff as the provider prints it, for the review pane to show read-only.
 */
export interface CloudTaskDiffReadResponse {
  /**
   * The task.
   */
  taskId: CloudTaskId;
  /**
   * The attempt.
   */
  attempt: number;
  /**
   * Its diff.
   */
  diff: string;
}
/**
 * The `cloud.task.updated` payload: cloud work was sent, its provider reported a new state, or it
 * was brought back. It carries the whole work as it now stands, so the session's record of its
 * cloud work is the latest of these per id.
 */
export interface CloudTaskUpdatedPayload {
  /**
   * The work.
   */
  task: CloudWork;
}

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link CloudTaskId}. */
// prettier-ignore
export const validateCloudTaskId: CompiledSchemaCheck<CloudTaskId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateCloudTaskId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateCloudTaskId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateCloudTaskId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateCloudTaskId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema191: any = {"description":"Why the account is not entitled to the provider's cloud: it is signed in a way that lacks it,\nor it lacks the subscription it needs.","type":"string","enum":["signInKindNotEntitled","subscriptionRequired"]};
/** Checks that a value is a {@link CloudAccountNotEntitledReason}. */
// prettier-ignore
export const validateCloudAccountNotEntitledReason: CompiledSchemaCheck<CloudAccountNotEntitledReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudAccountNotEntitledReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudAccountNotEntitledReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateCloudAccountNotEntitledReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "signInKindNotEntitled") || (data === "subscriptionRequired"))){validateCloudAccountNotEntitledReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema191.enum}}];return false;}validateCloudAccountNotEntitledReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudAccountNotEntitledReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudAccountNotEntitledDetails}. */
// prettier-ignore
export const validateCloudAccountNotEntitledDetails: CompiledSchemaCheck<CloudAccountNotEntitledDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudAccountNotEntitledDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudAccountNotEntitledDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.reason === undefined) && (missing0 = "reason")) || ((data.provider === undefined) && (missing0 = "provider"))){validateCloudAccountNotEntitledDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reason") || (key0 === "provider"))){validateCloudAccountNotEntitledDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){const _errs2: any = errors;if(!(validateCloudAccountNotEntitledReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudAccountNotEntitledReason.errors : vErrors.concat(validateCloudAccountNotEntitledReason.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs3: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateCloudAccountNotEntitledDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudAccountNotEntitledDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudAccountNotEntitledDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link CloudBringBack}. */
// prettier-ignore
export const validateCloudBringBack: CompiledSchemaCheck<CloudBringBack> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudBringBack {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudBringBack.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "applied"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.outcome === undefined) && (missing0 = "outcome")){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "outcome")){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;if(typeof data0 !== "string"){validateCloudBringBack.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("applied" !== data0){validateCloudBringBack.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "applied"}}];return false;}}}}}else {validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "partial"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.outcome === undefined) && (missing1 = "outcome")) || ((data.skippedPaths === undefined) && (missing1 = "skippedPaths"))) || ((data.conflictingPaths === undefined) && (missing1 = "conflictingPaths"))){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!(((key1 === "outcome") || (key1 === "skippedPaths")) || (key1 === "conflictingPaths"))){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.outcome !== undefined){let data1: any = data.outcome;const _errs10: any = errors;if(typeof data1 !== "string"){validateCloudBringBack.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("partial" !== data1){validateCloudBringBack.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "partial"}}];return false;}var valid4: any = _errs10 === errors;}else {var valid4: any = true;}if(valid4){if(data.skippedPaths !== undefined){let data2: any = data.skippedPaths;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data2)){var valid5: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){let data3: any = data2[i0];const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) > 4096){validateCloudBringBack.errors = [{instancePath:instancePath+"/skippedPaths/" + i0,schemaPath:"#/oneOf/1/properties/skippedPaths/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validateCloudBringBack.errors = [{instancePath:instancePath+"/skippedPaths/" + i0,schemaPath:"#/oneOf/1/properties/skippedPaths/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data3)){validateCloudBringBack.errors = [{instancePath:instancePath+"/skippedPaths/" + i0,schemaPath:"#/oneOf/1/properties/skippedPaths/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateCloudBringBack.errors = [{instancePath:instancePath+"/skippedPaths/" + i0,schemaPath:"#/oneOf/1/properties/skippedPaths/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs14 === errors;if(!valid5){break;}}}else {validateCloudBringBack.errors = [{instancePath:instancePath+"/skippedPaths",schemaPath:"#/oneOf/1/properties/skippedPaths/type",keyword:"type",params:{type: "array"}}];return false;}}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.conflictingPaths !== undefined){let data4: any = data.conflictingPaths;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data4)){var valid6: any = true;const len1: any = data4.length;for(let i1=0; i1<len1; i1++){let data5: any = data4[i1];const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 4096){validateCloudBringBack.errors = [{instancePath:instancePath+"/conflictingPaths/" + i1,schemaPath:"#/oneOf/1/properties/conflictingPaths/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validateCloudBringBack.errors = [{instancePath:instancePath+"/conflictingPaths/" + i1,schemaPath:"#/oneOf/1/properties/conflictingPaths/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data5)){validateCloudBringBack.errors = [{instancePath:instancePath+"/conflictingPaths/" + i1,schemaPath:"#/oneOf/1/properties/conflictingPaths/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateCloudBringBack.errors = [{instancePath:instancePath+"/conflictingPaths/" + i1,schemaPath:"#/oneOf/1/properties/conflictingPaths/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs18 === errors;if(!valid6){break;}}}else {validateCloudBringBack.errors = [{instancePath:instancePath+"/conflictingPaths",schemaPath:"#/oneOf/1/properties/conflictingPaths/type",keyword:"type",params:{type: "array"}}];return false;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}}}}}}else {validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "error"){const _errs20: any = errors;if(errors === _errs20){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.outcome === undefined) && (missing2 = "outcome")) || ((data.message === undefined) && (missing2 = "message"))){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs22: any = errors;for(const key2 in data){if(!((key2 === "outcome") || (key2 === "message"))){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs22 === errors){if(data.outcome !== undefined){let data6: any = data.outcome;const _errs23: any = errors;if(typeof data6 !== "string"){validateCloudBringBack.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("error" !== data6){validateCloudBringBack.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/const",keyword:"const",params:{allowedValue: "error"}}];return false;}var valid8: any = _errs23 === errors;}else {var valid8: any = true;}if(valid8){if(data.message !== undefined){let data7: any = data.message;const _errs25: any = errors;if(errors === _errs25){if(typeof data7 === "string"){if(func1(data7) < 1){validateCloudBringBack.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateCloudBringBack.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/2/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs25 === errors;}else {var valid8: any = true;}}}}}else {validateCloudBringBack.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs20 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else {validateCloudBringBack.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validateCloudBringBack.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateCloudBringBack.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateCloudBringBack.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudBringBack.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudBringBack.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema203: any = {"description":"A state of a cloud task its provider reported without an error.","type":"string","enum":["pending","ready","applied"]};
/** Checks that a value is a {@link CloudTaskState}. */
// prettier-ignore
export const validateCloudTaskState: CompiledSchemaCheck<CloudTaskState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateCloudTaskState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "pending") || (data === "ready")) || (data === "applied"))){validateCloudTaskState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema203.enum}}];return false;}validateCloudTaskState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema202: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"Always `task`.","type":"string","enum":["task"]},"taskId":{"$ref":"#/$defs/CloudTaskId","description":"The task."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session that sent it."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider whose cloud runs it."},"environment":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The environment it runs in."},"attempts":{"type":"integer","minimum":1,"maximum":4,"description":"How many attempts it runs."},"bringBack":{"anyOf":[{"$ref":"#/$defs/CloudBringBack"},{"type":"null"}],"description":"The last bring-back of this task, or `null` before the first."},"state":{"$ref":"#/$defs/CloudTaskState","description":"Its state."}},"required":["kind","taskId","sessionId","provider","environment","attempts","bringBack","state"],"description":"A task its provider reported without an error."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"Always `task`.","type":"string","enum":["task"]},"taskId":{"$ref":"#/$defs/CloudTaskId","description":"The task."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session that sent it."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider whose cloud runs it."},"environment":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The environment it runs in."},"attempts":{"type":"integer","minimum":1,"maximum":4,"description":"How many attempts it runs."},"bringBack":{"anyOf":[{"$ref":"#/$defs/CloudBringBack"},{"type":"null"}],"description":"The last bring-back of this task, or `null` before the first."},"state":{"description":"Always `error`.","type":"string","enum":["error"]},"errorMessage":{"type":"string","minLength":1,"description":"The provider's own message."}},"required":["kind","taskId","sessionId","provider","environment","attempts","bringBack","state","errorMessage"],"description":"A task its provider reported as failed."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"Always `session`.","type":"string","enum":["session"]},"taskId":{"$ref":"#/$defs/CloudTaskId","description":"The cloud session."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session that sent it."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider whose cloud holds it."},"state":{"description":"Always `submitted`.","type":"string","enum":["submitted"]},"url":{"type":"string","format":"https-url","pattern":"^[^\\x00]*$","description":"Its address on the provider's site."}},"required":["kind","taskId","sessionId","provider","state","url"],"description":"A cloud session."}],"description":"One piece of a session's cloud work, with only the state its provider reported."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
/** Checks that a value is a {@link CloudWork}. */
// prettier-ignore
export const validateCloudWork: CompiledSchemaCheck<CloudWork> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudWork {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudWork.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.taskId === undefined) && (missing0 = "taskId"))) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.environment === undefined) && (missing0 = "environment"))) || ((data.attempts === undefined) && (missing0 = "attempts"))) || ((data.bringBack === undefined) && (missing0 = "bringBack"))) || ((data.state === undefined) && (missing0 = "state"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((((((key0 === "kind") || (key0 === "taskId")) || (key0 === "sessionId")) || (key0 === "provider")) || (key0 === "environment")) || (key0 === "attempts")) || (key0 === "bringBack")) || (key0 === "state"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/0/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(data0 === "task")){const err3: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/0/properties/kind/enum",keyword:"enum",params:{allowedValues: schema202.anyOf[0].properties.kind.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.taskId !== undefined){const _errs6: any = errors;if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.provider !== undefined){const _errs8: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.environment !== undefined){let data4: any = data.environment;const _errs9: any = errors;if(errors === _errs9){if(typeof data4 === "string"){if(func1(data4) > 256){const err4: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/0/properties/environment/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {if(func1(data4) < 1){const err5: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/0/properties/environment/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {if(!pattern5.test(data4)){const err6: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/0/properties/environment/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}}}else {const err7: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/0/properties/environment/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}if(valid1){if(data.attempts !== undefined){let data5: any = data.attempts;const _errs11: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){const err8: any = {instancePath:instancePath+"/attempts",schemaPath:"#/anyOf/0/properties/attempts/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}if(errors === _errs11){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 4 || isNaN(data5)){const err9: any = {instancePath:instancePath+"/attempts",schemaPath:"#/anyOf/0/properties/attempts/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {if(data5 < 1 || isNaN(data5)){const err10: any = {instancePath:instancePath+"/attempts",schemaPath:"#/anyOf/0/properties/attempts/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}}}var valid1: any = _errs11 === errors;}else {var valid1: any = true;}if(valid1){if(data.bringBack !== undefined){let data6: any = data.bringBack;const _errs13: any = errors;const _errs14: any = errors;let valid2: any = false;const _errs15: any = errors;if(!(validateCloudBringBack.call(this, data6, {instancePath:instancePath+"/bringBack",parentData:data,parentDataProperty:"bringBack",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudBringBack.errors : vErrors.concat(validateCloudBringBack.errors);errors = vErrors.length;}var _valid1: any = _errs15 === errors;valid2 = valid2 || _valid1;const _errs16: any = errors;if(data6 !== null){const err11: any = {instancePath:instancePath+"/bringBack",schemaPath:"#/anyOf/0/properties/bringBack/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}var _valid1: any = _errs16 === errors;valid2 = valid2 || _valid1;if(!valid2){const err12: any = {instancePath:instancePath+"/bringBack",schemaPath:"#/anyOf/0/properties/bringBack/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid1: any = _errs13 === errors;}else {var valid1: any = true;}if(valid1){if(data.state !== undefined){const _errs18: any = errors;if(!(validateCloudTaskState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskState.errors : vErrors.concat(validateCloudTaskState.errors);errors = vErrors.length;}var valid1: any = _errs18 === errors;}else {var valid1: any = true;}}}}}}}}}}}else {const err13: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props1: any = true;}const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((((data.kind === undefined) && (missing1 = "kind")) || ((data.taskId === undefined) && (missing1 = "taskId"))) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.provider === undefined) && (missing1 = "provider"))) || ((data.environment === undefined) && (missing1 = "environment"))) || ((data.attempts === undefined) && (missing1 = "attempts"))) || ((data.bringBack === undefined) && (missing1 = "bringBack"))) || ((data.state === undefined) && (missing1 = "state"))) || ((data.errorMessage === undefined) && (missing1 = "errorMessage"))){const err14: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {const _errs21: any = errors;for(const key1 in data){if(!(func2.call(schema202.anyOf[1].properties, key1))){const err15: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;break;}}if(_errs21 === errors){if(data.kind !== undefined){let data8: any = data.kind;const _errs22: any = errors;if(typeof data8 !== "string"){const err16: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/1/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}if(!(data8 === "task")){const err17: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/1/properties/kind/enum",keyword:"enum",params:{allowedValues: schema202.anyOf[1].properties.kind.enum}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var valid3: any = _errs22 === errors;}else {var valid3: any = true;}if(valid3){if(data.taskId !== undefined){const _errs24: any = errors;if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}var valid3: any = _errs24 === errors;}else {var valid3: any = true;}if(valid3){if(data.sessionId !== undefined){const _errs25: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid3: any = _errs25 === errors;}else {var valid3: any = true;}if(valid3){if(data.provider !== undefined){const _errs26: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid3: any = _errs26 === errors;}else {var valid3: any = true;}if(valid3){if(data.environment !== undefined){let data12: any = data.environment;const _errs27: any = errors;if(errors === _errs27){if(typeof data12 === "string"){if(func1(data12) > 256){const err18: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/1/properties/environment/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {if(func1(data12) < 1){const err19: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/1/properties/environment/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}else {if(!pattern5.test(data12)){const err20: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/1/properties/environment/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}}}}else {const err21: any = {instancePath:instancePath+"/environment",schemaPath:"#/anyOf/1/properties/environment/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}var valid3: any = _errs27 === errors;}else {var valid3: any = true;}if(valid3){if(data.attempts !== undefined){let data13: any = data.attempts;const _errs29: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){const err22: any = {instancePath:instancePath+"/attempts",schemaPath:"#/anyOf/1/properties/attempts/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}if(errors === _errs29){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 4 || isNaN(data13)){const err23: any = {instancePath:instancePath+"/attempts",schemaPath:"#/anyOf/1/properties/attempts/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}else {if(data13 < 1 || isNaN(data13)){const err24: any = {instancePath:instancePath+"/attempts",schemaPath:"#/anyOf/1/properties/attempts/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}}}var valid3: any = _errs29 === errors;}else {var valid3: any = true;}if(valid3){if(data.bringBack !== undefined){let data14: any = data.bringBack;const _errs31: any = errors;const _errs32: any = errors;let valid4: any = false;const _errs33: any = errors;if(!(validateCloudBringBack.call(this, data14, {instancePath:instancePath+"/bringBack",parentData:data,parentDataProperty:"bringBack",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudBringBack.errors : vErrors.concat(validateCloudBringBack.errors);errors = vErrors.length;}var _valid2: any = _errs33 === errors;valid4 = valid4 || _valid2;const _errs34: any = errors;if(data14 !== null){const err25: any = {instancePath:instancePath+"/bringBack",schemaPath:"#/anyOf/1/properties/bringBack/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}var _valid2: any = _errs34 === errors;valid4 = valid4 || _valid2;if(!valid4){const err26: any = {instancePath:instancePath+"/bringBack",schemaPath:"#/anyOf/1/properties/bringBack/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}else {errors = _errs32;if(vErrors !== null){if(_errs32){vErrors.length = _errs32;}else {vErrors = null;}}}var valid3: any = _errs31 === errors;}else {var valid3: any = true;}if(valid3){if(data.state !== undefined){let data15: any = data.state;const _errs36: any = errors;if(typeof data15 !== "string"){const err27: any = {instancePath:instancePath+"/state",schemaPath:"#/anyOf/1/properties/state/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}if(!(data15 === "error")){const err28: any = {instancePath:instancePath+"/state",schemaPath:"#/anyOf/1/properties/state/enum",keyword:"enum",params:{allowedValues: schema202.anyOf[1].properties.state.enum}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}var valid3: any = _errs36 === errors;}else {var valid3: any = true;}if(valid3){if(data.errorMessage !== undefined){let data16: any = data.errorMessage;const _errs38: any = errors;if(errors === _errs38){if(typeof data16 === "string"){if(func1(data16) < 1){const err29: any = {instancePath:instancePath+"/errorMessage",schemaPath:"#/anyOf/1/properties/errorMessage/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}else {const err30: any = {instancePath:instancePath+"/errorMessage",schemaPath:"#/anyOf/1/properties/errorMessage/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}}var valid3: any = _errs38 === errors;}else {var valid3: any = true;}}}}}}}}}}}}else {const err31: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}}var _valid0: any = _errs19 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props1 !== true){props1 = true;}}const _errs40: any = errors;if(errors === _errs40){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.kind === undefined) && (missing2 = "kind")) || ((data.taskId === undefined) && (missing2 = "taskId"))) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.provider === undefined) && (missing2 = "provider"))) || ((data.state === undefined) && (missing2 = "state"))) || ((data.url === undefined) && (missing2 = "url"))){const err32: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}else {const _errs42: any = errors;for(const key2 in data){if(!((((((key2 === "kind") || (key2 === "taskId")) || (key2 === "sessionId")) || (key2 === "provider")) || (key2 === "state")) || (key2 === "url"))){const err33: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;break;}}if(_errs42 === errors){if(data.kind !== undefined){let data17: any = data.kind;const _errs43: any = errors;if(typeof data17 !== "string"){const err34: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/2/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}if(!(data17 === "session")){const err35: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/2/properties/kind/enum",keyword:"enum",params:{allowedValues: schema202.anyOf[2].properties.kind.enum}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}var valid5: any = _errs43 === errors;}else {var valid5: any = true;}if(valid5){if(data.taskId !== undefined){const _errs45: any = errors;if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}var valid5: any = _errs45 === errors;}else {var valid5: any = true;}if(valid5){if(data.sessionId !== undefined){const _errs46: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid5: any = _errs46 === errors;}else {var valid5: any = true;}if(valid5){if(data.provider !== undefined){const _errs47: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid5: any = _errs47 === errors;}else {var valid5: any = true;}if(valid5){if(data.state !== undefined){let data21: any = data.state;const _errs48: any = errors;if(typeof data21 !== "string"){const err36: any = {instancePath:instancePath+"/state",schemaPath:"#/anyOf/2/properties/state/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}if(!(data21 === "submitted")){const err37: any = {instancePath:instancePath+"/state",schemaPath:"#/anyOf/2/properties/state/enum",keyword:"enum",params:{allowedValues: schema202.anyOf[2].properties.state.enum}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}var valid5: any = _errs48 === errors;}else {var valid5: any = true;}if(valid5){if(data.url !== undefined){let data22: any = data.url;const _errs50: any = errors;if(errors === _errs50){if(errors === _errs50){if(typeof data22 === "string"){if(!pattern33.test(data22)){const err38: any = {instancePath:instancePath+"/url",schemaPath:"#/anyOf/2/properties/url/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}else {if(!(formats0(data22))){const err39: any = {instancePath:instancePath+"/url",schemaPath:"#/anyOf/2/properties/url/format",keyword:"format",params:{format: "https-url"}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}}else {const err40: any = {instancePath:instancePath+"/url",schemaPath:"#/anyOf/2/properties/url/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}}}var valid5: any = _errs50 === errors;}else {var valid5: any = true;}}}}}}}}}else {const err41: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}}var _valid0: any = _errs40 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props1 !== true){props1 = true;}}if(!valid0){const err42: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;validateCloudWork.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateCloudWork.errors = vErrors;evaluated0.props = props1;return errors === 0;};
// prettier-ignore
validateCloudWork.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskStartRequest}. */
// prettier-ignore
export const validateCloudTaskStartRequest: CompiledSchemaCheck<CloudTaskStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.prompt === undefined) && (missing0 = "prompt"))){validateCloudTaskStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "prompt")) || (key0 === "environment")) || (key0 === "attempts"))){validateCloudTaskStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.prompt !== undefined){const _errs3: any = errors;if(!(validateNonBlankText.call(this, data.prompt, {instancePath:instancePath+"/prompt",parentData:data,parentDataProperty:"prompt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateNonBlankText.errors : vErrors.concat(validateNonBlankText.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.environment !== undefined){let data2: any = data.environment;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/environment",schemaPath:"#/properties/environment/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/environment",schemaPath:"#/properties/environment/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/environment",schemaPath:"#/properties/environment/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/environment",schemaPath:"#/properties/environment/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempts !== undefined){let data3: any = data.attempts;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/attempts",schemaPath:"#/properties/attempts/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 4 || isNaN(data3)){validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/attempts",schemaPath:"#/properties/attempts/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateCloudTaskStartRequest.errors = [{instancePath:instancePath+"/attempts",schemaPath:"#/properties/attempts/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateCloudTaskStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskStartResponse}. */
// prettier-ignore
export const validateCloudTaskStartResponse: CompiledSchemaCheck<CloudTaskStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.taskId === undefined) && (missing0 = "taskId")){validateCloudTaskStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "taskId")){validateCloudTaskStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.taskId !== undefined){if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}}}}}else {validateCloudTaskStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskSubscribeRequest}. */
// prettier-ignore
export const validateCloudTaskSubscribeRequest: CompiledSchemaCheck<CloudTaskSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateCloudTaskSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateCloudTaskSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateCloudTaskSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskSubscribeFrame}. */
// prettier-ignore
export const validateCloudTaskSubscribeFrame: CompiledSchemaCheck<CloudTaskSubscribeFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskSubscribeFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskSubscribeFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.tasks === undefined) && (missing0 = "tasks"))){validateCloudTaskSubscribeFrame.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "tasks"))){validateCloudTaskSubscribeFrame.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tasks !== undefined){let data1: any = data.tasks;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateCloudWork.call(this, data1[i0], {instancePath:instancePath+"/tasks/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudWork.errors : vErrors.concat(validateCloudWork.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateCloudTaskSubscribeFrame.errors = [{instancePath:instancePath+"/tasks",schemaPath:"#/properties/tasks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateCloudTaskSubscribeFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskSubscribeFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskSubscribeFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskReadRequest}. */
// prettier-ignore
export const validateCloudTaskReadRequest: CompiledSchemaCheck<CloudTaskReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.taskId === undefined) && (missing0 = "taskId")){validateCloudTaskReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "taskId")){validateCloudTaskReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.taskId !== undefined){if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}}}}}else {validateCloudTaskReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskAttemptRequest}. */
// prettier-ignore
export const validateCloudTaskAttemptRequest: CompiledSchemaCheck<CloudTaskAttemptRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskAttemptRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskAttemptRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.taskId === undefined) && (missing0 = "taskId")){validateCloudTaskAttemptRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "taskId") || (key0 === "attempt"))){validateCloudTaskAttemptRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.taskId !== undefined){const _errs2: any = errors;if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data1: any = data.attempt;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateCloudTaskAttemptRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 4 || isNaN(data1)){validateCloudTaskAttemptRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateCloudTaskAttemptRequest.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateCloudTaskAttemptRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskAttemptRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskAttemptRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskDiffReadResponse}. */
// prettier-ignore
export const validateCloudTaskDiffReadResponse: CompiledSchemaCheck<CloudTaskDiffReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskDiffReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskDiffReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.taskId === undefined) && (missing0 = "taskId")) || ((data.attempt === undefined) && (missing0 = "attempt"))) || ((data.diff === undefined) && (missing0 = "diff"))){validateCloudTaskDiffReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "taskId") || (key0 === "attempt")) || (key0 === "diff"))){validateCloudTaskDiffReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.taskId !== undefined){const _errs2: any = errors;if(!(validateCloudTaskId.call(this, data.taskId, {instancePath:instancePath+"/taskId",parentData:data,parentDataProperty:"taskId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudTaskId.errors : vErrors.concat(validateCloudTaskId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data1: any = data.attempt;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateCloudTaskDiffReadResponse.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 4 || isNaN(data1)){validateCloudTaskDiffReadResponse.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateCloudTaskDiffReadResponse.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.diff !== undefined){const _errs5: any = errors;if(typeof data.diff !== "string"){validateCloudTaskDiffReadResponse.errors = [{instancePath:instancePath+"/diff",schemaPath:"#/properties/diff/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateCloudTaskDiffReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskDiffReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskDiffReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskApplyResponse}. */
// prettier-ignore
export const validateCloudTaskApplyResponse: CompiledSchemaCheck<CloudTaskApplyResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskApplyResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskApplyResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "task"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.bringBack === undefined) && (missing0 = "bringBack"))){validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "bringBack"))){validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateCloudTaskApplyResponse.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("task" !== data0){validateCloudTaskApplyResponse.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "task"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.bringBack !== undefined){const _errs7: any = errors;if(!(validateCloudBringBack.call(this, data.bringBack, {instancePath:instancePath+"/bringBack",parentData:data,parentDataProperty:"bringBack",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudBringBack.errors : vErrors.concat(validateCloudBringBack.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "session"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))){validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "sessionId"))){validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs11: any = errors;if(typeof data2 !== "string"){validateCloudTaskApplyResponse.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("session" !== data2){validateCloudTaskApplyResponse.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "session"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs13: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}}}}}else {validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateCloudTaskApplyResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskApplyResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskApplyResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloudTaskUpdatedPayload}. */
// prettier-ignore
export const validateCloudTaskUpdatedPayload: CompiledSchemaCheck<CloudTaskUpdatedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloudTaskUpdatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloudTaskUpdatedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.task === undefined) && (missing0 = "task")){validateCloudTaskUpdatedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "task")){validateCloudTaskUpdatedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.task !== undefined){if(!(validateCloudWork.call(this, data.task, {instancePath:instancePath+"/task",parentData:data,parentDataProperty:"task",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloudWork.errors : vErrors.concat(validateCloudWork.errors);errors = vErrors.length;}}}}}else {validateCloudTaskUpdatedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCloudTaskUpdatedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloudTaskUpdatedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link CLOUD_METHOD_DESCRIPTORS}, each with its checks. */
export interface CloudMethodDescriptors {
  readonly "cloud.task.start": {
    readonly method: "cloud.task.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<CloudTaskStartRequest>;
    readonly responseCheck: SchemaCheck<CloudTaskStartResponse>;
  };
  readonly "cloud.task.subscribe": {
    readonly method: "cloud.task.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<CloudTaskSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<CloudTaskSubscribeFrame>;
  };
  readonly "cloud.task.read": {
    readonly method: "cloud.task.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<CloudTaskReadRequest>;
    readonly responseCheck: SchemaCheck<CloudWork>;
  };
  readonly "cloud.task.diff.read": {
    readonly method: "cloud.task.diff.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<CloudTaskAttemptRequest>;
    readonly responseCheck: SchemaCheck<CloudTaskDiffReadResponse>;
  };
  readonly "cloud.task.apply": {
    readonly method: "cloud.task.apply";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<CloudTaskAttemptRequest>;
    readonly responseCheck: SchemaCheck<CloudTaskApplyResponse>;
  };
}
/** The `cloud.*` methods. */
export const CLOUD_METHOD_DESCRIPTORS: CloudMethodDescriptors = Object.freeze({
  "cloud.task.start": Object.freeze({
    method: "cloud.task.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateCloudTaskStartRequest,
    responseCheck: validateCloudTaskStartResponse,
  }),
  "cloud.task.subscribe": Object.freeze({
    method: "cloud.task.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateCloudTaskSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateCloudTaskSubscribeFrame,
  }),
  "cloud.task.read": Object.freeze({
    method: "cloud.task.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateCloudTaskReadRequest,
    responseCheck: validateCloudWork,
  }),
  "cloud.task.diff.read": Object.freeze({
    method: "cloud.task.diff.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateCloudTaskAttemptRequest,
    responseCheck: validateCloudTaskDiffReadResponse,
  }),
  "cloud.task.apply": Object.freeze({
    method: "cloud.task.apply",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateCloudTaskAttemptRequest,
    responseCheck: validateCloudTaskApplyResponse,
  }),
});
