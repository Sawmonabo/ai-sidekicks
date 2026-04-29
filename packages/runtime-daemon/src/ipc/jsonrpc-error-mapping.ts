// JSON-RPC error mapping — discriminate thrown values from the dispatch
// path and produce sanitized `JsonRpcErrorResponse` envelopes (Plan-007
// Phase 2, T-007p-2-2).
//
// Spec coverage:
//   * Spec-007 §Error Mapping (referenced via §Wire Format / §Required
//     Behavior in docs/specs/007-local-ipc-and-daemon-control.md) — the
//     daemon-side error-emission contract for JSON-RPC 2.0 envelopes.
//   * ADR-009 (docs/decisions/009-json-rpc-ipc-wire-format.md) — wire-
//     format decision rationale; numeric error code semantics.
//
// Invariants this module owns at the error-mapping boundary (canonical
// text in docs/plans/007-local-ipc-and-daemon-control.md §Invariants
// lines 101-111):
//   * I-007-7 (schema validation runs before handler dispatch) — mapping-
//     side: when the registry's `dispatch()` throws
//     `RegistryDispatchError(registryCode: "invalid_params")` BEFORE the
//     handler body executes, this module surfaces the wire numeric
//     `-32602 Invalid Params`. The handler-never-ran property is preserved
//     because the registry surface guarantees throw-before-handler-call;
//     this module simply translates the registry's stable string code
//     into the canonical JSON-RPC numeric.
//   * I-007-8 (handler-thrown errors map to JSON-RPC error codes with
//     sanitized payloads) — mapping-side: every `error.message` produced
//     by this module flows through T-1's `sanitizeErrorMessage` before it
//     leaves the daemon. Stack traces, absolute filesystem paths, and
//     UNC / Windows-drive paths are stripped at the substrate boundary
//     in `local-ipc-gateway.ts`; this module IMPORTS and reuses that
//     helper rather than reimplementing.
//
// Plan citations:
//   * F-007p-2-02 (BLOCKED-ON-C7) — JSON-RPC numeric error space (-32700,
//     -32600, -32601, -32602, -32603) ↔ project dotted-namespace
//     ErrorResponse mapping. The canonical mapping table lives in
//     error-contracts.md (§Plan-007), which is undeclared at the time of
//     this implementation. The mechanical path when C-7 lands:
//       1. Import the canonical numeric ↔ dotted-namespace table from
//          `@ai-sidekicks/contracts`.
//       2. Replace inline numeric assignments with the table lookup at
//          the discriminator branches below.
//       3. Populate `error.data.code` with the project dotted code per
//          the table.
//     The function signature stays unchanged — every call site continues
//     to invoke `mapJsonRpcError(thrown, requestId)`.
//
// What this module does NOT do:
//   * Reimplement sanitization. T-1's `sanitizeErrorMessage` is the single
//     I-007-8 enforcement seam; we IMPORT and reuse it.
//   * Invent placeholder project dotted-namespace codes. Inventing names
//     now would create a future migration tax — when C-7 lands, every
//     placeholder would need to be located, checked against the canonical
//     table, and renamed. We ship the JSON-RPC 2.0 spec numerics now and
//     leave `error.data.code` unset until C-7 lands.
//   * Discriminate notifications. JSON-RPC notifications (per §4.1) are
//     one-way and MUST NOT receive a response — that is the gateway's
//     concern (it skips the response-emission path entirely for
//     notifications). This module is only invoked when the gateway has
//     already decided a response is owed.
//
// BLOCKED-ON-C7 — every place where a project dotted-namespace code would
// normally land carries a `// BLOCKED-ON-C7` comment marking the
// mechanical replacement site.

