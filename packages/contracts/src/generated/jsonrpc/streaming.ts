// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The wire shapes of a streaming subscription: `$/subscription/notify`, `$/subscription/end` and `$/subscription/cancel`, and the acknowledgment every `*.subscribe` method answers with. A subscription holds only its place, never a queue, so its frames drop nothing a consumer cannot read back.

import type { SchemaCheck } from "../../schema-check.js";
import type { JsonRpcError } from "./message.js";

/**
 * The daemon-to-client notification carrying one subscription value. The `$/` prefix marks a
 * system method outside the user namespace; the daemon registers no handler for it.
 */
export const SUBSCRIPTION_NOTIFY_METHOD = "$/subscription/notify" as const;

/**
 * The call a client sends to tear down a subscription. The daemon answers it as a read, so a
 * client can still clean up after a failed version handshake.
 */
export const SUBSCRIPTION_CANCEL_METHOD = "$/subscription/cancel" as const;

/**
 * The daemon-to-client notification that ends one subscription from the daemon's side: the
 * last frame for that id. A subscription the client cancels, or whose connection closes,
 * gets none.
 */
export const SUBSCRIPTION_END_METHOD = "$/subscription/end" as const;

/**
 * The most changes one frame carries. The daemon coalesces a stream's changes into one frame
 * per short window or this many changes, whichever comes first.
 */
export const STREAM_FRAME_MAX_CHANGES = 50 as const;

/**
 * The most events a stream over a stored record may stand behind the record's head when its
 * next frame is read; past it the stream is sent the behind frame and moved to the head.
 */
export const STREAM_BEHIND_MAX_EVENTS = 1024 as const;

/**
 * The most bytes of stored events, 1 MB, a stream over a stored record may stand behind the
 * record's head when its next frame is read; past it the stream is sent the behind frame.
 */
export const STREAM_BEHIND_MAX_BYTES = 1000000 as const;

/**
 * The opaque id of one subscription, a UUID the daemon mints.
 */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };
/**
 * The params of an end frame: `completed` when the stream finished, or `refused` with the error
 * the daemon ended it for.
 */
export type SubscriptionEndParams =
  | {
      reason: "completed";
      /**
       * The subscription that ended.
       */
      subscriptionId: SubscriptionId;
    }
  | {
      reason: "refused";
      /**
       * The subscription that ended.
       */
      subscriptionId: SubscriptionId;
      /**
       * Why it ended.
       */
      error: JsonRpcError;
    };

/**
 * The acknowledgment every `*.subscribe` method answers with: the id the daemon allocated.
 * Values follow as notify frames, and the acknowledgment settles before any of them.
 */
export interface SubscribeAcknowledgmentResponse {
  /**
   * The subscription's id, which routes its notify frames.
   */
  subscriptionId: SubscriptionId;
}
/**
 * The params of a notify frame: the id that routes it and one value the stream produced.
 */
export interface SubscriptionNotifyParams {
  /**
   * The subscription the value belongs to.
   */
  subscriptionId: SubscriptionId;
  /**
   * The value.
   */
  value: unknown;
}
/**
 * The params of a cancel call. It is a request, so the client learns from its result whether it
 * worked; only the connection that owns a subscription can cancel it.
 */
export interface SubscriptionCancelRequest {
  /**
   * The subscription to cancel.
   */
  subscriptionId: SubscriptionId;
}
/**
 * The result of a cancel call. `canceled` is false when the id is unknown or another
 * connection's; the two are not told apart, so one connection cannot probe for another's.
 */
