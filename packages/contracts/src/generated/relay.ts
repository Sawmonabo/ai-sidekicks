// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The relay pin: what the service records when a pinned relay presents a different key, and the request that accepts the relay's new key.

import type { SchemaCheck } from "../schema-check.js";
import { validateEmptyPayload } from "./checks/method-descriptor.js";
import { validateRelayRepinRequest } from "./checks/relay.js";
import type { EmptyPayload } from "./method-descriptor.js";
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

export {
  validateHostname,
  validateRelayPinRefusedPayload,
  validateRelayRepinRequest,
  validateSpkiPrefix,
} from "./checks/relay.js";

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
export const RELAY_METHOD_DESCRIPTORS: RelayMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "relay.repin": /* @__PURE__ */ Object.freeze({
    method: "relay.repin",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRelayRepinRequest,
    responseCheck: validateEmptyPayload,
  }),
});
