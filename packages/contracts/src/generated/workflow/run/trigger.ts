/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// How a workflow run was started and by whom: the run mode, the trigger node's kind, the trigger node that started it, the run's place in its chain, and the person, device, message or parent run that started it.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";
import type { AgentId } from "../../agent/definition.js";
import type { EventCursor, SessionId } from "../../session/id.js";
import type { DeviceId } from "../../trust-statement.js";
import type { WorkflowNodeId } from "../definition/document.js";
import type { WorkflowRunId } from "./id.js";

/** Every way a run is started. */
export const WORKFLOW_RUN_MODES = [
  "manual",
  "trigger",
  "webhook",
  "chat",
  "agent",
  "retry",
  "subWorkflow",
] as const;

/**
 * Every trigger kind a run can be started by, in the order the runs table's filter lists
 * them.
 */
export const WORKFLOW_TRIGGER_KINDS = [
  "trigger.manual",
  "trigger.schedule",
  "trigger.fileWatch",
  "trigger.webhook",
  "trigger.sessionEvent",
  "trigger.chat",
  "trigger.subWorkflow",
  "trigger.error",
] as const;

/**
 * How a run was started, which is a different question from who started it.
 */
export type WorkflowRunMode =
  | "manual"
  | "trigger"
  | "webhook"
  | "chat"
  | "agent"
  | "retry"
  | "subWorkflow";
/**
 * The kind of trigger node that started a run, which the runs table's trigger column and filter
 * read. A retry keeps its source run's kind; a mode cannot carry this, because `trigger` covers a
 * schedule, a file event, a session event and another workflow failing alike.
 */
export type WorkflowTriggerKind =
  | "trigger.manual"
  | "trigger.schedule"
  | "trigger.fileWatch"
  | "trigger.webhook"
  | "trigger.sessionEvent"
  | "trigger.chat"
  | "trigger.subWorkflow"
  | "trigger.error";
/**
 * A run's place in its chain: it starts a chain of its own, or it joins the chain whose first run
 * is `chain_root_run_id`, through an error trigger when `is_from_error`.
 */
export type WorkflowRunChainPlace =
  | {
      kind: "starts";
    }
  | {
      kind: "joins";
      /**
       * The chain's first run.
       */
      chainRootRunId: WorkflowRunId;
      /**
       * Whether an error trigger started it.
       */
      isFromError: boolean;
    };
/**
 * Who or what started a run, as its row and its header name it. A person's start records the
 * device of the connection that made it, never a person; a chat start carries the message it came
 * from, so the run links back to that message.
 */
export type WorkflowStartedBy =
  | {
      kind: "user";
      /**
       * The device.
       */
      deviceId: DeviceId;
    }
  | {
      kind: "schedule";
    }
  | {
      kind: "chat";
      /**
       * The session the message is in.
       */
      sessionId: SessionId;
      /**
       * The message's place in the session's log.
       */
      messageAnchorCursor?: EventCursor;
    }
  | {
      kind: "agent";
      /**
       * The agent.
       */
      agentId: AgentId;
    }
  | {
      kind: "webhook";
    }
  | {
      kind: "fileEvent";
    }
  | {
      kind: "parentWorkflow";
      /**
       * The parent run.
       */
      parentWorkflowRunId: WorkflowRunId;
    };

/**
 * Which trigger node started a run, as its row's trigger record and its started event carry it.
 */