import type {
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcId,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { FramingError, sanitizeErrorMessage } from "./local-ipc-gateway.js";
import { RegistryDispatchError } from "./registry.js";

// --------------------------------------------------------------------------
// JSON-RPC 2.0 numeric error codes (BLOCKED-ON-C7 anchor constants)
// --------------------------------------------------------------------------

/**
 * The JSON-RPC 2.0 spec reserved numeric error codes (per
 * https://www.jsonrpc.org/specification §5.1 "Error object"). These five
 * are the only numerics the substrate emits at Tier 1 — domain-specific
 * codes ride in `error.data.code` once the canonical mapping table lands
 * in error-contracts.md §Plan-007 (BLOCKED-ON-C7).
 *
 * The name `JsonRpcErrorCode` is exported as a typed enum-style object so
 * test code and downstream callers reference the named constant rather
 * than the magic number. The inline numeric values are the spec's
 * prerogative; renaming would not be a JSON-RPC-compliance change.
 *
 *   * `-32700 ParseError` — Invalid JSON was received by the server.
 *     An error occurred on the server while parsing the JSON text.
 *   * `-32600 InvalidRequest` — The JSON sent is not a valid Request
 *     object.
 *   * `-32601 MethodNotFound` — The method does not exist / is not
 *     available.
 *   * `-32602 InvalidParams` — Invalid method parameter(s).
 *   * `-32603 InternalError` — Internal JSON-RPC error.
 *
 * BLOCKED-ON-C7: when error-contracts.md §Plan-007 lands the canonical
 * JSON-RPC numeric ↔ project dotted-namespace table, the discriminator
 * branches in `mapJsonRpcError` below will additionally populate
 * `error.data.code` with the project dotted code. The numeric constants
 * themselves remain — they are the JSON-RPC spec's contract, not a
 * project choice.
 */
export const JsonRpcErrorCode = {
  /** Invalid JSON received / framing-malformed body. Spec §5.1. */
  ParseError: -32700,
  /** JSON parsed but envelope is not a valid JSON-RPC Request. Spec §5.1. */
  InvalidRequest: -32600,
  /** Method does not exist in the registry. Spec §5.1. */
  MethodNotFound: -32601,
  /** Invalid method parameter(s) — Zod validation failure. Spec §5.1. */
  InvalidParams: -32602,
  /** Internal JSON-RPC error — handler-thrown unexpected error or
   *  result-schema validation failure. Spec §5.1. */
  InternalError: -32603,
} as const;

/**
 * Type alias for the JSON-RPC numeric error code value space. Used in
 * test assertions and downstream callers that pattern-match on the
 * numeric code without taking a runtime dependency on the named-constant
 * object.
 */
export type JsonRpcErrorCodeValue =
  (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// --------------------------------------------------------------------------
// FramingError code → JSON-RPC numeric mapping
// --------------------------------------------------------------------------

/**
 * Map T-1's `FramingError.code` strings (declared in `local-ipc-gateway.ts`'s
 * `parseFrame` / `encodeFrame` throws) to the appropriate JSON-RPC numeric.
 * Per JSON-RPC §5.1, both "couldn't parse" and "envelope-shape malformed"
 * are valid framing failure modes — the spec lumps "couldn't parse the
 * request" into `-32700` and "valid JSON but bad envelope" into `-32600`.
 *
 * T-1's framing codes (canonical at `local-ipc-gateway.ts` line ~199):
 *   * `"header_too_long"` — header section exceeded the defense-in-depth
 *     1 KB cap before CRLFCRLF. The wire is desynced; we cannot trust
 *     the body either. → `-32700 ParseError`.
 *   * `"oversized_body"` — declared `Content-Length` exceeded
 *     `MAX_MESSAGE_BYTES`. The framing parser successfully read the
 *     header but refuses to read the body. Per Plan-007:268 + W-007p-2-T5,
 *     this is structurally an "Invalid Request" (the request envelope
 *     itself is malformed-by-being-too-large, not malformed-as-JSON).
 *     → `-32600 InvalidRequest` per JSON-RPC §5.1 ("The JSON sent is not
 *     a valid Request object").
 *   * `"malformed_header"` — header grammar violation (wrong line
 *     terminator, missing colon, empty header line). Body cannot be
 *     trusted. → `-32700 ParseError`.
 *   * `"malformed_content_length"` — Content-Length value is not a
 *     non-negative decimal integer, or duplicated. → `-32700 ParseError`.
 *   * `"missing_content_length"` — header section omitted Content-Length
 *     entirely. → `-32700 ParseError`.
 *   * `"invalid_json"` — frame body parsed past the framing layer but
 *     `JSON.parse` rejected it. The wire was framed correctly but the
 *     payload is not valid JSON. → `-32700 ParseError` per spec §5.1
 *     ("Invalid JSON was received by the server").
 *   * `"invalid_envelope"` — frame body is valid JSON but does not match
 *     the JSON-RPC envelope shape (missing `jsonrpc` field, missing
 *     `method` on a request, etc.). The framing+JSON layers succeeded;
 *     the JSON-RPC layer rejects. → `-32600 InvalidRequest` per spec §5.1
 *     ("The JSON sent is not a valid Request object").
 *
 * The two virtual codes `"invalid_json"` and `"invalid_envelope"` are
 * NOT thrown by `parseFrame` directly — `local-ipc-gateway.ts`'s
 * `#dispatchFrame` synthesizes them when wrapping `JSON.parse` /
 * envelope-shape failures into a `FramingError` (so this mapping
 * function has a single point of dispatch). The synthesis is documented
 * at the call sites in `local-ipc-gateway.ts`.
 */
function mapFramingErrorCode(code: string): JsonRpcErrorCodeValue {
  // BLOCKED-ON-C7 — when error-contracts.md §Plan-007 lands the canonical
  // table, this switch becomes a single table lookup and the virtual-code
  // synthesis at call sites collapses into the table-driven path.
  switch (code) {
    case "invalid_envelope":
    case "oversized_body":
      return JsonRpcErrorCode.InvalidRequest;
    case "header_too_long":
    case "malformed_header":
    case "malformed_content_length":
    case "missing_content_length":
    case "invalid_json":
      return JsonRpcErrorCode.ParseError;
    default:
      // Unknown framing code — defensive fall-through. A new
      // `FramingError.code` string added in `local-ipc-gateway.ts` should
      // be wired explicitly above, but if a future T-1 amendment forgets
      // to update this mapping, the safe default is "treat as parse
      // failure" rather than "leak as internal error" — the framing layer
      // by definition signals a wire-level failure, not a daemon-internal
      // one.
      return JsonRpcErrorCode.ParseError;
  }
}

// --------------------------------------------------------------------------
// RegistryDispatchError code → JSON-RPC numeric mapping
// --------------------------------------------------------------------------

/**
 * Map T-3's `RegistryDispatchError.registryCode` discriminated string to
 * the JSON-RPC numeric. The mapping is fixed per the registry's JSDoc
 * contract at `registry.ts` lines 195-222:
 *
 *   * `"method_not_found"` — registered method missing from registry. →
 *     `-32601 MethodNotFound` per JSON-RPC §5.1.
 *   * `"invalid_params"` — `paramsSchema.safeParse(params)` failed. The
 *     handler was NEVER invoked (I-007-7). → `-32602 InvalidParams`.
 *   * `"invalid_result"` — `resultSchema.safeParse(result)` failed
 *     against the handler's resolved value. This is a PROGRAMMER ERROR
 *     (the handler returned malformed data); the client did nothing
 *     wrong. → `-32603 InternalError` per the registry's deliberate
 *     asymmetry "params blames the client; result blames the daemon".
 */
function mapRegistryDispatchCode(
  code: RegistryDispatchError["registryCode"],
): JsonRpcErrorCodeValue {
  // BLOCKED-ON-C7 — when error-contracts.md §Plan-007 lands the canonical
  // table, this switch is replaced by a table lookup that ALSO drives the
  // `error.data.code` project dotted-namespace string.
  switch (code) {
    case "method_not_found":
      return JsonRpcErrorCode.MethodNotFound;
    case "invalid_params":
      return JsonRpcErrorCode.InvalidParams;
    case "invalid_result":
      return JsonRpcErrorCode.InternalError;
  }
}

// --------------------------------------------------------------------------
// Internal carry-data shape (BLOCKED-ON-C7 substrate field)
// --------------------------------------------------------------------------

/**
 * Build the `error.data` payload for a thrown value. Returns `undefined`
 * when no structured data is available — the caller (the envelope-builder
 * below) honors `exactOptionalPropertyTypes: true` by omitting the field
 * rather than assigning `undefined`.
 *
 * Current data shape (BLOCKED-ON-C7):
 *   * `registryCode?: string` — for `RegistryDispatchError` only. Carries
 *     the registry's stable string code so downstream observability /
 *     test code can introspect the dispatch failure without parsing the
 *     human-readable message. Once C-7 lands, this field is replaced by
 *     the canonical project dotted-namespace `code: string` from the
 *     error-contracts.md §Plan-007 table — we keep the shape but rename
 *     the key.
 *   * `issues?: ReadonlyArray<unknown>` — for `RegistryDispatchError`
 *     with non-empty issues only. Carries the raw zod issue array so
 *     clients can introspect schema-validation failures.
 *
 * The `data.registryCode` field is a STABLE INTERNAL field for T-2
 * substrate carry. It is documented as "T-2 substrate carry; replaced by
 * canonical project dotted code when C-7 lands." Test code MAY assert on
 * it; the canonical mapping in error-contracts.md MUST establish a
 * migration path that does not break existing assertions (e.g. by
 * keeping `registryCode` alongside the new `code` field during a
 * deprecation window, or by mechanically renaming at C-7-land time).
 *
 * Recommendation: include `registryCode` for `RegistryDispatchError`
 * inputs only; omit for `FramingError` and `unknown` inputs.
 * Alternative considered: include a `framingCode` for `FramingError` too,
 *   for symmetry. Why this loses: the framing layer is wire-level and
 *   not a domain failure; downstream callers don't need the framing
 *   code on the wire (they need the JSON-RPC numeric, which already
 *   communicates "framing failure" via `-32700`). Adding `framingCode`
 *   creates a wire surface we'd then need to either preserve or remove
 *   at C-7-land time.
 * Trade-off accepted: tests that want to discriminate the SPECIFIC
 *   framing code can introspect the disconnect reason in supervision
 *   hooks rather than the wire envelope.
 */
function buildErrorData(thrown: unknown): unknown | undefined {
  if (thrown instanceof RegistryDispatchError) {
    if (thrown.issues !== undefined && thrown.issues.length > 0) {
      // BLOCKED-ON-C7: when the canonical table lands, this object grows
      // a `code: <project-dotted-namespace-code>` field driven by the
      // table. The `registryCode` field documented above is the
      // transitional substrate carry.
      return {
        registryCode: thrown.registryCode,
        issues: thrown.issues,
      };
    }
    return { registryCode: thrown.registryCode };
  }
  return undefined;
}

// --------------------------------------------------------------------------
// mapJsonRpcError — public entry point
// --------------------------------------------------------------------------

/**
 * Discriminate an arbitrary thrown value from the gateway's dispatch path
 * and produce a sanitized `JsonRpcErrorResponse` envelope ready for the
 * wire. Every error.message is sanitized via T-1's `sanitizeErrorMessage`
 * (I-007-8 enforcement); every error.code is one of the JSON-RPC 2.0 spec
 * numerics in `JsonRpcErrorCode` (BLOCKED-ON-C7 anchor for the project
 * dotted-namespace table).
 *
 * Discrimination order:
 *   1. `RegistryDispatchError` — the registry's typed dispatch failure
 *      surface. `registryCode` selects the JSON-RPC numeric per the
 *      `mapRegistryDispatchCode` table; `issues` carries on `error.data`
 *      when present.
 *   2. `FramingError` — T-1's framing-layer / envelope-shape failure
 *      surface. `code` selects the JSON-RPC numeric per the
 *      `mapFramingErrorCode` table; no `error.data` is populated (the
 *      framing layer is wire-level, not domain-level — see
 *      `buildErrorData` rationale).
 *   3. Anything else — handler-thrown `Error` / `string` / arbitrary
 *      thrown value. Collapses to `-32603 Internal Error` with the
 *      sanitized message. NO `error.data` populated; the project
 *      dotted-namespace mapping for handler-thrown registered domain
 *      errors lands at C-7-time (the registry-side error envelope is
 *      Plan-001's `resource.limit_exceeded` shape, but the wire
 *      conversion is BLOCKED-ON-C7).
 *
 * Per JSON-RPC §5: if the request id was undeterminable (e.g. parse
 * error before id was extracted), the caller MUST pass `null`. This
 * function does not attempt to extract the id from the thrown value —
 * that is the caller's concern. Pass the request id verbatim from
 * `JsonRpcRequest.id` for dispatch-time errors; pass `null` for
 * framing-layer / parse-error scenarios.
 */
export function mapJsonRpcError(
  thrown: unknown,
  requestId: JsonRpcId,
): JsonRpcErrorResponse {
  // Step 1: select the JSON-RPC numeric code via discriminator. Order
  // matters — RegistryDispatchError before FramingError before generic
  // throw — because (a) the registry surface is the most specific and
  // (b) the FramingError path is structurally distinct (synthesized at
  // T-1's framing/envelope-rejection sites; never thrown from a
  // handler).
  let numericCode: JsonRpcErrorCodeValue;
  let data: unknown | undefined;
  if (thrown instanceof RegistryDispatchError) {
    numericCode = mapRegistryDispatchCode(thrown.registryCode);
    data = buildErrorData(thrown);
  } else if (thrown instanceof FramingError) {
    numericCode = mapFramingErrorCode(thrown.code);
    data = undefined;
  } else {
    // Per JSON-RPC §5.1: "Internal JSON-RPC error" — the catch-all for
    // unexpected throws inside the handler body. The handler's failure
    // is a daemon-internal one, not a client-protocol one; -32603 is
    // the canonical numeric.
    //
    // BLOCKED-ON-C7: when the canonical table lands, REGISTERED domain
    // errors thrown from handlers (e.g. a typed `SessionNotFoundError`)
    // will discriminate here as a third explicit branch and select the
    // appropriate JSON-RPC numeric per the table. Until then, every
    // unregistered throw collapses to -32603.
    numericCode = JsonRpcErrorCode.InternalError;
    data = undefined;
  }

  // Step 2: sanitize the message (I-007-8 enforcement). T-1's
  // `sanitizeErrorMessage` strips stack traces, Unix absolute paths,
  // UNC paths, and Windows-drive paths. We DO NOT reimplement here — the
  // single sanitization seam keeps the security posture auditable in
  // one place.
  const sanitizedMessage = sanitizeErrorMessage(thrown);

  // Step 3: build the envelope. `exactOptionalPropertyTypes: true`
  // requires conditional spread for the optional `data` field — we
  // OMIT the field rather than assign `undefined`. Mirrors the pattern
  // already in use in T-1's `#sendErrorResponse`.
  const error: JsonRpcError = {
    code: numericCode,
    message: sanitizedMessage,
    ...(data !== undefined ? { data } : {}),
  };

  return {
    jsonrpc: JSONRPC_VERSION,
    id: requestId,
    error,
  };
}
