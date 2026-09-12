// DaemonDomainError — generic base for daemon namespace errors that project
// into the JSON-RPC error envelope (error-mapping seam).
//
//   * the canonical two-layer envelope (numeric `code` + `data: { type,
//     fields? Consumers discriminate on `data.type`, never on the coarse
//     numeric — and a bare `-32603` with NO `data.type` remains a genuine
//     daemon-internal failure (the `gdpr.*` / `transport.unavailable`
//     precedent).
//   * Handler-thrown errors project to the canonical envelope with secrets
//     / stack traces stripped. The single `instanceof DaemonDomainError`
//     branch in `mapJsonRpcError` (`jsonrpc-error-mapping.ts`) does the
//     projection; `detail` flows through that module's `sanitizeFields`
//     seam before reaching the wire.
//
// Why a base class: the daemon already has per-error typed surfaces
// (`SessionNotFoundError`, `SecureDefaultsValidationError`, …) each with its
// own `instanceof` branch in `mapJsonRpcError`. As the wider namespace
// plans (repo worktree approvals channels/orchestration) come online, every
// new namespace would otherwise add another near-identical branch.
// `DaemonDomainError` collapses that to ONE branch: any error extending it
// (or thrown as it directly) carries its own wire mapping, so the mapper
// projects the whole family uniformly.
//
// Additive, not a migration: the existing typed-error branches
// (`RegistryDispatchError`, `FramingError`, `NegotiationError`,
// `SessionNotFoundError`, `SecureDefaultsValidationError`) are left exactly
// as-is — they have tested wire behavior and no mandate to re-home onto this
// base. This class is the base for FUTURE namespace errors; the mapper's new
// branch sits immediately before the untyped catch-all so it never shadows a
// more-specific existing branch.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

/**
 * The JSON-RPC numeric a domain error may project to. Deliberately narrowed
 * to the three the project uses for domain failures — bound to the canonical
 * `JsonRpcErrorCode` constants (`@ai-sidekicks/contracts`) rather than raw
 * literals so the union tracks the spec table:
 *
 *   * `InvalidRequest` (`-32600`) — the request is structurally well-formed
 *     JSON-RPC but violates a protocol-state / shape contract.
 *   * `InvalidParams` (`-32602`) — "requested resource does not exist" reads
 *     as a param-shape failure (the supplied id does not resolve); a
 *     not-found namespace error rides `-32602`, like `session.not_found`.
 *   * `InternalError` (`-32603`) — the default when a domain error declares
 *     no more specific numeric.
 *
 * A domain error never mints a parse (`-32700`) or method-not-found
 * (`-32601`) numeric — those are framing / registry substrate concerns, not
 * domain ones.
 */
export type DomainErrorJsonRpcCode =
  | typeof JsonRpcErrorCode.InvalidRequest
  | typeof JsonRpcErrorCode.InvalidParams
  | typeof JsonRpcErrorCode.InternalError;

/**
 * The wire-projection contract a `DaemonDomainError` carries. Passed as the
 * second constructor argument (the first is the human-readable `message`,
 * mirroring `Error(message, options)` and the existing
 * `SessionNotFoundError(message, fields?)` idiom).
 */
export interface DaemonDomainErrorOptions {
  /**
   * The canonical dotted project identifier (e.g. Projects VERBATIM into the
   * envelope's `data.type` — the discriminator consumers switch on.
   */
  readonly code: string;
  /**
   * Optional — when omitted the mapper defaults to `-32603
   * InternalError`.
   */
  readonly jsonRpcCode?: DomainErrorJsonRpcCode;
  /**
   * Carried for control-plane / observability symmetry with the tRPC surface —
   * it is NOT read by the JSON-RPC wire seam (`mapJsonRpcError` selects the
   * numeric from `jsonRpcCode`).
   */
  readonly httpStatus?: number;
  /**
   * Structured throw-site detail (e.g. Projects into the envelope's
   * `data.fields` AFTER passing through `mapJsonRpcError`'s
   * `sanitizeFields` seam (path redaction + JSON-safety + depth/width
   * caps).
   */
  readonly detail?: Record<string, unknown>;
}

/**
 * Base class for daemon namespace errors with a self-describing JSON-RPC wire
 * projection. Concrete (directly throwable) so a handler can
 * `throw new DaemonDomainError("repo X not found", { code: "repo.not_found",
 * jsonRpcCode: -32602, httpStatus: 404, detail: { repoId } })` without a
 * bespoke subclass — and extensible, so a namespace that wants a named type
 * can `extends DaemonDomainError` and fix `code` / `jsonRpcCode` in its own
 * `super(...)` call.
 *
 * The optional fields use `if (x !== undefined) this.x = x` assignment (not a
 * `?? default`) because `exactOptionalPropertyTypes: true` rejects assigning a
 * possibly-`undefined` option to a property whose declared type excludes it.
 * It is a type-level device only: the declarations below are emitted under
 * `useDefineForClassFields: true`, so an unset field is an own property
 * holding `undefined` either way, and it is the mapper's value checks
 * (`thrown.detail !== undefined`, `thrown.jsonRpcCode ?? …`) rather than key
 * presence that read absence. Mirrors `SessionNotFoundError`'s field guard.
 *
 * `name` is set from `new.target.name` so a subclass instance reports its own
 * class name in stack traces without each subclass re-assigning `this.name`.
 */
export class DaemonDomainError extends Error {
  /** Canonical dotted project identifier → envelope `data.type`. */
  readonly code: string;
  /** JSON-RPC numeric → envelope `error.code` (mapper default `-32603`). */
  readonly jsonRpcCode?: DomainErrorJsonRpcCode;
  /** Notional HTTP status; not read by the wire seam. */
  readonly httpStatus?: number;
  /** Structured detail → envelope `data.fields` (sanitized at the mapper seam). */
  readonly detail?: Record<string, unknown>;

  constructor(message: string, options: DaemonDomainErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    if (options.jsonRpcCode !== undefined) {
      this.jsonRpcCode = options.jsonRpcCode;
    }
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }
}
