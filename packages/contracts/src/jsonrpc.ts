// JSON-RPC 2.0 envelope contracts — wire-shape types for Plan-007 Phase 2.
//
// Plan-007-partial Phase 2 (T-007p-2-1) ships the substrate that frames and
// dispatches JSON-RPC 2.0 messages between the local daemon and its clients
// (CLI, desktop shell, future SDK consumers). This file owns the
// CROSS-PACKAGE type surface — the request / response / notification / error
// envelopes that every wire participant agrees on. It deliberately contains
// NO Node-specific imports (no `Buffer`, no `node:*`); the substrate-side
// framing parser, transport, and supervision hooks live in
// `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`.
//
// Spec coverage:
//   * Spec-007 §Wire Format (docs/specs/007-local-ipc-and-daemon-control.md
//     lines 50-56) — JSON-RPC 2.0 + LSP-style Content-Length framing.
//   * ADR-009 (docs/decisions/009-json-rpc-ipc-wire-format.md) — wire-format
//     decision rationale.
//
// What this file does NOT define (deferred to sibling tasks):
//   * `MethodRegistry` — owned by T-007p-2-3 (`packages/runtime-daemon/src/ipc/registry.ts`).
//   * JSON-RPC numeric error code mapping (`-32700` parse, `-32600` invalid
//     request, `-32601` method not found, `-32602` invalid params, `-32603`
//     internal error) ↔ project dotted-namespace ErrorResponse — owned by
//     T-007p-2-2 (`jsonrpc-error-mapping.ts`). This file exposes the
//     ABSTRACT `code: number, message: string, data?: unknown` error-object
//     shape the JSON-RPC spec requires; T-2 lands the canonical mapping
//     table.
//   * `DaemonHello` / `DaemonHelloAck` — owned by T-007p-2-4
//     (`protocol-negotiation.ts`).
//   * `LocalSubscription<T>` / `$/subscription/notify` notification methods
//     — owned by T-007p-2-5 (`streaming-primitive.ts`). The
//     `JsonRpcNotification` shape here is the GENERIC notification envelope
//     (any `method` string + `params`); the streaming primitive's
//     `$/subscription/notify` is one specific instance T-5 will type
//     against this generic shape.
//
// BLOCKED-ON-C6. The `protocolVersion` field type is parameterized over
// `number | string` per the audit directive. Spec-007:54 declares an integer
// field; api-payload-contracts.md:541-548 declares a string field. The
// substrate accepts both shapes; Phase 3 handlers narrow once
// api-payload-contracts.md §Plan-007 lands the canonical type. When C-6
// resolves, the union narrows in place — every consumer keeps the same
// type-import line.

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * The JSON-RPC 2.0 spec literal. Every request, notification, and response
 * envelope MUST carry `jsonrpc: "2.0"` per the spec
 * (https://www.jsonrpc.org/specification §4 "Request object"). The literal
 * is exported so consumers (substrate framing parser, T-2 error-mapping,
 * T-3 registry, T-5 streaming) compare against the typed value rather than
 * the bare string.
 */
export const JSONRPC_VERSION = "2.0" as const;
export type JsonRpcVersion = typeof JSONRPC_VERSION;

// --------------------------------------------------------------------------
// JsonRpcId
// --------------------------------------------------------------------------

/**
 * Per JSON-RPC 2.0 §4: a request `id` MUST be a String, Number, or NULL
 * value. Notifications omit `id` entirely. We accept all three runtime
 * types here so the substrate parser does not pre-narrow the wire shape;
 * downstream code can choose to reject `null` IDs (the spec strongly
 * discourages them but does not forbid) at its own layer.
 *
 * The ID is opaque to the substrate: it is echoed back in the response
 * verbatim. Its only contract is round-trip equality between request and
 * response. The registry (T-3) and dispatcher (T-2) do not interpret it.
 */
export type JsonRpcId = string | number | null;

// --------------------------------------------------------------------------
// JsonRpcRequest
// --------------------------------------------------------------------------

/**
 * JSON-RPC 2.0 request envelope.
 *
 * `protocolVersion` is the Spec-007 §Wire Format per-request field
 * (line 54 — every request except health checks must carry it). It is
 * typed as `number | string` per the BLOCKED-ON-C6 directive — Spec-007:54
 * declares an integer; api-payload-contracts.md:541-548 declares a string.
 * The substrate accepts either; Phase 3 handlers narrow when the canonical
 * type lands. Optional because health checks omit it per Spec-007:54.
 *
 * `params` is `unknown` at this layer because the substrate does NOT
 * validate it — Zod schema validation runs INSIDE the registry's
 * `dispatch` (T-3) per I-007-7. The substrate's only contract is "frame
 * boundary parses cleanly into a JSON-RPC envelope"; payload typing is
 * the registered handler's contract.
 */
export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
  // BLOCKED-ON-C6 — narrows to `number` or `string` (one of the two) when
  // api-payload-contracts.md §Plan-007 declares the canonical
  // `protocolVersion` field type.
  readonly protocolVersion?: number | string;
}

