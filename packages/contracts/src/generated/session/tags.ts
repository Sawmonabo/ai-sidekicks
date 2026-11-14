// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's tags as the person adds and removes them, and the tags in use that `Add tag` suggests.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  ucs2length,
  wireByteLength,
} from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type Tag, type TagList, validateTag, validateTagList } from "../tag.js";
import { type SessionId, validateSessionId } from "./id.js";

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

/** Checks that a value is a {@link SessionTagRequest}. */
// prettier-ignore
export const validateSessionTagRequest: CompiledSchemaCheck<SessionTagRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionTagRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionTagRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.tag === undefined) && (missing0 = "tag"))){validateSessionTagRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "tag"))){validateSessionTagRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tag !== undefined){const _errs3: any = errors;if(!(validateTag.call(this, data.tag, {instancePath:instancePath+"/tag",parentData:data,parentDataProperty:"tag",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTag.errors : vErrors.concat(validateTag.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionTagRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionTagRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionTagRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionTagListResponse}. */
// prettier-ignore
export const validateSessionTagListResponse: CompiledSchemaCheck<SessionTagListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionTagListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionTagListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.tags === undefined) && (missing0 = "tags")){validateSessionTagListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "tags")){validateSessionTagListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.tags !== undefined){let data0: any = data.tags;if(!(validateTagList.call(this, data0, {instancePath:instancePath+"/tags",parentData:data,parentDataProperty:"tags",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTagList.errors : vErrors.concat(validateTagList.errors);errors = vErrors.length;}else {if(wireByteLength(data0, this && this.attachments) > 991808){validateSessionTagListResponse.errors = [{instancePath:instancePath+"/tags",schemaPath:"#/properties/tags/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}}}}}}else {validateSessionTagListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionTagListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionTagListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
