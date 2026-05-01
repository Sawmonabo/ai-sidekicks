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
//     sanitized payloads) — mapping-side: BOTH channels of the error
//     envelope flow through dedicated sanitizers before reaching the
//     wire. The `error.message` channel flows through T-1's
//     `sanitizeErrorMessage`; the `error.data.fields` channel flows
//     through this module's `sanitizeFields`. Stack traces, absolute
//     filesystem paths, and UNC / Windows-drive paths are stripped from
//     both channels via the shared `redactPathsFromString` primitive
//     extracted into the substrate (`local-ipc-gateway.ts`).
//     `sanitizeFields` additionally normalizes JSON-unsafe values
//     (BigInt, circular references, symbols, functions, NaN/±Infinity)
//     into stable sentinel strings so `encodeFrame.JSON.stringify`
//     cannot be DoS'd by a hostile or buggy `error.fields` payload.
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
//   for `transport.message_too_large`).
//
// What this module does NOT do:
//   * Reimplement message-channel sanitization. T-1's
//     `sanitizeErrorMessage` is the single I-007-8 seam for the
//     `error.message` string; we IMPORT and reuse it.
//   * Reimplement path-shape regex matching. T-1's
//     `redactPathsFromString` is the single primitive shared between
//     `sanitizeErrorMessage` (single-string sanitization) and
//     `sanitizeFields` (recursive structured-value sanitization); both
//     I-007-8 enforcement seams use it.
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
import { FramingError, redactPathsFromString, sanitizeErrorMessage } from "./local-ipc-gateway.js";
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
 * The `oversized_body` row projects to the registered transport-layer
 * code `transport.message_too_large` (HTTP 413 semantic per §Error Codes
 * §Transport). This is intentionally distinct from `resource.limit_exceeded`
 * (Spec-001 quota-enforcement code, HTTP 429): a wire frame exceeding the
 * 1MB body cap is a TRANSPORT failure (peer is mis-using the framing
 * layer) — it is NOT a domain-level resource limit (which describes
 * sessions / runs / invites being created at a rate above
 * `ResourceLimitExceededDetailsSchema`'s `{resource, limit, current}`
 * contract). Conflating them violates the Spec-001 strict-schema invariant
 * and makes 413-semantic peer mis-framing indistinguishable from 429-
 * semantic quota saturation in downstream observability.
 *
 * The rest of the framing codes project directly through their framing-
 * code string (which carries no domain meaning, only wire-level meaning).
 * The §JSON-RPC Wire Mapping table permits framework-level identifiers in
 * `data.type` for substrate-only concerns — `invalid_json`,
 * `invalid_envelope`, `malformed_header` etc. are not §Error Codes
 * registry entries but they are stable, documented substrate-level
 * identifiers that downstream test/observability code can discriminate
 * against.
 */
