/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's tags as the person adds and removes them, and the tags in use that `Add tag` suggests.

import { type SchemaCheck, ucs2length, wireByteLength } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { Tag, TagList } from "../tag.js";
import type { SessionId } from "./id.js";

/**
 * Adds a tag to a session or removes one. A tag is matched ignoring case and nests with `/`.
 */
export interface SessionTagRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The tag.
   */
  tag: Tag;
}
/**
 * The tags in use across every session, which `Add tag` suggests. They fit the shared page
 * budget.
 */
export interface SessionTagListResponse {
  /**
   * The tags.
   */
  tags: TagList;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern2811 = new RegExp("^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$", "u");
// prettier-ignore
function validate2083(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2083.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){let data0: any = data[i0];const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validate2083.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/Tag/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern2811.test(data0)){validate2083.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/Tag/pattern",keyword:"pattern",params:{pattern: "^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$"}}];return false;}}}else {validate2083.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"#/$defs/Tag/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validate2083.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validate2083.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2083.errors = null as any[] | null;
// prettier-ignore
validate2083.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2082(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionTagListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2082.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.tags === undefined) && (missing0 = "tags")){validate2082.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "tags")){validate2082.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.tags !== undefined){let data0: any = data.tags;if(!(validate2083.call(this, data0, {instancePath:instancePath+"/tags",parentData:data,parentDataProperty:"tags",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2083.errors : vErrors.concat(validate2083.errors);errors = vErrors.length;}else {if(wireByteLength(data0, this && this.attachments) > 991808){validate2082.errors = [{instancePath:instancePath+"/tags",schemaPath:"#/properties/tags/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}}}}}}else {validate2082.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2082.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2082.errors = null as any[] | null;
// prettier-ignore
validate2082.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2085(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionTagRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2085.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.tag === undefined) && (missing0 = "tag"))){validate2085.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "tag"))){validate2085.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2085.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2085.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tag !== undefined){let data1: any = data.tag;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2085.errors = [{instancePath:instancePath+"/tag",schemaPath:"sidekicks-contracts:tag#/$defs/Tag/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern2811.test(data1)){validate2085.errors = [{instancePath:instancePath+"/tag",schemaPath:"sidekicks-contracts:tag#/$defs/Tag/pattern",keyword:"pattern",params:{pattern: "^[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+(?:/[^\\x00/\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)*$"}}];return false;}}}else {validate2085.errors = [{instancePath:instancePath+"/tag",schemaPath:"sidekicks-contracts:tag#/$defs/Tag/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2085.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2085.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2085.errors = null as any[] | null;
// prettier-ignore
validate2085.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionTagListResponse}. */
export const validateSessionTagListResponse: SchemaCheck<SessionTagListResponse> = validate2082;
/** Checks that a value is a {@link SessionTagRequest}. */
export const validateSessionTagRequest: SchemaCheck<SessionTagRequest> = validate2085;

/** The methods of {@link SESSION_TAG_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionTagMethodDescriptors {
  readonly "session.tag.add": {
    readonly method: "session.tag.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTagRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.tag.remove": {
    readonly method: "session.tag.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTagRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.tag.list": {
    readonly method: "session.tag.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SessionTagListResponse>;
  };
}
/** The session tag methods' wire contract: name, procedure type and types. */
export const SESSION_TAG_METHOD_DESCRIPTORS: SessionTagMethodDescriptors = Object.freeze({
  "session.tag.add": Object.freeze({
    method: "session.tag.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTagRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.tag.remove": Object.freeze({
    method: "session.tag.remove",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTagRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.tag.list": Object.freeze({
    method: "session.tag.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSessionTagListResponse,
  }),
});
