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
//   * JSON-RPC numeric error code mapping discriminator (which thrown values
//     map to which JSON-RPC numeric code, sanitization, envelope assembly) —
//     owned by T-007p-2-2 (`jsonrpc-error-mapping.ts`). This file exposes
//     the wire-envelope SHAPE per BL-103 closure; the discriminator that
//     populates it lives daemon-side. The canonical numeric ↔ project
//     dotted-namespace mapping table itself lives at
//     docs/architecture/contracts/error-contracts.md §JSON-RPC Wire Mapping
//     (BL-103 ratified 2026-05-01).
//   * `DaemonHello` / `DaemonHelloAck` — owned by T-007p-2-4
//     (`protocol-negotiation.ts`).
//   * `LocalSubscription<T>` / `$/subscription/notify` notification methods
//     — owned by T-007p-2-5 (`streaming-primitive.ts`). The
//     `JsonRpcNotification` shape here is the GENERIC notification envelope
//     (any `method` string + `params`); the streaming primitive's
//     `$/subscription/notify` is one specific instance T-5 will type
//     against this generic shape.
//
// `protocolVersion` field type ratified at api-payload-contracts.md
// §Tier 1 (cont.): Plan-007 (BL-102 closed 2026-05-01) — ISO 8601
// `YYYY-MM-DD` date-string per the MCP §Architecture overview precedent
// (modelcontextprotocol.io). Spec-007:54 amended to match. Date-strings
// sort lexicographically equivalent to chronologically and dodge the
// semver "v1.5 with no v1.4" ambiguity.

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

/**
 * Methods exempt from the substrate's envelope-level `protocolVersion`
 * gate. Spec-007:54 mandates that every request carries an ISO 8601
 * `YYYY-MM-DD` `protocolVersion` field on the JSON-RPC envelope; the
 * `local-ipc-gateway.ts#dispatchFrame` substrate enforces the field
 * BEFORE dispatch (per I-007-7), but the handshake exchange itself
 * (`daemon.hello`) cannot — by definition — carry a negotiated version
 * because the negotiation has not yet occurred. The handshake's
 * `protocolVersion` rides in `params.protocolVersion` (proposed primary)
 * + `params.supportedProtocols` (full set), validated INSIDE the
 * registry against `DaemonHelloSchema` per F-007p-2-10.
 *
 * Tier 1 surface only registers `daemon.hello`; Tier-4 health-check
 * methods (Spec-007:54 "except health checks") will extend this set
 * when those methods are implemented. Adding a method here is a
 * deliberate, documented exemption — every entry MUST cite which
 * envelope-level violation invariant it is shifting into the handler's
 * own params validation.
 *
 * Frozen via `readonly` so consumers cannot mutate the substrate's gate
 * at runtime.
 */
