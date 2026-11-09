/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The links between sessions as the person reads and changes them.

import { type SchemaCheck, deepEqual, ucs2length, wireByteLength } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { SessionId } from "./id.js";

/**
 * How two sessions are linked. Every kind but `related` is written by the daemon when the event
 * that makes it happens; `related` is added on purpose and is the one a person removes.
 */
export type SessionLinkKind =
  | "started"
  | "copiedFrom"
  | "messaged"
  | "asked"
  | "mentioned"
  | "related";

/**
 * `session.relatedSession.subscribe`'s input: the session whose related sessions to follow.
 */
export interface SessionRelatedSessionSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One session linked to the followed one. `kind` is the strongest link between the two, and
 * `sessionIsSource` is true where the followed session started, copied, messaged, asked or
 * mentioned the other.
 */
export interface SessionRelatedListEntry {
  /**
   * The linked session.
   */
  sessionId: SessionId;
  /**
   * Its name; absent for an untitled session.
   */
  name?: string;
  /**
   * The strongest link.
   */
  kind: SessionLinkKind;
  /**
   * Whether the followed session is the link's source.
   */
  sessionIsSource: boolean;
  /**
   * On a `messaged` link, how many messages the two traded.
   */
  messageCount?: number;
  /**
   * Whether the pair carries a `related` link, which `Unlink` removes.
   */
  removable: boolean;
}
/**
 * Each `session.relatedSession.subscribe` emission: the whole related list, highest relevance
 * first, sent when the stream opens and again each time a link it depends on is re-scored. The
 * list fits the shared page budget.
 */
export interface SessionRelatedListUpdate {
  /**
   * The followed session.
   */
  sessionId: SessionId;
  /**
   * Its related sessions.
   */
  related: SessionRelatedListEntry[];
}
/**
 * Adds or removes a `related` link between two sessions, naming both by id so a rename changes
 * nothing. The two are different sessions: none links to itself.
 */
export interface SessionLinkRequest {
  /**
   * One session.
   */
  sessionId: SessionId;
  /**
   * The other.
   */
  targetSessionId: SessionId;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
function validate1988(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionLinkRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1988.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.targetSessionId === undefined) && (missing0 = "targetSessionId"))){validate1988.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "targetSessionId"))){validate1988.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1988.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1988.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.targetSessionId !== undefined){let data1: any = data.targetSessionId;const _errs6: any = errors;if(typeof data1 !== "string"){validate1988.errors = [{instancePath:instancePath+"/targetSessionId",schemaPath:"#/properties/targetSessionId/type",keyword:"type",params:{type: "string"}}];return false;}const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1988.errors = [{instancePath:instancePath+"/targetSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1988.errors = [{instancePath:instancePath+"/targetSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;if(valid2){const _errs11: any = errors;const _errs12: any = errors;const vSchema0: any = data && data.sessionId;if(vSchema0 !== undefined && (!func0(data1, vSchema0))){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid3: any = _errs12 === errors;if(valid3){validate1988.errors = [{instancePath:instancePath+"/targetSessionId",schemaPath:"#/properties/targetSessionId/not",keyword:"not",params:{}}];return false;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1988.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1988.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1988.errors = null as any[] | null;
// prettier-ignore
validate1988.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3954: any = {"description":"How two sessions are linked. Every kind but `related` is written by the daemon when the event\nthat makes it happens; `related` is added on purpose and is the one a person removes.","type":"string","enum":["started","copiedFrom","messaged","asked","mentioned","related"]};
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1990(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1990.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.kind === undefined) && (missing0 = "kind"))) || ((data.sessionIsSource === undefined) && (missing0 = "sessionIsSource"))) || ((data.removable === undefined) && (missing0 = "removable"))){validate1990.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "name")) || (key0 === "kind")) || (key0 === "sessionIsSource")) || (key0 === "messageCount")) || (key0 === "removable"))){validate1990.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1990.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1990.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate1990.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1990.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1990.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1990.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){let data2: any = data.kind;const _errs8: any = errors;if(typeof data2 !== "string"){validate1990.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionLinkKind/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data2 === "started") || (data2 === "copiedFrom")) || (data2 === "messaged")) || (data2 === "asked")) || (data2 === "mentioned")) || (data2 === "related"))){validate1990.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionLinkKind/enum",keyword:"enum",params:{allowedValues: schema3954.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionIsSource !== undefined){const _errs11: any = errors;if(typeof data.sessionIsSource !== "boolean"){validate1990.errors = [{instancePath:instancePath+"/sessionIsSource",schemaPath:"#/properties/sessionIsSource/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageCount !== undefined){let data4: any = data.messageCount;const _errs13: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1990.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1990.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validate1990.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.removable !== undefined){const _errs15: any = errors;if(typeof data.removable !== "boolean"){validate1990.errors = [{instancePath:instancePath+"/removable",schemaPath:"#/properties/removable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1990.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1990.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1990.errors = null as any[] | null;
// prettier-ignore
validate1990.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1989(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRelatedListUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1989.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.related === undefined) && (missing0 = "related"))){validate1989.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "related"))){validate1989.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1989.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1989.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.related !== undefined){let data1: any = data.related;const _errs6: any = errors;if(wireByteLength(data1, this && this.attachments) > 991808){validate1989.errors = [{instancePath:instancePath+"/related",schemaPath:"#/properties/related/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1990.call(this, data1[i0], {instancePath:instancePath+"/related/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1990.errors : vErrors.concat(validate1990.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1989.errors = [{instancePath:instancePath+"/related",schemaPath:"#/properties/related/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1989.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1989.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1989.errors = null as any[] | null;
// prettier-ignore
validate1989.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1992(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRelatedSessionSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1992.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1992.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1992.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1992.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1992.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1992.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1992.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1992.errors = null as any[] | null;
// prettier-ignore
validate1992.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionLinkRequest}. */
export const validateSessionLinkRequest: SchemaCheck<SessionLinkRequest> = validate1988;
/** Checks that a value is a {@link SessionRelatedListUpdate}. */
export const validateSessionRelatedListUpdate: SchemaCheck<SessionRelatedListUpdate> = validate1989;
/** Checks that a value is a {@link SessionRelatedSessionSubscribeRequest}. */
export const validateSessionRelatedSessionSubscribeRequest: SchemaCheck<SessionRelatedSessionSubscribeRequest> =
  validate1992;

/** The methods of {@link SESSION_LINK_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionLinkMethodDescriptors {
  readonly "session.relatedSession.subscribe": {
    readonly method: "session.relatedSession.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionRelatedSessionSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SessionRelatedListUpdate>;
  };
  readonly "session.link.add": {
    readonly method: "session.link.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionLinkRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.link.remove": {
    readonly method: "session.link.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionLinkRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The session link methods' wire contract: name, procedure type and types. */
export const SESSION_LINK_METHOD_DESCRIPTORS: SessionLinkMethodDescriptors = Object.freeze({
  "session.relatedSession.subscribe": Object.freeze({
    method: "session.relatedSession.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionRelatedSessionSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateSessionRelatedListUpdate,
  }),
  "session.link.add": Object.freeze({
    method: "session.link.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionLinkRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.link.remove": Object.freeze({
    method: "session.link.remove",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionLinkRequest,
    responseCheck: validateEmptyPayload,
  }),
});
