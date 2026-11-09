// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Interventions on a running run: the interrupt and the faster-model retry a caller sends through `agent.run.intervene`, the daemon's answer, the states an intervention passes through, and an interrupt's stored record.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { ProviderTurnId } from "../turn.js";
import type { RunId } from "./id.js";
import type { QueueItemId } from "./queue.js";

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
 * The stored `payload` of an interrupt's `interventions` row: a person's, or the daemon's own at
 * a limit. The arms are disjoint: a person's carries `pending` and no limit, the daemon's only
 * its limit, so a person's reason never reads as a limit.
 */
export type InterruptInterventionRecord = PersonInterruptRecord | LimitInterruptRecord;
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

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1754(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunInterveneRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1754.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.type;if(typeof tag0 == "string"){if(tag0 === "interrupt"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.type === undefined) && (missing0 = "type")){validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {if(data.type !== undefined){let data0: any = data.type;const _errs5: any = errors;if(typeof data0 !== "string"){validate1754.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("interrupt" !== data0){validate1754.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "interrupt"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){const tag1: any = data.pending;if(typeof tag1 == "string"){if(tag1 === "nextTurn"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.pending === undefined) && (missing1 = "pending")) || ((data.targetRunId === undefined) && (missing1 = "targetRunId"))) || ((data.expectedRunVersion === undefined) && (missing1 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing1 = "clientIdempotencyKey"))){validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {if(data.pending !== undefined){let data1: any = data.pending;const _errs9: any = errors;if(typeof data1 !== "string"){validate1754.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/0/properties/pending/type",keyword:"type",params:{type: "string"}}];return false;}if("nextTurn" !== data1){validate1754.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/0/properties/pending/const",keyword:"const",params:{allowedValue: "nextTurn"}}];return false;}var valid5: any = _errs9 === errors;}else {var valid5: any = true;}if(valid5){if(data.targetRunId !== undefined){let data2: any = data.targetRunId;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1754.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs11 === errors;}else {var valid5: any = true;}if(valid5){if(data.expectedRunVersion !== undefined){let data3: any = data.expectedRunVersion;const _errs15: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/0/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/0/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/0/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs17: any = errors;if(errors === _errs17){if(typeof data4 === "string"){if(!pattern222.test(data4)){validate1754.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/0/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/0/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.reason !== undefined){let data5: any = data.reason;const _errs19: any = errors;if(errors === _errs19){if(typeof data5 === "string"){if(func1(data5) > 512){validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data5) < 1){validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.deliverFirst !== undefined){let data6: any = data.deliverFirst;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate1754.errors = [{instancePath:instancePath+"/deliverFirst",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueueItemId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/deliverFirst",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueueItemId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}}}else {validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var props0: any = {};props0.pending = true;props0.targetRunId = true;props0.expectedRunVersion = true;props0.clientIdempotencyKey = true;props0.reason = true;props0.deliverFirst = true;props0.type = true;}else if(tag1 === "returnToDraft"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.pending === undefined) && (missing2 = "pending")) || ((data.targetRunId === undefined) && (missing2 = "targetRunId"))) || ((data.expectedRunVersion === undefined) && (missing2 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing2 = "clientIdempotencyKey"))){validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {if(data.pending !== undefined){let data7: any = data.pending;const _errs27: any = errors;if(typeof data7 !== "string"){validate1754.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/1/properties/pending/type",keyword:"type",params:{type: "string"}}];return false;}if("returnToDraft" !== data7){validate1754.errors = [{instancePath:instancePath+"/pending",schemaPath:"#/oneOf/0/oneOf/1/properties/pending/const",keyword:"const",params:{allowedValue: "returnToDraft"}}];return false;}var valid9: any = _errs27 === errors;}else {var valid9: any = true;}if(valid9){if(data.targetRunId !== undefined){let data8: any = data.targetRunId;const _errs29: any = errors;const _errs30: any = errors;if(errors === _errs30){if(typeof data8 === "string"){if(!pattern4.test(data8)){validate1754.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs29 === errors;}else {var valid9: any = true;}if(valid9){if(data.expectedRunVersion !== undefined){let data9: any = data.expectedRunVersion;const _errs33: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/1/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs33){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/1/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/0/oneOf/1/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs33 === errors;}else {var valid9: any = true;}if(valid9){if(data.clientIdempotencyKey !== undefined){let data10: any = data.clientIdempotencyKey;const _errs35: any = errors;if(errors === _errs35){if(typeof data10 === "string"){if(!pattern222.test(data10)){validate1754.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/1/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/0/oneOf/1/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs35 === errors;}else {var valid9: any = true;}if(valid9){if(data.reason !== undefined){let data11: any = data.reason;const _errs37: any = errors;if(errors === _errs37){if(typeof data11 === "string"){if(func1(data11) > 512){validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data11) < 1){validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data11)){validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1754.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs37 === errors;}else {var valid9: any = true;}if(valid9){if(data.deliverFirst !== undefined){const _errs39: any = errors;validate1754.errors = [{instancePath:instancePath+"/deliverFirst",schemaPath:"#/oneOf/0/oneOf/1/properties/deliverFirst/not",keyword:"not",params:{}}];return false;var valid9: any = _errs39 === errors;}else {var valid9: any = true;}}}}}}}}else {validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}if(props0 !== true){props0 = props0 || {};props0.pending = true;props0.targetRunId = true;props0.expectedRunVersion = true;props0.clientIdempotencyKey = true;props0.reason = true;props0.deliverFirst = true;}}else {validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "pending", tagValue: tag1}}];return false;}}else {validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/discriminator",keyword:"discriminator",params:{error: "tag", tag: "pending", tagValue: tag1}}];return false;}}}}else {validate1754.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;valid0 = valid1;}else if(tag0 === "fasterModelRetry"){const _errs42: any = errors;if(errors === _errs42){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((((data.type === undefined) && (missing3 = "type")) || ((data.targetRunId === undefined) && (missing3 = "targetRunId"))) || ((data.expectedRunVersion === undefined) && (missing3 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing3 = "clientIdempotencyKey"))) || ((data.expectedTurnId === undefined) && (missing3 = "expectedTurnId"))) || ((data.model === undefined) && (missing3 = "model"))){validate1754.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs44: any = errors;for(const key0 in data){if(!((((((key0 === "type") || (key0 === "targetRunId")) || (key0 === "expectedRunVersion")) || (key0 === "clientIdempotencyKey")) || (key0 === "expectedTurnId")) || (key0 === "model"))){validate1754.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs44 === errors){if(data.type !== undefined){let data13: any = data.type;const _errs45: any = errors;if(typeof data13 !== "string"){validate1754.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("fasterModelRetry" !== data13){validate1754.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "fasterModelRetry"}}];return false;}var valid12: any = _errs45 === errors;}else {var valid12: any = true;}if(valid12){if(data.targetRunId !== undefined){let data14: any = data.targetRunId;const _errs47: any = errors;const _errs48: any = errors;if(errors === _errs48){if(typeof data14 === "string"){if(!pattern4.test(data14)){validate1754.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs47 === errors;}else {var valid12: any = true;}if(valid12){if(data.expectedRunVersion !== undefined){let data15: any = data.expectedRunVersion;const _errs51: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/1/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs51){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/1/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validate1754.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/oneOf/1/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid12: any = _errs51 === errors;}else {var valid12: any = true;}if(valid12){if(data.clientIdempotencyKey !== undefined){let data16: any = data.clientIdempotencyKey;const _errs53: any = errors;if(errors === _errs53){if(typeof data16 === "string"){if(!pattern222.test(data16)){validate1754.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/1/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1754.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/oneOf/1/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs53 === errors;}else {var valid12: any = true;}if(valid12){if(data.expectedTurnId !== undefined){let data17: any = data.expectedTurnId;const _errs55: any = errors;const _errs56: any = errors;if(errors === _errs56){if(typeof data17 === "string"){if(func1(data17) > 256){validate1754.errors = [{instancePath:instancePath+"/expectedTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data17) < 1){validate1754.errors = [{instancePath:instancePath+"/expectedTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data17)){validate1754.errors = [{instancePath:instancePath+"/expectedTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1754.errors = [{instancePath:instancePath+"/expectedTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs55 === errors;}else {var valid12: any = true;}if(valid12){if(data.model !== undefined){let data18: any = data.model;const _errs59: any = errors;if(errors === _errs59){if(typeof data18 === "string"){if(func1(data18) > 128){validate1754.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data18) < 1){validate1754.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data18)){validate1754.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1754.errors = [{instancePath:instancePath+"/model",schemaPath:"#/oneOf/1/properties/model/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs59 === errors;}else {var valid12: any = true;}}}}}}}}}else {validate1754.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs42 === errors;if(props0 !== true){props0 = true;}valid0 = valid11;}else {validate1754.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validate1754.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key1 in data){if(!props0 || !props0[key1]){validate1754.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key1}}];return false;break;}}}}}else {validate1754.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1754.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1754.errors = null as any[] | null;
// prettier-ignore
validate1754.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1673: any = {"description":"How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a\nfaster model, which the daemon carries out by stopping the turn and sending its message again on\nthe named model. A person's message mid-turn is a queue send, never an intervention.","type":"string","enum":["interrupt","fasterModelRetry"]};
// prettier-ignore
function validate1755(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunInterveneResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1755.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "requested"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.state === undefined) && (missing0 = "state")) || ((data.interventionId === undefined) && (missing0 = "interventionId"))) || ((data.interventionType === undefined) && (missing0 = "interventionType"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((((key0 === "state") || (key0 === "interventionId")) || (key0 === "interventionType")) || (key0 === "runVersion")) || (key0 === "rejectionReason")) || (key0 === "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("requested" !== data0){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "requested"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.interventionId !== undefined){let data1: any = data.interventionId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.interventionType !== undefined){let data2: any = data.interventionType;const _errs11: any = errors;if(typeof data2 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "interrupt") || (data2 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.runVersion !== undefined){let data3: any = data.runVersion;const _errs14: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/0/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs14){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/0/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/0/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.rejectionReason !== undefined){const _errs16: any = errors;validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/0/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.failureReason !== undefined){const _errs19: any = errors;validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/0/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs19 === errors;}else {var valid2: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "accepted"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.interventionId === undefined) && (missing1 = "interventionId"))) || ((data.interventionType === undefined) && (missing1 = "interventionType"))) || ((data.runVersion === undefined) && (missing1 = "runVersion"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs24: any = errors;for(const key1 in data){if(!((((((key1 === "state") || (key1 === "interventionId")) || (key1 === "interventionType")) || (key1 === "runVersion")) || (key1 === "rejectionReason")) || (key1 === "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs24 === errors){if(data.state !== undefined){let data6: any = data.state;const _errs25: any = errors;if(typeof data6 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("accepted" !== data6){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "accepted"}}];return false;}var valid6: any = _errs25 === errors;}else {var valid6: any = true;}if(valid6){if(data.interventionId !== undefined){let data7: any = data.interventionId;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data7 === "string"){if(!pattern4.test(data7)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data.interventionType !== undefined){let data8: any = data.interventionType;const _errs31: any = errors;if(typeof data8 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data8 === "interrupt") || (data8 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid6: any = _errs31 === errors;}else {var valid6: any = true;}if(valid6){if(data.runVersion !== undefined){let data9: any = data.runVersion;const _errs34: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/1/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs34){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/1/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/1/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs34 === errors;}else {var valid6: any = true;}if(valid6){if(data.rejectionReason !== undefined){const _errs36: any = errors;validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/1/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid6: any = _errs36 === errors;}else {var valid6: any = true;}if(valid6){if(data.failureReason !== undefined){const _errs39: any = errors;validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/1/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid6: any = _errs39 === errors;}else {var valid6: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs22 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "applied"){const _errs42: any = errors;if(errors === _errs42){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.state === undefined) && (missing2 = "state")) || ((data.interventionId === undefined) && (missing2 = "interventionId"))) || ((data.interventionType === undefined) && (missing2 = "interventionType"))) || ((data.runVersion === undefined) && (missing2 = "runVersion"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs44: any = errors;for(const key2 in data){if(!((((((key2 === "state") || (key2 === "interventionId")) || (key2 === "interventionType")) || (key2 === "runVersion")) || (key2 === "rejectionReason")) || (key2 === "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs44 === errors){if(data.state !== undefined){let data12: any = data.state;const _errs45: any = errors;if(typeof data12 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("applied" !== data12){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "applied"}}];return false;}var valid10: any = _errs45 === errors;}else {var valid10: any = true;}if(valid10){if(data.interventionId !== undefined){let data13: any = data.interventionId;const _errs47: any = errors;const _errs48: any = errors;if(errors === _errs48){if(typeof data13 === "string"){if(!pattern4.test(data13)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs47 === errors;}else {var valid10: any = true;}if(valid10){if(data.interventionType !== undefined){let data14: any = data.interventionType;const _errs51: any = errors;if(typeof data14 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data14 === "interrupt") || (data14 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid10: any = _errs51 === errors;}else {var valid10: any = true;}if(valid10){if(data.runVersion !== undefined){let data15: any = data.runVersion;const _errs54: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/2/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs54){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/2/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/2/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid10: any = _errs54 === errors;}else {var valid10: any = true;}if(valid10){if(data.rejectionReason !== undefined){const _errs56: any = errors;validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/2/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid10: any = _errs56 === errors;}else {var valid10: any = true;}if(valid10){if(data.failureReason !== undefined){const _errs59: any = errors;validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/2/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid10: any = _errs59 === errors;}else {var valid10: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs42 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else if(tag0 === "degraded"){const _errs62: any = errors;if(errors === _errs62){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.state === undefined) && (missing3 = "state")) || ((data.interventionId === undefined) && (missing3 = "interventionId"))) || ((data.interventionType === undefined) && (missing3 = "interventionType"))) || ((data.runVersion === undefined) && (missing3 = "runVersion"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs64: any = errors;for(const key3 in data){if(!((((((key3 === "state") || (key3 === "interventionId")) || (key3 === "interventionType")) || (key3 === "runVersion")) || (key3 === "rejectionReason")) || (key3 === "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs64 === errors){if(data.state !== undefined){let data18: any = data.state;const _errs65: any = errors;if(typeof data18 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("degraded" !== data18){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "degraded"}}];return false;}var valid14: any = _errs65 === errors;}else {var valid14: any = true;}if(valid14){if(data.interventionId !== undefined){let data19: any = data.interventionId;const _errs67: any = errors;const _errs68: any = errors;if(errors === _errs68){if(typeof data19 === "string"){if(!pattern4.test(data19)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs67 === errors;}else {var valid14: any = true;}if(valid14){if(data.interventionType !== undefined){let data20: any = data.interventionType;const _errs71: any = errors;if(typeof data20 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data20 === "interrupt") || (data20 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid14: any = _errs71 === errors;}else {var valid14: any = true;}if(valid14){if(data.runVersion !== undefined){let data21: any = data.runVersion;const _errs74: any = errors;if(!(((typeof data21 == "number") && (!(data21 % 1) && !isNaN(data21))) && (isFinite(data21)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/3/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs74){if((typeof data21 == "number") && (isFinite(data21))){if(data21 > 9007199254740991 || isNaN(data21)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/3/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data21 < 0 || isNaN(data21)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/3/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid14: any = _errs74 === errors;}else {var valid14: any = true;}if(valid14){if(data.rejectionReason !== undefined){const _errs76: any = errors;validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/3/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid14: any = _errs76 === errors;}else {var valid14: any = true;}if(valid14){if(data.failureReason !== undefined){const _errs79: any = errors;validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/3/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid14: any = _errs79 === errors;}else {var valid14: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs62 === errors;if(props0 !== true){props0 = true;}valid0 = valid13;}else if(tag0 === "expired"){const _errs82: any = errors;if(errors === _errs82){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((data.state === undefined) && (missing4 = "state")) || ((data.interventionId === undefined) && (missing4 = "interventionId"))) || ((data.interventionType === undefined) && (missing4 = "interventionType"))) || ((data.runVersion === undefined) && (missing4 = "runVersion"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs84: any = errors;for(const key4 in data){if(!((((((key4 === "state") || (key4 === "interventionId")) || (key4 === "interventionType")) || (key4 === "runVersion")) || (key4 === "rejectionReason")) || (key4 === "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs84 === errors){if(data.state !== undefined){let data24: any = data.state;const _errs85: any = errors;if(typeof data24 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("expired" !== data24){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "expired"}}];return false;}var valid18: any = _errs85 === errors;}else {var valid18: any = true;}if(valid18){if(data.interventionId !== undefined){let data25: any = data.interventionId;const _errs87: any = errors;const _errs88: any = errors;if(errors === _errs88){if(typeof data25 === "string"){if(!pattern4.test(data25)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs87 === errors;}else {var valid18: any = true;}if(valid18){if(data.interventionType !== undefined){let data26: any = data.interventionType;const _errs91: any = errors;if(typeof data26 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data26 === "interrupt") || (data26 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid18: any = _errs91 === errors;}else {var valid18: any = true;}if(valid18){if(data.runVersion !== undefined){let data27: any = data.runVersion;const _errs94: any = errors;if(!(((typeof data27 == "number") && (!(data27 % 1) && !isNaN(data27))) && (isFinite(data27)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/4/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs94){if((typeof data27 == "number") && (isFinite(data27))){if(data27 > 9007199254740991 || isNaN(data27)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/4/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data27 < 0 || isNaN(data27)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/4/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid18: any = _errs94 === errors;}else {var valid18: any = true;}if(valid18){if(data.rejectionReason !== undefined){const _errs96: any = errors;validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/4/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid18: any = _errs96 === errors;}else {var valid18: any = true;}if(valid18){if(data.failureReason !== undefined){const _errs99: any = errors;validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/4/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid18: any = _errs99 === errors;}else {var valid18: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid17: any = _errs82 === errors;if(props0 !== true){props0 = true;}valid0 = valid17;}else if(tag0 === "rejected"){const _errs102: any = errors;if(errors === _errs102){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((((((data.state === undefined) && (missing5 = "state")) || ((data.interventionId === undefined) && (missing5 = "interventionId"))) || ((data.interventionType === undefined) && (missing5 = "interventionType"))) || ((data.runVersion === undefined) && (missing5 = "runVersion"))) || ((data.rejectionReason === undefined) && (missing5 = "rejectionReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs104: any = errors;for(const key5 in data){if(!((((((key5 === "state") || (key5 === "interventionId")) || (key5 === "interventionType")) || (key5 === "runVersion")) || (key5 === "rejectionReason")) || (key5 === "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs104 === errors){if(data.state !== undefined){let data30: any = data.state;const _errs105: any = errors;if(typeof data30 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("rejected" !== data30){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/const",keyword:"const",params:{allowedValue: "rejected"}}];return false;}var valid22: any = _errs105 === errors;}else {var valid22: any = true;}if(valid22){if(data.interventionId !== undefined){let data31: any = data.interventionId;const _errs107: any = errors;const _errs108: any = errors;if(errors === _errs108){if(typeof data31 === "string"){if(!pattern4.test(data31)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid22: any = _errs107 === errors;}else {var valid22: any = true;}if(valid22){if(data.interventionType !== undefined){let data32: any = data.interventionType;const _errs111: any = errors;if(typeof data32 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data32 === "interrupt") || (data32 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid22: any = _errs111 === errors;}else {var valid22: any = true;}if(valid22){if(data.runVersion !== undefined){let data33: any = data.runVersion;const _errs114: any = errors;if(!(((typeof data33 == "number") && (!(data33 % 1) && !isNaN(data33))) && (isFinite(data33)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/5/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs114){if((typeof data33 == "number") && (isFinite(data33))){if(data33 > 9007199254740991 || isNaN(data33)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/5/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data33 < 0 || isNaN(data33)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/5/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid22: any = _errs114 === errors;}else {var valid22: any = true;}if(valid22){if(data.rejectionReason !== undefined){let data34: any = data.rejectionReason;const _errs116: any = errors;if(errors === _errs116){if(typeof data34 === "string"){if(func1(data34) > 256){validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data34) < 1){validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data34)){validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/5/properties/rejectionReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid22: any = _errs116 === errors;}else {var valid22: any = true;}if(valid22){if(data.failureReason !== undefined){const _errs118: any = errors;validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/5/properties/failureReason/not",keyword:"not",params:{}}];return false;var valid22: any = _errs118 === errors;}else {var valid22: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid21: any = _errs102 === errors;if(props0 !== true){props0 = true;}valid0 = valid21;}else if(tag0 === "failed"){const _errs121: any = errors;if(errors === _errs121){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((((data.state === undefined) && (missing6 = "state")) || ((data.interventionId === undefined) && (missing6 = "interventionId"))) || ((data.interventionType === undefined) && (missing6 = "interventionType"))) || ((data.runVersion === undefined) && (missing6 = "runVersion"))) || ((data.failureReason === undefined) && (missing6 = "failureReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs123: any = errors;for(const key6 in data){if(!((((((key6 === "state") || (key6 === "interventionId")) || (key6 === "interventionType")) || (key6 === "runVersion")) || (key6 === "failureReason")) || (key6 === "rejectionReason"))){validate1755.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs123 === errors){if(data.state !== undefined){let data36: any = data.state;const _errs124: any = errors;if(typeof data36 !== "string"){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/6/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data36){validate1755.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/6/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid26: any = _errs124 === errors;}else {var valid26: any = true;}if(valid26){if(data.interventionId !== undefined){let data37: any = data.interventionId;const _errs126: any = errors;const _errs127: any = errors;if(errors === _errs127){if(typeof data37 === "string"){if(!pattern4.test(data37)){validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1755.errors = [{instancePath:instancePath+"/interventionId",schemaPath:"#/$defs/InterventionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid26: any = _errs126 === errors;}else {var valid26: any = true;}if(valid26){if(data.interventionType !== undefined){let data38: any = data.interventionType;const _errs130: any = errors;if(typeof data38 !== "string"){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data38 === "interrupt") || (data38 === "fasterModelRetry"))){validate1755.errors = [{instancePath:instancePath+"/interventionType",schemaPath:"#/$defs/InterventionType/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}var valid26: any = _errs130 === errors;}else {var valid26: any = true;}if(valid26){if(data.runVersion !== undefined){let data39: any = data.runVersion;const _errs133: any = errors;if(!(((typeof data39 == "number") && (!(data39 % 1) && !isNaN(data39))) && (isFinite(data39)))){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/6/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs133){if((typeof data39 == "number") && (isFinite(data39))){if(data39 > 9007199254740991 || isNaN(data39)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/6/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data39 < 0 || isNaN(data39)){validate1755.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/oneOf/6/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid26: any = _errs133 === errors;}else {var valid26: any = true;}if(valid26){if(data.failureReason !== undefined){let data40: any = data.failureReason;const _errs135: any = errors;if(errors === _errs135){if(typeof data40 === "string"){if(func1(data40) > 32768){validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data40) < 1){validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data40)){validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1755.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/6/properties/failureReason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid26: any = _errs135 === errors;}else {var valid26: any = true;}if(valid26){if(data.rejectionReason !== undefined){const _errs137: any = errors;validate1755.errors = [{instancePath:instancePath+"/rejectionReason",schemaPath:"#/oneOf/6/properties/rejectionReason/not",keyword:"not",params:{}}];return false;var valid26: any = _errs137 === errors;}else {var valid26: any = true;}}}}}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}var valid25: any = _errs121 === errors;if(props0 !== true){props0 = true;}valid0 = valid25;}else {validate1755.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate1755.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key7 in data){if(!props0 || !props0[key7]){validate1755.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key7}}];return false;break;}}}}}else {validate1755.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1755.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1755.errors = null as any[] | null;
// prettier-ignore
validate1755.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1756(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is InterventionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1756.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1756.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1756.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1756.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1756.errors = null as any[] | null;
// prettier-ignore
validate1756.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1757(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is InterventionType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1757.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1757.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "interrupt") || (data === "fasterModelRetry"))){validate1757.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1673.enum}}];return false;}validate1757.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1757.errors = null as any[] | null;
// prettier-ignore
validate1757.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunInterveneRequest}. */
export const validateAgentRunInterveneRequest: SchemaCheck<AgentRunInterveneRequest> = validate1754;
/** Checks that a value is a {@link AgentRunInterveneResponse}. */
export const validateAgentRunInterveneResponse: SchemaCheck<AgentRunInterveneResponse> =
  validate1755;
/** Checks that a value is a {@link InterventionId}. */
export const validateInterventionId: SchemaCheck<InterventionId> = validate1756;
/** Checks that a value is a {@link InterventionType}. */
export const validateInterventionType: SchemaCheck<InterventionType> = validate1757;