export interface WorkflowRunTrigger {
  /**
   * The trigger node's kind.
   */
  kind: WorkflowTriggerKind;
  /**
   * The trigger node.
   */
  nodeId: WorkflowNodeId;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2929(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunChainPlace {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2929.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2929.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "starts"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){validate2929.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(key1 === "kind")){validate2929.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;if(typeof data0 !== "string"){validate2929.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("starts" !== data0){validate2929.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "starts"}}];return false;}}}}}else {validate2929.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "joins"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.chainRootRunId === undefined) && (missing1 = "chainRootRunId"))) || ((data.isFromError === undefined) && (missing1 = "isFromError"))){validate2929.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "chainRootRunId")) || (key2 === "isFromError"))){validate2929.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs10 === errors){if(data.kind !== undefined){let data1: any = data.kind;const _errs11: any = errors;if(typeof data1 !== "string"){validate2929.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("joins" !== data1){validate2929.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "joins"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.chainRootRunId !== undefined){let data2: any = data.chainRootRunId;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2929.errors = [{instancePath:instancePath+"/chainRootRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2929.errors = [{instancePath:instancePath+"/chainRootRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.isFromError !== undefined){const _errs17: any = errors;if(typeof data.isFromError !== "boolean"){validate2929.errors = [{instancePath:instancePath+"/isFromError",schemaPath:"#/oneOf/1/properties/isFromError/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}}}}}}else {validate2929.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2929.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2929.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2929.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2929.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2929.errors = null as any[] | null;
// prettier-ignore
validate2929.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1368: any = {"description":"How a run was started, which is a different question from who started it.","type":"string","enum":["manual","trigger","webhook","chat","agent","retry","subWorkflow"]};
// prettier-ignore
function validate2930(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunMode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2930.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate2930.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data === "manual") || (data === "trigger")) || (data === "webhook")) || (data === "chat")) || (data === "agent")) || (data === "retry")) || (data === "subWorkflow"))){validate2930.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1368.enum}}];return false;}validate2930.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2930.errors = null as any[] | null;
// prettier-ignore
validate2930.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1376: any = {"description":"The kind of trigger node that started a run, which the runs table's trigger column and filter\nread. A retry keeps its source run's kind; a mode cannot carry this, because `trigger` covers a\nschedule, a file event, a session event and another workflow failing alike.","type":"string","enum":["trigger.manual","trigger.schedule","trigger.fileWatch","trigger.webhook","trigger.sessionEvent","trigger.chat","trigger.subWorkflow","trigger.error"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2931(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunTrigger {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2931.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))){validate2931.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "nodeId"))){validate2931.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validate2931.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/WorkflowTriggerKind/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((((data0 === "trigger.manual") || (data0 === "trigger.schedule")) || (data0 === "trigger.fileWatch")) || (data0 === "trigger.webhook")) || (data0 === "trigger.sessionEvent")) || (data0 === "trigger.chat")) || (data0 === "trigger.subWorkflow")) || (data0 === "trigger.error"))){validate2931.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/WorkflowTriggerKind/enum",keyword:"enum",params:{allowedValues: schema1376.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data1: any = data.nodeId;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate2931.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2931.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2931.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2931.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2931.errors = null as any[] | null;
// prettier-ignore
validate2931.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate2932(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStartedBy {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2932.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2932.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "user"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "deviceId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("user" !== data0){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "user"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){let data1: any = data.deviceId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(func1(data1) > 256){validate2932.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data1)){validate2932.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2932.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "schedule"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(key2 === "kind")){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;if(typeof data2 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("schedule" !== data2){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "schedule"}}];return false;}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "chat"){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs19: any = errors;for(const key3 in data){if(!(((key3 === "kind") || (key3 === "sessionId")) || (key3 === "messageAnchorCursor"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs19 === errors){if(data.kind !== undefined){let data3: any = data.kind;const _errs20: any = errors;if(typeof data3 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("chat" !== data3){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "chat"}}];return false;}var valid7: any = _errs20 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data4: any = data.sessionId;const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate2932.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2932.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs22 === errors;}else {var valid7: any = true;}if(valid7){if(data.messageAnchorCursor !== undefined){let data5: any = data.messageAnchorCursor;const _errs26: any = errors;const _errs27: any = errors;if(errors === _errs27){if(typeof data5 === "string"){if(func1(data5) > 256){validate2932.errors = [{instancePath:instancePath+"/messageAnchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate2932.errors = [{instancePath:instancePath+"/messageAnchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2932.errors = [{instancePath:instancePath+"/messageAnchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs26 === errors;}else {var valid7: any = true;}}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "agent"){const _errs30: any = errors;if(errors === _errs30){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.kind === undefined) && (missing3 = "kind")) || ((data.agentId === undefined) && (missing3 = "agentId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs32: any = errors;for(const key4 in data){if(!((key4 === "kind") || (key4 === "agentId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs32 === errors){if(data.kind !== undefined){let data6: any = data.kind;const _errs33: any = errors;if(typeof data6 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data6){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid11: any = _errs33 === errors;}else {var valid11: any = true;}if(valid11){if(data.agentId !== undefined){let data7: any = data.agentId;const _errs35: any = errors;const _errs36: any = errors;if(errors === _errs36){if(typeof data7 === "string"){if(!pattern4.test(data7)){validate2932.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2932.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs35 === errors;}else {var valid11: any = true;}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "webhook"){const _errs39: any = errors;if(errors === _errs39){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.kind === undefined) && (missing4 = "kind")){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs41: any = errors;for(const key5 in data){if(!(key5 === "kind")){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs41 === errors){if(data.kind !== undefined){let data8: any = data.kind;if(typeof data8 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("webhook" !== data8){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "webhook"}}];return false;}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "fileEvent"){const _errs44: any = errors;if(errors === _errs44){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((data.kind === undefined) && (missing5 = "kind")){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs46: any = errors;for(const key6 in data){if(!(key6 === "kind")){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs46 === errors){if(data.kind !== undefined){let data9: any = data.kind;if(typeof data9 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("fileEvent" !== data9){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "fileEvent"}}];return false;}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "parentWorkflow"){const _errs49: any = errors;if(errors === _errs49){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((data.kind === undefined) && (missing6 = "kind")) || ((data.parentWorkflowRunId === undefined) && (missing6 = "parentWorkflowRunId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs51: any = errors;for(const key7 in data){if(!((key7 === "kind") || (key7 === "parentWorkflowRunId"))){validate2932.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}}];return false;break;}}if(_errs51 === errors){if(data.kind !== undefined){let data10: any = data.kind;const _errs52: any = errors;if(typeof data10 !== "string"){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("parentWorkflow" !== data10){validate2932.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "parentWorkflow"}}];return false;}var valid18: any = _errs52 === errors;}else {var valid18: any = true;}if(valid18){if(data.parentWorkflowRunId !== undefined){let data11: any = data.parentWorkflowRunId;const _errs54: any = errors;const _errs55: any = errors;if(errors === _errs55){if(typeof data11 === "string"){if(!pattern4.test(data11)){validate2932.errors = [{instancePath:instancePath+"/parentWorkflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2932.errors = [{instancePath:instancePath+"/parentWorkflowRunId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs54 === errors;}else {var valid18: any = true;}}}}}else {validate2932.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2932.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2932.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2932.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2932.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2932.errors = null as any[] | null;
// prettier-ignore
validate2932.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2933(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowTriggerKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2933.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate2933.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((((data === "trigger.manual") || (data === "trigger.schedule")) || (data === "trigger.fileWatch")) || (data === "trigger.webhook")) || (data === "trigger.sessionEvent")) || (data === "trigger.chat")) || (data === "trigger.subWorkflow")) || (data === "trigger.error"))){validate2933.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1376.enum}}];return false;}validate2933.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2933.errors = null as any[] | null;
// prettier-ignore
validate2933.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunChainPlace}. */
export const validateWorkflowRunChainPlace: SchemaCheck<WorkflowRunChainPlace> = validate2929;
/** Checks that a value is a {@link WorkflowRunMode}. */
export const validateWorkflowRunMode: SchemaCheck<WorkflowRunMode> = validate2930;
/** Checks that a value is a {@link WorkflowRunTrigger}. */
export const validateWorkflowRunTrigger: SchemaCheck<WorkflowRunTrigger> = validate2931;
/** Checks that a value is a {@link WorkflowStartedBy}. */
export const validateWorkflowStartedBy: SchemaCheck<WorkflowStartedBy> = validate2932;
/** Checks that a value is a {@link WorkflowTriggerKind}. */
export const validateWorkflowTriggerKind: SchemaCheck<WorkflowTriggerKind> = validate2933;
