// The relay-pin contract: what the service records when a pinned relay presents a
// different key, the code that refusal carries, and the request that accepts the
// relay's new key.
//
// A relay's key is pinned only when its certificate does not chain to a root the
// operating system trusts (a self-signed relay, or one on a private certificate
// authority), because such a relay makes a new key at every renewal and nothing
// else vouches for it. Hashes are SHA-256 over the certificate's public key, in
// lowercase hex, so the prefix the refusal records is the start of the hash the
// person pastes.
import { z } from "zod";

import { EmptyAcknowledgementSchema, type EmptyAcknowledgement } from "./device.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";

/** The refusal of a connection to a pinned relay whose key no longer matches the pin. */
export type RelaySpkiMismatchCode = "relay.spki_mismatch";
/** The refusal of a connection to a pinned relay whose key no longer matches the pin. */
export const RELAY_SPKI_MISMATCH_CODE: RelaySpkiMismatchCode = "relay.spki_mismatch";

const SpkiPrefixSchema = z
  .string()
  .regex(
    /^[0-9a-f]{16}$/u,
    "a key prefix is the hash's first 8 bytes, 16 lowercase hex characters",
  );

/**
 * The `relay.pin_refused` event's payload, recorded on the service's own sentinel
 * session: the relay's host and the first 8 bytes of the pinned and the presented
 * key hashes, never a token.
 */
export interface RelayPinRefusedPayload {
  relayHost: string;
  pinnedSpkiPrefix: string;
  presentedSpkiPrefix: string;
}
/** Parses a {@link RelayPinRefusedPayload}. */
export const RelayPinRefusedPayloadSchema: z.ZodType<RelayPinRefusedPayload> = z
  .object({
    relayHost: z.hostname(),
    pinnedSpkiPrefix: SpkiPrefixSchema,
    presentedSpkiPrefix: SpkiPrefixSchema,
  })
  .strict();

/** `sidekicks relay repin --force`: the new key hash the person pasted becomes the pin. */
export interface RelayRepinRequest {
  spkiHash: string;
}
/** Parses a {@link RelayRepinRequest}: a full SHA-256, 64 lowercase hex characters. */
export const RelayRepinRequestSchema: z.ZodType<RelayRepinRequest, RelayRepinRequest> = z
  .object({
    spkiHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u, "a key hash is a SHA-256, 64 lowercase hex characters"),
  })
  .strict();

/** The relay method the service answers. */
export interface RelayMethodDescriptors {
  readonly "relay.repin": MethodDescriptor<"relay.repin", RelayRepinRequest, EmptyAcknowledgement>;
}

/** The relay method the service answers. */
export const RELAY_METHOD_DESCRIPTORS: RelayMethodDescriptors = defineMethodDescriptors({
  "relay.repin": {
    method: "relay.repin",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RelayRepinRequestSchema,
    responseSchema: EmptyAcknowledgementSchema,
  },
});
