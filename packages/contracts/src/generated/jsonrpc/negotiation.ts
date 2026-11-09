// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `connection.initialize` handshake, `ConnectionInitializeRequest` and `ConnectionInitializeResponse`, shared by the daemon and its clients. A `protocolVersion` is an ISO 8601 `YYYY-MM-DD` date, so lexical order is chronological.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { DeviceId } from "../trust-statement.js";

/** The JSON-RPC method name of the negotiation handshake. */
export const CONNECTION_INITIALIZE_METHOD = "connection.initialize" as const;

/** The longest a free-form negotiation string (`clientId`, a capability tag) may be. */
export const NEGOTIATION_FIELD_MAX_LEN = 256 as const;

/** The most entries any protocol-version or capability list in the handshake may carry. */
export const SUPPORTED_PROTOCOLS_MAX_LEN = 32 as const;

/**
 * The protocol version this build speaks: the version a client offers in
 * `connection.initialize`, and the newest one the daemon accepts.
 */
export const CURRENT_PROTOCOL_VERSION = "2026-05-01" as const;

/**
 * The protocol versions this build speaks, newest last: its own, and the one before it once a
 * release has shipped one. The daemon accepts exactly these, and a client offers exactly
 * these in `connection.initialize`.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-05-01"] as const;

/** Ack reason: the client is too old for the daemon. */
export const NEGOTIATION_REASON_FLOOR_EXCEEDED = "connection.version.floorExceeded" as const;

/** Ack reason: the client is too new for the daemon. */
export const NEGOTIATION_REASON_CEILING_EXCEEDED = "connection.version.ceilingExceeded" as const;

/** Ack reason: this connection already completed a handshake. */
export const NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED =
  "connection.handshake.alreadyCompleted" as const;

/**
 * The refusal of a mutating call on a connection whose handshake answered
 * `compatible: false`.
 */
export const CONNECTION_VERSION_MISMATCH_CODE = "connection.version.mismatch" as const;

/**
 * The refusal of every call on a connection whose `connection.initialize` carried no session
 * token or the wrong one, the `connection.initialize` itself included.
 */
export const AUTH_TOKEN_INVALID_CODE = "auth.token.invalid" as const;

/**
 * The refusal of every call, whatever token it carried, on a connection opened by a process
 * the daemon started outside the person's terminals, or one the system could not name or
 * trace to its first process.
 */
export const AUTH_CALLER_REFUSED_CODE = "auth.callerRefused" as const;

/**
 * A protocol version: a `YYYY-MM-DD` date.
 */
export type ProtocolVersion = string;
/**
 * Why a handshake is incompatible. It rides in the ack, which is a successful response, not as a
 * JSON-RPC error.
 */
export type NegotiationIncompatibleReason =
  | "connection.version.floorExceeded"
  | "connection.version.ceilingExceeded"
  | "connection.handshake.alreadyCompleted";

/**
 * The `connection.initialize` request, the first call on a connection: the client's preferred
 * version, its full supported set (by default `[protocolVersion]`), and the daemon's session token
 * read from its token file.
 */
export interface ConnectionInitializeRequest {
  /**
   * The client's preferred version.
   */
  protocolVersion: ProtocolVersion;
  /**
   * Every version the client speaks.
   *
   * @minItems 1
   * @maxItems 32
   */
  supportedProtocols?: [ProtocolVersion, ...ProtocolVersion[]];
  /**
   * The client's name for itself.
   */
  clientId?: string;
  /**
   * The session token the daemon wrote to its token file at this start; its absence is
   * answered as a wrong one, `auth.token.invalid`.
   */
  sessionToken?: string;
  /**
   * The capability tags the client offers.
   *
   * @maxItems 32
   */
  capabilities?: string[];
}
/**
 * The `connection.initialize` result. When `compatible` is false only read-only calls are allowed,
 * and `protocolVersion` is the daemon's newest; `reason` and `daemonSupportedProtocols` appear
 * only on an incompatible first handshake.
 */
