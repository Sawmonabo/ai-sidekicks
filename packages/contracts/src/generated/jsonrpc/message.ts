// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// JSON-RPC 2.0 messages shared by the daemon and its clients: the kinds of message, the error a response carries, the bound on a request's id, the calls a connection holds in flight and why a request's protocol version is refused.

import type { RefusalCategory } from "./refusal.js";

/** The `jsonrpc` member every message carries. */
export const JSONRPC_VERSION = "2.0" as const;

/**
 * The largest JSON-RPC `id`, in bytes once JSON-encoded (a UUID id is 38). A response echoes
 * its request's `id`, so the gateway refuses a longer one before dispatch.
 */
export const JSON_RPC_ID_MAX_BYTES = 256 as const;

/**
 * The most calls one connection holds in flight; a call past it is refused at once with
 * `connection.call.limitReached`, and a client holds its calls past it, sending each as a
 * slot frees. A subscription cancel, a stop and a terminal write take no slot. It changes only
 * with a new dated protocol version, so a conforming client is never refused.
 */
export const MAX_CALLS_IN_FLIGHT = 100 as const;

/**
 * The refusal a client reports when the daemon cannot be reached: nothing listens on its
 * socket, or the link to it is down; `fields.reason` says why.
 */
export const CONNECTION_UNAVAILABLE_CODE = "connection.unavailable" as const;

/**
 * A request's `id`: a string, a number or `null`, echoed back by its response.
 */
export type JsonRpcId = string | number | null;
/**
 * A response: a success or an error, never both.
 */
export type JsonRpcResponseEnvelope = JsonRpcResponse | JsonRpcErrorResponse;
/**
 * One JSON-RPC 2.0 message: a request, a notification or a response.
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponseEnvelope;
/**
 * What a client receives from the daemon: a response or a notification, and nothing else.
 */
export type JsonRpcServerMessage = JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification;
/**
 * Why a socket cannot reach the daemon, the `fields.reason` of `connection.unavailable`.
 */
export type ConnectionUnavailableReason = "notListening" | "accessDenied" | "unreachable";
/**
 * Why a request's `protocolVersion` is refused, the `fields.reason` of
 * `request.protocolVersion.invalid`.
 */
export type ProtocolVersionInvalidReason = "missing" | "wrongType" | "invalidFormat";
/**
 * A refused value's JSON type, named so the value itself is never echoed: `object` for an object
 * or an array.
 */
export type ObservedType = "null" | "object" | "boolean" | "number" | "string";

/**
 * The `data` of an error: the refusal's code, its category and its structured detail, which
 * producers keep free of stack traces, absolute paths and secrets.
 */
export interface JsonRpcErrorData {
  /**
   * The refusal's code; clients branch on it, never on the message.
   */
  type: string;
  /**
   * The refusal's category, which a client acts on for a code it does not know.
   */
  category: RefusalCategory;
  /**
   * The refusal's detail.
   */
  fields?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * An error response's `error`.
 */
export interface JsonRpcError {
  /**
   * The numeric code that frames the error.
   */
  code: number;
  /**
   * A sentence for a person, sanitized before it leaves the daemon.
   */
  message: string;
  /**
   * The refusal's code and detail.
   */
  data?: JsonRpcErrorData;
}
/**
 * A JSON-RPC 2.0 request: a call that gets exactly one response. `protocolVersion` is absent
 * only on `connection.initialize`.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
  protocolVersion?: string;
}
/**
 * A JSON-RPC 2.0 notification: a call with no `id`, which gets no response.
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
/**
 * A JSON-RPC 2.0 success response; `id` is its request's.
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}
/**
 * A JSON-RPC 2.0 error response; `id` is `null` where the request's id could not be read.
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}
/**
 * The `request.protocolVersion.invalid` refusal's `data.fields`: why, and for a wrong type the
 * value's JSON type, never the value.
 */
export interface ProtocolVersionInvalidDetails {
  /**
   * Why the member is refused.
   */
  reason: ProtocolVersionInvalidReason;
  /**
   * The member's JSON type, present only when `reason` is `wrongType`.
   */
  observedType?: ObservedType;
}
