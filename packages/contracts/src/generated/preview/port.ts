// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The ports a machine shares with the person's other devices, and the `preview.port*` methods.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  ucs2length,
} from "../../schema-check.js";
import {
  type Port,
  type WireInstant,
  validatePort,
  validateWireInstant,
} from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";

/** A port added to the shared list that is on it already; nothing changes. */
export const PREVIEW_PORT_SHARE_ALREADY_EXISTS_CODE = "preview.portShare.alreadyExists" as const;

/** A forward or a web ticket asked for a port that is not on the shared list. */
export const PREVIEW_PORT_NOT_SHARED_CODE = "preview.port.notShared" as const;

/**
 * The details both port refusals carry: the port the request named.
 */
export interface PreviewPortRefusalDetails {
  /**
   * The port.
   */
  port: Port;
}
/**
 * One shared port with what the machine knows of it: the framework discovery named, `null` where
 * it named none, and whether anything listens on it yet. A port may be shared before its server
 * starts.
 */
export interface PreviewSharedPort {
  /**
   * The port.
   */
  port: Port;
  /**
   * The framework discovery named.
   */
  framework: string | null;
  /**
   * Whether anything listens on it.
   */
  listening: boolean;
  /**
   * When it was shared.
   */
  addedAt: WireInstant;
}
/**
 * One frame of the shared-ports list: every shared port, in the order they were added. The stream
 * sends the newest list once the reader has room, never a queue of the lists between.
 */
export interface PreviewPortShareListFrame {
  /**
   * The shared ports.
   */
  ports: PreviewSharedPort[];
}
/**
 * Names one port: share it, stop sharing it, or issue the web address's ticket for it.
 */
export interface PreviewPortRequest {
  /**
   * The port.
   */
  port: Port;
}
/**
 * The port now shared, and when.
 */
export interface PreviewPortShareAddResponse {
  /**
   * The port.
   */
  port: Port;
  /**
   * When it was shared.
   */
  addedAt: WireInstant;
}
/**
 * The port is no longer shared and every forward open on it is closed. Removing a port that is
 * not shared answers the same.
 */
export interface PreviewPortShareRemoveResponse {
  /**
   * The port.
   */
  port: Port;
  /**
   * Always `true`.
   */
  removed: true;
}
/**
 * The shared port's own web address for a browser tab, carrying a one-time ticket good for 60
 * seconds that the machine trades for a cookie scoped to the address.
 */
export interface PreviewPortTicketIssueResponse {
  /**
   * The address, always `https:`.
   */
  address: string;
}

