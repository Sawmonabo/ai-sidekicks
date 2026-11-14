// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Interventions on a running run: the interrupt and the faster-model retry a caller sends through `agent.run.intervene`, the daemon's answer, the states an intervention passes through, and an interrupt's stored record.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type ProviderTurnId, validateProviderTurnId } from "../turn.js";
import { type RunId, validateRunId } from "./id.js";
import { type QueueItemId, validateQueueItemId } from "./queue.js";

/** Every state an intervention passes through, `requested` first. */
export const INTERVENTION_STATES = [
  "requested",
  "accepted",
  "applied",
  "rejected",
  "degraded",
  "expired",
  "failed",
] as const;

/**
 * Identifies one intervention on a run.
 */
export type InterventionId = string & { readonly __brand: "InterventionId" };
/**
 * How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a
 * faster model, which the daemon carries out by stopping the turn and sending its message again on
 * the named model. A person's message mid-turn is a queue send, never an intervention.
 */
export type InterventionType = "interrupt" | "fasterModelRetry";
/**
 * Where an intervention stands, from request to outcome; each state has its own event. `failed`
 * is a dispatch that threw, so a request never stays `accepted` for good.
 */
export type InterventionState =
  | "requested"
  | "accepted"
  | "applied"
  | "rejected"
  | "degraded"
  | "expired"
  | "failed";
/**
 * A limit the daemon stops a run at by itself: the step limit on a provider that does not bound a
 * turn's steps, or the spend or token limit. Only the daemon's own stop records one.
 */
export type RunLimit = "stepLimit" | "spendLimit" | "tokenLimit";
/**
 * A person's interrupt as its `interventions` row stores it: what becomes of the waiting
 * messages, the message delivered first and the person's reason, never a limit.
 */
export type PersonInterruptRecord =
  | {
      pending: "nextTurn";
      /**
       * The message `Send now` puts ahead of the rest.
       */
      deliverFirst?: QueueItemId;
      /**
       * The person's reason.
       */
      reason?: string;
      /**
       * Never present: only the daemon's own stop carries a limit.
       */
      limit?: never;
    }
  | {
      pending: "returnToDraft";
      /**
       * Never present: a message delivered first goes as the next turn.
       */
      deliverFirst?: never;
      /**
       * The person's reason.
       */
      reason?: string;
      /**
       * Never present: only the daemon's own stop carries a limit.
       */
      limit?: never;
    };
/**
 * The stored `payload` of an interrupt's `interventions` row: a person's, the daemon's own at a
 * limit, or the daemon's own for an undo. The three arms are disjoint: a person's carries
 * `pending` and no limit, a limit's only its limit, an undo's only its `undoKey`, so a person's
 * reason never reads as a limit and a mixed row is refused.
 */
export type InterruptInterventionRecord =
  | PersonInterruptRecord
  | LimitInterruptRecord
  | UndoInterruptRecord;
/**
 * A caller's request to interrupt or retry a run; a person's steer is an `agent.queueItem.create`,
 * never an intervention. `fasterModelRetry` resends a turn the provider holds for a safety check
 * on `model`.
 */
export type AgentRunInterveneRequest =
  | ((
      | {
          pending: "nextTurn";
          /**
           * The run interrupted.
           */
          targetRunId: RunId;
          /**
           * The run version the caller last saw; an absent or outdated one is refused,
           * never applied.
           */
          expectedRunVersion: number;
          /**
           * The caller's key, stored with the intervention, so an identical retry answers
           * the recorded outcome.
           */
          clientIdempotencyKey: string;
          /**
           * The person's reason.
           */
          reason?: string;
          /**
           * The message `Send now` puts ahead of the rest.
           */
          deliverFirst?: QueueItemId;
        }
      | {
          pending: "returnToDraft";
          /**
           * The run interrupted.
           */
          targetRunId: RunId;
          /**
           * The run version the caller last saw; an absent or outdated one is refused,
           * never applied.
           */
          expectedRunVersion: number;
          /**
           * The caller's key, stored with the intervention, so an identical retry answers
           * the recorded outcome.
           */
          clientIdempotencyKey: string;
          /**
           * The person's reason.
           */
          reason?: string;
          /**
           * Never present: a message delivered first goes as the next turn.
           */
          deliverFirst?: never;
        }
    ) & {
      type: "interrupt";
    })
  | {
      type: "fasterModelRetry";
      /**
       * The run retried.
       */
      targetRunId: RunId;
      /**
       * The run version the caller last saw; an absent or outdated one is refused, never
       * applied.
       */
      expectedRunVersion: number;
      /**
       * The caller's key, stored with the intervention, so an identical retry answers the
       * recorded outcome.
       */
      clientIdempotencyKey: string;
      /**
       * The provider's id of the turn held.
       */
      expectedTurnId: ProviderTurnId;
      /**
       * The model the turn is sent again on.
       */
      model: string;
    };
