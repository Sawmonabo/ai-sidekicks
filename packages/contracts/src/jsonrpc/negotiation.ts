// The `daemon.hello` handshake, `DaemonHello` and `DaemonHelloAck`, shared by the daemon and its
// clients. A `protocolVersion` is an ISO 8601 `YYYY-MM-DD` date, so lexical order is chronological.

import { z } from "zod";

/** The JSON-RPC method name of the negotiation handshake. */
export const DAEMON_HELLO_METHOD = "daemon.hello" as const;

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

/**
 * The protocol version this build speaks: the version a client offers in `daemon.hello`, and the
 * newest one the daemon accepts.
 */
export const CURRENT_PROTOCOL_VERSION = "2026-05-01";

/**
 * The protocol versions this build speaks, newest last: its own, and the one before it once a
 * release has shipped one, so an app and a service one release apart still agree. The daemon
 * accepts exactly these, and a client offers exactly these in `daemon.hello`.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [CURRENT_PROTOCOL_VERSION];

/** A protocol version: a `YYYY-MM-DD` date string. */
export const ProtocolVersionSchema: z.ZodString = z.string().regex(PROTOCOL_VERSION_REGEX);

/** A non-empty free-form string, at most `NEGOTIATION_FIELD_MAX_LEN` long. */
const NegotiationFreeFormString = z.string().min(1).max(NEGOTIATION_FIELD_MAX_LEN);

/**
 * The `daemon.hello` request, the first call on a connection: the client's preferred
 * `protocolVersion`, its full `supportedProtocols` set, which defaults to `[protocolVersion]`, and
 * the daemon's session token read from its token file.
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
    sessionToken: NegotiationFreeFormString.optional(),
    capabilities: z.array(NegotiationFreeFormString).max(SUPPORTED_PROTOCOLS_MAX_LEN).optional(),
  })
  .strict() as unknown as z.ZodType<DaemonHello>;

/**
 * The `DaemonHello` request payload. Declared by hand, with the schema cast to it, because zod's
 * inferred type does not match this `readonly` shape under `exactOptionalPropertyTypes`.
 */
export interface DaemonHello {
  readonly protocolVersion: string;
  readonly supportedProtocols?: ReadonlyArray<string>;
  readonly clientId?: string;
  /**
   * The session token the daemon wrote to its token file at this start. Optional in the shape so
   * the daemon answers its absence with `auth.token_invalid`, as it does a wrong one; it serves
   * nothing on a connection whose hello lacks the right token.
   */
  readonly sessionToken?: string;
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

/**
 * The error code (`error.data.type`) a mutating call is refused with on a connection whose
 * handshake answered `compatible: false`.
 */
export const NEGOTIATION_VERSION_MISMATCH_CODE = "protocol.version_mismatch" as const;

/**
 * The error code (`error.data.type`) every call is refused with on a connection whose
 * `daemon.hello` carried no session token or the wrong one, the hello included.
 */
export const NEGOTIATION_TOKEN_INVALID_CODE = "auth.token_invalid" as const;

/** The reasons a `DaemonHelloAck` may give for `compatible: false`. */
export type NegotiationIncompatibleReason =
  | typeof NEGOTIATION_REASON_FLOOR_EXCEEDED
  | typeof NEGOTIATION_REASON_CEILING_EXCEEDED
  | typeof NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED;

/**
 * The `daemon.hello` result. When `compatible` is false only read-only calls are allowed, and
 * `protocolVersion` is the daemon's newest rather than the negotiated one; `reason` and
 * `daemonSupportedProtocols` appear only on an incompatible first handshake.
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
