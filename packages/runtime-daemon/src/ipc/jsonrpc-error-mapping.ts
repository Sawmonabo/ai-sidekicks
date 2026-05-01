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
//   * error-contracts.md §JSON-RPC Wire Mapping — canonical numeric ↔
//     project dotted-namespace table (BL-103 closed 2026-05-01). The
//     two-layer envelope (numeric `code` + `data: { type, fields? }`) is
//     ratified there; this module is its substrate-side enforcement seam.
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
// Discriminator architecture (post-BL-103):
//   `mapJsonRpcError` discriminates `instanceof` against the daemon's
//   typed error surfaces and projects each into the canonical JSON-RPC
//   envelope per the §JSON-RPC Wire Mapping table:
//
//     1. RegistryDispatchError     → registryCode → numeric + data.type
//     2. FramingError              → code         → numeric + data.type
//     3. NegotiationError          → negotiationCode → numeric + data.type
//     4. SecureDefaultsValidationError → code     → numeric + data.type
//     5. default (unknown throw)   → -32603 InternalError, no data
//
//   Every branch's `data.type` is a canonical project dotted-namespace
//   identifier (or a JSON-RPC framework identifier like `invalid_params`
//   when the failure is a substrate concern). `data.fields`, when
//   present, carries the structured detail the throw site captured
//   (e.g. `{ setting, value }` for `unknown_setting`, `{ limit, observed }`
//   for `resource.limit_exceeded`).
//
// What this module does NOT do:
//   * Reimplement sanitization. T-1's `sanitizeErrorMessage` is the single
//     I-007-8 enforcement seam; we IMPORT and reuse it.
//   * Discriminate notifications. JSON-RPC notifications (per §4.1) are
//     one-way and MUST NOT receive a response — that is the gateway's
//     concern (it skips the response-emission path entirely for
//     notifications). This module is only invoked when the gateway has
//     already decided a response is owed.

