// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The push contract: a machine hands the control plane one sealed notice for one of the person's devices, sealed to the device's own push key.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import type { DeviceId } from "./trust-statement.js";

/** The most sealed bytes one push carries: every platform's 4 KB payload limit. */
export const PUSH_SEALED_NOTICE_MAX_BYTES = 4096 as const;

/** Every [`PushUrgency`]. */
export const PUSH_URGENCIES = ["high", "normal"] as const;

/**
 * How soon the push service delivers a notice: `Waiting on you` and a workflow's Notify step go
 * at `high`; `Finished` and `Failed` at `normal`.
 */
export type PushUrgency = "high" | "normal";
/**
 * The id a later notice for the same moment replaces an earlier one under: 1 to 32 base64url
 * characters, which fits Web Push's `Topic` header, the tightest of the three platforms.
 */
export type PushCollapseId = string;

/**
 * One sealed push. Every push expires 24 hours after its moment.
 */
export interface DevicePushSendRequest {
  /**
   * The device the notice is for.
   */
  deviceId: DeviceId;
  /**
   * The notice, sealed to the device's push key.
   */
  sealed: string;
  /**
   * Derived from the moment's stable id.
   */
  collapseId: PushCollapseId;
  /**
   * How soon to deliver it.
   */
  urgency: PushUrgency;
  /**
   * When the push services drop it undelivered.
   */
  expiresAt: WireInstant;
}

// prettier-ignore
const schema2984: any = {"description":"How soon the push service delivers a notice: `Waiting on you` and a workflow's Notify step go\nat `high`; `Finished` and `Failed` at `normal`.","type":"string","enum":["high","normal"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern2001 = new RegExp("==$", "u");
// prettier-ignore
const pattern436 = new RegExp("^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$", "u");
// prettier-ignore
const pattern2003 = new RegExp("^[A-Za-z0-9_-]{1,32}$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1605(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DevicePushSendRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1605.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.deviceId === undefined) && (missing0 = "deviceId")) || ((data.sealed === undefined) && (missing0 = "sealed"))) || ((data.collapseId === undefined) && (missing0 = "collapseId"))) || ((data.urgency === undefined) && (missing0 = "urgency"))) || ((data.expiresAt === undefined) && (missing0 = "expiresAt"))){validate1605.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "deviceId") || (key0 === "sealed")) || (key0 === "collapseId")) || (key0 === "urgency")) || (key0 === "expiresAt"))){validate1605.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deviceId !== undefined){let data0: any = data.deviceId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1605.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate1605.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1605.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sealed !== undefined){let data1: any = data.sealed;const _errs6: any = errors;const _errs8: any = errors;let valid2: any = false;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(func1(data1) > 5460){const err0: any = {instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/anyOf/0/maxLength",keyword:"maxLength",params:{limit: 5460}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs9 === errors;valid2 = valid2 || _valid0;const _errs11: any = errors;if(errors === _errs11){if(typeof data1 === "string"){if(!pattern2001.test(data1)){const err2: any = {instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/anyOf/1/pattern",keyword:"pattern",params:{pattern: "==$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var _valid0: any = _errs11 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1605.errors = vErrors;return false;}else {errors = _errs8;if(vErrors !== null){if(_errs8){vErrors.length = _errs8;}else {vErrors = null;}}}if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 5464){validate1605.errors = [{instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/maxLength",keyword:"maxLength",params:{limit: 5464}}];return false;}else {if(func1(data1) < 1){validate1605.errors = [{instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern436.test(data1)){validate1605.errors = [{instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validate1605.errors = [{instancePath:instancePath+"/sealed",schemaPath:"#/properties/sealed/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.collapseId !== undefined){let data2: any = data.collapseId;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data2 === "string"){if(!pattern2003.test(data2)){validate1605.errors = [{instancePath:instancePath+"/collapseId",schemaPath:"#/$defs/PushCollapseId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9_-]{1,32}$"}}];return false;}}else {validate1605.errors = [{instancePath:instancePath+"/collapseId",schemaPath:"#/$defs/PushCollapseId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.urgency !== undefined){let data3: any = data.urgency;const _errs16: any = errors;if(typeof data3 !== "string"){validate1605.errors = [{instancePath:instancePath+"/urgency",schemaPath:"#/$defs/PushUrgency/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data3 === "high") || (data3 === "normal"))){validate1605.errors = [{instancePath:instancePath+"/urgency",schemaPath:"#/$defs/PushUrgency/enum",keyword:"enum",params:{allowedValues: schema2984.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.expiresAt !== undefined){let data4: any = data.expiresAt;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(!pattern5.test(data4)){validate1605.errors = [{instancePath:instancePath+"/expiresAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1605.errors = [{instancePath:instancePath+"/expiresAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1605.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1605.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1605.errors = null as any[] | null;
// prettier-ignore
validate1605.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DevicePushSendRequest}. */
export const validateDevicePushSendRequest: SchemaCheck<DevicePushSendRequest> = validate1605;

/** The methods of {@link PUSH_METHOD_DESCRIPTORS}, each with its checks. */
export interface PushMethodDescriptors {
  readonly "device.push.send": {
    readonly method: "device.push.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DevicePushSendRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The push procedure the control plane serves. */
export const PUSH_METHOD_DESCRIPTORS: PushMethodDescriptors = Object.freeze({
  "device.push.send": Object.freeze({
    method: "device.push.send",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDevicePushSendRequest,
    responseCheck: validateEmptyPayload,
  }),
});
