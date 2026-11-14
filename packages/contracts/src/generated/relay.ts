// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The relay pin: what the service records when a pinned relay presents a different key, and the request that accepts the relay's new key.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import { type Sha256Hex, validateSha256Hex } from "./release-manifest.js";

/**
 * A DNS host name: labels of letters, digits and inner hyphens, at most 253 characters before an optional final dot.
 */
export type Hostname = string;
/**
 * The first 8 bytes of a key hash: 16 lowercase hex characters.
 */
export type SpkiPrefix = string;

/**
 * The `relay.pin.refused` event's payload, recorded on the service's own sentinel session: the
 * relay's host and the first 8 bytes of the pinned and the presented key hashes, never a token.
 */
export interface RelayPinRefusedPayload {
  /**
   * The relay's host.
   */
  relayHost: Hostname;
  /**
   * The start of the pinned key's hash.
   */
  pinnedSpkiPrefix: SpkiPrefix;
  /**
   * The start of the presented key's hash.
   */
  presentedSpkiPrefix: SpkiPrefix;
}
/**
 * `sidekicks relay repin --force`: the new key hash the person pasted becomes the pin.
 */
export interface RelayRepinRequest {
  /**
   * The full SHA-256 of the relay's new key.
   */
  spkiHash: Sha256Hex;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern265 = new RegExp("\\.$", "u");
// prettier-ignore
const pattern266 = new RegExp("^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$", "u");
/** Checks that a value is a {@link Hostname}. */
// prettier-ignore
export const validateHostname: CompiledSchemaCheck<Hostname> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Hostname {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateHostname.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = false;const _errs2: any = errors;if(errors === _errs2){if(typeof data === "string"){if(func1(data) > 253){const err0: any = {instancePath,schemaPath:"#/anyOf/0/maxLength",keyword:"maxLength",params:{limit: 253}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;const _errs4: any = errors;if(errors === _errs4){if(typeof data === "string"){if(func1(data) > 254){const err2: any = {instancePath,schemaPath:"#/anyOf/1/maxLength",keyword:"maxLength",params:{limit: 254}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(!pattern265.test(data)){const err3: any = {instancePath,schemaPath:"#/anyOf/1/pattern",keyword:"pattern",params:{pattern: "\\.$"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(!valid0){const err5: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validateHostname.errors = vErrors;return false;}else {errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}}if(errors === 0){if(typeof data === "string"){if(!pattern266.test(data)){validateHostname.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$"}}];return false;}}else {validateHostname.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateHostname.errors = vErrors;return errors === 0;};
// prettier-ignore
validateHostname.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern267 = new RegExp("^[0-9a-f]{16}$", "u");
/** Checks that a value is a {@link SpkiPrefix}. */
// prettier-ignore
export const validateSpkiPrefix: CompiledSchemaCheck<SpkiPrefix> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SpkiPrefix {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSpkiPrefix.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern267.test(data)){validateSpkiPrefix.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{16}$"}}];return false;}}else {validateSpkiPrefix.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSpkiPrefix.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSpkiPrefix.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RelayPinRefusedPayload}. */
// prettier-ignore
export const validateRelayPinRefusedPayload: CompiledSchemaCheck<RelayPinRefusedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RelayPinRefusedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRelayPinRefusedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.relayHost === undefined) && (missing0 = "relayHost")) || ((data.pinnedSpkiPrefix === undefined) && (missing0 = "pinnedSpkiPrefix"))) || ((data.presentedSpkiPrefix === undefined) && (missing0 = "presentedSpkiPrefix"))){validateRelayPinRefusedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "relayHost") || (key0 === "pinnedSpkiPrefix")) || (key0 === "presentedSpkiPrefix"))){validateRelayPinRefusedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.relayHost !== undefined){const _errs2: any = errors;if(!(validateHostname.call(this, data.relayHost, {instancePath:instancePath+"/relayHost",parentData:data,parentDataProperty:"relayHost",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateHostname.errors : vErrors.concat(validateHostname.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pinnedSpkiPrefix !== undefined){const _errs3: any = errors;if(!(validateSpkiPrefix.call(this, data.pinnedSpkiPrefix, {instancePath:instancePath+"/pinnedSpkiPrefix",parentData:data,parentDataProperty:"pinnedSpkiPrefix",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSpkiPrefix.errors : vErrors.concat(validateSpkiPrefix.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.presentedSpkiPrefix !== undefined){const _errs4: any = errors;if(!(validateSpkiPrefix.call(this, data.presentedSpkiPrefix, {instancePath:instancePath+"/presentedSpkiPrefix",parentData:data,parentDataProperty:"presentedSpkiPrefix",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSpkiPrefix.errors : vErrors.concat(validateSpkiPrefix.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateRelayPinRefusedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRelayPinRefusedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRelayPinRefusedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RelayRepinRequest}. */
// prettier-ignore
export const validateRelayRepinRequest: CompiledSchemaCheck<RelayRepinRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RelayRepinRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRelayRepinRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.spkiHash === undefined) && (missing0 = "spkiHash")){validateRelayRepinRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "spkiHash")){validateRelayRepinRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.spkiHash !== undefined){if(!(validateSha256Hex.call(this, data.spkiHash, {instancePath:instancePath+"/spkiHash",parentData:data,parentDataProperty:"spkiHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSha256Hex.errors : vErrors.concat(validateSha256Hex.errors);errors = vErrors.length;}}}}}else {validateRelayRepinRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRelayRepinRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRelayRepinRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link RELAY_METHOD_DESCRIPTORS}, each with its checks. */
export interface RelayMethodDescriptors {
  readonly "relay.repin": {
    readonly method: "relay.repin";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<RelayRepinRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The relay method the service answers. */
export const RELAY_METHOD_DESCRIPTORS: RelayMethodDescriptors = Object.freeze({
  "relay.repin": Object.freeze({
    method: "relay.repin",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRelayRepinRequest,
    responseCheck: validateEmptyPayload,
  }),
});