/**
 * The daemon's answer to an intervention request. A refused intervention is a normal answer in
 * state `rejected` with a machine-readable `rejectionReason`, not a JSON-RPC error; one whose
 * dispatch threw, never completed or was never sent answers `failed` with its `failureReason`,
 * the error's code or message, the restart that lost the outcome or the run's end and
 * continue before the dispatch, and a retry under the same key answers the same. No other
 * state carries a reason.
 */
export type AgentRunInterveneResponse =
  | {
      state: "requested";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "accepted";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "applied";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "degraded";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "expired";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "rejected";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The machine-readable cause, such as `provider.capability.unsupported`.
       */
      rejectionReason: string;
      /**
       * Never present outside `failed`.
       */
      failureReason?: never;
    }
  | {
      state: "failed";
      /**
       * The intervention.
       */
      interventionId: InterventionId;
      /**
       * What it does.
       */
      interventionType: InterventionType;
      /**
       * The run version after the intervention, for the caller's next
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The thrown error's code, else its message, or why it never completed or was never
       * sent.
       */
      failureReason: string;
      /**
       * Never present outside `rejected`.
       */
      rejectionReason?: never;
    };

/**
 * The daemon's own stop at a limit as its `interventions` row stores it, with no device: the
 * limit and the turn the stop cut, so a restart settles the run and ends that turn with that
 * cause. The waiting messages stay waiting.
 */
export interface LimitInterruptRecord {
  /**
   * The limit the run reached.
   */
  limit: RunLimit;
  /**
   * The turn the stop cut; absent when no turn of the run was open.
   */
  turnNumber?: number;
}
/**
 * The daemon's own interrupt for an undo as its `interventions` row stores it, with no device:
 * the undo it stopped the run for, named by its idempotency key. The waiting messages stay
 * waiting.
 */
export interface UndoInterruptRecord {
  /**
   * The idempotency key of the undo the interrupt serves.
   */
  undoKey: string;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link InterventionId}. */
