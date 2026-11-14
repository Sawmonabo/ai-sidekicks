// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A goal inside a session: the condition one agent works toward, the two methods that set and clear it, and the two events that record each change.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type AgentId, validateAgentId } from "../agent/definition.js";
import { type SessionAcknowledgment, validateSessionAcknowledgment } from "./controls/methods.js";
import { type SessionId, validateSessionId } from "./id.js";

/**
 * Where a goal stands. `complete` and `impossible` are final; a goal's last status is what its row
 * draws. `impossible` comes only from a provider whose judge can rule a goal out, carrying the
 * judge's reason. Clearing is the event `session.goal.cleared`, never a status.
 */
export type SessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"
  | "impossible";

/**
 * A goal's condition, as the person wrote it. `text` has no length cap of the app's own; it is
 * not blank and free of NUL, checked as written and never trimmed. Clearing is its own operation,
 * so an update with empty text is refused rather than read as a clear.
 */
export interface SessionGoal {
  /**
   * The condition.
   */
  text: string;
}
/**
 * Sets or replaces the goal of one agent in the session. The last write wins.
 */
export interface SessionGoalUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The goal.
   */
  goal: SessionGoal;
}
/**
 * The accepted goal, echoed exactly as the `session.goal.updated` event carries it.
 */
export interface SessionGoalUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The goal.
   */
  goal: SessionGoal;
}
/**
 * Removes one agent's goal. With no goal set it succeeds, as a provider's own clear does.
 */
export interface SessionGoalClearRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
}
/**
 * The `session.goal.updated` payload: the goal and where it now stands. `reason` is the provider's
 * judge's reason, present exactly when the status is `impossible`.
 */
export interface SessionGoalUpdatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The goal.
   */
  goal: SessionGoal;
  /**
   * Where it now stands.
   */
  status: SessionGoalStatus;
  /**
   * The judge's reason, present exactly when the status is `impossible`.
   */
  reason?: string;
}
/**
 * The `session.goal.cleared` payload: whose goal was removed.
 */
