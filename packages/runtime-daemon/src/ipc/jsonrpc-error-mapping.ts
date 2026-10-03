// JSON-RPC error mapping: turns a value thrown on the dispatch path into a sanitized
// `JsonRpcErrorResponse` whose `data.type` is a dotted project identifier (or a JSON-RPC framework
// identifier such as `invalid_params` for a substrate failure).
//
// * Both text channels are sanitized before the wire: `error.message` through
//   `sanitizeErrorMessage`, `error.data.fields` through `sanitizeFields`. Both strip stack traces
//   and absolute paths via `redactPathsFromString`; `sanitizeFields` also replaces JSON-unsafe
//   values with sentinel strings so a hostile `fields` payload cannot make `encodeFrame` throw.
// * A `RegistryDispatchError` with `invalid_params` is thrown before the handler runs.
// * Notifications get no response; the gateway calls this module only when one is owed.

import type {
  JsonRpcError,
  JsonRpcErrorCodeValue,
  JsonRpcErrorData,
  JsonRpcErrorResponse,
  JsonRpcId,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { SecureDefaultsValidationError } from "../bootstrap/secure-defaults.js";
import { FramingError } from "./content-length-framing.js";
import { DaemonDomainError } from "./domain-error.js";
import { redactPathsFromString, sanitizeErrorMessage } from "./local-ipc-gateway.js";
import { NegotiationError } from "./protocol-negotiation.js";
import { RegistryDispatchError } from "./registry.js";
import { SessionNotFoundError } from "./session-errors.js";

/**
 * Maps a `FramingError.code` to a JSON-RPC numeric: a desynced or unparseable wire is `-32700`, a
 * framed but malformed request `-32600`. The gateway wraps `invalid_json`, `invalid_envelope` and
 * `invalid_protocol_version` in a `FramingError`, so this is the single mapping point.
 */
function mapFramingErrorCode(code: string): JsonRpcErrorCodeValue {
  switch (code) {
    case "invalid_envelope":
    case "invalid_protocol_version":
    case "oversized_body":
      return JsonRpcErrorCode.InvalidRequest;
    case "header_too_long":
    case "malformed_header":
    case "malformed_content_length":
    case "missing_content_length":
    case "invalid_json":
      return JsonRpcErrorCode.ParseError;
    default:
      // An unknown framing code is still a wire-level failure, not an internal error.
      return JsonRpcErrorCode.ParseError;
  }
}

/**
 * Maps a `FramingError.code` to `data.type`: an oversized body is `transport.message_too_large` and
 * a bad per-request version is `transport.invalid_protocol_version` (not the negotiation gate's
 * `protocol.version_mismatch`); other codes pass through.
 */
function framingErrorDataType(code: string): string {
  if (code === "oversized_body") {
    return "transport.message_too_large";
  }
  if (code === "invalid_protocol_version") {
    return "transport.invalid_protocol_version";
  }
  return code;
}

/**
 * Maps `RegistryDispatchError.registryCode` to a JSON-RPC numeric. `invalid_result` is a daemon
 * fault (`-32603`); `invalid_params` blames the client and the handler never ran.
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

/** Build `data` for a `RegistryDispatchError`; Zod issues ride in `data.fields.issues`. */
function buildRegistryDispatchData(thrown: RegistryDispatchError): JsonRpcErrorData {
  if (thrown.issues !== undefined && thrown.issues.length > 0) {
    return {
      type: thrown.registryCode,
      fields: { issues: thrown.issues },
    };
  }
  return { type: thrown.registryCode };
}

/** Build `data` for a `FramingError`; an oversized body carries `{ limit, observed }` bytes. */
function buildFramingErrorData(thrown: FramingError): JsonRpcErrorData {
  const type = framingErrorDataType(thrown.code);
  if (thrown.fields !== undefined) {
    return { type, fields: thrown.fields };
  }
  return { type };
}

function buildNegotiationErrorData(thrown: NegotiationError): JsonRpcErrorData {
  if (thrown.fields !== undefined) {
    return { type: thrown.negotiationCode, fields: thrown.fields };
  }
  return { type: thrown.negotiationCode };
}

function buildSecureDefaultsValidationData(
  thrown: SecureDefaultsValidationError,
): JsonRpcErrorData {
  if (thrown.fields !== undefined) {
    return { type: thrown.code, fields: thrown.fields };
  }
  return { type: thrown.code };
}

function buildSessionNotFoundData(thrown: SessionNotFoundError): JsonRpcErrorData {
  if (thrown.fields !== undefined) {
    return { type: thrown.code, fields: thrown.fields };
  }
  return { type: thrown.code };
}

/** Builds `data` for a `DaemonDomainError`: `detail` becomes `data.fields`. */
function buildDomainErrorData(thrown: DaemonDomainError): JsonRpcErrorData {
  if (thrown.detail !== undefined) {
    return { type: thrown.code, fields: thrown.detail };
  }
  return { type: thrown.code };
}

/** Longest string kept in a sanitized value, so one long string cannot balloon the envelope. */
const FIELDS_VALUE_MAX_LEN = 512;

/** Most keys kept per object; real error payloads have two to five. */
const FIELDS_MAX_KEYS = 32;

/** Most elements kept per array; Zod issue arrays are typically one to five entries. */
const FIELDS_MAX_ARRAY_LEN = 32;

/** Deepest nesting the walk follows; real payloads are two or three levels deep. */
const FIELDS_MAX_DEPTH = 6;

/**
 * Most nodes (primitives, keys, elements) the walk visits. The per-level caps alone allow a billion
 * nodes; 1024 nodes of 512 characters stay near 512KB, under the 1MB framing cap.
 */
const FIELDS_MAX_NODES = 1024;

/** Stable strings for values that cannot be sent, styled like `<redacted-path>`. */
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

/** Node budget shared by reference through the recursive walk. */
interface SanitizationBudget {
  remaining: number;
}

/**
 * Sanitizes a `data.fields` payload for the wire: strings are path-redacted and capped, and values
 * `JSON.stringify` would drop or throw on (BigInt, cycles, symbols) become sentinels or strings.
 * A nested value that throws when read becomes a sentinel, since a throw would crash
 * `mapJsonRpcError`. It does not catch non-path secrets.
 */
export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const budget: SanitizationBudget = { remaining: FIELDS_MAX_NODES };
  const seen = new WeakSet<object>();
  // No prototype, so a reserved key that slips past the skip list cannot pollute one.
  const result: Record<string, unknown> = Object.create(null);
  let keyCount = 0;
  const entries = Object.entries(fields);
  for (const [key, value] of entries) {
    if (keyCount >= FIELDS_MAX_KEYS) {
      result[SENTINEL_TRUNCATED_KEYS_KEY] = `${entries.length - FIELDS_MAX_KEYS}-more-keys`;
      break;
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      // Skipped so the wire payload is unambiguous for consumers using `Object` prototypes.
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

/** Sanitizes one value by type. Mutates `budget` and `seen`, so not safe for concurrent use. */
function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: SanitizationBudget,
): unknown {
  if (depth > FIELDS_MAX_DEPTH) {
    return SENTINEL_TRUNCATED_DEPTH;
  }

  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    // `JSON.stringify` would turn these into `null`, losing the fact that one was captured.
    if (Number.isNaN(value)) return SENTINEL_NON_FINITE_NAN;
    if (value === Number.POSITIVE_INFINITY) return SENTINEL_NON_FINITE_POS_INF;
    if (value === Number.NEGATIVE_INFINITY) return SENTINEL_NON_FINITE_NEG_INF;
    return value;
  }

  if (typeof value === "bigint") {
    // `JSON.stringify` throws on a bigint.
    return capString(redactPathsFromString(`${value.toString()}n`));
  }

  if (typeof value === "string") {
    return capString(redactPathsFromString(value));
  }

  if (typeof value === "symbol") {
    // `JSON.stringify` drops symbol values (`null` in arrays); the sentinel keeps the fact.
    return SENTINEL_SYMBOL;
  }

  if (typeof value === "function") {
    // Dropped by `JSON.stringify` like a symbol.
    return SENTINEL_FUNCTION;
  }

  if (typeof value === "object") {
    // `seen` is the ancestor chain, popped in `finally`: siblings sharing a reference serialize as
    // data and only a true back-edge becomes the circular sentinel.
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
          // A Proxy with a throwing `get` trap lands in the outer catch.
          out.push(sanitizeValue(value[i], depth + 1, seen, budget));
        }
        if (value.length > FIELDS_MAX_ARRAY_LEN) {
          out.push(`<truncated:${value.length - FIELDS_MAX_ARRAY_LEN}-more>`);
        }
        return out;
      }

      // Own enumerable string keys only, the shape JSON emits: class instances show their data
      // fields, and symbol keys are skipped.
      const out: Record<string, unknown> = Object.create(null);
      // A throwing getter or Proxy `ownKeys` trap lands in the catch below.
      const entries = Object.entries(value);
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
      // A throwing getter, `toString` or Proxy trap; the sentinel keeps the envelope well-formed.
      return SENTINEL_UNSANITIZEABLE;
    } finally {
      seen.delete(value);
    }
  }
}

