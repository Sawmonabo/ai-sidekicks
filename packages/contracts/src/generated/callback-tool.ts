/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The daemon's callback tools as the allowlist picker reads them.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
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
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate274(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCallbackToolListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate274.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.tools === undefined) && (missing0 = "tools")){validate274.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "tools")){validate274.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.tools !== undefined){let data0: any = data.tools;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if(((data1.name === undefined) && (missing1 = "name")) || ((data1.description === undefined) && (missing1 = "description"))){validate274.errors = [{instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/CallbackToolEntry/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs7: any = errors;for(const key1 in data1){if(!(((key1 === "name") || (key1 === "label")) || (key1 === "description"))){validate274.errors = [{instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/CallbackToolEntry/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs7 === errors){if(data1.name !== undefined){let data2: any = data1.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/CallbackToolEntry/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/CallbackToolEntry/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/CallbackToolEntry/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/CallbackToolEntry/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs8 === errors;}else {var valid3: any = true;}if(valid3){if(data1.label !== undefined){let data3: any = data1.label;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 128){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/label",schemaPath:"#/$defs/CallbackToolEntry/properties/label/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/label",schemaPath:"#/$defs/CallbackToolEntry/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/label",schemaPath:"#/$defs/CallbackToolEntry/properties/label/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/label",schemaPath:"#/$defs/CallbackToolEntry/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}if(valid3){if(data1.description !== undefined){let data4: any = data1.description;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) > 16384){validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/description",schemaPath:"#/$defs/CallbackToolEntry/properties/description/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}}else {validate274.errors = [{instancePath:instancePath+"/tools/" + i0+"/description",schemaPath:"#/$defs/CallbackToolEntry/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}}}}}}else {validate274.errors = [{instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/CallbackToolEntry/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate274.errors = [{instancePath:instancePath+"/tools",schemaPath:"#/properties/tools/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate274.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate274.errors = vErrors;return errors === 0;}
// prettier-ignore
validate274.errors = null as any[] | null;
// prettier-ignore
validate274.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCallbackToolListResponse}. */
export const validateAgentCallbackToolListResponse: SchemaCheck<AgentCallbackToolListResponse> =
  validate274;

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
