// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// JSON-RPC 2.0 messages shared by the daemon and its clients: the kinds of message, the error a response carries, the bound on a request's id, the calls a connection holds in flight and why a request's protocol version is refused.

import type { SchemaCheck } from "../../schema-check.js";
import type { RefusalCategory } from "./refusal.js";

/** The `jsonrpc` member every message carries. */
export const JSONRPC_VERSION = "2.0" as const;

/**
 * The largest JSON-RPC `id`, in bytes once JSON-encoded (a UUID id is 38). A response echoes
 * its request's `id`, so the gateway refuses a longer one before dispatch.
 */
export const JSON_RPC_ID_MAX_BYTES = 256 as const;

/**
 * The most calls one connection holds in flight; a call past it is refused at once with
 * `connection.call.limitReached`, and a client holds its calls past it, sending each as a
 * slot frees. A subscription cancel, a stop and a terminal write take no slot. It changes only
 * with a new dated protocol version, so a conforming client is never refused.
 */
export const MAX_CALLS_IN_FLIGHT = 100 as const;

/**
 * The refusal a client reports when the daemon cannot be reached: nothing listens on its
 * socket, or the link to it is down; `fields.reason` says why.
 */
export const CONNECTION_UNAVAILABLE_CODE = "connection.unavailable" as const;

/**
 * A request's `id`: a string, a number or `null`, echoed back by its response.
 */
export type JsonRpcId = string | number | null;
/**
 * A response: a success or an error, never both.
 */
export type JsonRpcResponseEnvelope = JsonRpcResponse | JsonRpcErrorResponse;
/**
 * One JSON-RPC 2.0 message: a request, a notification or a response.
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponseEnvelope;
/**
 * What a client receives from the daemon: a response or a notification, and nothing else.
 */
export type JsonRpcServerMessage = JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification;
/**
 * Why a socket cannot reach the daemon, the `fields.reason` of `connection.unavailable`.
 */
export type ConnectionUnavailableReason = "notListening" | "accessDenied" | "unreachable";
/**
 * Why a request's `protocolVersion` is refused, the `fields.reason` of
 * `request.protocolVersion.invalid`.
 */
export type ProtocolVersionInvalidReason = "missing" | "wrongType" | "invalidFormat";
/**
 * A refused value's JSON type, named so the value itself is never echoed: `object` for an object
 * or an array.
 */
export type ObservedType = "null" | "object" | "boolean" | "number" | "string";

/**
 * The `data` of an error: the refusal's code, its category and its structured detail, which
 * producers keep free of stack traces, absolute paths and secrets.
 */