/** Cap a string at `FIELDS_VALUE_MAX_LEN` with the same suffix as `sanitizeErrorMessage`. */
function capString(value: string): string {
  if (value.length <= FIELDS_VALUE_MAX_LEN) {
    return value;
  }
  return `${value.slice(0, FIELDS_VALUE_MAX_LEN - "…[truncated]".length)}…[truncated]`;
}

/**
 * Turns any value thrown on the gateway's dispatch path into a sanitized `JsonRpcErrorResponse`.
 * `requestId` is echoed verbatim (`null` for a framing or parse error); no id is read from it.
 */
export function mapJsonRpcError(thrown: unknown, requestId: JsonRpcId): JsonRpcErrorResponse {
  let numericCode: JsonRpcErrorCodeValue;
  let data: JsonRpcErrorData | undefined;
  if (thrown instanceof RegistryDispatchError) {
    numericCode = mapRegistryDispatchCode(thrown.registryCode);
    data = buildRegistryDispatchData(thrown);
  } else if (thrown instanceof FramingError) {
    numericCode = mapFramingErrorCode(thrown.code);
    data = buildFramingErrorData(thrown);
  } else if (thrown instanceof NegotiationError) {
    // The request is valid JSON-RPC but violates the connection's protocol state.
    numericCode = JsonRpcErrorCode.InvalidRequest;
    data = buildNegotiationErrorData(thrown);
  } else if (thrown instanceof SessionNotFoundError) {
    // A missing resource is a param-shape failure: the supplied sessionId does not resolve.
    numericCode = JsonRpcErrorCode.InvalidParams;
    data = buildSessionNotFoundData(thrown);
  } else if (thrown instanceof SecureDefaultsValidationError) {
    // Boot-time config is the person's request parameters, so a bad setting is invalid params.
    numericCode = JsonRpcErrorCode.InvalidParams;
    data = buildSecureDefaultsValidationData(thrown);
  } else if (thrown instanceof DaemonDomainError) {
    // The error carries its own wire mapping; `detail` becomes `data.fields`.
    numericCode = thrown.jsonRpcCode ?? JsonRpcErrorCode.InternalError;
    data = buildDomainErrorData(thrown);
  } else {
    // Only registered failures carry `data`, so its absence marks an unregistered internal one.
    numericCode = JsonRpcErrorCode.InternalError;
    data = undefined;
  }

  // Sanitize here, once, and never inside a builder, so a future builder cannot skip it.
  if (data !== undefined && data.fields !== undefined) {
    data = { type: data.type, fields: sanitizeFields(data.fields) };
  }

  const sanitizedMessage = sanitizeErrorMessage(thrown);

  // `exactOptionalPropertyTypes` requires omitting `data` rather than assigning `undefined`.
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