function framingErrorDataType(code: string): string {
  if (code === "oversized_body") {
    return "transport.message_too_large";
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
 * `oversized_body` path projects to `transport.message_too_large` (HTTP
 * 413 semantic) with the captured byte counts; other framing codes
 * project their framing-code string directly. Throw sites that capture
 * structured detail (e.g. `{ limit, observed }` for `oversized_body`)
 * propagate it through `error.fields`.
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
// sanitizeFields — I-007-8 enforcement for `data.fields` (BL-103 hardening)
// --------------------------------------------------------------------------

/**
 * Per-string length cap for sanitized `data.fields` values. Keeps a single
 * pathological string from ballooning the response envelope past the
 * substrate's 1MB framing cap. 512 chars covers any legitimate
 * structured-detail value (paths post-redaction, version strings, settings
 * names, BigInt coercions); a value longer than this is almost certainly
 * a hostile or buggy input rather than legitimate context.
 */
const FIELDS_VALUE_MAX_LEN = 512;

/**
 * Per-object property cap. Real `error.fields` payloads in this codebase
 * are flat with 2-5 keys (`{setting, value}`, `{limit, observed}`,
 * `{reason}`, `{issues}`). 32 is a comfortable headroom multiple while
 * still bounding hostile object widths.
 */
const FIELDS_MAX_KEYS = 32;

/**
 * Per-array length cap. Mirrors `FIELDS_MAX_KEYS` rationale — Zod issue
 * arrays in `RegistryDispatchError.issues` are typically 1-5 entries; 32
 * gives headroom while bounding hostile array widths.
 */
const FIELDS_MAX_ARRAY_LEN = 32;

/**
 * Recursion depth cap for the structured-value walk. Real error metadata
 * in this codebase is flat or 2-3 levels deep (Zod issue `path` arrays
 * are 1-2 deep). 6 covers all legitimate cases while bounding hostile
 * recursion / cyclic structures (the WeakSet-based cycle detector is the
 * primary cycle defense; this is defense-in-depth).
 */
const FIELDS_MAX_DEPTH = 6;

/**
 * Global node-count cap on the recursive walk — aggregate count of
 * primitives, object keys, and array elements visited. Defense-in-depth
 * against the multiplicative-bounded worst case (`FIELDS_MAX_KEYS *
 * FIELDS_MAX_ARRAY_LEN ^ FIELDS_MAX_DEPTH` = 32^6 ≈ 1B nodes if each cap
 * is hit at every level). 1024 nodes × 512 chars per string ≈ 512KB worst
 * case, comfortably below the 1MB framing cap. The 1MB framing cap is
 * the absolute backstop; this cap exists so we fail FAST with stable
 * sentinel strings rather than producing a wire-rejected envelope.
 */
const FIELDS_MAX_NODES = 1024;

/**
 * Sentinel strings substituted for unrepresentable values. Stable across
 * versions so downstream test/observability code can discriminate them.
 * The angle-bracket convention (`<symbol>`, `<truncated:circular>`) is
 * shared with `sanitizeErrorMessage`'s `<redacted-path>` and
 * `<unprintable thrown value>` literals — a single convention for "this
 * substitution happened at the substrate boundary, the original value
 * is structurally unsendable".
 */
const SENTINEL_SYMBOL = "<symbol>";
const SENTINEL_FUNCTION = "<function>";
const SENTINEL_TRUNCATED_DEPTH = "<truncated:max-depth>";
const SENTINEL_TRUNCATED_CIRCULAR = "<truncated:circular>";
const SENTINEL_TRUNCATED_NODES = "<truncated:max-nodes>";
const SENTINEL_NON_FINITE_NAN = "<non-finite:NaN>";
const SENTINEL_NON_FINITE_POS_INF = "<non-finite:Infinity>";
const SENTINEL_NON_FINITE_NEG_INF = "<non-finite:-Infinity>";
const SENTINEL_UNSANITIZEABLE = "<unsanitizeable>";
const SENTINEL_TRUNCATED_KEYS_KEY = "<truncated>";

/**
 * Walk-time mutable counter passed by reference through recursion. A
 * single-property object so the recursive callees can decrement and read
 * the same shared state without parameter shuffling.
 */
interface SanitizationBudget {
  remaining: number;
}

/**
 * Sanitize a `data.fields` payload for wire emission. The I-007-8
 * enforcement seam for the structured-detail channel of the JSON-RPC
 * error envelope.
 *
 * Why this exists: the `error.message` channel has a single-seam
 * sanitizer (`sanitizeErrorMessage` in `local-ipc-gateway.ts`) that
 * strips Unix / UNC / Windows-drive paths and caps length. Before this
 * helper, the parallel `error.data.fields` channel was a verbatim
 * passthrough of the throw site's structured detail — a
 * `SecureDefaultsValidationError` on `--bind-address`, `--banner`, or
 * `--local-ipc-path` carries the operator-supplied raw value into
 * `data.fields.value`, which can be a path-shape, a secret-shape, or a
 * non-JSON-safe type (`BigInt` throws in `JSON.stringify`; circular
 * objects throw; symbols / functions silently drop). All four classes
 * are I-007-8 violations:
 *
 *   1. Confidentiality: an absolute path or secret-shape value bypasses
 *      the path-redaction the message channel applies.
 *   2. DoS: a `BigInt` or circular value crashes
 *      `local-ipc-gateway.ts`'s `encodeFrame.JSON.stringify`, which
 *      destroys the connection (peer sees `ECONNRESET`).
 *   3. Asymmetric I-007-8: only `error.message` was actually enforced
 *      by the substrate; `data.fields` was producer-honor-system.
 *
 * What this function does:
 *   * Recursively walks the structured payload bounded by
 *     `FIELDS_MAX_DEPTH` (6 levels) and `FIELDS_MAX_NODES` (1024 nodes).
 *   * Strings: `redactPathsFromString` (Unix / UNC / Windows-drive
 *     paths → `<redacted-path>`); cap to `FIELDS_VALUE_MAX_LEN`.
 *   * BigInt: coerce to `${n}n` string, redact, cap (BigInt is not JSON-
 *     representable per ECMA-262 25.5.1.1 — `JSON.stringify` throws).
 *   * Non-finite numbers (NaN / ±Infinity): coerce to stable sentinel
 *     (`JSON.stringify` silently emits these as `null`, which loses
 *     diagnostic information).
 *   * Symbol / function: `<symbol>` / `<function>` sentinel
 *     (`JSON.stringify` silently DROPS these as object values and
 *     emits them as `null` in arrays — also lossy).
 *   * Cycles (object refs seen in the same walk): `<truncated:circular>`
 *     sentinel via WeakSet (`JSON.stringify` throws on cycles).
 *   * Object / array width caps: keys after `FIELDS_MAX_KEYS` get a
 *     `<truncated>` summary key; elements after `FIELDS_MAX_ARRAY_LEN`
 *     get a `<truncated:N-more>` trailing element. Both stable and
 *     introspectable.
 *   * Prototype-pollution-immune: result objects use
 *     `Object.create(null)`; reserved keys (`__proto__`, `constructor`,
 *     `prototype`) are skipped during enumeration.
 *
 * Non-throwing contract: `JSON.stringify(sanitizeFields(anything))` MUST
 * NOT throw. `sanitizeFields(anything)` itself MUST NOT throw. Hostile
 * inputs with throwing `Object.entries` getters, throwing `toString`, or
 * `Symbol.toPrimitive` traps are caught and replaced with
 * `<unsanitizeable>`. The substrate's I-007-8 enforcement seam MUST be
 * non-throwing because a throw here would crash `mapJsonRpcError`,
 * which is itself the substrate's only escape hatch for handler errors.
 *
 * What this function does NOT do:
 *   * Strip secrets that don't match path patterns. Same trade-off as
 *     `sanitizeErrorMessage`: handler authors are responsible for not
 *     putting raw secrets in error fields; path-redaction is defense-in-
 *     depth.
 *   * Validate against any registered schema. The `JsonRpcErrorData`
 *     contract is `{type: string, fields?: Record<string, unknown>}`;
 *     this function preserves the shape but normalizes the values.
 */
export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  // Top-level input is contractually a Record. The recursive walker
  // would still handle non-Record input gracefully but the public seam
  // is typed for the contract. Use a fresh budget per call — each
  // sanitization is isolated, no shared state across error responses.
  const budget: SanitizationBudget = { remaining: FIELDS_MAX_NODES };
  const seen = new WeakSet<object>();
  // Object.create(null) avoids prototype-chain pollution if a reserved
  // key like `__proto__` slips past the explicit skip list (defense-in-
  // depth). It also keeps the wire payload identical to `{}` after
  // JSON.stringify, since the encoder reads own enumerable properties.
  const result: Record<string, unknown> = Object.create(null);
  let keyCount = 0;
  let entries: [string, unknown][];
  try {
    entries = Object.entries(fields);
  } catch {
    // Hostile or buggy fields: `Object.entries` invokes property getters
    // and can throw if a getter throws or if `fields` is a Proxy with a
    // throwing `ownKeys` trap. Return empty rather than propagating.
    return result;
  }
  for (const [key, value] of entries) {
    if (keyCount >= FIELDS_MAX_KEYS) {
      result[SENTINEL_TRUNCATED_KEYS_KEY] = `${entries.length - FIELDS_MAX_KEYS}-more-keys`;
      break;
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      // Object.create(null) makes assignment safe (no prototype chain to
      // pollute), but skipping these keys keeps the wire payload
      // unambiguous and prevents downstream `Object`-prototype consumers
      // from misinterpreting them.
      continue;
    }
    if (budget.remaining <= 0) {
      result[SENTINEL_TRUNCATED_KEYS_KEY] = SENTINEL_TRUNCATED_NODES;
      break;
    }
    budget.remaining -= 1;
    result[key] = sanitizeValue(value, 1, seen, budget);
    keyCount += 1;
  }
  return result;
}

/**
 * Recursive value-sanitizer. Type-discriminates the input and applies
 * per-type normalization. Mutates `budget.remaining` and `seen` as a
 * side effect — single-call-tree; not safe for concurrent calls (caller
 * `sanitizeFields` allocates fresh budget+seen per top-level invocation).
 *
 * The `depth` parameter starts at 1 because the top-level `sanitizeFields`
 * call is depth 0 by convention; the first recursion into a value is
 * depth 1. `FIELDS_MAX_DEPTH = 6` allows up to 6 levels of nesting
 * before the depth-cap sentinel kicks in.
 */
function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: SanitizationBudget,
): unknown {
  if (depth > FIELDS_MAX_DEPTH) {
    return SENTINEL_TRUNCATED_DEPTH;
  }

  // Primitives that JSON.stringify handles natively and that carry no
  // secret/path surface. `null` and `undefined` both encode safely
  // (`undefined` becomes `null` in arrays, omitted as object values per
  // ECMA-262 25.5.2.2). We preserve `undefined` here and let the encoder
  // make its decision; sanitization shouldn't second-guess JSON semantics.
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    // JSON.stringify converts NaN/±Infinity to `null` — diagnostic-lossy.
    // Substituting stable sentinels preserves the information that the
    // throw site captured a non-finite value.
    if (Number.isNaN(value)) return SENTINEL_NON_FINITE_NAN;
    if (value === Number.POSITIVE_INFINITY) return SENTINEL_NON_FINITE_POS_INF;
    if (value === Number.NEGATIVE_INFINITY) return SENTINEL_NON_FINITE_NEG_INF;
    return value;
  }

  if (typeof value === "bigint") {
    // BigInt is not JSON-representable: ECMA-262 25.5.1.1 ToJSON throws
    // a TypeError on bigint. We coerce to the canonical `${n}n` string
    // representation (matching `BigInt.prototype.toString` + the `n`
    // suffix convention used by V8 / TC39). Path-redact + length-cap
    // applied uniformly with regular strings.
    let coerced: string;
    try {
      coerced = `${value.toString()}n`;
    } catch {
      // BigInt toString cannot throw on a real bigint, but if a Proxy
      // or hostile prototype manipulation produced something that
      // type-tests as bigint and throws on toString, we have a sentinel.
      return SENTINEL_UNSANITIZEABLE;
    }
    return capString(redactPathsFromString(coerced));
  }

  if (typeof value === "string") {
    return capString(redactPathsFromString(value));
  }

  if (typeof value === "symbol") {
    // JSON.stringify silently drops symbol-VALUED properties (returns
    // undefined, treated as omitted in objects, encoded as `null` in
    // arrays). Sentinel preserves diagnostic information.
    return SENTINEL_SYMBOL;
  }

  if (typeof value === "function") {
    // Same posture as symbol: JSON.stringify drops function values
    // silently. Sentinel preserves the fact that the throw site
    // captured a function reference (almost certainly a bug to surface).
    return SENTINEL_FUNCTION;
  }

  // Object / array branch. `typeof null === "object"` is handled above;
  // by here `value` is a non-null object (or a plain object / array /
  // class instance / Map / Set / etc.).
  if (typeof value === "object") {
    // Cycle detection via DFS-path tracking: `seen` represents the
    // current ancestor chain of in-flight recursion frames, NOT every
    // value visited during the walk. We `add` immediately before
    // descending and `delete` in a `finally` after the descent
    // returns, so two siblings that share a common reference each see
    // an empty `seen` for that reference and serialize it as data
    // rather than as `<truncated:circular>`. The `finally` is load-
    // bearing: a throw inside the recursion (hostile getter, throwing
    // Proxy trap, etc.) still pops the path entry, keeping the
    // WeakSet aligned with the actual call stack. WeakSet membership
    // check happens BEFORE `add`, so a true back-edge — the same
    // reference observed twice on the same ancestor chain — short-
    // circuits to the circular sentinel.
    if (seen.has(value)) {
      return SENTINEL_TRUNCATED_CIRCULAR;
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const out: unknown[] = [];
        const limit = Math.min(value.length, FIELDS_MAX_ARRAY_LEN);
        for (let i = 0; i < limit; i++) {
          if (budget.remaining <= 0) {
            out.push(SENTINEL_TRUNCATED_NODES);
            return out;
          }
          budget.remaining -= 1;
          // `value[i]` can throw if the array is a Proxy with a
          // throwing get trap; the outer try/catch handles it by
          // returning the unsanitizeable sentinel for the entire array.
          out.push(sanitizeValue(value[i], depth + 1, seen, budget));
        }
        if (value.length > FIELDS_MAX_ARRAY_LEN) {
          out.push(`<truncated:${value.length - FIELDS_MAX_ARRAY_LEN}-more>`);
        }
        return out;
      }

      // Plain object branch. We deliberately use Object.entries (own
      // enumerable string-keyed properties only — same shape JSON
      // emits) rather than walking the prototype chain. This means
      // class instances surface only their own data fields, not
      // inherited methods (which would be functions anyway). Symbol-
      // keyed properties are skipped entirely (JSON.stringify ignores
      // them too).
      const out: Record<string, unknown> = Object.create(null);
      let entries: [string, unknown][];
      try {
        entries = Object.entries(value);
      } catch {
        return SENTINEL_UNSANITIZEABLE;
      }
      let keyCount = 0;
      for (const [key, child] of entries) {
        if (keyCount >= FIELDS_MAX_KEYS) {
          out[SENTINEL_TRUNCATED_KEYS_KEY] = `${entries.length - FIELDS_MAX_KEYS}-more-keys`;
          break;
        }
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          continue;
        }
        if (budget.remaining <= 0) {
          out[SENTINEL_TRUNCATED_KEYS_KEY] = SENTINEL_TRUNCATED_NODES;
          break;
        }
        budget.remaining -= 1;
        out[key] = sanitizeValue(child, depth + 1, seen, budget);
        keyCount += 1;
      }
      return out;
    } catch {
      // Hostile input: throwing getter, throwing toString invoked by
      // some implicit coercion, throwing Proxy trap, etc. Return the
      // catch-all sentinel so the wire envelope stays well-formed.
      return SENTINEL_UNSANITIZEABLE;
    } finally {
      // Pop this value from the ancestor chain. Matched with the
      // `seen.add(value)` above; WeakSet.delete is a no-op if the
      // value was never added (defensive against rearrangement).
      seen.delete(value);
    }
  }

  // Unreachable: `typeof` returns one of `undefined / boolean / number /
  // bigint / string / symbol / function / object`, all handled above.
  // Defense-in-depth sentinel for any future `typeof` extension or
  // type-system blind spot.
  return SENTINEL_UNSANITIZEABLE;
}

