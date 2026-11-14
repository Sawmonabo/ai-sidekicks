// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the working line reads about one turn: the tokens received so far and the agent's own task list.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type RunId, validateRunId } from "./run/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";

/**
 * A provider's id of one turn.
 */
export type ProviderTurnId = string & { readonly __brand: "ProviderTurnId" };
/**
 * Where one task on the agent's list stands.
 */
export type TurnTaskState = "notStarted" | "inProgress" | "done";

/**
 * The run whose current turn an `agent.turn.usage.subscribe` or `agent.turn.task.subscribe`
 * subscription follows.
 */
export interface AgentTurnSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
}
/**
 * The tokens received this turn: the provider's own output count for each model round, summed
 * across the turn, with reasoning already inside it. Cumulative rather than a delta, so a
 * subscriber that joins mid-turn reads the true figure.
 */
export interface TurnUsageUpdate {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The turn.
   */
  turnId: ProviderTurnId;
  /**
   * Tokens received so far.
   */
  tokensReceived: number;
}
/**
 * One task on the agent's list, in the agent's own words.
 */
export interface TurnTask {
  /**
   * The task.
   */
  text: string;
  /**
   * Where it stands.
   */
  state: TurnTaskState;
}
/**
 * The turn's whole task list in the agent's order, sent whole on every change, because a provider
 * replaces its list rather than patching it. The list goes when the turn is interrupted and
 * returns with the next turn's list.
 */
export interface TurnTasksUpdate {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The turn.
   */
  turnId: ProviderTurnId;
  /**
   * The tasks.
   */
  tasks: TurnTask[];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ProviderTurnId}. */
// prettier-ignore
export const validateProviderTurnId: CompiledSchemaCheck<ProviderTurnId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderTurnId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderTurnId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateProviderTurnId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateProviderTurnId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data)){validateProviderTurnId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderTurnId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateProviderTurnId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderTurnId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentTurnSubscribeRequest}. */
// prettier-ignore
export const validateAgentTurnSubscribeRequest: CompiledSchemaCheck<AgentTurnSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTurnSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentTurnSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))){validateAgentTurnSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "runId"))){validateAgentTurnSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentTurnSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentTurnSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentTurnSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TurnUsageUpdate}. */
// prettier-ignore
export const validateTurnUsageUpdate: CompiledSchemaCheck<TurnUsageUpdate> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TurnUsageUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTurnUsageUpdate.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.runId === undefined) && (missing0 = "runId")) || ((data.turnId === undefined) && (missing0 = "turnId"))) || ((data.tokensReceived === undefined) && (missing0 = "tokensReceived"))){validateTurnUsageUpdate.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "runId") || (key0 === "turnId")) || (key0 === "tokensReceived"))){validateTurnUsageUpdate.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnId !== undefined){const _errs3: any = errors;if(!(validateProviderTurnId.call(this, data.turnId, {instancePath:instancePath+"/turnId",parentData:data,parentDataProperty:"turnId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderTurnId.errors : vErrors.concat(validateProviderTurnId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokensReceived !== undefined){let data2: any = data.tokensReceived;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateTurnUsageUpdate.errors = [{instancePath:instancePath+"/tokensReceived",schemaPath:"#/properties/tokensReceived/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateTurnUsageUpdate.errors = [{instancePath:instancePath+"/tokensReceived",schemaPath:"#/properties/tokensReceived/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateTurnUsageUpdate.errors = [{instancePath:instancePath+"/tokensReceived",schemaPath:"#/properties/tokensReceived/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateTurnUsageUpdate.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTurnUsageUpdate.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTurnUsageUpdate.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1365: any = {"description":"Where one task on the agent's list stands.","type":"string","enum":["notStarted","inProgress","done"]};
/** Checks that a value is a {@link TurnTaskState}. */
// prettier-ignore
export const validateTurnTaskState: CompiledSchemaCheck<TurnTaskState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TurnTaskState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTurnTaskState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateTurnTaskState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "notStarted") || (data === "inProgress")) || (data === "done"))){validateTurnTaskState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1365.enum}}];return false;}validateTurnTaskState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTurnTaskState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TurnTask}. */
// prettier-ignore
export const validateTurnTask: CompiledSchemaCheck<TurnTask> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TurnTask {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTurnTask.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.text === undefined) && (missing0 = "text")) || ((data.state === undefined) && (missing0 = "state"))){validateTurnTask.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "text") || (key0 === "state"))){validateTurnTask.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){let data0: any = data.text;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateTurnTask.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateTurnTask.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateTurnTaskState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTurnTaskState.errors : vErrors.concat(validateTurnTaskState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateTurnTask.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTurnTask.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTurnTask.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TurnTasksUpdate}. */
// prettier-ignore
export const validateTurnTasksUpdate: CompiledSchemaCheck<TurnTasksUpdate> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TurnTasksUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTurnTasksUpdate.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.runId === undefined) && (missing0 = "runId")) || ((data.turnId === undefined) && (missing0 = "turnId"))) || ((data.tasks === undefined) && (missing0 = "tasks"))){validateTurnTasksUpdate.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "runId") || (key0 === "turnId")) || (key0 === "tasks"))){validateTurnTasksUpdate.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnId !== undefined){const _errs3: any = errors;if(!(validateProviderTurnId.call(this, data.turnId, {instancePath:instancePath+"/turnId",parentData:data,parentDataProperty:"turnId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderTurnId.errors : vErrors.concat(validateProviderTurnId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.tasks !== undefined){let data2: any = data.tasks;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateTurnTask.call(this, data2[i0], {instancePath:instancePath+"/tasks/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTurnTask.errors : vErrors.concat(validateTurnTask.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validateTurnTasksUpdate.errors = [{instancePath:instancePath+"/tasks",schemaPath:"#/properties/tasks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateTurnTasksUpdate.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTurnTasksUpdate.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTurnTasksUpdate.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link TURN_METHOD_DESCRIPTORS}, each with its checks. */
export interface TurnMethodDescriptors {
  readonly "agent.turn.usage.subscribe": {
    readonly method: "agent.turn.usage.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentTurnSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<TurnUsageUpdate>;
  };
  readonly "agent.turn.task.subscribe": {
    readonly method: "agent.turn.task.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentTurnSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<TurnTasksUpdate>;
  };
}
/** The running turn's two subscriptions, which follow one run's current turn. */
export const TURN_METHOD_DESCRIPTORS: TurnMethodDescriptors = Object.freeze({
  "agent.turn.usage.subscribe": Object.freeze({
    method: "agent.turn.usage.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentTurnSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateTurnUsageUpdate,
  }),
  "agent.turn.task.subscribe": Object.freeze({
    method: "agent.turn.task.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentTurnSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateTurnTasksUpdate,
  }),
});
