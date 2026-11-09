/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A child's own controls: steer, interrupt and pause one provider helper inside a run, and stop every agent a session dispatched.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { AgentTreeMember, ChildHandle } from "../agent/tree.js";
import type { SessionId } from "../session/id.js";
import type { RunId } from "./id.js";
import type { QueueItemId } from "./queue.js";
import type { RunState } from "./state.js";

/**
 * The refusal of a child control: the child has ended or the provider refused the act. A
 * handle that names no child of the run is `agent.childRun.notFound`, and a hold lost before
 * a continue is a result, never this refusal.
 */
export const AGENT_CHILD_RUN_CONTROL_REFUSED_CODE = "agent.childRun.controlRefused" as const;

/** Every reason a child control is refused. */
export const AGENT_CHILD_RUN_CONTROL_REFUSED_REASONS = ["childEnded", "providerRefused"] as const;

/**
 * Where the child stands after the set; a lost hold never comes with `paused: true`.
 */
export type AgentChildRunPausedUpdateResponse =
  | {
      /**
       * The child.
       */
      childHandle: ChildHandle;
      /**
       * Always `true`.
       */
      paused: true;
      /**
       * A lost hold never leaves the child paused.
       */
      holdLost?: never;
    }
  | {
      /**
       * The child.
       */
      childHandle: ChildHandle;
      /**
       * Always `false`.
       */
      paused: false;
      /**
       * Present only when the hold was lost.
       */
      holdLost?: true;
    };
/**
 * The run state a stop leaves a child in: `stopped` where the provider's stop is final,
 * `interrupted` where a send can continue it.
 */
export type ChildStoppedState = "stopped" | "interrupted";
/**
 * One child's stop: stopped, with the state it left the child in, already ended, or failed with
 * the daemon's reason.
 */
export type ChildStopOutcome =
  | {
      outcome: "stopped";
      /**
       * The child.
       */
      child: AgentTreeMember;
      /**
       * The state the stop left the child in.
       */
      state: ChildStoppedState;
      /**
       * Only a failed stop carries a reason.
       */
      reason?: never;
    }
  | {
      outcome: "alreadyEnded";
      /**
       * The child.
       */
      child: AgentTreeMember;
      /**
       * Only a stopped child carries the state the stop left it in.
       */
      state?: never;
      /**
       * Only a failed stop carries a reason.
       */
      reason?: never;
    }
  | {
      outcome: "failed";
      /**
       * The child.
       */
      child: AgentTreeMember;
      /**
       * Only a stopped child carries the state the stop left it in.
       */
      state?: never;
      /**
       * The daemon's reason.
       */
      reason: string;
    };
/**
 * Why a child control was refused.
 */
export type AgentChildRunControlRefusedReason = "childEnded" | "providerRefused";

/**
 * Sends a message onto one child's own queue (`agent.childRun.steer`), where it waits for the
 * child's next step as a pending row the lead's queue verbs reach with `childHandle`. It names
 * the helper by its session and handle, so it reaches a helper whose parent run has ended, and it
 * answers as `agent.queueItem.create` does.
 */
export interface AgentChildRunSteerRequest {
  /**
   * The session the helper works in.
   */
  sessionId: SessionId;
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * The words.
   */
  content: string;
  /**
   * A retry's key is the failed steer's queue item id, so a second press answers the first.
   */
  clientIdempotencyKey: string;
  /**
   * A retry of the child's steer that reads not delivered, with its own words: it goes again as
   * a new message at the end of the child's queue, and the failed one reads `superseded`.
   */
  replacesQueueItemId?: QueueItemId;
}
/**
 * Interrupts one child, and only that child (`agent.childRun.interrupt`); its pending messages go
 * as its next turn, with `deliver_first`, the row `Send now` was pressed on, ahead of the rest.
 */
export interface AgentChildRunInterruptRequest {
  /**
   * The run the child belongs to.
   */
  targetRunId: RunId;
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * The parent run's version the caller last observed.
   */
  expectedRunVersion: number;
  /**
   * A retry under the same key answers what the first saved.
   */
  clientIdempotencyKey: string;
  /**
   * The pending row that goes first.
   */
  deliverFirst?: QueueItemId;
}
/**
 * Where the child stands after the interrupt. A child that had already finished answers the state
 * it finished in.
 */