/** Checks that a value is a {@link PreviewPortRefusalDetails}. */
// prettier-ignore
export const validatePreviewPortRefusalDetails: CompiledSchemaCheck<PreviewPortRefusalDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortRefusalDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortRefusalDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.port === undefined) && (missing0 = "port")){validatePreviewPortRefusalDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "port")){validatePreviewPortRefusalDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}}}}}else {validatePreviewPortRefusalDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortRefusalDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPortRefusalDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema900: any = {"type":"object","additionalProperties":false,"properties":{"port":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Port","description":"The port."},"framework":{"type":["string","null"],"minLength":1,"description":"The framework discovery named."},"listening":{"type":"boolean","description":"Whether anything listens on it."},"addedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was shared."}},"required":["port","framework","listening","addedAt"],"description":"One shared port with what the machine knows of it: the framework discovery named, `null` where\nit named none, and whether anything listens on it yet. A port may be shared before its server\nstarts."};
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link PreviewSharedPort}. */
// prettier-ignore
export const validatePreviewSharedPort: CompiledSchemaCheck<PreviewSharedPort> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSharedPort {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewSharedPort.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.port === undefined) && (missing0 = "port")) || ((data.framework === undefined) && (missing0 = "framework"))) || ((data.listening === undefined) && (missing0 = "listening"))) || ((data.addedAt === undefined) && (missing0 = "addedAt"))){validatePreviewSharedPort.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "port") || (key0 === "framework")) || (key0 === "listening")) || (key0 === "addedAt"))){validatePreviewSharedPort.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){const _errs2: any = errors;if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.framework !== undefined){let data1: any = data.framework;const _errs3: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validatePreviewSharedPort.errors = [{instancePath:instancePath+"/framework",schemaPath:"#/properties/framework/type",keyword:"type",params:{type: schema900.properties.framework.type}}];return false;}if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validatePreviewSharedPort.errors = [{instancePath:instancePath+"/framework",schemaPath:"#/properties/framework/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.listening !== undefined){const _errs5: any = errors;if(typeof data.listening !== "boolean"){validatePreviewSharedPort.errors = [{instancePath:instancePath+"/listening",schemaPath:"#/properties/listening/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.addedAt !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.addedAt, {instancePath:instancePath+"/addedAt",parentData:data,parentDataProperty:"addedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validatePreviewSharedPort.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewSharedPort.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewSharedPort.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPortShareListFrame}. */
// prettier-ignore
export const validatePreviewPortShareListFrame: CompiledSchemaCheck<PreviewPortShareListFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortShareListFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortShareListFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.ports === undefined) && (missing0 = "ports")){validatePreviewPortShareListFrame.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "ports")){validatePreviewPortShareListFrame.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ports !== undefined){let data0: any = data.ports;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePreviewSharedPort.call(this, data0[i0], {instancePath:instancePath+"/ports/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewSharedPort.errors : vErrors.concat(validatePreviewSharedPort.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePreviewPortShareListFrame.errors = [{instancePath:instancePath+"/ports",schemaPath:"#/properties/ports/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validatePreviewPortShareListFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortShareListFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPortShareListFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPortRequest}. */
// prettier-ignore
export const validatePreviewPortRequest: CompiledSchemaCheck<PreviewPortRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.port === undefined) && (missing0 = "port")){validatePreviewPortRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "port")){validatePreviewPortRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}}}}}else {validatePreviewPortRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPortRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPortShareAddResponse}. */
// prettier-ignore
export const validatePreviewPortShareAddResponse: CompiledSchemaCheck<PreviewPortShareAddResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortShareAddResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortShareAddResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.port === undefined) && (missing0 = "port")) || ((data.addedAt === undefined) && (missing0 = "addedAt"))){validatePreviewPortShareAddResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "port") || (key0 === "addedAt"))){validatePreviewPortShareAddResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){const _errs2: any = errors;if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.addedAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.addedAt, {instancePath:instancePath+"/addedAt",parentData:data,parentDataProperty:"addedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPortShareAddResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortShareAddResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPortShareAddResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPortShareRemoveResponse}. */
// prettier-ignore
export const validatePreviewPortShareRemoveResponse: CompiledSchemaCheck<PreviewPortShareRemoveResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortShareRemoveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortShareRemoveResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.port === undefined) && (missing0 = "port")) || ((data.removed === undefined) && (missing0 = "removed"))){validatePreviewPortShareRemoveResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "port") || (key0 === "removed"))){validatePreviewPortShareRemoveResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){const _errs2: any = errors;if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.removed !== undefined){let data1: any = data.removed;const _errs3: any = errors;if(typeof data1 !== "boolean"){validatePreviewPortShareRemoveResponse.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validatePreviewPortShareRemoveResponse.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPortShareRemoveResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortShareRemoveResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPortShareRemoveResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link PreviewPortTicketIssueResponse}. */
// prettier-ignore
export const validatePreviewPortTicketIssueResponse: CompiledSchemaCheck<PreviewPortTicketIssueResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortTicketIssueResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortTicketIssueResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.address === undefined) && (missing0 = "address")){validatePreviewPortTicketIssueResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "address")){validatePreviewPortTicketIssueResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.address !== undefined){let data0: any = data.address;const _errs2: any = errors;if(errors === _errs2){if(errors === _errs2){if(typeof data0 === "string"){if(!pattern33.test(data0)){validatePreviewPortTicketIssueResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data0))){validatePreviewPortTicketIssueResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/format",keyword:"format",params:{format: "https-url"}}];return false;}}}else {validatePreviewPortTicketIssueResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}}else {validatePreviewPortTicketIssueResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortTicketIssueResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPortTicketIssueResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link PREVIEW_PORT_METHOD_DESCRIPTORS}, each with its checks. */
export interface PreviewPortMethodDescriptors {
  readonly "preview.portShare.subscribe": {
    readonly method: "preview.portShare.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<PreviewPortShareListFrame>;
  };
  readonly "preview.portShare.add": {
    readonly method: "preview.portShare.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPortRequest>;
    readonly responseCheck: SchemaCheck<PreviewPortShareAddResponse>;
  };
  readonly "preview.portShare.remove": {
    readonly method: "preview.portShare.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPortRequest>;
    readonly responseCheck: SchemaCheck<PreviewPortShareRemoveResponse>;
  };
  readonly "preview.portTicket.issue": {
    readonly method: "preview.portTicket.issue";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPortRequest>;
    readonly responseCheck: SchemaCheck<PreviewPortTicketIssueResponse>;
  };
}
/** The `preview.port*` methods the daemon answers. */
export const PREVIEW_PORT_METHOD_DESCRIPTORS: PreviewPortMethodDescriptors = Object.freeze({
  "preview.portShare.subscribe": Object.freeze({
    method: "preview.portShare.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validatePreviewPortShareListFrame,
  }),
  "preview.portShare.add": Object.freeze({
    method: "preview.portShare.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPortRequest,
    responseCheck: validatePreviewPortShareAddResponse,
  }),
  "preview.portShare.remove": Object.freeze({
    method: "preview.portShare.remove",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPortRequest,
    responseCheck: validatePreviewPortShareRemoveResponse,
  }),
  "preview.portTicket.issue": Object.freeze({
    method: "preview.portTicket.issue",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPortRequest,
    responseCheck: validatePreviewPortTicketIssueResponse,
  }),
});