export interface SubscriptionCancelResponse {
  /**
   * Whether the subscription was canceled.
   */
  canceled: boolean;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1032(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubscribeAcknowledgmentResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1032.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.subscriptionId === undefined) && (missing0 = "subscriptionId")){validate1032.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "subscriptionId")){validate1032.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.subscriptionId !== undefined){let data0: any = data.subscriptionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1032.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1032.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1032.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1032.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1032.errors = null as any[] | null;
// prettier-ignore
validate1032.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1033(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubscriptionCancelResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1033.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.canceled === undefined) && (missing0 = "canceled")){validate1033.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "canceled")){validate1033.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.canceled !== undefined){if(typeof data.canceled !== "boolean"){validate1033.errors = [{instancePath:instancePath+"/canceled",schemaPath:"#/properties/canceled/type",keyword:"type",params:{type: "boolean"}}];return false;}}}}}else {validate1033.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1033.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1033.errors = null as any[] | null;
// prettier-ignore
validate1033.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
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
function validate1035(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1035.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.code === undefined) && (missing0 = "code")) || ((data.message === undefined) && (missing0 = "message"))){validate1035.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "code") || (key0 === "message")) || (key0 === "data"))){validate1035.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.code !== undefined){let data0: any = data.code;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1035.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1035.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < -9007199254740991 || isNaN(data0)){validate1035.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.message !== undefined){const _errs4: any = errors;if(typeof data.message !== "string"){validate1035.errors = [{instancePath:instancePath+"/message",schemaPath:"#/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.data !== undefined){const _errs6: any = errors;if(!(validate1022.call(this, data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1022.errors : vErrors.concat(validate1022.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1035.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1035.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1035.errors = null as any[] | null;
// prettier-ignore
validate1035.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1034(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubscriptionEndParams {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1034.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.reason;if(typeof tag0 == "string"){if(tag0 === "completed"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.reason === undefined) && (missing0 = "reason")) || ((data.subscriptionId === undefined) && (missing0 = "subscriptionId"))){validate1034.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "reason") || (key0 === "subscriptionId"))){validate1034.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.reason !== undefined){let data0: any = data.reason;const _errs5: any = errors;if(typeof data0 !== "string"){validate1034.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("completed" !== data0){validate1034.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/const",keyword:"const",params:{allowedValue: "completed"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.subscriptionId !== undefined){let data1: any = data.subscriptionId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1034.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1034.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validate1034.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "refused"){const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.reason === undefined) && (missing1 = "reason")) || ((data.subscriptionId === undefined) && (missing1 = "subscriptionId"))) || ((data.error === undefined) && (missing1 = "error"))){validate1034.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data){if(!(((key1 === "reason") || (key1 === "subscriptionId")) || (key1 === "error"))){validate1034.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data.reason !== undefined){let data2: any = data.reason;const _errs14: any = errors;if(typeof data2 !== "string"){validate1034.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("refused" !== data2){validate1034.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/const",keyword:"const",params:{allowedValue: "refused"}}];return false;}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data.subscriptionId !== undefined){let data3: any = data.subscriptionId;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate1034.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1034.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data.error !== undefined){const _errs20: any = errors;if(!(validate1035.call(this, data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1035.errors : vErrors.concat(validate1035.errors);errors = vErrors.length;}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}}}}}}else {validate1034.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs11 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else {validate1034.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "reason", tagValue: tag0}}];return false;}}else {validate1034.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "reason", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate1034.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate1034.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1034.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1034.errors = null as any[] | null;
// prettier-ignore
validate1034.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1038(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubscriptionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1038.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1038.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1038.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1038.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1038.errors = null as any[] | null;
// prettier-ignore
validate1038.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1039(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubscriptionNotifyParams {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1039.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.subscriptionId === undefined) && (missing0 = "subscriptionId")) || ((data.value === undefined) && (missing0 = "value"))){validate1039.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "subscriptionId") || (key0 === "value"))){validate1039.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.subscriptionId !== undefined){let data0: any = data.subscriptionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1039.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1039.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){const _errs6: any = errors;var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1039.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1039.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1039.errors = null as any[] | null;
// prettier-ignore
validate1039.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SubscribeAcknowledgmentResponse}. */
export const validateSubscribeAcknowledgmentResponse: SchemaCheck<SubscribeAcknowledgmentResponse> =
  validate1032;
/** Checks that a value is a {@link SubscriptionCancelResponse}. */
export const validateSubscriptionCancelResponse: SchemaCheck<SubscriptionCancelResponse> =
  validate1033;
/** Checks that a value is a {@link SubscriptionEndParams}. */
export const validateSubscriptionEndParams: SchemaCheck<SubscriptionEndParams> = validate1034;
/** Checks that a value is a {@link SubscriptionId}. */
export const validateSubscriptionId: SchemaCheck<SubscriptionId> = validate1038;
/** Checks that a value is a {@link SubscriptionNotifyParams}. */
export const validateSubscriptionNotifyParams: SchemaCheck<SubscriptionNotifyParams> = validate1039;