/**
 * Length-cap a string at `FIELDS_VALUE_MAX_LEN`, suffixing with the
 * stable `…[truncated]` marker (mirroring `sanitizeErrorMessage`'s
 * truncation suffix for surface consistency).
 */
function capString(value: string): string {
  if (value.length <= FIELDS_VALUE_MAX_LEN) {
    return value;
  }
  return `${value.slice(0, FIELDS_VALUE_MAX_LEN - "…[truncated]".length)}…[truncated]`;
}

// --------------------------------------------------------------------------
// mapJsonRpcError — public entry point
// --------------------------------------------------------------------------

/**
 * Discriminate an arbitrary thrown value from the gateway's dispatch path
 * and produce a sanitized `JsonRpcErrorResponse` envelope ready for the
 * wire. Every `error.message` is sanitized via T-1's `sanitizeErrorMessage`
 * (I-007-8 enforcement on the message channel); every `error.data.fields`
 * is sanitized via `sanitizeFields` (I-007-8 enforcement on the structured-
 * detail channel — added 2026-05-01 per Codex review of PR #26 closing the
 * confidentiality + DoS gaps documented in BL-103); every `error.code` is
 * one of the JSON-RPC 2.0 spec numerics in `JsonRpcErrorCode`; `error.data`
 * is the canonical two-layer envelope shape ratified at error-contracts.md
 * §JSON-RPC Wire Mapping (BL-103 closed 2026-05-01).
 *
 * I-007-8 multi-channel posture (the canonical text in plan §Invariants
 * lines 107-111 says "Stack traces and secrets MUST never leak through the
 * response" — "the response" is the entire JSON-RPC error envelope, not
 * just `error.message`). Both surfaces of the envelope that carry
 * substrate-or-throw-site-supplied content flow through dedicated
 * sanitizers:
 *
 *     `error.message`      → `sanitizeErrorMessage` (path redaction + length cap)
 *     `error.data.fields`  → `sanitizeFields`       (recursive value normalization)
 *
 * Discrimination order:
 *   1. `RegistryDispatchError` — the registry's typed dispatch failure.
 *      `registryCode` selects the JSON-RPC numeric; `data.type` carries
 *      the registry code verbatim; `data.fields.issues` carries Zod
 *      validation issues when present.
 *   2. `FramingError` — T-1's framing-layer failure. `code` selects the
 *      JSON-RPC numeric; `data.type` projects to
 *      `transport.message_too_large` (HTTP 413 semantic) for
 *      `oversized_body` and to the framing-code string otherwise;
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

  // Step 2: sanitize the structured-detail payload (I-007-8 enforcement
  // on the `data.fields` channel). The data builders (Step 1) project
  // the throw site's typed `error.fields` verbatim; before this step,
  // those values flowed unredacted to the wire — a path-shape value, a
  // BigInt, or a circular reference would either leak operator state or
  // crash `encodeFrame.JSON.stringify`. `sanitizeFields` runs the
  // recursive walk that mirrors `sanitizeErrorMessage`'s posture for the
  // single-string channel. Single-seam: only HERE, never inside the
  // per-class builders, so the I-007-8 enforcement is auditable in one
  // location and cannot be bypassed by a future builder forgetting to
  // sanitize.
  if (data !== undefined && data.fields !== undefined) {
    data = { type: data.type, fields: sanitizeFields(data.fields) };
  }

  // Step 3: sanitize the message (I-007-8 enforcement on the
  // `error.message` channel). T-1's `sanitizeErrorMessage` strips stack
  // traces, Unix absolute paths, UNC paths, and Windows-drive paths. We
  // DO NOT reimplement here — the single sanitization seam keeps the
  // security posture auditable in one place. `redactPathsFromString` is
  // the shared regex primitive between this and `sanitizeFields`.
  const sanitizedMessage = sanitizeErrorMessage(thrown);

  // Step 4: build the envelope. `exactOptionalPropertyTypes: true`
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
