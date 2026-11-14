// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The hosted account's procedures on the control plane: deleting it and exporting what the control plane keeps for the person.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { type DeviceEntry, validateDeviceEntry } from "./device.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import { type UserId, validateUserId } from "./session/id.js";

/**
 * The account's own record, as the control plane keeps it.
 */
export interface AccountRecord {
  /**
   * The person.
   */
  userId: UserId;
  /**
   * When the account was made.
   */
  createdAt: WireInstant;
  /**
   * The person's display name.
   */
  displayName: string;
}
/**
 * The account record and its device list; reading them changes nothing.
 */
export interface AccountExportResponse {
  /**
   * The account.
   */
  account: AccountRecord;
  /**
   * Its devices.
   */
  devices: DeviceEntry[];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link AccountRecord}. */
// prettier-ignore
export const validateAccountRecord: CompiledSchemaCheck<AccountRecord> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AccountRecord {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAccountRecord.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.userId === undefined) && (missing0 = "userId")) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.displayName === undefined) && (missing0 = "displayName"))){validateAccountRecord.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "userId") || (key0 === "createdAt")) || (key0 === "displayName"))){validateAccountRecord.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.userId !== undefined){const _errs2: any = errors;if(!(validateUserId.call(this, data.userId, {instancePath:instancePath+"/userId",parentData:data,parentDataProperty:"userId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserId.errors : vErrors.concat(validateUserId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data2: any = data.displayName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) < 1){validateAccountRecord.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateAccountRecord.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateAccountRecord.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAccountRecord.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAccountRecord.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAccountRecord.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AccountExportResponse}. */
// prettier-ignore
export const validateAccountExportResponse: CompiledSchemaCheck<AccountExportResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AccountExportResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAccountExportResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.account === undefined) && (missing0 = "account")) || ((data.devices === undefined) && (missing0 = "devices"))){validateAccountExportResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "account") || (key0 === "devices"))){validateAccountExportResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.account !== undefined){const _errs2: any = errors;if(!(validateAccountRecord.call(this, data.account, {instancePath:instancePath+"/account",parentData:data,parentDataProperty:"account",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAccountRecord.errors : vErrors.concat(validateAccountRecord.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.devices !== undefined){let data1: any = data.devices;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateDeviceEntry.call(this, data1[i0], {instancePath:instancePath+"/devices/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceEntry.errors : vErrors.concat(validateDeviceEntry.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateAccountExportResponse.errors = [{instancePath:instancePath+"/devices",schemaPath:"#/properties/devices/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAccountExportResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAccountExportResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAccountExportResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link ACCOUNT_METHOD_DESCRIPTORS}, each with its checks. */
export interface AccountMethodDescriptors {
  readonly "account.delete": {
    readonly method: "account.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "account.export": {
    readonly method: "account.export";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<AccountExportResponse>;
  };
}
/** The hosted account's procedures the control plane serves. */
export const ACCOUNT_METHOD_DESCRIPTORS: AccountMethodDescriptors = Object.freeze({
  "account.delete": Object.freeze({
    method: "account.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
  "account.export": Object.freeze({
    method: "account.export",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateAccountExportResponse,
  }),
});
