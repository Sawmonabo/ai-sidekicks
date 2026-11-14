// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `connection.initialize` handshake, `ConnectionInitializeRequest` and `ConnectionInitializeResponse`, shared by the daemon and its clients. A `protocolVersion` is an ISO 8601 `YYYY-MM-DD` date, so lexical order is chronological.

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

export {
  validateConnectionInitializeRequest,
  validateConnectionInitializeResponse,
  validateNegotiationIncompatibleReason,
  validateProtocolVersion,
} from "../checks/jsonrpc/negotiation.js";
