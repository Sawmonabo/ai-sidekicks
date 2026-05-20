// Session-domain error surface for IPC handlers.
//
// Mirrors the `SecureDefaultsValidationError` pattern at
// `packages/runtime-daemon/src/bootstrap/secure-defaults.ts`: a typed Error
// subclass whose stable `code` string projects directly into the JSON-RPC
// envelope's `error.data.type` per `error-contracts.md` §JSON-RPC Wire
// Mapping (line 114 registers `session.not_found` as the canonical
// project dotted-namespace identifier — HTTP 404 equivalent).
//
// Per Plan-007 §Invariants I-007-8 ("handler-thrown errors project to the
// canonical envelope; secrets and stack traces never leak"), the
// discriminator branch for this class lives in `mapJsonRpcError` at
// `packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts`. The numeric
// mapping is `-32602 InvalidParams` per the project's convention that
// "requested resource does not exist" is structurally a param-shape
// failure (the supplied sessionId does not resolve), matching the
// `SecureDefaultsValidationError` "unknown setting" treatment.
//
// Throw sites: per Spec-007 AC-N2 + AC-N3, the `readSession` and
// `joinSession` deps contracts (declared in `handlers/session-read.ts` and
// `handlers/session-join.ts`) MUST surface unknown sessionIds by throwing
// this class. Throwing a plain `Error` collapses to `-32603 InternalError`
// (catch-all) and is a contract violation.

/**
 * Thrown by `SessionReadDeps.readSession` and `SessionJoinDeps.joinSession`
 * when the supplied `sessionId` does not resolve to a known session.
 *
 * The `code` literal is the wire-stable `data.type` discriminator; the
 * optional `fields` carries the structured throw-site detail (the
 * offending `sessionId`, optionally any contextual data) that
 * `mapJsonRpcError` projects through to `data.fields` via
 * `buildSessionNotFoundData`.
 */
export class SessionNotFoundError extends Error {
  readonly code = "session.not_found" as const;
  readonly fields?: Record<string, unknown>;

  constructor(message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "SessionNotFoundError";
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}
