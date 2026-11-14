// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The daemon's callback tools as the allowlist picker reads them.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";

/**
 * One callback tool. `name` is the name a provider sees; `label` is the words a person reads, the
 * one label the picker and the transcript both draw, and a tool without one is drawn as its name
 * in sentence case.
 */
export interface CallbackToolEntry {
  /**
   * The name a provider sees.
   */
  name: string;
  /**
   * The words a person reads.
   */
  label?: string;
  /**
   * What the tool does.
   */
  description: string;
}
/**
 * The daemon's callback tools.
 */
export interface AgentCallbackToolListResponse {
  /**
   * The tools.
   */
  tools: CallbackToolEntry[];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link CallbackToolEntry}. */
// prettier-ignore
export const validateCallbackToolEntry: CompiledSchemaCheck<CallbackToolEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CallbackToolEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCallbackToolEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.name === undefined) && (missing0 = "name")) || ((data.description === undefined) && (missing0 = "description"))){validateCallbackToolEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "name") || (key0 === "label")) || (key0 === "description"))){validateCallbackToolEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateCallbackToolEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 128){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateCallbackToolEntry.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data2: any = data.description;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 16384){validateCallbackToolEntry.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}}else {validateCallbackToolEntry.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateCallbackToolEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCallbackToolEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCallbackToolEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCallbackToolListResponse}. */
// prettier-ignore
export const validateAgentCallbackToolListResponse: CompiledSchemaCheck<AgentCallbackToolListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCallbackToolListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCallbackToolListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.tools === undefined) && (missing0 = "tools")){validateAgentCallbackToolListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "tools")){validateAgentCallbackToolListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.tools !== undefined){let data0: any = data.tools;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateCallbackToolEntry.call(this, data0[i0], {instancePath:instancePath+"/tools/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCallbackToolEntry.errors : vErrors.concat(validateCallbackToolEntry.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateAgentCallbackToolListResponse.errors = [{instancePath:instancePath+"/tools",schemaPath:"#/properties/tools/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateAgentCallbackToolListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCallbackToolListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCallbackToolListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link CALLBACK_TOOL_METHOD_DESCRIPTORS}, each with its checks. */
export interface CallbackToolMethodDescriptors {
  readonly "agent.callbackTool.list": {
    readonly method: "agent.callbackTool.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<AgentCallbackToolListResponse>;
  };
}
/** The `agent.callbackTool.*` methods. */
export const CALLBACK_TOOL_METHOD_DESCRIPTORS: CallbackToolMethodDescriptors = Object.freeze({
  "agent.callbackTool.list": Object.freeze({
    method: "agent.callbackTool.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateAgentCallbackToolListResponse,
  }),
});
