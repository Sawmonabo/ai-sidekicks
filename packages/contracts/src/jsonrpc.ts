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
//   * `Spec-007 §Wire Format` — JSON-RPC 2.0 + LSP-style Content-Length framing.
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
//   * `LocalSubscriptionProducer<T>` (server-side producer handle) /
//     `$/subscription/notify` notification methods — owned by T-007p-2-5
//     (`streaming-primitive.ts`). The `JsonRpcNotification` shape here is
//     the GENERIC notification envelope (any `method` string + `params`);
//     the streaming primitive's `$/subscription/notify` is one specific
//     instance T-5 will type against this generic shape. The
//     `LocalSubscriptionProducer<T>` interface is re-exported from
//     `jsonrpc-streaming.ts` via `index.ts`; the corresponding CLIENT-side
//     consumer is `LocalSubscriptionConsumer<T>` declared at
//     `packages/client-sdk/src/transport/types.ts` (not re-exported here —
//     the client-sdk owns its own consumer shape).
//
// `protocolVersion` field type ratified at api-payload-contracts.md
// §Tier 1 (cont.): Plan-007 (BL-102 closed 2026-05-01) — ISO 8601
// `YYYY-MM-DD` date-string per the MCP §Architecture overview precedent
// (modelcontextprotocol.io). `Spec-007 §Wire Format` amended to match. Date-strings
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
 * The maximum size, in bytes, of ONE framed JSON-RPC message body.
 *
 * `Spec-007 §Wire Format` ("Maximum message size: 1 MB"); "1 MB" is decimal,
 * 1,000,000 bytes, following that section's wording. The bound is on the BODY
 * the `Content-Length` header declares — the header bytes are not counted
 * against it. An oversized body closes the connection with an error frame
 * (F-007p-2-05), so exceeding this is not a recoverable per-request failure.
 * Changing the value requires a Plan-007 Phase 2 amendment plus a Spec-007
 * update, per F-007p-2-11.
 *
 * DECLARED HERE, ENFORCED IN THE SUBSTRATE. The framing parser and encoder
 * live daemon-side in `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`,
 * which re-exports this constant so the substrate keeps its single name for
 * it. It was hoisted into this package because it acquired a SECOND consumer
 * that is not the framer: a producer that must size a paged reply so the
 * frame it will become cannot be refused. A response schema deriving its own
 * page budget from a private copy of the number would drift from the framer
 * the day the framer moved, and the drift would surface as closed connections
 * rather than as a failing test.
 */
export const MAX_MESSAGE_BYTES = 1_000_000;