export interface ConnectionInitializeResponse {
  /**
   * Whether the client and the daemon share a version.
   */
  compatible: boolean;
  /**
   * The negotiated version, or the daemon's newest when incompatible.
   */
  protocolVersion: ProtocolVersion;
  /**
   * The connecting device's own id; for a local connection, the service's own.
   */
  deviceId: DeviceId;
  /**
   * Why the handshake is incompatible.
   */
  reason?: NegotiationIncompatibleReason;
  /**
   * The capability tags the daemon offers.
   *
   * @maxItems 32
   */
  serverCapabilities?: string[];
  /**
   * Every version the daemon speaks, on an incompatible first handshake.
   *
   * @maxItems 32
   */
  daemonSupportedProtocols?: ProtocolVersion[];
}

// prettier-ignore
const pattern1190 = new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1030(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ConnectionInitializeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1030.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.protocolVersion === undefined) && (missing0 = "protocolVersion")){validate1030.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "protocolVersion") || (key0 === "supportedProtocols")) || (key0 === "clientId")) || (key0 === "sessionToken")) || (key0 === "capabilities"))){validate1030.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.protocolVersion !== undefined){let data0: any = data.protocolVersion;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern1190.test(data0)){validate1030.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/$defs/ProtocolVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}}];return false;}}else {validate1030.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/$defs/ProtocolVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.supportedProtocols !== undefined){let data1: any = data.supportedProtocols;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data1)){if(data1.length > 32){validate1030.errors = [{instancePath:instancePath+"/supportedProtocols",schemaPath:"#/properties/supportedProtocols/maxItems",keyword:"maxItems",params:{limit: 32}}];return false;}else {if(data1.length < 1){validate1030.errors = [{instancePath:instancePath+"/supportedProtocols",schemaPath:"#/properties/supportedProtocols/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern1190.test(data2)){validate1030.errors = [{instancePath:instancePath+"/supportedProtocols/" + i0,schemaPath:"#/$defs/ProtocolVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}}];return false;}}else {validate1030.errors = [{instancePath:instancePath+"/supportedProtocols/" + i0,schemaPath:"#/$defs/ProtocolVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;if(!valid2){break;}}}}}else {validate1030.errors = [{instancePath:instancePath+"/supportedProtocols",schemaPath:"#/properties/supportedProtocols/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientId !== undefined){let data3: any = data.clientId;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 256){validate1030.errors = [{instancePath:instancePath+"/clientId",schemaPath:"#/properties/clientId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate1030.errors = [{instancePath:instancePath+"/clientId",schemaPath:"#/properties/clientId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1030.errors = [{instancePath:instancePath+"/clientId",schemaPath:"#/properties/clientId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionToken !== undefined){let data4: any = data.sessionToken;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) > 256){validate1030.errors = [{instancePath:instancePath+"/sessionToken",schemaPath:"#/properties/sessionToken/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate1030.errors = [{instancePath:instancePath+"/sessionToken",schemaPath:"#/properties/sessionToken/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1030.errors = [{instancePath:instancePath+"/sessionToken",schemaPath:"#/properties/sessionToken/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.capabilities !== undefined){let data5: any = data.capabilities;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data5)){if(data5.length > 32){validate1030.errors = [{instancePath:instancePath+"/capabilities",schemaPath:"#/properties/capabilities/maxItems",keyword:"maxItems",params:{limit: 32}}];return false;}else {var valid4: any = true;const len1: any = data5.length;for(let i1=0; i1<len1; i1++){let data6: any = data5[i1];const _errs16: any = errors;if(errors === _errs16){if(typeof data6 === "string"){if(func1(data6) > 256){validate1030.errors = [{instancePath:instancePath+"/capabilities/" + i1,schemaPath:"#/properties/capabilities/items/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validate1030.errors = [{instancePath:instancePath+"/capabilities/" + i1,schemaPath:"#/properties/capabilities/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1030.errors = [{instancePath:instancePath+"/capabilities/" + i1,schemaPath:"#/properties/capabilities/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;if(!valid4){break;}}}}else {validate1030.errors = [{instancePath:instancePath+"/capabilities",schemaPath:"#/properties/capabilities/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1030.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1030.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1030.errors = null as any[] | null;
// prettier-ignore
validate1030.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1958: any = {"description":"Why a handshake is incompatible. It rides in the ack, which is a successful response, not as a\nJSON-RPC error.","type":"string","enum":["connection.version.floorExceeded","connection.version.ceilingExceeded","connection.handshake.alreadyCompleted"]};
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1031(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ConnectionInitializeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1031.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.compatible === undefined) && (missing0 = "compatible")) || ((data.protocolVersion === undefined) && (missing0 = "protocolVersion"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validate1031.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "compatible") || (key0 === "protocolVersion")) || (key0 === "deviceId")) || (key0 === "reason")) || (key0 === "serverCapabilities")) || (key0 === "daemonSupportedProtocols"))){validate1031.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.compatible !== undefined){const _errs2: any = errors;if(typeof data.compatible !== "boolean"){validate1031.errors = [{instancePath:instancePath+"/compatible",schemaPath:"#/properties/compatible/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.protocolVersion !== undefined){let data1: any = data.protocolVersion;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern1190.test(data1)){validate1031.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/$defs/ProtocolVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}}];return false;}}else {validate1031.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/$defs/ProtocolVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data2: any = data.deviceId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 256){validate1031.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data2)){validate1031.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1031.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data3: any = data.reason;const _errs11: any = errors;if(typeof data3 !== "string"){validate1031.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/NegotiationIncompatibleReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data3 === "connection.version.floorExceeded") || (data3 === "connection.version.ceilingExceeded")) || (data3 === "connection.handshake.alreadyCompleted"))){validate1031.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/NegotiationIncompatibleReason/enum",keyword:"enum",params:{allowedValues: schema1958.enum}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverCapabilities !== undefined){let data4: any = data.serverCapabilities;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data4)){if(data4.length > 32){validate1031.errors = [{instancePath:instancePath+"/serverCapabilities",schemaPath:"#/properties/serverCapabilities/maxItems",keyword:"maxItems",params:{limit: 32}}];return false;}else {var valid4: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){let data5: any = data4[i0];const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) > 256){validate1031.errors = [{instancePath:instancePath+"/serverCapabilities/" + i0,schemaPath:"#/properties/serverCapabilities/items/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1031.errors = [{instancePath:instancePath+"/serverCapabilities/" + i0,schemaPath:"#/properties/serverCapabilities/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1031.errors = [{instancePath:instancePath+"/serverCapabilities/" + i0,schemaPath:"#/properties/serverCapabilities/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;if(!valid4){break;}}}}else {validate1031.errors = [{instancePath:instancePath+"/serverCapabilities",schemaPath:"#/properties/serverCapabilities/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.daemonSupportedProtocols !== undefined){let data6: any = data.daemonSupportedProtocols;const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data6)){if(data6.length > 32){validate1031.errors = [{instancePath:instancePath+"/daemonSupportedProtocols",schemaPath:"#/properties/daemonSupportedProtocols/maxItems",keyword:"maxItems",params:{limit: 32}}];return false;}else {var valid5: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){let data7: any = data6[i1];const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(typeof data7 === "string"){if(!pattern1190.test(data7)){validate1031.errors = [{instancePath:instancePath+"/daemonSupportedProtocols/" + i1,schemaPath:"#/$defs/ProtocolVersion/pattern",keyword:"pattern",params:{pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}}];return false;}}else {validate1031.errors = [{instancePath:instancePath+"/daemonSupportedProtocols/" + i1,schemaPath:"#/$defs/ProtocolVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs20 === errors;if(!valid5){break;}}}}else {validate1031.errors = [{instancePath:instancePath+"/daemonSupportedProtocols",schemaPath:"#/properties/daemonSupportedProtocols/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1031.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1031.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1031.errors = null as any[] | null;
// prettier-ignore
validate1031.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ConnectionInitializeRequest}. */
export const validateConnectionInitializeRequest: SchemaCheck<ConnectionInitializeRequest> =
  validate1030;
/** Checks that a value is a {@link ConnectionInitializeResponse}. */
export const validateConnectionInitializeResponse: SchemaCheck<ConnectionInitializeResponse> =
  validate1031;
