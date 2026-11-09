// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A goal inside a session: the condition one agent works toward, the two methods that set and clear it, and the two events that record each change.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { AgentId } from "../agent/definition.js";
import { type SessionAcknowledgment, validateSessionAcknowledgment } from "./controls/methods.js";
import type { SessionId } from "./id.js";

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
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1956(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoal {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1956.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.text === undefined) && (missing0 = "text")){validate1956.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "text")){validate1956.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){let data0: any = data.text;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate1956.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1956.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1956.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1956.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1956.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1956.errors = null as any[] | null;
// prettier-ignore
validate1956.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1957(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalClearRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1957.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate1957.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "agentId"))){validate1957.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1957.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1957.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1957.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1957.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1957.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1957.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1957.errors = null as any[] | null;
// prettier-ignore
validate1957.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1958(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalClearedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1958.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate1958.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "agentId"))){validate1958.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1958.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1958.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1958.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1958.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1958.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1958.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1958.errors = null as any[] | null;
// prettier-ignore
validate1958.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1330: any = {"description":"Where a goal stands. `complete` and `impossible` are final; a goal's last status is what its row\ndraws. `impossible` comes only from a provider whose judge can rule a goal out, carrying the\njudge's reason. Clearing is the event `session.goal.cleared`, never a status.","type":"string","enum":["active","paused","blocked","usageLimited","budgetLimited","complete","impossible"]};
// prettier-ignore
function validate1959(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1959.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1959.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data === "active") || (data === "paused")) || (data === "blocked")) || (data === "usageLimited")) || (data === "budgetLimited")) || (data === "complete")) || (data === "impossible"))){validate1959.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1330.enum}}];return false;}validate1959.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1959.errors = null as any[] | null;
// prettier-ignore
validate1959.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1960(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1960.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))) || ((data.goal === undefined) && (missing0 = "goal"))){validate1960.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "agentId")) || (key0 === "goal"))){validate1960.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1960.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1960.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1960.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1960.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.goal !== undefined){let data2: any = data.goal;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.text === undefined) && (missing1 = "text")){validate1960.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data2){if(!(key1 === "text")){validate1960.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data2.text !== undefined){let data3: any = data2.text;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) < 1){validate1960.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1960.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1960.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1960.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1960.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1960.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1960.errors = null as any[] | null;
// prettier-ignore
validate1960.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1961(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1961.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.goal === undefined) && (missing0 = "goal"))){validate1961.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "goal"))){validate1961.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1961.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1961.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.goal !== undefined){let data1: any = data.goal;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if((data1.text === undefined) && (missing1 = "text")){validate1961.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data1){if(!(key1 === "text")){validate1961.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data1.text !== undefined){let data2: any = data1.text;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate1961.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1961.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1961.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1961.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1961.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1961.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1961.errors = null as any[] | null;
// prettier-ignore
validate1961.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1962(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGoalUpdatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1962.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.status === undefined) && (missing0 = "status")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.status !== undefined){if("impossible" !== data.status){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs4: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.reason === undefined) && (missing1 = "reason")){validate1962.errors = [{instancePath,schemaPath:"#/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}var _valid0: any = _errs4 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.reason = true;props0.status = true;}ifClause0 = "then";}else {const _errs5: any = errors;const _errs6: any = errors;const _errs7: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.reason === undefined) && (missing2 = "reason")){const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var valid2: any = _errs7 === errors;if(valid2){validate1962.errors = [{instancePath,schemaPath:"#/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var _valid0: any = _errs5 === errors;valid0 = _valid0;ifClause0 = "else";}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1962.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.sessionId === undefined) && (missing3 = "sessionId")) || ((data.agentId === undefined) && (missing3 = "agentId"))) || ((data.goal === undefined) && (missing3 = "goal"))) || ((data.status === undefined) && (missing3 = "status"))){validate1962.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs8: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "agentId")) || (key0 === "goal")) || (key0 === "status")) || (key0 === "reason"))){validate1962.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs8 === errors){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1962.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1962.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs9 === errors;}else {var valid3: any = true;}if(valid3){if(data.agentId !== undefined){let data2: any = data.agentId;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1962.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1962.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs13 === errors;}else {var valid3: any = true;}if(valid3){if(data.goal !== undefined){let data3: any = data.goal;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing4: any;if((data3.text === undefined) && (missing4 = "text")){validate1962.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs20: any = errors;for(const key1 in data3){if(!(key1 === "text")){validate1962.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs20 === errors){if(data3.text !== undefined){let data4: any = data3.text;const _errs21: any = errors;if(errors === _errs21){if(typeof data4 === "string"){if(func1(data4) < 1){validate1962.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1962.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1962.errors = [{instancePath:instancePath+"/goal/text",schemaPath:"#/$defs/SessionGoal/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1962.errors = [{instancePath:instancePath+"/goal",schemaPath:"#/$defs/SessionGoal/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs17 === errors;}else {var valid3: any = true;}if(valid3){if(data.status !== undefined){let data5: any = data.status;const _errs23: any = errors;if(typeof data5 !== "string"){validate1962.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/SessionGoalStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data5 === "active") || (data5 === "paused")) || (data5 === "blocked")) || (data5 === "usageLimited")) || (data5 === "budgetLimited")) || (data5 === "complete")) || (data5 === "impossible"))){validate1962.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/SessionGoalStatus/enum",keyword:"enum",params:{allowedValues: schema1330.enum}}];return false;}var valid3: any = _errs23 === errors;}else {var valid3: any = true;}if(valid3){if(data.reason !== undefined){let data6: any = data.reason;const _errs26: any = errors;if(errors === _errs26){if(typeof data6 === "string"){if(func1(data6) > 32768){validate1962.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data6) < 1){validate1962.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate1962.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1962.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs26 === errors;}else {var valid3: any = true;}}}}}}}}else {validate1962.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1962.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1962.errors = null as any[] | null;
// prettier-ignore
validate1962.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGoal}. */
export const validateSessionGoal: SchemaCheck<SessionGoal> = validate1956;
/** Checks that a value is a {@link SessionGoalClearRequest}. */
export const validateSessionGoalClearRequest: SchemaCheck<SessionGoalClearRequest> = validate1957;
/** Checks that a value is a {@link SessionGoalClearedPayload}. */
export const validateSessionGoalClearedPayload: SchemaCheck<SessionGoalClearedPayload> =
  validate1958;
/** Checks that a value is a {@link SessionGoalStatus}. */
export const validateSessionGoalStatus: SchemaCheck<SessionGoalStatus> = validate1959;
/** Checks that a value is a {@link SessionGoalUpdateRequest}. */
export const validateSessionGoalUpdateRequest: SchemaCheck<SessionGoalUpdateRequest> = validate1960;
/** Checks that a value is a {@link SessionGoalUpdateResponse}. */
export const validateSessionGoalUpdateResponse: SchemaCheck<SessionGoalUpdateResponse> =
  validate1961;
/** Checks that a value is a {@link SessionGoalUpdatedPayload}. */
export const validateSessionGoalUpdatedPayload: SchemaCheck<SessionGoalUpdatedPayload> =
  validate1962;

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