export interface JsonRpcErrorData {
  /**
   * The refusal's code; clients branch on it, never on the message.
   */
  type: string;
  /**
   * The refusal's category, which a client acts on for a code it does not know.
   */
  category: RefusalCategory;
  /**
   * The refusal's detail.
   */
  fields?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * An error response's `error`.
 */
export interface JsonRpcError {
  /**
   * The numeric code that frames the error.
   */
  code: number;
  /**
   * A sentence for a person, sanitized before it leaves the daemon.
   */
  message: string;
  /**
   * The refusal's code and detail.
   */
  data?: JsonRpcErrorData;
}
/**
 * A JSON-RPC 2.0 request: a call that gets exactly one response. `protocolVersion` is absent
 * only on `connection.initialize`.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
  protocolVersion?: string;
}
/**
 * A JSON-RPC 2.0 notification: a call with no `id`, which gets no response.
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
/**
 * A JSON-RPC 2.0 success response; `id` is its request's.
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}
/**
 * A JSON-RPC 2.0 error response; `id` is `null` where the request's id could not be read.
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}
/**
 * The `request.protocolVersion.invalid` refusal's `data.fields`: why, and for a wrong type the
 * value's JSON type, never the value.
 */
export interface ProtocolVersionInvalidDetails {
  /**
   * Why the member is refused.
   */
  reason: ProtocolVersionInvalidReason;
  /**
   * The member's JSON type, present only when `reason` is `wrongType`.
   */
  observedType?: ObservedType;
}

// prettier-ignore
function validate1018(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1018.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.jsonrpc === undefined) && (missing0 = "jsonrpc")) || ((data.id === undefined) && (missing0 = "id"))) || ((data.result === undefined) && (missing0 = "result"))){validate1018.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "jsonrpc") || (key0 === "id")) || (key0 === "result"))){validate1018.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jsonrpc !== undefined){const _errs2: any = errors;if("2.0" !== data.jsonrpc){validate1018.errors = [{instancePath:instancePath+"/jsonrpc",schemaPath:"#/properties/jsonrpc/const",keyword:"const",params:{allowedValue: "2.0"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs3: any = errors;const _errs5: any = errors;let valid2: any = false;const _errs6: any = errors;if(typeof data1 !== "string"){const err0: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs6 === errors;valid2 = valid2 || _valid0;const _errs8: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){const err1: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf/1/type",keyword:"type",params:{type: "number"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs8 === errors;valid2 = valid2 || _valid0;const _errs10: any = errors;if(data1 !== null){const err2: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf/2/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs10 === errors;valid2 = valid2 || _valid0;if(!valid2){const err3: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1018.errors = vErrors;return false;}else {errors = _errs5;if(vErrors !== null){if(_errs5){vErrors.length = _errs5;}else {vErrors = null;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1018.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1018.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1018.errors = null as any[] | null;
// prettier-ignore
validate1018.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1949: any = {"description":"The categories this build knows: the canonical gRPC status codes.","type":"string","enum":["invalidArgument","notFound","alreadyExists","failedPrecondition","aborted","unauthenticated","permissionDenied","resourceExhausted","unavailable","unimplemented","deadlineExceeded","canceled","internal"]};
// prettier-ignore
function validate1024(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1024.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"#/$defs/KnownRefusalCategory/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!(((((((((((((data === "invalidArgument") || (data === "notFound")) || (data === "alreadyExists")) || (data === "failedPrecondition")) || (data === "aborted")) || (data === "unauthenticated")) || (data === "permissionDenied")) || (data === "resourceExhausted")) || (data === "unavailable")) || (data === "unimplemented")) || (data === "deadlineExceeded")) || (data === "canceled")) || (data === "internal"))){const err1: any = {instancePath,schemaPath:"#/$defs/KnownRefusalCategory/enum",keyword:"enum",params:{allowedValues: schema1949.enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs4: any = errors;if(typeof data !== "string"){const err2: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(!valid0){const err3: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1024.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1024.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1024.errors = null as any[] | null;
// prettier-ignore
validate1024.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1022(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1022.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.type === undefined) && (missing0 = "type")) || ((data.category === undefined) && (missing0 = "category"))){validate1022.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "type") || (key0 === "category")) || (key0 === "fields"))){validate1022.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.type !== undefined){const _errs2: any = errors;if(typeof data.type !== "string"){validate1022.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs4: any = errors;if(!(validate1024.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1024.errors : vErrors.concat(validate1024.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.fields !== undefined){let data2: any = data.fields;const _errs5: any = errors;if(errors === _errs5){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){for(const key1 in data2){const _errs7: any = errors;const _errs8: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs8 === errors;if(valid2){const _errs10: any = errors;const _errs11: any = errors;const _errs12: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs12 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}var valid2: any = _errs10 === errors;}var valid1: any = _errs7 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1022.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data2){const _errs14: any = errors;var valid4: any = _errs14 === errors;if(!valid4){break;}}}}else {validate1022.errors = [{instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validate1022.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1022.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1022.errors = null as any[] | null;
// prettier-ignore
validate1022.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1021(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1021.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.code === undefined) && (missing0 = "code")) || ((data.message === undefined) && (missing0 = "message"))){validate1021.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "code") || (key0 === "message")) || (key0 === "data"))){validate1021.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.code !== undefined){let data0: any = data.code;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1021.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1021.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < -9007199254740991 || isNaN(data0)){validate1021.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){const _errs4: any = errors;if(typeof data.message !== "string"){validate1021.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.data !== undefined){const _errs6: any = errors;if(!(validate1022.call(this, data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1022.errors : vErrors.concat(validate1022.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1021.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1021.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1021.errors = null as any[] | null;
// prettier-ignore
validate1021.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1020(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1020.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.jsonrpc === undefined) && (missing0 = "jsonrpc")) || ((data.id === undefined) && (missing0 = "id"))) || ((data.error === undefined) && (missing0 = "error"))){validate1020.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "jsonrpc") || (key0 === "id")) || (key0 === "error"))){validate1020.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.jsonrpc !== undefined){const _errs2: any = errors;if("2.0" !== data.jsonrpc){validate1020.errors = [{instancePath:instancePath+"/jsonrpc",schemaPath:"#/properties/jsonrpc/const",keyword:"const",params:{allowedValue: "2.0"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs3: any = errors;const _errs5: any = errors;let valid2: any = false;const _errs6: any = errors;if(typeof data1 !== "string"){const err0: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs6 === errors;valid2 = valid2 || _valid0;const _errs8: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){const err1: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf/1/type",keyword:"type",params:{type: "number"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs8 === errors;valid2 = valid2 || _valid0;const _errs10: any = errors;if(data1 !== null){const err2: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf/2/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs10 === errors;valid2 = valid2 || _valid0;if(!valid2){const err3: any = {instancePath:instancePath+"/id",schemaPath:"#/$defs/JsonRpcId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1020.errors = vErrors;return false;}else {errors = _errs5;if(vErrors !== null){if(_errs5){vErrors.length = _errs5;}else {vErrors = null;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.error !== undefined){const _errs12: any = errors;if(!(validate1021.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1021.errors : vErrors.concat(validate1021.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}else {validate1020.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1020.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1020.errors = null as any[] | null;
// prettier-ignore
validate1020.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1017(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is JsonRpcServerMessage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1017.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validate1018.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1018.errors : vErrors.concat(validate1018.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validate1020.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1020.errors : vErrors.concat(validate1020.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs3: any = errors;const _errs4: any = errors;if(errors === _errs4){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.jsonrpc === undefined) && (missing0 = "jsonrpc")) || ((data.method === undefined) && (missing0 = "method"))){const err0: any = {instancePath,schemaPath:"#/$defs/JsonRpcNotification/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs6: any = errors;for(const key0 in data){if(!(((key0 === "jsonrpc") || (key0 === "method")) || (key0 === "params"))){const err1: any = {instancePath,schemaPath:"#/$defs/JsonRpcNotification/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs6 === errors){if(data.jsonrpc !== undefined){const _errs7: any = errors;if("2.0" !== data.jsonrpc){const err2: any = {instancePath:instancePath+"/jsonrpc",schemaPath:"#/$defs/JsonRpcNotification/properties/jsonrpc/const",keyword:"const",params:{allowedValue: "2.0"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.method !== undefined){const _errs8: any = errors;if(typeof data.method !== "string"){const err3: any = {instancePath:instancePath+"/method",schemaPath:"#/$defs/JsonRpcNotification/properties/method/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {const err4: any = {instancePath,schemaPath:"#/$defs/JsonRpcNotification/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs3 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err5: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate1017.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1017.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1017.errors = null as any[] | null;
// prettier-ignore
validate1017.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link JsonRpcServerMessage}. */
export const validateJsonRpcServerMessage: SchemaCheck<JsonRpcServerMessage> = validate1017;
