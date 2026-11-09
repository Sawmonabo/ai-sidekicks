/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A project's session groups as the person places sessions in them.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { SessionId } from "./id.js";

/**
 * Identifies one session group of a project; the daemon mints it.
 */
export type SessionGroupId = string & { readonly __brand: "SessionGroupId" };

/**
 * Makes a group in the session's project with this session in it, so no group is ever empty. A
 * name another group of the project holds, ignoring case, is refused; a chat sits in no group.
 */
export interface SessionGroupCreateRequest {
  /**
   * The session the group starts with.
   */
  sessionId: SessionId;
  /**
   * The group's name.
   */
  name: string;
}
/**
 * The group `session.group.create` made.
 */
export interface SessionGroupCreateResponse {
  /**
   * The group.
   */
  groupId: SessionGroupId;
}
/**
 * Moves the session into a group of its own project, leaving any group it was in; `groupId`
 * `null` takes it out among the project's loose sessions. A group left with no session is removed.
 */
export interface SessionGroupMoveRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The group, or `null` for none.
   */
  groupId: SessionGroupId | null;
}
/**
 * Renames a group, held to the same uniqueness in its project as a new group's name.
 */
export interface SessionGroupRenameRequest {
  /**
   * The group.
   */
  groupId: SessionGroupId;
  /**
   * Its new name.
   */
  name: string;
}
/**
 * Ungroups a group: its sessions go back loose, and nothing is archived or closed.
 */
export interface SessionGroupUngroupRequest {
  /**
   * The group.
   */
  groupId: SessionGroupId;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1963(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGroupCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1963.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.name === undefined) && (missing0 = "name"))){validate1963.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "name"))){validate1963.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1963.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1963.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate1963.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1963.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1963.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1963.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1963.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1963.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1963.errors = null as any[] | null;
// prettier-ignore
validate1963.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1964(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGroupCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1964.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.groupId === undefined) && (missing0 = "groupId")){validate1964.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "groupId")){validate1964.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.groupId !== undefined){let data0: any = data.groupId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1964.errors = [{instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1964.errors = [{instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1964.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1964.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1964.errors = null as any[] | null;
// prettier-ignore
validate1964.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1965(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGroupId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1965.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1965.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1965.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1965.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1965.errors = null as any[] | null;
// prettier-ignore
validate1965.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1966(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGroupMoveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1966.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.groupId === undefined) && (missing0 = "groupId"))){validate1966.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "groupId"))){validate1966.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1966.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1966.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.groupId !== undefined){let data1: any = data.groupId;const _errs6: any = errors;const _errs7: any = errors;let valid2: any = false;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){const err0: any = {instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs8 === errors;valid2 = valid2 || _valid0;const _errs12: any = errors;if(data1 !== null){const err2: any = {instancePath:instancePath+"/groupId",schemaPath:"#/properties/groupId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs12 === errors;valid2 = valid2 || _valid0;if(!valid2){const err3: any = {instancePath:instancePath+"/groupId",schemaPath:"#/properties/groupId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1966.errors = vErrors;return false;}else {errors = _errs7;if(vErrors !== null){if(_errs7){vErrors.length = _errs7;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1966.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1966.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1966.errors = null as any[] | null;
// prettier-ignore
validate1966.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1967(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGroupRenameRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1967.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.groupId === undefined) && (missing0 = "groupId")) || ((data.name === undefined) && (missing0 = "name"))){validate1967.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "groupId") || (key0 === "name"))){validate1967.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.groupId !== undefined){let data0: any = data.groupId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1967.errors = [{instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1967.errors = [{instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate1967.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1967.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1967.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1967.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1967.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1967.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1967.errors = null as any[] | null;
// prettier-ignore
validate1967.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1968(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionGroupUngroupRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1968.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.groupId === undefined) && (missing0 = "groupId")){validate1968.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "groupId")){validate1968.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.groupId !== undefined){let data0: any = data.groupId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1968.errors = [{instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1968.errors = [{instancePath:instancePath+"/groupId",schemaPath:"#/$defs/SessionGroupId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1968.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1968.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1968.errors = null as any[] | null;
// prettier-ignore
validate1968.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionGroupCreateRequest}. */
export const validateSessionGroupCreateRequest: SchemaCheck<SessionGroupCreateRequest> =
  validate1963;
/** Checks that a value is a {@link SessionGroupCreateResponse}. */
export const validateSessionGroupCreateResponse: SchemaCheck<SessionGroupCreateResponse> =
  validate1964;
/** Checks that a value is a {@link SessionGroupId}. */
export const validateSessionGroupId: SchemaCheck<SessionGroupId> = validate1965;
/** Checks that a value is a {@link SessionGroupMoveRequest}. */
export const validateSessionGroupMoveRequest: SchemaCheck<SessionGroupMoveRequest> = validate1966;
/** Checks that a value is a {@link SessionGroupRenameRequest}. */
export const validateSessionGroupRenameRequest: SchemaCheck<SessionGroupRenameRequest> =
  validate1967;
/** Checks that a value is a {@link SessionGroupUngroupRequest}. */
export const validateSessionGroupUngroupRequest: SchemaCheck<SessionGroupUngroupRequest> =
  validate1968;

/** The methods of {@link SESSION_GROUP_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionGroupMethodDescriptors {
  readonly "session.group.create": {
    readonly method: "session.group.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupCreateRequest>;
    readonly responseCheck: SchemaCheck<SessionGroupCreateResponse>;
  };
  readonly "session.group.move": {
    readonly method: "session.group.move";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupMoveRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.group.rename": {
    readonly method: "session.group.rename";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupRenameRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.group.ungroup": {
    readonly method: "session.group.ungroup";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupUngroupRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The session group methods' wire contract: name, procedure type and types. */
export const SESSION_GROUP_METHOD_DESCRIPTORS: SessionGroupMethodDescriptors = Object.freeze({
  "session.group.create": Object.freeze({
    method: "session.group.create",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionGroupCreateRequest,
    responseCheck: validateSessionGroupCreateResponse,
  }),
  "session.group.move": Object.freeze({
    method: "session.group.move",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionGroupMoveRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.group.rename": Object.freeze({
    method: "session.group.rename",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionGroupRenameRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.group.ungroup": Object.freeze({
    method: "session.group.ungroup",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionGroupUngroupRequest,
    responseCheck: validateEmptyPayload,
  }),
});