// --------------------------------------------------------------------------
// JsonRpcNotification
// --------------------------------------------------------------------------

/**
 * JSON-RPC 2.0 notification envelope. Per spec §4.1 a notification is a
 * request without an `id` field (the absence is what the spec uses to
 * discriminate "no response expected" from "response expected"). The
 * server MUST NOT reply to a notification per spec.
 *
 * The streaming-primitive task (T-5) types its `$/subscription/notify`
 * frames against this shape. The substrate's framing parser produces
 * `JsonRpcNotification` for every incoming envelope that lacks an `id`
 * field — no special-case for the streaming `$/`-prefixed methods.
 */
export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly method: string;
  readonly params?: P;
}

// --------------------------------------------------------------------------
// JsonRpcResponse (success branch)
// --------------------------------------------------------------------------

/**
 * JSON-RPC 2.0 success response envelope (spec §5).
 *
 * The `id` MUST equal the request's `id` per spec — the substrate's
 * dispatcher echoes it back verbatim. `result` is `unknown` at this layer
 * because the per-method result schema is owned by the registry's
 * `register(method, paramsSchema, resultSchema, handler)` typed surface
 * (T-3); the substrate only frames the envelope.
 *
 * Mutually exclusive with `JsonRpcErrorResponse`: a single response carries
 * EITHER `result` OR `error`, never both. The `JsonRpcResponseEnvelope`
 * union below makes that exclusivity load-bearing at the type level.
 */
export interface JsonRpcResponse<R = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly result: R;
}

// --------------------------------------------------------------------------
// JsonRpcErrorResponse (error branch)
// --------------------------------------------------------------------------

/**
 * JSON-RPC 2.0 error response envelope (spec §5.1).
 *
 * The error object's shape per spec §5.1:
 *   * `code: integer` — error code; the JSON-RPC reserved range
 *     (-32768..-32000) is the spec's prerogative; project domain codes
 *     ride in `data`. The canonical mapping table between JSON-RPC
 *     numeric codes and project dotted-namespace ErrorResponse codes is
 *     T-007p-2-2's surface — this file does NOT enumerate them.
 *   * `message: string` — human-readable; the substrate's I-007-8
 *     sanitization step strips stack traces and absolute paths from
 *     this field before it leaves the daemon. Sanitization itself is
 *     a substrate-side helper (`sanitizeErrorMessage` in
 *     `local-ipc-gateway.ts`); the contract here is "this string is
 *     trusted to not leak secrets".
 *   * `data?: unknown` — optional supplementary structured value. T-2's
 *     mapping carries the project dotted code (e.g. `session.not_found`)
 *     here when a registered domain error fires through the substrate.
 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: JsonRpcVersion;
  // Per spec §5: if there was an error in detecting the request's id, the
  // id MUST be `null`. The runtime substrate produces `null` on parse-error
  // / missing-id paths and echoes the request id verbatim otherwise.
  readonly id: JsonRpcId;
  readonly error: JsonRpcError;
}

// --------------------------------------------------------------------------
// JsonRpcResponseEnvelope (discriminated union)
// --------------------------------------------------------------------------

/**
 * The full response envelope is exactly one of `JsonRpcResponse` (success)
 * or `JsonRpcErrorResponse` (error) per spec §5. Union form rather than a
 * single type with optional `result` / `error` because the spec is explicit
 * that the two are mutually exclusive — encoding that as a union pushes
 * the discriminator (`"result" in env` vs `"error" in env`) into the type
 * system, so a regression that emitted both fields would fail to typecheck.
 *
 * `R = unknown` default: per-method result schemas live in the registry
 * (T-3); the substrate's framing layer is type-erased.
 */
export type JsonRpcResponseEnvelope<R = unknown> = JsonRpcResponse<R> | JsonRpcErrorResponse;

// --------------------------------------------------------------------------
// JsonRpcMessage (parsed-but-untyped union)
// --------------------------------------------------------------------------

/**
 * The full set of envelopes the substrate's framing parser produces from
 * an incoming frame body. Substrate-side dispatch (T-2) discriminates on
 * `"id" in env` (request vs notification) and `"method" in env`
 * (request/notification vs response).
 *
 * Server-incoming traffic is dominated by requests + notifications; the
 * `JsonRpcResponseEnvelope` arm exists because the same JSON-RPC envelope
 * grammar covers client-side framing too — the daemon may someday emit
 * outbound calls (e.g. server-initiated diagnostics) that wear a response
 * shape coming back. Including it in the union now means T-2 doesn't have
 * to widen the type later.
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponseEnvelope;