export const ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  "daemon.hello",
]);

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
 * (line 54 — every request except health checks must carry it). Typed as
 * an ISO 8601 `YYYY-MM-DD` date-string per api-payload-contracts.md
 * §Tier 1 (cont.): Plan-007 (BL-102 ratified 2026-05-01). Optional because
 * health checks omit it per Spec-007:54.
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
  readonly protocolVersion?: string;
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
 * Structured `data` payload riding inside a JSON-RPC error object. Shape
 * ratified at error-contracts.md §JSON-RPC Wire Mapping (BL-103 closed
 * 2026-05-01) per the [RFC 7807 Problem Details]
 * (https://datatracker.ietf.org/doc/html/rfc7807) precedent and the
 * [LSP 3.17 ResponseError]
 * (https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#responseError)
 * field convention:
 *
 *   * `type: string` — the canonical project dotted-namespace code (e.g.
 *     `session.not_found`, `unknown_setting`, `protocol.handshake_required`,
 *     `resource.limit_exceeded`). The string is a SUPERSET of the
 *     error-contracts.md §Error Codes registry: it ALSO includes
 *     framework-level / substrate-only identifiers (e.g. `invalid_params`,
 *     `invalid_envelope`, `method_not_found`, `oversized_body`) that are
 *     stable substrate identifiers without §Error Codes registry entries.
 *     Consumers MUST discriminate on `data.type` for project-level error
 *     handling; the numeric `code` is for JSON-RPC §5.1 framing only.
 *   * `fields?: Record<string, unknown>` — optional structured detail (e.g.
 *     `{ setting: string, value: unknown }` for `unknown_setting`,
 *     `{ limit, observed }` for `transport.message_too_large`). Producers
 *     MUST keep this payload free of stack traces, absolute paths, and
 *     secrets per Plan-007 invariant I-007-8.
 *
 * The shape is REQUIRED whenever `data` is populated. The substrate's
 * daemon-side discriminator (T-007p-2-2's `jsonrpc-error-mapping.ts`)
 * projects each typed throw into this canonical shape; clients see the
 * canonical shape only.
 */
export interface JsonRpcErrorData {
  readonly type: string;
  readonly fields?: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// JsonRpcErrorCode — JSON-RPC 2.0 spec §5.1 numeric error codes
// --------------------------------------------------------------------------

/**
 * The five JSON-RPC 2.0 spec reserved numeric error codes (per
 * https://www.jsonrpc.org/specification §5.1 "Error object"). These are
 * the only numerics the substrate emits — domain-specific codes ride in
 * `error.data.type` per error-contracts.md §JSON-RPC Wire Mapping (BL-103
 * closed 2026-05-01).
 *
 * Promoted to `@ai-sidekicks/contracts` so that daemon-side mapping
 * (`packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts`) and SDK-side
 * decoding (`packages/client-sdk/src/transport/jsonRpcClient.ts`) share
 * one canonical declaration. Both packages depend on
 * `@ai-sidekicks/contracts` per the Tier 1 dependency direction (clients
 * depend on contracts; never on the daemon).
 *
 *   * `-32700 ParseError` — Invalid JSON received by the server.
 *   * `-32600 InvalidRequest` — JSON parsed but the envelope is not a
 *     valid JSON-RPC Request object.
 *   * `-32601 MethodNotFound` — The method does not exist / is not
 *     available.
 *   * `-32602 InvalidParams` — Invalid method parameter(s); Zod validation
 *     failure at the registry's dispatch boundary.
 *   * `-32603 InternalError` — Internal JSON-RPC error; handler-thrown
 *     unexpected error or result-schema validation failure (programmer
 *     error on the daemon side).
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Type alias for the JSON-RPC numeric error code value space. Test code
 * and downstream callers pattern-match on the numeric without taking a
 * runtime dependency on the `JsonRpcErrorCode` named-constant object.
 */
export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

/**
 * JSON-RPC 2.0 error response envelope (spec §5.1).
 *
 * The error object's shape per spec §5.1:
 *   * `code: integer` — error code; the JSON-RPC reserved range
 *     (-32768..-32000) is the spec's prerogative. The canonical numeric ↔
 *     project dotted-namespace table lives at error-contracts.md
 *     §JSON-RPC Wire Mapping. Project domain codes ride in `data.type`
 *     (NOT in `code`), per the table.
 *   * `message: string` — human-readable; the substrate's I-007-8
 *     sanitization step strips stack traces and absolute paths from this
 *     field before it leaves the daemon. Sanitization itself is a
 *     substrate-side helper (`sanitizeErrorMessage` in
 *     `local-ipc-gateway.ts`); the contract here is "this string is
 *     trusted to not leak secrets".
 *   * `data?: JsonRpcErrorData` — structured project-level detail per
 *     BL-103. `data.type` is the project dotted-namespace code;
 *     `data.fields` is optional structured context. See `JsonRpcErrorData`
 *     above for the full contract.
 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonRpcErrorData;
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
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponseEnvelope;
