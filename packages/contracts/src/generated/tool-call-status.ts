// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The status line under a running tool call: the provider's own words for its progress, live and keyed per call, never stored.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type ToolCallId, validateToolCallId } from "./provider/tool-call.js";
import { type SessionId, validateSessionId } from "./session/id.js";

/**
 * The longest status line, in code points: the size of the longest one-line text a provider
 * reports.
 */
export const TOOL_CALL_STATUS_MAX_LEN = 512 as const;

/**
 * The session whose tool calls' status lines an `agent.toolCall.status.subscribe` subscription
 * follows.
 */
export interface AgentToolCallStatusSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One tool call's status line.
 */
export interface ToolCallStatusUpdate {
  /**
   * The tool call.
   */
  toolCallId: ToolCallId;
  /**
   * The call's newest status line, or `null` once the call closed, after which the key sends
   * nothing more.
   */
  status: string | null;
}

/** Checks that a value is a {@link AgentToolCallStatusSubscribeRequest}. */
// prettier-ignore
export const validateAgentToolCallStatusSubscribeRequest: CompiledSchemaCheck<AgentToolCallStatusSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentToolCallStatusSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentToolCallStatusSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateAgentToolCallStatusSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateAgentToolCallStatusSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateAgentToolCallStatusSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentToolCallStatusSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentToolCallStatusSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1342: any = {"type":"object","additionalProperties":false,"properties":{"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The tool call."},"status":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":512,"description":"The call's newest status line, or `null` once the call closed, after which the key sends\nnothing more."}},"required":["toolCallId","status"],"description":"One tool call's status line."};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ToolCallStatusUpdate}. */
// prettier-ignore
export const validateToolCallStatusUpdate: CompiledSchemaCheck<ToolCallStatusUpdate> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ToolCallStatusUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateToolCallStatusUpdate.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.toolCallId === undefined) && (missing0 = "toolCallId")) || ((data.status === undefined) && (missing0 = "status"))){validateToolCallStatusUpdate.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "toolCallId") || (key0 === "status"))){validateToolCallStatusUpdate.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.toolCallId !== undefined){const _errs2: any = errors;if(!(validateToolCallId.call(this, data.toolCallId, {instancePath:instancePath+"/toolCallId",parentData:data,parentDataProperty:"toolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data1: any = data.status;const _errs3: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validateToolCallStatusUpdate.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/type",keyword:"type",params:{type: schema1342.properties.status.type}}];return false;}if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 512){validateToolCallStatusUpdate.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data1) < 1){validateToolCallStatusUpdate.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateToolCallStatusUpdate.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateToolCallStatusUpdate.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateToolCallStatusUpdate.errors = vErrors;return errors === 0;};
// prettier-ignore
validateToolCallStatusUpdate.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link TOOL_CALL_STATUS_METHOD_DESCRIPTORS}, each with its checks. */
export interface ToolCallStatusMethodDescriptors {
  readonly "agent.toolCall.status.subscribe": {
    readonly method: "agent.toolCall.status.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentToolCallStatusSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ToolCallStatusUpdate>;
  };
}
/** The status lines of a session's running tool calls. */
export const TOOL_CALL_STATUS_METHOD_DESCRIPTORS: ToolCallStatusMethodDescriptors = Object.freeze({
  "agent.toolCall.status.subscribe": Object.freeze({
    method: "agent.toolCall.status.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentToolCallStatusSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateToolCallStatusUpdate,
  }),
});