import type {
  JsonRpcError,
  JsonRpcErrorCodeValue,
  JsonRpcErrorData,
  JsonRpcErrorResponse,
  JsonRpcId,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { SecureDefaultsValidationError } from "../bootstrap/secure-defaults.js";
import { FramingError, sanitizeErrorMessage } from "./local-ipc-gateway.js";
import { NegotiationError } from "./protocol-negotiation.js";
import { RegistryDispatchError } from "./registry.js";

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

/**
 * Map T-1's `FramingError.code` to the canonical project dotted-namespace
 * `data.type` per error-contracts.md §JSON-RPC Wire Mapping.
 *
 * The `oversized_body` row is the only framing code that has a registered
 * domain-level dotted code (`resource.limit_exceeded`); the rest project
 * directly through their framing-code string (which carries no domain
 * meaning, only wire-level meaning). The §JSON-RPC Wire Mapping table
 * permits framework-level identifiers in `data.type` for substrate-only
 * concerns — `invalid_json`, `invalid_envelope`, `malformed_header` etc.
 * are not §Error Codes registry entries but they are stable, documented
 * substrate-level identifiers that downstream test/observability code
 * can discriminate against.
 */
function framingErrorDataType(code: string): string {
  if (code === "oversized_body") {
    return "resource.limit_exceeded";
  }
  return code;
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
// data: JsonRpcErrorData builders (per error class)
// --------------------------------------------------------------------------

/**
 * Build the `data: JsonRpcErrorData` payload for a `RegistryDispatchError`.
 * The registry's stable string code (`method_not_found` / `invalid_params`
 * / `invalid_result`) projects directly into `data.type` — these are the
 * JSON-RPC §5.1 framework-level identifiers, not §Error Codes registry
 * entries, but they are the canonical substrate identifiers downstream
 * test / observability code discriminates against. Zod validation issues
 * ride in `data.fields.issues` when present so clients can introspect the
 * specific schema violations.
 */
function buildRegistryDispatchData(thrown: RegistryDispatchError): JsonRpcErrorData {
  if (thrown.issues !== undefined && thrown.issues.length > 0) {
    return {
      type: thrown.registryCode,
      fields: { issues: thrown.issues },
    };
  }
  return { type: thrown.registryCode };
}

/**
 * Build the `data: JsonRpcErrorData` payload for a `FramingError`. The
 * `oversized_body` path projects to `resource.limit_exceeded` with the
 * captured byte counts; other framing codes project their framing-code
 * string directly. Throw sites that capture structured detail (e.g.
 * `{ limit, observed }` for `oversized_body`) propagate it through
 * `error.fields`.
 */
function buildFramingErrorData(thrown: FramingError): JsonRpcErrorData {
  const type = framingErrorDataType(thrown.code);
  if (thrown.fields !== undefined) {
    return { type, fields: thrown.fields };
  }
  return { type };
}

/**
 * Build the `data: JsonRpcErrorData` payload for a `NegotiationError`.
 * `negotiationCode` is already the canonical project dotted-namespace
 * identifier (`protocol.handshake_required` / `protocol.version_mismatch`)
 * per error-contracts.md §JSON-RPC Wire Mapping — project it through to
 * `data.type` verbatim. `error.fields` (when set, e.g. `{ reason }` for
 * `protocol.version_mismatch`) projects through to `data.fields`.
 */
function buildNegotiationErrorData(thrown: NegotiationError): JsonRpcErrorData {
  if (thrown.fields !== undefined) {
    return { type: thrown.negotiationCode, fields: thrown.fields };
  }
  return { type: thrown.negotiationCode };
}

/**
 * Build the `data: JsonRpcErrorData` payload for a
 * `SecureDefaultsValidationError`. The error's stable `code` string is
 * the canonical `data.type` (`unknown_setting`, `invalid_bind_address`,
 * etc.) per error-contracts.md §JSON-RPC Wire Mapping. The structured
 * `{ setting, value }` payload captured at the throw site projects
 * through to `data.fields`.
 */
function buildSecureDefaultsValidationData(
  thrown: SecureDefaultsValidationError,
): JsonRpcErrorData {
  if (thrown.fields !== undefined) {
    return { type: thrown.code, fields: thrown.fields };
  }
  return { type: thrown.code };
}

// --------------------------------------------------------------------------
// mapJsonRpcError — public entry point
// --------------------------------------------------------------------------

/**
 * Discriminate an arbitrary thrown value from the gateway's dispatch path
 * and produce a sanitized `JsonRpcErrorResponse` envelope ready for the
 * wire. Every `error.message` is sanitized via T-1's `sanitizeErrorMessage`
 * (I-007-8 enforcement); every `error.code` is one of the JSON-RPC 2.0
 * spec numerics in `JsonRpcErrorCode`; `error.data` is the canonical
 * two-layer envelope shape ratified at error-contracts.md §JSON-RPC Wire
 * Mapping (BL-103 closed 2026-05-01).
 *
 * Discrimination order:
 *   1. `RegistryDispatchError` — the registry's typed dispatch failure.
 *      `registryCode` selects the JSON-RPC numeric; `data.type` carries
 *      the registry code verbatim; `data.fields.issues` carries Zod
 *      validation issues when present.
 *   2. `FramingError` — T-1's framing-layer failure. `code` selects the
 *      JSON-RPC numeric; `data.type` projects to `resource.limit_exceeded`
 *      for `oversized_body` and to the framing-code string otherwise;
 *      `data.fields` carries the throw-site-captured structured detail
 *      (e.g. `{ limit, observed }` for `oversized_body`).
 *   3. `NegotiationError` — gate-refusal failure. `negotiationCode` is
 *      already the canonical dotted-namespace identifier and projects
 *      directly into `data.type`; `data.fields` carries throw-site detail
 *      (e.g. `{ reason }` for `protocol.version_mismatch`).
 *   4. `SecureDefaultsValidationError` — bootstrap config-validation
 *      failure. `code` selects the JSON-RPC numeric (always `-32602`);
 *      `data.type` carries the validation code verbatim; `data.fields`
 *      carries `{ setting, value }` from the throw site.
 *   5. Anything else — handler-thrown `Error` / `string` / arbitrary
 *      thrown value. Collapses to `-32603 Internal Error` with no
 *      `data` field — the substrate has no canonical projection for an
 *      unregistered throw, and per BL-103 the absence of `data` is the
 *      signal that this is a daemon-internal failure rather than a
 *      registered domain failure.
 *
 * Per JSON-RPC §5: if the request id was undeterminable (e.g. parse
 * error before id was extracted), the caller MUST pass `null`. This
 * function does not attempt to extract the id from the thrown value —
 * that is the caller's concern. Pass the request id verbatim from
 * `JsonRpcRequest.id` for dispatch-time errors; pass `null` for
 * framing-layer / parse-error scenarios.
 */
export function mapJsonRpcError(thrown: unknown, requestId: JsonRpcId): JsonRpcErrorResponse {
  // Step 1: discriminate the thrown value and select numeric code +
  // structured `data` payload. Order matters — the most specific
  // subclass first (RegistryDispatchError, FramingError) before the
  // shared-shape subclasses (NegotiationError,
  // SecureDefaultsValidationError) before the generic catch-all.
  let numericCode: JsonRpcErrorCodeValue;
  let data: JsonRpcErrorData | undefined;
  if (thrown instanceof RegistryDispatchError) {
    numericCode = mapRegistryDispatchCode(thrown.registryCode);
    data = buildRegistryDispatchData(thrown);
  } else if (thrown instanceof FramingError) {
    numericCode = mapFramingErrorCode(thrown.code);
    data = buildFramingErrorData(thrown);
  } else if (thrown instanceof NegotiationError) {
    // Both `protocol.handshake_required` and `protocol.version_mismatch`
    // surface as `-32600 InvalidRequest` per error-contracts.md §JSON-RPC
    // Wire Mapping. The request is structurally valid JSON-RPC, but the
    // per-connection protocol-state contract is violated — JSON-RPC §5.1
    // "the JSON sent is not a valid Request object" at the protocol layer.
    numericCode = JsonRpcErrorCode.InvalidRequest;
    data = buildNegotiationErrorData(thrown);
  } else if (thrown instanceof SecureDefaultsValidationError) {
    // Config-validation failures are `-32602 InvalidParams` per
    // error-contracts.md §Plan-007 Tier 1 Domain Identifiers — daemon
    // boot-time config IS the request parameters from the operator's
    // perspective; rejecting an unknown setting or an invalid bind
    // address is structurally the same shape as rejecting a malformed
    // handler param.
    numericCode = JsonRpcErrorCode.InvalidParams;
    data = buildSecureDefaultsValidationData(thrown);
  } else {
    // Per JSON-RPC §5.1: "Internal JSON-RPC error" — the catch-all for
    // unexpected throws inside the handler body. The handler's failure
    // is a daemon-internal one, not a client-protocol one; -32603 is
    // the canonical numeric. The absence of `data` is intentional: per
    // BL-103, only registered failure surfaces carry `data` so clients
    // can discriminate "registered domain failure" (data present) from
    // "unregistered substrate-internal failure" (data absent).
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
