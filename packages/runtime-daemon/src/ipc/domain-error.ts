/**
 * Base class for daemon namespace errors that project into the JSON-RPC error envelope. One
 * `instanceof DaemonDomainError` branch in `mapJsonRpcError` (`jsonrpc-error-mapping.ts`)
 * handles the whole family: `code` becomes `data.type`, `detail` becomes `data.fields` after
 * `sanitizeFields`, and `jsonRpcCode` selects the numeric. Consumers discriminate on `data.type`;
 * a bare `-32603` with no `data.type` is an unclassified daemon failure.
 */

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

/**
 * The JSON-RPC numeric a domain error may project to, bound to the canonical `JsonRpcErrorCode`
 * constants. Only three are allowed: `InvalidRequest` (well-formed JSON-RPC that violates a
 * protocol-state or shape contract), `InvalidParams` (the supplied id does not resolve, so a
 * not-found error rides `-32602` like `session.not_found`), and `InternalError` (the default).
 * Parse and method-not-found belong to framing and the registry, never to a domain error.
 */
export type DomainErrorJsonRpcCode =
  | typeof JsonRpcErrorCode.InvalidRequest
  | typeof JsonRpcErrorCode.InvalidParams
  | typeof JsonRpcErrorCode.InternalError;

/**
 * The wire-projection contract a `DaemonDomainError` carries, passed as the second constructor
 * argument after the human-readable `message`.
 */
export interface DaemonDomainErrorOptions {
  /** Canonical dotted identifier, projected verbatim into the envelope's `data.type`. */
  readonly code: string;
  /** Numeric for `error.code`; the mapper uses `-32603` when omitted. */
  readonly jsonRpcCode?: DomainErrorJsonRpcCode;
  /**
   * Structured throw-site detail, projected into `data.fields` after the mapper's `sanitizeFields`
   * (path redaction, JSON-safety, depth and width caps).
   */
  readonly detail?: Record<string, unknown>;
}

/**
 * Base class for daemon namespace errors with a self-describing JSON-RPC wire projection. It can
 * be thrown directly (`new DaemonDomainError("repo X not found", { code: "repo.not_found" })`) or
 * extended to fix `code` and `jsonRpcCode` in a named subclass.
 *
 * Optional fields are assigned behind `if (x !== undefined)` because `exactOptionalPropertyTypes`
 * rejects assigning a possibly-`undefined` option. Under `useDefineForClassFields` an unset field
 * is still an own property holding `undefined`, so the mapper tests values, not key presence.
 * `name` comes from `new.target.name` so a subclass reports its own class name in stack traces.
 */
export class DaemonDomainError extends Error {
  /** Canonical dotted identifier; becomes envelope `data.type`. */
  readonly code: string;
  /** JSON-RPC numeric; becomes envelope `error.code`. */
  readonly jsonRpcCode?: DomainErrorJsonRpcCode;
  /** Structured detail; becomes envelope `data.fields` after sanitizing. */
  readonly detail?: Record<string, unknown>;

  constructor(message: string, options: DaemonDomainErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    if (options.jsonRpcCode !== undefined) {
      this.jsonRpcCode = options.jsonRpcCode;
    }
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }
}
