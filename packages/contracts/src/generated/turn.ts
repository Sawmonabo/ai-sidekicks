// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the working line reads about one turn: the tokens received so far and the agent's own task list.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";

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
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2237(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTurnSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2237.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))){validate2237.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "runId"))){validate2237.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2237.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2237.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2237.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2237.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2237.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2237.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2237.errors = null as any[] | null;
// prettier-ignore
validate2237.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const schema4429: any = {"description":"Where one task on the agent's list stands.","type":"string","enum":["notStarted","inProgress","done"]};
// prettier-ignore
function validate2239(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2239.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.text === undefined) && (missing0 = "text")) || ((data.state === undefined) && (missing0 = "state"))){validate2239.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "text") || (key0 === "state"))){validate2239.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){let data0: any = data.text;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate2239.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2239.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs4: any = errors;if(typeof data1 !== "string"){validate2239.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/TurnTaskState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "notStarted") || (data1 === "inProgress")) || (data1 === "done"))){validate2239.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/TurnTaskState/enum",keyword:"enum",params:{allowedValues: schema4429.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate2239.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2239.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2239.errors = null as any[] | null;
// prettier-ignore
validate2239.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2238(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TurnTasksUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2238.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.runId === undefined) && (missing0 = "runId")) || ((data.turnId === undefined) && (missing0 = "turnId"))) || ((data.tasks === undefined) && (missing0 = "tasks"))){validate2238.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "runId") || (key0 === "turnId")) || (key0 === "tasks"))){validate2238.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){let data0: any = data.runId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2238.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2238.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnId !== undefined){let data1: any = data.turnId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2238.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2238.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2238.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2238.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.tasks !== undefined){let data2: any = data.tasks;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data2)){var valid3: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validate2239.call(this, data2[i0], {instancePath:instancePath+"/tasks/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2239.errors : vErrors.concat(validate2239.errors);errors = vErrors.length;}var valid3: any = _errs12 === errors;if(!valid3){break;}}}else {validate2238.errors = [{instancePath:instancePath+"/tasks",schemaPath:"#/properties/tasks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2238.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2238.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2238.errors = null as any[] | null;
// prettier-ignore
validate2238.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2241(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TurnUsageUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2241.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.runId === undefined) && (missing0 = "runId")) || ((data.turnId === undefined) && (missing0 = "turnId"))) || ((data.tokensReceived === undefined) && (missing0 = "tokensReceived"))){validate2241.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "runId") || (key0 === "turnId")) || (key0 === "tokensReceived"))){validate2241.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){let data0: any = data.runId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2241.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2241.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnId !== undefined){let data1: any = data.turnId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2241.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2241.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2241.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2241.errors = [{instancePath:instancePath+"/turnId",schemaPath:"#/$defs/ProviderTurnId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokensReceived !== undefined){let data2: any = data.tokensReceived;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate2241.errors = [{instancePath:instancePath+"/tokensReceived",schemaPath:"#/properties/tokensReceived/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate2241.errors = [{instancePath:instancePath+"/tokensReceived",schemaPath:"#/properties/tokensReceived/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate2241.errors = [{instancePath:instancePath+"/tokensReceived",schemaPath:"#/properties/tokensReceived/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2241.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2241.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2241.errors = null as any[] | null;
// prettier-ignore
validate2241.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentTurnSubscribeRequest}. */
export const validateAgentTurnSubscribeRequest: SchemaCheck<AgentTurnSubscribeRequest> =
  validate2237;
/** Checks that a value is a {@link TurnTasksUpdate}. */
export const validateTurnTasksUpdate: SchemaCheck<TurnTasksUpdate> = validate2238;
/** Checks that a value is a {@link TurnUsageUpdate}. */
export const validateTurnUsageUpdate: SchemaCheck<TurnUsageUpdate> = validate2241;

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