// prettier-ignore
export const validateInterventionId: CompiledSchemaCheck<InterventionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is InterventionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateInterventionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateInterventionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateInterventionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateInterventionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateInterventionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema597: any = {"description":"How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a\nfaster model, which the daemon carries out by stopping the turn and sending its message again on\nthe named model. A person's message mid-turn is a queue send, never an intervention.","type":"string","enum":["interrupt","fasterModelRetry"]};
/** Checks that a value is a {@link InterventionType}. */
// prettier-ignore
export const validateInterventionType: CompiledSchemaCheck<InterventionType> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is InterventionType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateInterventionType.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateInterventionType.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "interrupt") || (data === "fasterModelRetry"))){validateInterventionType.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema597.enum}}];return false;}validateInterventionType.errors = vErrors;return errors === 0;};
// prettier-ignore
validateInterventionType.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link AgentRunInterveneRequest}. */
// prettier-ignore
export const validateAgentRunInterveneRequest: CompiledSchemaCheck<AgentRunInterveneRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunInterveneRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunInterveneRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.type;if(typeof tag0 == "string"){if(tag0 === "interrupt"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.type === undefined) && (missing0 = "type")){validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {if(data.type !== undefined){let data0: any = data.type;const _errs5: any = errors;if(typeof data0 !== "string"){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("interrupt" !== data0){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "interrupt"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){const tag1: any = data.pending;if(typeof tag1 == "string"){if(tag1 === "nextTurn"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.pending === undefined) && (missing1 = "pending")) || ((data.targetRunId === undefined) && (missing1 = "targetRunId"))) || ((data.expectedRunVersion === undefined) && (missing1 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing1 = "clientIdempotencyKey"))){validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {if(data.pending !== undefined){let data1: any = data.pending;const _errs9: any = errors;if(typeof data1 !== "string"){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/0/properties/pending/type",keyword:"type",params:{type: "string"}}];return false;}if("nextTurn" !== data1){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/0/properties/pending/const",keyword:"const",params:{allowedValue: "nextTurn"}}];return false;}var valid5: any = _errs9 === errors;}else {var valid5: any = true;}if(valid5){if(data.targetRunId !== undefined){const _errs11: any = errors;if(!(validateRunId.call(this, data.targetRunId, {instancePath:instancePath+"/targetRunId",parentData:data,parentDataProperty:"targetRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid5: any = _errs11 === errors;}else {var valid5: any = true;}if(valid5){if(data.expectedRunVersion !== undefined){let data3: any = data.expectedRunVersion;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/0/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/0/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/0/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs12 === errors;}else {var valid5: any = true;}if(valid5){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(!pattern88.test(data4)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/0/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/0/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data.reason !== undefined){let data5: any = data.reason;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) > 512){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data5) < 1){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data.deliverFirst !== undefined){const _errs18: any = errors;if(!(validateQueueItemId.call(this, data.deliverFirst, {instancePath:instancePath+"/deliverFirst",parentData:data,parentDataProperty:"deliverFirst",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateQueueItemId.errors : vErrors.concat(validateQueueItemId.errors);errors = vErrors.length;}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}}}}}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var props0: any = {};props0.pending = true;props0.targetRunId = true;props0.expectedRunVersion = true;props0.clientIdempotencyKey = true;props0.reason = true;props0.deliverFirst = true;props0.type = true;}else if(tag1 === "returnToDraft"){const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.pending === undefined) && (missing2 = "pending")) || ((data.targetRunId === undefined) && (missing2 = "targetRunId"))) || ((data.expectedRunVersion === undefined) && (missing2 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing2 = "clientIdempotencyKey"))){validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {if(data.pending !== undefined){let data7: any = data.pending;const _errs21: any = errors;if(typeof data7 !== "string"){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/1/properties/pending/type",keyword:"type",params:{type: "string"}}];return false;}if("returnToDraft" !== data7){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/1/properties/pending/const",keyword:"const",params:{allowedValue: "returnToDraft"}}];return false;}var valid7: any = _errs21 === errors;}else {var valid7: any = true;}if(valid7){if(data.targetRunId !== undefined){const _errs23: any = errors;if(!(validateRunId.call(this, data.targetRunId, {instancePath:instancePath+"/targetRunId",parentData:data,parentDataProperty:"targetRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid7: any = _errs23 === errors;}else {var valid7: any = true;}if(valid7){if(data.expectedRunVersion !== undefined){let data9: any = data.expectedRunVersion;const _errs24: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/1/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/1/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/1/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs24 === errors;}else {var valid7: any = true;}if(valid7){if(data.clientIdempotencyKey !== undefined){let data10: any = data.clientIdempotencyKey;const _errs26: any = errors;if(errors === _errs26){if(typeof data10 === "string"){if(!pattern88.test(data10)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/1/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/1/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs26 === errors;}else {var valid7: any = true;}if(valid7){if(data.reason !== undefined){let data11: any = data.reason;const _errs28: any = errors;if(errors === _errs28){if(typeof data11 === "string"){if(func1(data11) > 512){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data11) < 1){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data11)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}if(valid7){if(data.deliverFirst !== undefined){const _errs30: any = errors;validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/deliverFirst",schemaPath:"#/oneOf/0/oneOf/1/properties/deliverFirst/not",keyword:"not",params:{}}];return false;var valid7: any = _errs30 === errors;}else {var valid7: any = true;}}}}}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}if(props0 !== true){props0 = props0 || {};props0.pending = true;props0.targetRunId = true;props0.expectedRunVersion = true;props0.clientIdempotencyKey = true;props0.reason = true;props0.deliverFirst = true;}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "pending", tagValue: tag1}}];return false;}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/discriminator",keyword:"discriminator",params:{error: "tag", tag: "pending", tagValue: tag1}}];return false;}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;valid0 = valid1;}else if(tag0 === "fasterModelRetry"){const _errs33: any = errors;if(errors === _errs33){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((((data.type === undefined) && (missing3 = "type")) || ((data.targetRunId === undefined) && (missing3 = "targetRunId"))) || ((data.expectedRunVersion === undefined) && (missing3 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing3 = "clientIdempotencyKey"))) || ((data.expectedTurnId === undefined) && (missing3 = "expectedTurnId"))) || ((data.model === undefined) && (missing3 = "model"))){validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs35: any = errors;for(const key0 in data){if(!((((((key0 === "type") || (key0 === "targetRunId")) || (key0 === "expectedRunVersion")) || (key0 === "clientIdempotencyKey")) || (key0 === "expectedTurnId")) || (key0 === "model"))){validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs35 === errors){if(data.type !== undefined){let data13: any = data.type;const _errs36: any = errors;if(typeof data13 !== "string"){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("fasterModelRetry" !== data13){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "fasterModelRetry"}}];return false;}var valid9: any = _errs36 === errors;}else {var valid9: any = true;}if(valid9){if(data.targetRunId !== undefined){const _errs38: any = errors;if(!(validateRunId.call(this, data.targetRunId, {instancePath:instancePath+"/targetRunId",parentData:data,parentDataProperty:"targetRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid9: any = _errs38 === errors;}else {var valid9: any = true;}if(valid9){if(data.expectedRunVersion !== undefined){let data15: any = data.expectedRunVersion;const _errs39: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/1/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs39){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/1/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/1/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs39 === errors;}else {var valid9: any = true;}if(valid9){if(data.clientIdempotencyKey !== undefined){let data16: any = data.clientIdempotencyKey;const _errs41: any = errors;if(errors === _errs41){if(typeof data16 === "string"){if(!pattern88.test(data16)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/1/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/1/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs41 === errors;}else {var valid9: any = true;}if(valid9){if(data.expectedTurnId !== undefined){const _errs43: any = errors;if(!(validateProviderTurnId.call(this, data.expectedTurnId, {instancePath:instancePath+"/expectedTurnId",parentData:data,parentDataProperty:"expectedTurnId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderTurnId.errors : vErrors.concat(validateProviderTurnId.errors);errors = vErrors.length;}var valid9: any = _errs43 === errors;}else {var valid9: any = true;}if(valid9){if(data.model !== undefined){let data18: any = data.model;const _errs44: any = errors;if(errors === _errs44){if(typeof data18 === "string"){if(func1(data18) > 128){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data18) < 1){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data18)){validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs44 === errors;}else {var valid9: any = true;}}}}}}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs33 === errors;if(props0 !== true){props0 = true;}valid0 = valid8;}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key1 in data){if(!props0 || !props0[key1]){validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key1}}];return false;break;}}}}}else {validateAgentRunInterveneRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunInterveneRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunInterveneRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunInterveneResponse}. */
// prettier-ignore
export const validateAgentRunInterveneResponse: CompiledSchemaCheck<AgentRunInterveneResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunInterveneResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunInterveneResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "requested"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.state === undefined) && (missing0 = "state")) || ((data.interventionId === undefined) && (missing0 = "interventionId"))) || ((data.interventionType === undefined) && (missing0 = "interventionType"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((((key0 === "state") || (key0 === "interventionId")) || (key0 === "interventionType")) || (key0 === "runVersion")) || (key0 === "rejectionReason")) || (key0 === "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("requested" !== data0){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "requested"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.interventionId !== undefined){const _errs7: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.interventionType !== undefined){const _errs8: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.runVersion !== undefined){let data3: any = data.runVersion;const _errs9: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/0/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/0/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/0/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.rejectionReason !== undefined){const _errs11: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/0/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.failureReason !== undefined){const _errs14: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/0/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "accepted"){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.interventionId === undefined) && (missing1 = "interventionId"))) || ((data.interventionType === undefined) && (missing1 = "interventionType"))) || ((data.runVersion === undefined) && (missing1 = "runVersion"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs19: any = errors;for(const key1 in data){if(!((((((key1 === "state") || (key1 === "interventionId")) || (key1 === "interventionType")) || (key1 === "runVersion")) || (key1 === "rejectionReason")) || (key1 === "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs19 === errors){if(data.state !== undefined){let data6: any = data.state;const _errs20: any = errors;if(typeof data6 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("accepted" !== data6){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "accepted"}}];return false;}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.interventionId !== undefined){const _errs22: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.interventionType !== undefined){const _errs23: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid4: any = _errs23 === errors;}else {var valid4: any = true;}if(valid4){if(data.runVersion !== undefined){let data9: any = data.runVersion;const _errs24: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/1/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/1/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/1/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}if(valid4){if(data.rejectionReason !== undefined){const _errs26: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/1/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid4: any = _errs26 === errors;}else {var valid4: any = true;}if(valid4){if(data.failureReason !== undefined){const _errs29: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/1/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid4: any = _errs29 === errors;}else {var valid4: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs17 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "applied"){const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.state === undefined) && (missing2 = "state")) || ((data.interventionId === undefined) && (missing2 = "interventionId"))) || ((data.interventionType === undefined) && (missing2 = "interventionType"))) || ((data.runVersion === undefined) && (missing2 = "runVersion"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs34: any = errors;for(const key2 in data){if(!((((((key2 === "state") || (key2 === "interventionId")) || (key2 === "interventionType")) || (key2 === "runVersion")) || (key2 === "rejectionReason")) || (key2 === "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs34 === errors){if(data.state !== undefined){let data12: any = data.state;const _errs35: any = errors;if(typeof data12 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("applied" !== data12){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "applied"}}];return false;}var valid6: any = _errs35 === errors;}else {var valid6: any = true;}if(valid6){if(data.interventionId !== undefined){const _errs37: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid6: any = _errs37 === errors;}else {var valid6: any = true;}if(valid6){if(data.interventionType !== undefined){const _errs38: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid6: any = _errs38 === errors;}else {var valid6: any = true;}if(valid6){if(data.runVersion !== undefined){let data15: any = data.runVersion;const _errs39: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/2/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs39){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/2/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/2/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs39 === errors;}else {var valid6: any = true;}if(valid6){if(data.rejectionReason !== undefined){const _errs41: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/2/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid6: any = _errs41 === errors;}else {var valid6: any = true;}if(valid6){if(data.failureReason !== undefined){const _errs44: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/2/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid6: any = _errs44 === errors;}else {var valid6: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs32 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "degraded"){const _errs47: any = errors;if(errors === _errs47){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.state === undefined) && (missing3 = "state")) || ((data.interventionId === undefined) && (missing3 = "interventionId"))) || ((data.interventionType === undefined) && (missing3 = "interventionType"))) || ((data.runVersion === undefined) && (missing3 = "runVersion"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs49: any = errors;for(const key3 in data){if(!((((((key3 === "state") || (key3 === "interventionId")) || (key3 === "interventionType")) || (key3 === "runVersion")) || (key3 === "rejectionReason")) || (key3 === "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs49 === errors){if(data.state !== undefined){let data18: any = data.state;const _errs50: any = errors;if(typeof data18 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("degraded" !== data18){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "degraded"}}];return false;}var valid8: any = _errs50 === errors;}else {var valid8: any = true;}if(valid8){if(data.interventionId !== undefined){const _errs52: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid8: any = _errs52 === errors;}else {var valid8: any = true;}if(valid8){if(data.interventionType !== undefined){const _errs53: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid8: any = _errs53 === errors;}else {var valid8: any = true;}if(valid8){if(data.runVersion !== undefined){let data21: any = data.runVersion;const _errs54: any = errors;if(!(((typeof data21 == "number") && (!(data21 % 1) && !isNaN(data21))) && (isFinite(data21)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/3/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs54){if((typeof data21 == "number") && (isFinite(data21))){if(data21 > 9007199254740991 || isNaN(data21)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/3/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data21 < 0 || isNaN(data21)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/3/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid8: any = _errs54 === errors;}else {var valid8: any = true;}if(valid8){if(data.rejectionReason !== undefined){const _errs56: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/3/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid8: any = _errs56 === errors;}else {var valid8: any = true;}if(valid8){if(data.failureReason !== undefined){const _errs59: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/3/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid8: any = _errs59 === errors;}else {var valid8: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs47 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else if(tag0 === "expired"){const _errs62: any = errors;if(errors === _errs62){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((data.state === undefined) && (missing4 = "state")) || ((data.interventionId === undefined) && (missing4 = "interventionId"))) || ((data.interventionType === undefined) && (missing4 = "interventionType"))) || ((data.runVersion === undefined) && (missing4 = "runVersion"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs64: any = errors;for(const key4 in data){if(!((((((key4 === "state") || (key4 === "interventionId")) || (key4 === "interventionType")) || (key4 === "runVersion")) || (key4 === "rejectionReason")) || (key4 === "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs64 === errors){if(data.state !== undefined){let data24: any = data.state;const _errs65: any = errors;if(typeof data24 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("expired" !== data24){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "expired"}}];return false;}var valid10: any = _errs65 === errors;}else {var valid10: any = true;}if(valid10){if(data.interventionId !== undefined){const _errs67: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid10: any = _errs67 === errors;}else {var valid10: any = true;}if(valid10){if(data.interventionType !== undefined){const _errs68: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid10: any = _errs68 === errors;}else {var valid10: any = true;}if(valid10){if(data.runVersion !== undefined){let data27: any = data.runVersion;const _errs69: any = errors;if(!(((typeof data27 == "number") && (!(data27 % 1) && !isNaN(data27))) && (isFinite(data27)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/4/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs69){if((typeof data27 == "number") && (isFinite(data27))){if(data27 > 9007199254740991 || isNaN(data27)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/4/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data27 < 0 || isNaN(data27)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/4/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid10: any = _errs69 === errors;}else {var valid10: any = true;}if(valid10){if(data.rejectionReason !== undefined){const _errs71: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/4/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid10: any = _errs71 === errors;}else {var valid10: any = true;}if(valid10){if(data.failureReason !== undefined){const _errs74: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/4/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid10: any = _errs74 === errors;}else {var valid10: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs62 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else if(tag0 === "rejected"){const _errs77: any = errors;if(errors === _errs77){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((((((data.state === undefined) && (missing5 = "state")) || ((data.interventionId === undefined) && (missing5 = "interventionId"))) || ((data.interventionType === undefined) && (missing5 = "interventionType"))) || ((data.runVersion === undefined) && (missing5 = "runVersion"))) || ((data.rejectionReason === undefined) && (missing5 = "rejectionReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs79: any = errors;for(const key5 in data){if(!((((((key5 === "state") || (key5 === "interventionId")) || (key5 === "interventionType")) || (key5 === "runVersion")) || (key5 === "rejectionReason")) || (key5 === "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs79 === errors){if(data.state !== undefined){let data30: any = data.state;const _errs80: any = errors;if(typeof data30 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("rejected" !== data30){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/const",keyword:"const",params:{allowedValue: "rejected"}}];return false;}var valid12: any = _errs80 === errors;}else {var valid12: any = true;}if(valid12){if(data.interventionId !== undefined){const _errs82: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid12: any = _errs82 === errors;}else {var valid12: any = true;}if(valid12){if(data.interventionType !== undefined){const _errs83: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid12: any = _errs83 === errors;}else {var valid12: any = true;}if(valid12){if(data.runVersion !== undefined){let data33: any = data.runVersion;const _errs84: any = errors;if(!(((typeof data33 == "number") && (!(data33 % 1) && !isNaN(data33))) && (isFinite(data33)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/5/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs84){if((typeof data33 == "number") && (isFinite(data33))){if(data33 > 9007199254740991 || isNaN(data33)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/5/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data33 < 0 || isNaN(data33)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/5/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid12: any = _errs84 === errors;}else {var valid12: any = true;}if(valid12){if(data.rejectionReason !== undefined){let data34: any = data.rejectionReason;const _errs86: any = errors;if(errors === _errs86){if(typeof data34 === "string"){if(func1(data34) > 256){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data34) < 1){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data34)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs86 === errors;}else {var valid12: any = true;}if(valid12){if(data.failureReason !== undefined){const _errs88: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/5/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid12: any = _errs88 === errors;}else {var valid12: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs77 === errors;if(props0 !== true){props0 = true;}valid0 = valid11;}else if(tag0 === "failed"){const _errs91: any = errors;if(errors === _errs91){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((((data.state === undefined) && (missing6 = "state")) || ((data.interventionId === undefined) && (missing6 = "interventionId"))) || ((data.interventionType === undefined) && (missing6 = "interventionType"))) || ((data.runVersion === undefined) && (missing6 = "runVersion"))) || ((data.failureReason === undefined) && (missing6 = "failureReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs93: any = errors;for(const key6 in data){if(!((((((key6 === "state") || (key6 === "interventionId")) || (key6 === "interventionType")) || (key6 === "runVersion")) || (key6 === "failureReason")) || (key6 === "rejectionReason"))){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs93 === errors){if(data.state !== undefined){let data36: any = data.state;const _errs94: any = errors;if(typeof data36 !== "string"){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/6/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data36){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/6/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid14: any = _errs94 === errors;}else {var valid14: any = true;}if(valid14){if(data.interventionId !== undefined){const _errs96: any = errors;if(!(validateInterventionId.call(this, data.interventionId, {instancePath:instancePath+"/interventionId",parentData:data,parentDataProperty:"interventionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionId.errors : vErrors.concat(validateInterventionId.errors);errors = vErrors.length;}var valid14: any = _errs96 === errors;}else {var valid14: any = true;}if(valid14){if(data.interventionType !== undefined){const _errs97: any = errors;if(!(validateInterventionType.call(this, data.interventionType, {instancePath:instancePath+"/interventionType",parentData:data,parentDataProperty:"interventionType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateInterventionType.errors : vErrors.concat(validateInterventionType.errors);errors = vErrors.length;}var valid14: any = _errs97 === errors;}else {var valid14: any = true;}if(valid14){if(data.runVersion !== undefined){let data39: any = data.runVersion;const _errs98: any = errors;if(!(((typeof data39 == "number") && (!(data39 % 1) && !isNaN(data39))) && (isFinite(data39)))){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/6/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs98){if((typeof data39 == "number") && (isFinite(data39))){if(data39 > 9007199254740991 || isNaN(data39)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/6/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data39 < 0 || isNaN(data39)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/6/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid14: any = _errs98 === errors;}else {var valid14: any = true;}if(valid14){if(data.failureReason !== undefined){let data40: any = data.failureReason;const _errs100: any = errors;if(errors === _errs100){if(typeof data40 === "string"){if(func1(data40) > 32768){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data40) < 1){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data40)){validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs100 === errors;}else {var valid14: any = true;}if(valid14){if(data.rejectionReason !== undefined){const _errs102: any = errors;validateAgentRunInterveneResponse.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/6/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid14: any = _errs102 === errors;}else {var valid14: any = true;}}}}}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs91 === errors;if(props0 !== true){props0 = true;}valid0 = valid13;}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key7 in data){if(!props0 || !props0[key7]){validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key7}}];return false;break;}}}}}else {validateAgentRunInterveneResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunInterveneResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunInterveneResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
