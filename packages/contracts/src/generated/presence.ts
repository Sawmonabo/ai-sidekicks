// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Presence: which of the person's devices are connected to this machine, and whether an app window is in front on each.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import { type DeviceId, validateDeviceId } from "./trust-statement.js";

/** The longest device category, such as "desktop" or "mobile", in code points. */
export const DEVICE_TYPE_MAX_LEN = 64 as const;

/**
 * A device's report to a machine, sent when `appVisible` changes and otherwise every 15 seconds on
 * each machine connection the device holds. It names no device: the machine files it under the
 * device of the connection that carried it.
 */
export interface PresenceHeartbeatSendRequest {
  /**
   * The device's category.
   */
  deviceType: string;
  /**
   * An app window is in front on this device; a window behind a locked or sleeping screen is
   * not.
   */
  appVisible: boolean;
}
/**
 * One device connected to this machine: the last heartbeat the machine holds from it, under the
 * device that sent it.
 */
export interface ConnectedDevice {
  /**
   * The device.
   */
  deviceId: DeviceId;
  /**
   * Its category.
   */
  deviceType: string;
  /**
   * Whether an app window is in front on it.
   */
  appVisible: boolean;
}
/**
 * The devices connected to this machine: `presence.read`'s reply, and each value
 * `presence.subscribe` pushes when a device comes, goes or changes.
 */
export interface MachinePresence {
  /**
   * The devices.
   */
  devices: ConnectedDevice[];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link PresenceHeartbeatSendRequest}. */
// prettier-ignore
export const validatePresenceHeartbeatSendRequest: CompiledSchemaCheck<PresenceHeartbeatSendRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PresenceHeartbeatSendRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePresenceHeartbeatSendRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.deviceType === undefined) && (missing0 = "deviceType")) || ((data.appVisible === undefined) && (missing0 = "appVisible"))){validatePresenceHeartbeatSendRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "deviceType") || (key0 === "appVisible"))){validatePresenceHeartbeatSendRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deviceType !== undefined){let data0: any = data.deviceType;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 64){validatePresenceHeartbeatSendRequest.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(func1(data0) < 1){validatePresenceHeartbeatSendRequest.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validatePresenceHeartbeatSendRequest.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePresenceHeartbeatSendRequest.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVisible !== undefined){const _errs4: any = errors;if(typeof data.appVisible !== "boolean"){validatePresenceHeartbeatSendRequest.errors = [{instancePath:instancePath+"/appVisible",schemaPath:"#/properties/appVisible/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validatePresenceHeartbeatSendRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePresenceHeartbeatSendRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePresenceHeartbeatSendRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ConnectedDevice}. */
// prettier-ignore
export const validateConnectedDevice: CompiledSchemaCheck<ConnectedDevice> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ConnectedDevice {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateConnectedDevice.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.deviceId === undefined) && (missing0 = "deviceId")) || ((data.deviceType === undefined) && (missing0 = "deviceType"))) || ((data.appVisible === undefined) && (missing0 = "appVisible"))){validateConnectedDevice.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "deviceId") || (key0 === "deviceType")) || (key0 === "appVisible"))){validateConnectedDevice.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deviceId !== undefined){const _errs2: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceType !== undefined){let data1: any = data.deviceType;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 64){validateConnectedDevice.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(func1(data1) < 1){validateConnectedDevice.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateConnectedDevice.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateConnectedDevice.errors = [{instancePath:instancePath+"/deviceType",schemaPath:"#/properties/deviceType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVisible !== undefined){const _errs5: any = errors;if(typeof data.appVisible !== "boolean"){validateConnectedDevice.errors = [{instancePath:instancePath+"/appVisible",schemaPath:"#/properties/appVisible/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateConnectedDevice.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateConnectedDevice.errors = vErrors;return errors === 0;};
// prettier-ignore
validateConnectedDevice.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link MachinePresence}. */
// prettier-ignore
export const validateMachinePresence: CompiledSchemaCheck<MachinePresence> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachinePresence {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMachinePresence.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.devices === undefined) && (missing0 = "devices")){validateMachinePresence.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "devices")){validateMachinePresence.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.devices !== undefined){let data0: any = data.devices;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateConnectedDevice.call(this, data0[i0], {instancePath:instancePath+"/devices/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateConnectedDevice.errors : vErrors.concat(validateConnectedDevice.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateMachinePresence.errors = [{instancePath:instancePath+"/devices",schemaPath:"#/properties/devices/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateMachinePresence.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateMachinePresence.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMachinePresence.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link PRESENCE_METHOD_DESCRIPTORS}, each with its checks. */
export interface PresenceMethodDescriptors {
  readonly "presence.read": {
    readonly method: "presence.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<MachinePresence>;
  };
  readonly "presence.heartbeat.send": {
    readonly method: "presence.heartbeat.send";
    readonly procedureType: "mutation";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PresenceHeartbeatSendRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "presence.subscribe": {
    readonly method: "presence.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<MachinePresence>;
  };
}
/** The `presence.*` methods the daemon answers. */
export const PRESENCE_METHOD_DESCRIPTORS: PresenceMethodDescriptors = Object.freeze({
  "presence.read": Object.freeze({
    method: "presence.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateMachinePresence,
  }),
  "presence.heartbeat.send": Object.freeze({
    method: "presence.heartbeat.send",
    procedureType: "mutation",
    mutating: false,
    requestCheck: validatePresenceHeartbeatSendRequest,
    responseCheck: validateEmptyPayload,
  }),
  "presence.subscribe": Object.freeze({
    method: "presence.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateMachinePresence,
  }),
});
