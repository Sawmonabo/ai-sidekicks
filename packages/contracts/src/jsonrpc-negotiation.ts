// The `daemon.hello` wire envelopes, `DaemonHello` and `DaemonHelloAck`. The daemon's handshake
// state and mutating-call gate live in `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`;
// the schemas are here because the daemon package does not depend on zod. A `protocolVersion` is
// an ISO 8601 `YYYY-MM-DD` date, so lexical order is chronological and no semver parser is needed.

import { z } from "zod";

/** The JSON-RPC method name of the negotiation handshake. */
export const DAEMON_HELLO_METHOD = "daemon.hello" as const;
/** The type of {@link DAEMON_HELLO_METHOD}. */
export type DaemonHelloMethod = typeof DAEMON_HELLO_METHOD;

/**
 * The longest a free-form negotiation string (`clientId`, a capability tag) may be. The framing
 * limit bounds the whole frame; this bounds each field.
 */
export const NEGOTIATION_FIELD_MAX_LEN = 256;

/** The most entries any protocol-version or capability list in the handshake may carry. */
export const SUPPORTED_PROTOCOLS_MAX_LEN = 32;

/**
 * The shape of a `protocolVersion`: `YYYY-MM-DD`. The gateway's per-request check and
 * `ProtocolVersionSchema` both use it, so the two cannot drift.
 */
export const PROTOCOL_VERSION_REGEX: RegExp = /^\d{4}-\d{2}-\d{2}$/;

/** A protocol version: a `YYYY-MM-DD` date string. */
export const ProtocolVersionSchema: z.ZodString = z.string().regex(PROTOCOL_VERSION_REGEX);

/** A non-empty free-form string, at most `NEGOTIATION_FIELD_MAX_LEN` long. */
const NegotiationFreeFormString = z.string().min(1).max(NEGOTIATION_FIELD_MAX_LEN);

/**
 * The `daemon.hello` request: the first call on a connection. `protocolVersion` is the client's
 * preferred version and `supportedProtocols` its full set; when the set is absent the daemon
 * treats `[protocolVersion]` as the set. The daemon does not read `clientId` or `capabilities`.
 * Unknown fields are refused.
 */
export const DaemonHelloSchema: z.ZodType<DaemonHello> = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    supportedProtocols: z
      .array(ProtocolVersionSchema)
      .min(1)
      .max(SUPPORTED_PROTOCOLS_MAX_LEN)
      .optional(),
    clientId: NegotiationFreeFormString.optional(),
    capabilities: z.array(NegotiationFreeFormString).max(SUPPORTED_PROTOCOLS_MAX_LEN).optional(),
  })
  .strict() as unknown as z.ZodType<DaemonHello>;

/**
 * The `DaemonHello` request payload. Declared explicitly, with the schema cast to it, because zod's
 * inferred type does not match this `readonly` shape under `exactOptionalPropertyTypes`.
 */
export interface DaemonHello {
  readonly protocolVersion: string;
  readonly supportedProtocols?: ReadonlyArray<string>;
  readonly clientId?: string;
  readonly capabilities?: ReadonlyArray<string>;
}

/**
 * Why a handshake is incompatible: the client is too old (`version.floor_exceeded`), too new
 * (`version.ceiling_exceeded`), or a second handshake arrived on the connection
 * (`protocol.handshake_already_completed`). They ride in `DaemonHelloAck.reason`, not as a JSON-RPC
 * error code, because the ack itself is a successful response.
 */
export const NEGOTIATION_REASON_FLOOR_EXCEEDED = "version.floor_exceeded" as const;
/** Ack reason: the client is too new for the daemon. */
export const NEGOTIATION_REASON_CEILING_EXCEEDED = "version.ceiling_exceeded" as const;
/** Ack reason: this connection already completed a handshake. */
export const NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED =
  "protocol.handshake_already_completed" as const;

/** The reasons a `DaemonHelloAck` may give for `compatible: false`. */
export type NegotiationIncompatibleReason =
  | typeof NEGOTIATION_REASON_FLOOR_EXCEEDED
  | typeof NEGOTIATION_REASON_CEILING_EXCEEDED
  | typeof NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED;

/**
 * The `daemon.hello` result. `compatible` gates mutating calls: when false only read-only calls
 * are allowed. `protocolVersion` is the negotiated version when compatible, otherwise the
 * daemon's newest, so the client can decide whether to retry. `reason` and
 * `daemonSupportedProtocols` appear only on an incompatible first handshake. The daemon does not
 * populate `serverCapabilities`.
 */
export const DaemonHelloAckSchema: z.ZodType<DaemonHelloAck> = z
  .object({
    compatible: z.boolean(),
    protocolVersion: ProtocolVersionSchema,
    reason: z
      .union([
        z.literal(NEGOTIATION_REASON_FLOOR_EXCEEDED),
        z.literal(NEGOTIATION_REASON_CEILING_EXCEEDED),
        z.literal(NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED),
      ])
      .optional(),
    serverCapabilities: z
      .array(NegotiationFreeFormString)
      .max(SUPPORTED_PROTOCOLS_MAX_LEN)
      .optional(),
    daemonSupportedProtocols: z
      .array(ProtocolVersionSchema)
      .max(SUPPORTED_PROTOCOLS_MAX_LEN)
      .optional(),
  })
  .strict() as unknown as z.ZodType<DaemonHelloAck>;

/** The `DaemonHelloAck` result payload. */
export interface DaemonHelloAck {
  readonly compatible: boolean;
  readonly protocolVersion: string;
  readonly reason?: NegotiationIncompatibleReason;
  readonly serverCapabilities?: ReadonlyArray<string>;
  readonly daemonSupportedProtocols?: ReadonlyArray<string>;
}