export interface AgentChildRunInterruptResponse {
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * Where it stands.
   */
  state: RunState;
}
/**
 * Pauses one child (`paused: true`) or continues it (`paused: false`)
 * (`agent.childRun.paused.update`). A repeated set answers the child's standing and takes no
 * second hold.
 */
export interface AgentChildRunPausedUpdateRequest {
  /**
   * The run the child belongs to.
   */
  targetRunId: RunId;
  /**
   * The child.
   */
  childHandle: ChildHandle;
  /**
   * Whether to pause or continue it.
   */
  paused: boolean;
  /**
   * The parent run's version the caller last observed.
   */
  expectedRunVersion: number;
}
/**
 * Stops every agent the session dispatched at every depth (`agent.childRun.stopAll`), a helper an
 * earlier lead run left running included: the daemon walks its own index, one stop per agent,
 * never relayed through the lead.
 */
export interface AgentChildRunStopAllRequest {
  /**
   * The session whose agents to stop.
   */
  sessionId: SessionId;
}
/**
 * Every child the stop reached, each with its own outcome; nothing is atomic.
 */
export interface AgentChildRunStopAllResponse {
  /**
   * One row per child.
   */
  children: ChildStopOutcome[];
}
/**
 * The details an `agent.childRun.controlRefused` refusal carries.
 */
export interface AgentChildRunControlRefusedDetails {
  /**
   * Why it was refused.
   */
  reason: AgentChildRunControlRefusedReason;
}