export interface SessionGoalClearedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SessionGoal}. */
// prettier-ignore
export const validateSessionGoal: CompiledSchemaCheck<SessionGoal> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoal {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoal.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.text === undefined) && (missing0 = "text")){validateSessionGoal.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "text")){validateSessionGoal.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){let data0: any = data.text;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateSessionGoal.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateSessionGoal.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateSessionGoal.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateSessionGoal.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionGoal.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoal.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema508: any = {"description":"Where a goal stands. `complete` and `impossible` are final; a goal's last status is what its row\ndraws. `impossible` comes only from a provider whose judge can rule a goal out, carrying the\njudge's reason. Clearing is the event `session.goal.cleared`, never a status.","type":"string","enum":["active","paused","blocked","usageLimited","budgetLimited","complete","impossible"]};
/** Checks that a value is a {@link SessionGoalStatus}. */
// prettier-ignore
export const validateSessionGoalStatus: CompiledSchemaCheck<SessionGoalStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoalStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionGoalStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data === "active") || (data === "paused")) || (data === "blocked")) || (data === "usageLimited")) || (data === "budgetLimited")) || (data === "complete")) || (data === "impossible"))){validateSessionGoalStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema508.enum}}];return false;}validateSessionGoalStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoalStatus.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGoalUpdateRequest}. */
// prettier-ignore
export const validateSessionGoalUpdateRequest: CompiledSchemaCheck<SessionGoalUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoalUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))) || ((data.goal === undefined) && (missing0 = "goal"))){validateSessionGoalUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "agentId")) || (key0 === "goal"))){validateSessionGoalUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){const _errs3: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.goal !== undefined){const _errs4: any = errors;if(!(validateSessionGoal.call(this, data.goal, {instancePath:instancePath+"/goal",parentData:data,parentDataProperty:"goal",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionGoal.errors : vErrors.concat(validateSessionGoal.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionGoalUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionGoalUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoalUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGoalUpdateResponse}. */
// prettier-ignore
export const validateSessionGoalUpdateResponse: CompiledSchemaCheck<SessionGoalUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoalUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.goal === undefined) && (missing0 = "goal"))){validateSessionGoalUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "goal"))){validateSessionGoalUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.goal !== undefined){const _errs3: any = errors;if(!(validateSessionGoal.call(this, data.goal, {instancePath:instancePath+"/goal",parentData:data,parentDataProperty:"goal",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionGoal.errors : vErrors.concat(validateSessionGoal.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionGoalUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionGoalUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoalUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGoalClearRequest}. */
// prettier-ignore
export const validateSessionGoalClearRequest: CompiledSchemaCheck<SessionGoalClearRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoalClearRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validateSessionGoalClearRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "agentId"))){validateSessionGoalClearRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){const _errs3: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionGoalClearRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionGoalClearRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoalClearRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGoalUpdatedPayload}. */
// prettier-ignore
export const validateSessionGoalUpdatedPayload: CompiledSchemaCheck<SessionGoalUpdatedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalUpdatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoalUpdatedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.status === undefined) && (missing0 = "status")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.status !== undefined){if("impossible" !== data.status){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs4: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.reason === undefined) && (missing1 = "reason")){validateSessionGoalUpdatedPayload.errors = [{instancePath,schemaPath:"#/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}var _valid0: any = _errs4 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.reason = true;props0.status = true;}ifClause0 = "then";}else {const _errs5: any = errors;const _errs6: any = errors;const _errs7: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.reason === undefined) && (missing2 = "reason")){const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var valid2: any = _errs7 === errors;if(valid2){validateSessionGoalUpdatedPayload.errors = [{instancePath,schemaPath:"#/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var _valid0: any = _errs5 === errors;valid0 = _valid0;ifClause0 = "else";}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateSessionGoalUpdatedPayload.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.sessionId === undefined) && (missing3 = "sessionId")) || ((data.agentId === undefined) && (missing3 = "agentId"))) || ((data.goal === undefined) && (missing3 = "goal"))) || ((data.status === undefined) && (missing3 = "status"))){validateSessionGoalUpdatedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs8: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "agentId")) || (key0 === "goal")) || (key0 === "status")) || (key0 === "reason"))){validateSessionGoalUpdatedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs8 === errors){if(data.sessionId !== undefined){const _errs9: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid3: any = _errs9 === errors;}else {var valid3: any = true;}if(valid3){if(data.agentId !== undefined){const _errs10: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}if(valid3){if(data.goal !== undefined){const _errs11: any = errors;if(!(validateSessionGoal.call(this, data.goal, {instancePath:instancePath+"/goal",parentData:data,parentDataProperty:"goal",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionGoal.errors : vErrors.concat(validateSessionGoal.errors);errors = vErrors.length;}var valid3: any = _errs11 === errors;}else {var valid3: any = true;}if(valid3){if(data.status !== undefined){const _errs12: any = errors;if(!(validateSessionGoalStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionGoalStatus.errors : vErrors.concat(validateSessionGoalStatus.errors);errors = vErrors.length;}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data.reason !== undefined){let data5: any = data.reason;const _errs13: any = errors;if(errors === _errs13){if(typeof data5 === "string"){if(func1(data5) > 32768){validateSessionGoalUpdatedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data5) < 1){validateSessionGoalUpdatedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateSessionGoalUpdatedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionGoalUpdatedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs13 === errors;}else {var valid3: any = true;}}}}}}}}else {validateSessionGoalUpdatedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionGoalUpdatedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoalUpdatedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGoalClearedPayload}. */
// prettier-ignore
export const validateSessionGoalClearedPayload: CompiledSchemaCheck<SessionGoalClearedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalClearedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionGoalClearedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validateSessionGoalClearedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "agentId"))){validateSessionGoalClearedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){const _errs3: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionGoalClearedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionGoalClearedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionGoalClearedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link SESSION_GOAL_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionGoalMethodDescriptors {
  readonly "session.goal.update": {
    readonly method: "session.goal.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGoalUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionGoalUpdateResponse>;
  };
  readonly "session.goal.clear": {
    readonly method: "session.goal.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGoalClearRequest>;
    readonly responseCheck: SchemaCheck<SessionAcknowledgment>;
  };
}
/** The goal methods' wire contract: name, procedure type and types. */
export const SESSION_GOAL_METHOD_DESCRIPTORS: SessionGoalMethodDescriptors = Object.freeze({
  "session.goal.update": Object.freeze({
    method: "session.goal.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionGoalUpdateRequest,
    responseCheck: validateSessionGoalUpdateResponse,
  }),
  "session.goal.clear": Object.freeze({
    method: "session.goal.clear",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionGoalClearRequest,
    responseCheck: validateSessionAcknowledgment,
  }),
});
