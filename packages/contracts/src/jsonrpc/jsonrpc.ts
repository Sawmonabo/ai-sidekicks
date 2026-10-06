// JSON-RPC 2.0 envelope types shared by the daemon and its clients. No Node imports, so any
// runtime can use them; the daemon's gateway owns framing and transport.

import { z } from "zod";

import { DAEMON_HELLO_METHOD } from "./negotiation.js";

/** The `jsonrpc` member every envelope carries. */
export const JSONRPC_VERSION = "2.0" as const;
/** The type of {@link JSONRPC_VERSION}. */
export type JsonRpcVersion = typeof JSONRPC_VERSION;

/**
 * The largest body of one framed JSON-RPC message, in bytes, as its `Content-Length` declares: a
 * message at Codex's own length limit plus its envelope. An oversized body closes the connection.
 * It bounds the transport only; a paged reply sizes itself against its own page budget.
 */
export const MAX_MESSAGE_BYTES: number = 4 * 1024 * 1024;

/**
 * The UTF-8 byte length of `value` serialized as JSON, the quantity {@link MAX_MESSAGE_BYTES}
 * bounds, or `Number.POSITIVE_INFINITY` when it cannot be serialized. It never throws, because its
 * callers are zod refinements; it counts by hand because this package has no `Buffer`.
 */
export function jsonUtf8ByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  let byteLength = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const codeUnit = serialized.charCodeAt(index);
    if (codeUnit < 0x80) {
      byteLength += 1;
    } else if (codeUnit < 0x800) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < serialized.length) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

/**
 * The largest JSON-RPC `id`, in bytes once JSON-encoded (a UUID id is 38). The reply echoes the
 * `id`, so the gateway refuses a longer one before dispatch rather than let the reply pass
 * {@link MAX_MESSAGE_BYTES}.
 */
export const JSON_RPC_ID_MAX_BYTES = 256;

/**
 * Whether `candidate` encodes within {@link JSON_RPC_ID_MAX_BYTES}. It checks size only, not shape;
 * an unserializable value is out of bound.
 */
export function isJsonRpcIdWithinBound(candidate: unknown): boolean {
  return jsonUtf8ByteLength(candidate) <= JSON_RPC_ID_MAX_BYTES;
}

/**
 * Methods the gateway does not require an envelope-level `protocolVersion` on: only `daemon.hello`,
 * which carries its versions in `params` because none is negotiated before it.
 */
export const ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  DAEMON_HELLO_METHOD,
]);

/**
 * A request `id`: a string, number or null, echoed back verbatim in the response. Notifications
 * omit it. It is bounded by {@link JSON_RPC_ID_MAX_BYTES} at the request boundary.
 */
export type JsonRpcId = string | number | null;

/**
 * A JSON-RPC 2.0 request. `params` is `unknown` here; the registry validates it against the
 * method's schema. `protocolVersion` is optional in the type because `daemon.hello` omits it; the
 * gateway requires it on every other request.
 */
export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
  readonly protocolVersion?: string;
}

/** A JSON-RPC 2.0 notification: a request with no `id`, which the server never answers. */
export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly method: string;
  readonly params?: P;
}

/** A JSON-RPC 2.0 success response; `id` equals the request's `id`. */
export interface JsonRpcResponse<R = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly result: R;
}

/**
 * The `data` of a JSON-RPC error. `type` is the project's dotted-namespace code
 * (`session.not_found`, `protocol.handshake_required`) or a stable substrate code
 * (`invalid_params`, `method_not_found`); clients discriminate on it, and the numeric `code` only
 * frames the error. `fields` is optional structured detail that producers keep free of stack
 * traces, absolute paths and secrets.
 */
export interface JsonRpcErrorData {
  readonly type: string;
  readonly fields?: Record<string, unknown>;
}

/**
 * The five numeric error codes JSON-RPC 2.0 reserves and the only ones the daemon emits;
 * domain errors ride in `error.data.type`. Shared so the daemon's mapping and the SDK's decoding
 * use one declaration.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** The union of the numeric values in {@link JsonRpcErrorCode}. */
export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

/**
 * The error object of a JSON-RPC response. `message` is sanitized by the gateway
 * (`sanitizeErrorMessage`) before it leaves the daemon, so it carries no stack trace or absolute
 * path.
 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonRpcErrorData;
}

/**
 * Parses a {@link JsonRpcError}. Its optional members are exact: present with a value, or absent,
 * as JSON carries them.
 */
export const JsonRpcErrorSchema: z.ZodType<JsonRpcError> = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z
    .object({ type: z.string(), fields: z.record(z.string(), z.unknown()).exactOptional() })
    .exactOptional(),
});

/** A JSON-RPC 2.0 error response; `id` is `null` when the request's id could not be read. */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly error: JsonRpcError;
}

/** A response is a success or an error, never both; the union makes that a type error. */
export type JsonRpcResponseEnvelope<R = unknown> = JsonRpcResponse<R> | JsonRpcErrorResponse;

/** Any envelope the framing parser can produce from a frame body. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponseEnvelope;