// prettier-ignore
const schema3177: any = {"description":"Why a child control was refused.","type":"string","enum":["childEnded","providerRefused"]};
// prettier-ignore
function validate1705(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunControlRefusedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1705.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){validate1705.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reason")){validate1705.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){let data0: any = data.reason;if(typeof data0 !== "string"){validate1705.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/AgentChildRunControlRefusedReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "childEnded") || (data0 === "providerRefused"))){validate1705.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/AgentChildRunControlRefusedReason/enum",keyword:"enum",params:{allowedValues: schema3177.enum}}];return false;}}}}}else {validate1705.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1705.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1705.errors = null as any[] | null;
// prettier-ignore
validate1705.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1706(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunInterruptRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1706.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.targetRunId === undefined) && (missing0 = "targetRunId")) || ((data.childHandle === undefined) && (missing0 = "childHandle"))) || ((data.expectedRunVersion === undefined) && (missing0 = "expectedRunVersion"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate1706.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "targetRunId") || (key0 === "childHandle")) || (key0 === "expectedRunVersion")) || (key0 === "clientIdempotencyKey")) || (key0 === "deliverFirst"))){validate1706.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.targetRunId !== undefined){let data0: any = data.targetRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1706.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1706.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){let data1: any = data.childHandle;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1706.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1706.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1706.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedRunVersion !== undefined){let data2: any = data.expectedRunVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1706.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1706.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1706.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data3: any = data.clientIdempotencyKey;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern222.test(data3)){validate1706.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1706.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.deliverFirst !== undefined){let data4: any = data.deliverFirst;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate1706.errors = [{instancePath:instancePath+"/deliverFirst",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueueItemId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1706.errors = [{instancePath:instancePath+"/deliverFirst",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueueItemId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1706.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1706.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1706.errors = null as any[] | null;
// prettier-ignore
validate1706.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1594: any = {"description":"Where a run stands. `pausing` is the step in flight finishing after a pause was asked for; the\nrun reads `paused` once nothing runs. `stopped` is a child ended for good by a stop that reached\nseveral agents; a provider whose stop leaves a child resumable reads `interrupted` instead.","type":"string","enum":["queued","starting","running","waitingForApproval","waitingForInput","pausing","paused","completed","interrupted","stopped","failed"]};
// prettier-ignore
function validate1707(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunInterruptResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1707.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.childHandle === undefined) && (missing0 = "childHandle")) || ((data.state === undefined) && (missing0 = "state"))){validate1707.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "childHandle") || (key0 === "state"))){validate1707.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.childHandle !== undefined){let data0: any = data.childHandle;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1707.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1707.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1707.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs6: any = errors;if(typeof data1 !== "string"){validate1707.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:run/state#/$defs/RunState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((data1 === "queued") || (data1 === "starting")) || (data1 === "running")) || (data1 === "waitingForApproval")) || (data1 === "waitingForInput")) || (data1 === "pausing")) || (data1 === "paused")) || (data1 === "completed")) || (data1 === "interrupted")) || (data1 === "stopped")) || (data1 === "failed"))){validate1707.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:run/state#/$defs/RunState/enum",keyword:"enum",params:{allowedValues: schema1594.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1707.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1707.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1707.errors = null as any[] | null;
// prettier-ignore
validate1707.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1708(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunPausedUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1708.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.targetRunId === undefined) && (missing0 = "targetRunId")) || ((data.childHandle === undefined) && (missing0 = "childHandle"))) || ((data.paused === undefined) && (missing0 = "paused"))) || ((data.expectedRunVersion === undefined) && (missing0 = "expectedRunVersion"))){validate1708.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "targetRunId") || (key0 === "childHandle")) || (key0 === "paused")) || (key0 === "expectedRunVersion"))){validate1708.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.targetRunId !== undefined){let data0: any = data.targetRunId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1708.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1708.errors = [{instancePath:instancePath+"/targetRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){let data1: any = data.childHandle;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1708.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1708.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1708.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.paused !== undefined){const _errs10: any = errors;if(typeof data.paused !== "boolean"){validate1708.errors = [{instancePath:instancePath+"/paused",schemaPath:"#/properties/paused/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedRunVersion !== undefined){let data3: any = data.expectedRunVersion;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1708.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/properties/expectedRunVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1708.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/properties/expectedRunVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1708.errors = [{instancePath:instancePath+"/expectedRunVersion",schemaPath:"#/properties/expectedRunVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate1708.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1708.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1708.errors = null as any[] | null;
// prettier-ignore
validate1708.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1709(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunPausedUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1709.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.childHandle === undefined) && (missing0 = "childHandle")) || ((data.paused === undefined) && (missing0 = "paused"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "childHandle") || (key0 === "paused")) || (key0 === "holdLost"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.childHandle !== undefined){let data0: any = data.childHandle;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data0 === "string"){if(func1(data0) > 256){const err2: any = {instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data0) < 1){const err3: any = {instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}else {const err4: any = {instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.paused !== undefined){let data1: any = data.paused;const _errs8: any = errors;if(typeof data1 !== "boolean"){const err5: any = {instancePath:instancePath+"/paused",schemaPath:"#/anyOf/0/properties/paused/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}if(true !== data1){const err6: any = {instancePath:instancePath+"/paused",schemaPath:"#/anyOf/0/properties/paused/const",keyword:"const",params:{allowedValue: true}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.holdLost !== undefined){const _errs10: any = errors;const err7: any = {instancePath:instancePath+"/holdLost",schemaPath:"#/anyOf/0/properties/holdLost/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;var valid1: any = _errs10 === errors;}else {var valid1: any = true;}}}}}}else {const err8: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs13: any = errors;if(errors === _errs13){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.childHandle === undefined) && (missing1 = "childHandle")) || ((data.paused === undefined) && (missing1 = "paused"))){const err9: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {const _errs15: any = errors;for(const key1 in data){if(!(((key1 === "childHandle") || (key1 === "paused")) || (key1 === "holdLost"))){const err10: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;break;}}if(_errs15 === errors){if(data.childHandle !== undefined){let data3: any = data.childHandle;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(typeof data3 === "string"){if(func1(data3) > 256){const err11: any = {instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(func1(data3) < 1){const err12: any = {instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}else {const err13: any = {instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}if(valid3){if(data.paused !== undefined){let data4: any = data.paused;const _errs20: any = errors;if(typeof data4 !== "boolean"){const err14: any = {instancePath:instancePath+"/paused",schemaPath:"#/anyOf/1/properties/paused/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(false !== data4){const err15: any = {instancePath:instancePath+"/paused",schemaPath:"#/anyOf/1/properties/paused/const",keyword:"const",params:{allowedValue: false}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}var valid3: any = _errs20 === errors;}else {var valid3: any = true;}if(valid3){if(data.holdLost !== undefined){let data5: any = data.holdLost;const _errs22: any = errors;if(typeof data5 !== "boolean"){const err16: any = {instancePath:instancePath+"/holdLost",schemaPath:"#/anyOf/1/properties/holdLost/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}if(true !== data5){const err17: any = {instancePath:instancePath+"/holdLost",schemaPath:"#/anyOf/1/properties/holdLost/const",keyword:"const",params:{allowedValue: true}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var valid3: any = _errs22 === errors;}else {var valid3: any = true;}}}}}}else {const err18: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var _valid0: any = _errs13 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err19: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;validate1709.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1709.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1709.errors = null as any[] | null;
// prettier-ignore
validate1709.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1710(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunSteerRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1710.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.childHandle === undefined) && (missing0 = "childHandle"))) || ((data.content === undefined) && (missing0 = "content"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate1710.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "childHandle")) || (key0 === "content")) || (key0 === "clientIdempotencyKey")) || (key0 === "replacesQueueItemId"))){validate1710.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1710.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1710.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.childHandle !== undefined){let data1: any = data.childHandle;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1710.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1710.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1710.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"sidekicks-contracts:agent/tree#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.content !== undefined){let data2: any = data.content;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate1710.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1710.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1710.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data3: any = data.clientIdempotencyKey;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern222.test(data3)){validate1710.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1710.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.replacesQueueItemId !== undefined){let data4: any = data.replacesQueueItemId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate1710.errors = [{instancePath:instancePath+"/replacesQueueItemId",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueueItemId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1710.errors = [{instancePath:instancePath+"/replacesQueueItemId",schemaPath:"sidekicks-contracts:run/queue#/$defs/QueueItemId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1710.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1710.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1710.errors = null as any[] | null;
// prettier-ignore
validate1710.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1711(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunStopAllRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1711.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1711.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1711.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1711.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1711.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1711.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1711.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1711.errors = null as any[] | null;
// prettier-ignore
validate1711.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema973: any = {"description":"The run state a stop leaves a child in: `stopped` where the provider's stop is final,\n`interrupted` where a send can continue it.","type":"string","enum":["stopped","interrupted"]};
// prettier-ignore
function validate131(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate131.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate131.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "agent"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data0){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "providerChild"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.childHandle === undefined) && (missing1 = "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "runId")) || (key2 === "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("providerChild" !== data2){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "providerChild"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.runId !== undefined){let data3: any = data.runId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.childHandle !== undefined){let data4: any = data.childHandle;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data4 === "string"){if(func1(data4) > 256){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate131.errors = vErrors;return errors === 0;}
// prettier-ignore
validate131.errors = null as any[] | null;
// prettier-ignore
validate131.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1713(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1713.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1713.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "stopped"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.outcome === undefined) && (missing0 = "outcome")) || ((data.child === undefined) && (missing0 = "child"))) || ((data.state === undefined) && (missing0 = "state"))){validate1713.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((key1 === "outcome") || (key1 === "child")) || (key1 === "state")) || (key1 === "reason"))){validate1713.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;const _errs6: any = errors;if(typeof data0 !== "string"){validate1713.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("stopped" !== data0){validate1713.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "stopped"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.child !== undefined){const _errs8: any = errors;if(!(validate131.call(this, data.child, {instancePath:instancePath+"/child",parentData:data,parentDataProperty:"child",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate131.errors : vErrors.concat(validate131.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.state !== undefined){let data2: any = data.state;const _errs9: any = errors;if(typeof data2 !== "string"){validate1713.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChildStoppedState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "stopped") || (data2 === "interrupted"))){validate1713.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChildStoppedState/enum",keyword:"enum",params:{allowedValues: schema973.enum}}];return false;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.reason !== undefined){const _errs12: any = errors;validate1713.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/not",keyword:"not",params:{}}];return false;var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}}else {validate1713.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "alreadyEnded"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.outcome === undefined) && (missing1 = "outcome")) || ((data.child === undefined) && (missing1 = "child"))){validate1713.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs17: any = errors;for(const key2 in data){if(!((((key2 === "outcome") || (key2 === "child")) || (key2 === "state")) || (key2 === "reason"))){validate1713.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs17 === errors){if(data.outcome !== undefined){let data4: any = data.outcome;const _errs18: any = errors;if(typeof data4 !== "string"){validate1713.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("alreadyEnded" !== data4){validate1713.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "alreadyEnded"}}];return false;}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data.child !== undefined){const _errs20: any = errors;if(!(validate131.call(this, data.child, {instancePath:instancePath+"/child",parentData:data,parentDataProperty:"child",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate131.errors : vErrors.concat(validate131.errors);errors = vErrors.length;}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}if(valid5){if(data.state !== undefined){const _errs21: any = errors;validate1713.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/not",keyword:"not",params:{}}];return false;var valid5: any = _errs21 === errors;}else {var valid5: any = true;}if(valid5){if(data.reason !== undefined){const _errs24: any = errors;validate1713.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/not",keyword:"not",params:{}}];return false;var valid5: any = _errs24 === errors;}else {var valid5: any = true;}}}}}}}else {validate1713.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "failed"){const _errs27: any = errors;if(errors === _errs27){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.outcome === undefined) && (missing2 = "outcome")) || ((data.child === undefined) && (missing2 = "child"))) || ((data.reason === undefined) && (missing2 = "reason"))){validate1713.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs29: any = errors;for(const key3 in data){if(!((((key3 === "outcome") || (key3 === "child")) || (key3 === "state")) || (key3 === "reason"))){validate1713.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs29 === errors){if(data.outcome !== undefined){let data8: any = data.outcome;const _errs30: any = errors;if(typeof data8 !== "string"){validate1713.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data8){validate1713.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid7: any = _errs30 === errors;}else {var valid7: any = true;}if(valid7){if(data.child !== undefined){const _errs32: any = errors;if(!(validate131.call(this, data.child, {instancePath:instancePath+"/child",parentData:data,parentDataProperty:"child",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate131.errors : vErrors.concat(validate131.errors);errors = vErrors.length;}var valid7: any = _errs32 === errors;}else {var valid7: any = true;}if(valid7){if(data.state !== undefined){const _errs33: any = errors;validate1713.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/not",keyword:"not",params:{}}];return false;var valid7: any = _errs33 === errors;}else {var valid7: any = true;}if(valid7){if(data.reason !== undefined){let data11: any = data.reason;const _errs36: any = errors;if(errors === _errs36){if(typeof data11 === "string"){if(func1(data11) > 512){validate1713.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data11) < 1){validate1713.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data11)){validate1713.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1713.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs36 === errors;}else {var valid7: any = true;}}}}}}}else {validate1713.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1713.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validate1713.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}}}else {validate1713.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1713.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1713.errors = null as any[] | null;
// prettier-ignore
validate1713.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1712(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildRunStopAllResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1712.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.children === undefined) && (missing0 = "children")){validate1712.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "children")){validate1712.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.children !== undefined){let data0: any = data.children;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1713.call(this, data0[i0], {instancePath:instancePath+"/children/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1713.errors : vErrors.concat(validate1713.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1712.errors = [{instancePath:instancePath+"/children",schemaPath:"#/properties/children/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1712.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1712.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1712.errors = null as any[] | null;
// prettier-ignore
validate1712.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentChildRunControlRefusedDetails}. */
export const validateAgentChildRunControlRefusedDetails: SchemaCheck<AgentChildRunControlRefusedDetails> =
  validate1705;
/** Checks that a value is a {@link AgentChildRunInterruptRequest}. */
export const validateAgentChildRunInterruptRequest: SchemaCheck<AgentChildRunInterruptRequest> =
  validate1706;
/** Checks that a value is a {@link AgentChildRunInterruptResponse}. */
export const validateAgentChildRunInterruptResponse: SchemaCheck<AgentChildRunInterruptResponse> =
  validate1707;
/** Checks that a value is a {@link AgentChildRunPausedUpdateRequest}. */
export const validateAgentChildRunPausedUpdateRequest: SchemaCheck<AgentChildRunPausedUpdateRequest> =
  validate1708;
/** Checks that a value is a {@link AgentChildRunPausedUpdateResponse}. */
export const validateAgentChildRunPausedUpdateResponse: SchemaCheck<AgentChildRunPausedUpdateResponse> =
  validate1709;
/** Checks that a value is a {@link AgentChildRunSteerRequest}. */
export const validateAgentChildRunSteerRequest: SchemaCheck<AgentChildRunSteerRequest> =
  validate1710;
/** Checks that a value is a {@link AgentChildRunStopAllRequest}. */
export const validateAgentChildRunStopAllRequest: SchemaCheck<AgentChildRunStopAllRequest> =
  validate1711;
/** Checks that a value is a {@link AgentChildRunStopAllResponse}. */
export const validateAgentChildRunStopAllResponse: SchemaCheck<AgentChildRunStopAllResponse> =
  validate1712;
