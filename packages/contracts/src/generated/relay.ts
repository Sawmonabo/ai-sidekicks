// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The relay pin: what the service records when a pinned relay presents a different key, and the request that accepts the relay's new key.

import type { SchemaCheck } from "../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import type { Sha256Hex } from "./release-manifest.js";

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
const pattern220 = new RegExp("^[0-9a-f]{64}$", "u");
// prettier-ignore
function validate1616(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RelayRepinRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1616.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.spkiHash === undefined) && (missing0 = "spkiHash")){validate1616.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "spkiHash")){validate1616.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.spkiHash !== undefined){let data0: any = data.spkiHash;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern220.test(data0)){validate1616.errors = [{instancePath:instancePath+"/spkiHash",schemaPath:"sidekicks-contracts:release-manifest#/$defs/Sha256Hex/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate1616.errors = [{instancePath:instancePath+"/spkiHash",schemaPath:"sidekicks-contracts:release-manifest#/$defs/Sha256Hex/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1616.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1616.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1616.errors = null as any[] | null;
// prettier-ignore
validate1616.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RelayRepinRequest}. */
export const validateRelayRepinRequest: SchemaCheck<RelayRepinRequest> = validate1616;

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