/**
 * The UTF-8 byte length of `value` once serialized as JSON — the quantity
 * {@link MAX_MESSAGE_BYTES} bounds — or `Number.POSITIVE_INFINITY` when
 * `value` cannot be serialized at all.
 *
 * WHY A PRODUCER NEEDS THIS. A reply is refused by the framer AFTER it has
 * been built, and the refusal closes the connection rather than failing one
 * request (F-007p-2-05). A producer that pages its output therefore has to
 * decide where to stop BEFORE it hands the page over, and the only honest
 * comparand is the same number the framer will compute. Estimating from
 * field-length caps does not substitute: a bound derived from caps is either
 * so conservative that ordinary pages split needlessly, or it silently omits
 * an unbounded member and stops being a bound at all.
 *
 * WHY NOT `Buffer.byteLength`. This package declares no Node dependency (see
 * this file's header), and the loop below is exact on every runtime. Lone
 * surrogates cannot reach it: `JSON.stringify` has been well-formed since
 * ES2019 and escapes them to ASCII, so the `0xd800`-`0xdbff` branch always
 * has its low surrogate. The unpaired-low-surrogate fall-through is charged
 * three bytes anyway rather than trusted, because a wrong answer here is a
 * closed connection.
 *
 * `POSITIVE_INFINITY` rather than a throw on an unserializable value (a
 * cycle, a `BigInt`): the callers are Zod refinements on a parse path, where
 * a throw escapes `.parse()` as an exception instead of a validation issue.
 * Infinity fails every comparison against a finite budget, which is the
 * correct verdict — a value the framer cannot serialize cannot be sent.
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
 * The maximum size, in bytes, of a JSON-RPC `id` once JSON-encoded.
 *
 * WHY A BOUND EXISTS AT ALL. The `id` is opaque to the substrate and echoed
 * back verbatim (see {@link JsonRpcId}), so a caller chooses how many bytes of
 * every response it authors. Without a bound that choice is only limited by
 * the inbound frame: a 900 KB id inside a well-formed 950 KB request is a
 * valid request today, and the reply echoing it exceeds
 * {@link MAX_MESSAGE_BYTES} no matter how small the result is. That failure
 * lands on the SEND side, where the reply that cannot be encoded is the very
 * thing that would have carried the error — so the substrate closes the
 * connection instead of answering (F-007p-2-05). A caller could therefore
 * drop its own session with a request the substrate accepted.
 *
 * WHY IT IS ENFORCED ON THE REQUEST, NOT SUBTRACTED FROM THE REPLY. No
 * response schema can bound a member the response does not choose. Sizing
 * replies around an unenforced allowance would leave the guarantee resting on
 * a caller's restraint. Bounding the id where it arrives makes the reserve a
 * paged reply subtracts a derivation from an enforced rule.
 *
 * WHY 256. It is the same ceiling this package puts on every other opaque
 * correlation string on the wire, and it is far above what any client in this
 * repo mints: the SDK's ids are monotonic integers, and a UUID id encodes to
 * 38 bytes. A caller needing more than 256 bytes of correlation state is
 * carrying state the substrate should not be storing in an echo field.
 *
 * The bound is on the JSON-ENCODED form, which is what rides the frame, so it
 * covers escaping rather than counting characters and applies uniformly to
 * the string, number, and null arms.
 *
 * DECLARED HERE, ENFORCED IN THE SUBSTRATE — the same split
 * {@link MAX_MESSAGE_BYTES} takes, and for the same reason: the gateway
 * refuses an over-bound id before dispatch, and this package's page budgets
 * subtract it. Changing the value requires a Plan-007 amendment, since it is
 * an accept/refuse rule on the wire.
 */
export const JSON_RPC_ID_MAX_BYTES = 256;

/**
 * Whether `candidate` encodes within {@link JSON_RPC_ID_MAX_BYTES}.
 *
 * Shape-blind on purpose: it answers only the size question, so a caller that
 * has already established the id is a string, number, or null gets one rule
 * rather than three. A value that cannot be serialized measures
 * `POSITIVE_INFINITY` and is therefore out of bound, which is the correct
 * verdict for the same reason {@link jsonUtf8ByteLength} gives.
 */
export function isJsonRpcIdWithinBound(candidate: unknown): boolean {
  return jsonUtf8ByteLength(candidate) <= JSON_RPC_ID_MAX_BYTES;
}

/**
 * Methods exempt from the substrate's envelope-level `protocolVersion`
 * gate. `Spec-007 §Wire Format` mandates that every request carries an ISO 8601
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
 * methods (`Spec-007 §Wire Format` "except health checks") will extend this set
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
 *
 * Opaque is not unbounded. Because the substrate echoes it, the id is the
 * one response member the CALLER sizes, so it is bounded at the request
 * boundary by {@link JSON_RPC_ID_MAX_BYTES} — see that constant for why an
 * unbounded id is a self-inflicted disconnect rather than a large reply.
 */
export type JsonRpcId = string | number | null;

// --------------------------------------------------------------------------
// JsonRpcRequest
// --------------------------------------------------------------------------

/**
 * JSON-RPC 2.0 request envelope.
 *
 * `protocolVersion` is the Spec-007 §Wire Format per-request field
 * (`Spec-007 §Wire Format` — every request except health checks must carry it). Typed as
 * an ISO 8601 `YYYY-MM-DD` date-string per api-payload-contracts.md
 * §Tier 1 (cont.): Plan-007 (BL-102 ratified 2026-05-01). Optional because
 * health checks omit it per `Spec-007 §Wire Format`.
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
