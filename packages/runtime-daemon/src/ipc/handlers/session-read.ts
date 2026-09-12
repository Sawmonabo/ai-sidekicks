// `session.read` JSON-RPC handler.
//
//   * `session.read` is the V1 vertical-slice READ method: a peer process
//     opens a connection, completes the `daemon.hello` handshake, then
//     dispatches `session.read` to fetch a session's current snapshot +
//     timeline cursor metadata.
//   * Bind the four `session.*` handlers; this file is the `read` slice.
//   * Verifies the handler is registered against the canonical method
//     name with the correct mutating-flag (read methods register
//     `mutating: false`).
//
// Invariants this module participates in (canonical text through):
//   * Same posture as the `session.create` slice.
//
// Why `mutating: false`: `session.read` does not mutate domain state. The
// pre-handshake mutating-op gate's predicate is `isMutating(method) ===
// true`; flagging `read` as `false` means a connection in `pre` or
// `done-incompatible` state can still call `read`. This matches — "If
// version negotiation fails, read-only compatibility may continue, but
// mutating operations must be blocked."
//
// What this file does NOT do (deferred to siblings):
//   * Snapshot construction / projection assembly — owned by the daemon's
//     session service / projector. This file consumes the resulting
//     projection through `SessionReadDeps.readSession`.
//   * Cursor materialization — `timelineCursors.latest` is the head of
//     the per-session sequence; `acknowledged` is the optional last-
//     viewed cursor for the calling user. The deps' implementor
//     is responsible for both.
//
// Method-name format ratified: dotted-camelCase. The `register` call site
// below passes `"session.read"`, which matches the canonical regex.

import type {
  Handler,
  MethodRegistry,
  SessionReadRequest,
  SessionReadResponse,
} from "@ai-sidekicks/contracts";
import { SessionReadRequestSchema, SessionReadResponseSchema } from "@ai-sidekicks/contracts";

/**
 * Dependencies required by `session.read`'s handler closure.
 *
 * The deps interface mirrors the pattern in `session-create.ts`: a
 * single async callback per handler. The bootstrap orchestrator
 * supplies the concrete implementation.
 */
export interface SessionReadDeps {
  /**
   * Read a session's current snapshot + timeline cursor metadata per
   * the canonical `SessionReadRequest`. Returns the projection
   * (`SessionReadResponse`) the wire client receives.
   *
   * Domain-side errors MUST surface as thrown subclasses of `Error` so
   * the registry's `dispatch()` wrapper applies `mapJsonRpcError`.
   * Unknown sessionIds MUST throw `SessionNotFoundError` from
   * `packages/runtime-daemon/src/ipc/session-errors.ts` so the
   * discriminator chain produces the canonical wire envelope `-32602
   * InvalidParams` + `data.type: "session.not_found"`. Other domain
   * failures (permission denied, persistence failure) without registered
   * discriminator branches collapse to `-32603 InternalError`
   * (catch-all) — register new typed subclasses as the V1 surface
   * widens.
   */
  readonly readSession: (request: SessionReadRequest) => Promise<SessionReadResponse>;
}

/**
 * Bind the `session.read` handler onto the supplied method registry.
 *
 * Mutating flag: `mutating: false`. Reading a session does not mutate
 * domain state, so the pre-handshake mutating-op gate's
 * `isMutating(method) === true` predicate evaluates to `false`, and
 * the call passes through regardless of negotiation state. This
 * matches — read-only compatibility continues across
 * version-mismatch.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * rejects duplicate registration at register-time.
 */
export function registerSessionRead(registry: MethodRegistry, deps: SessionReadDeps): void {
  const handler: Handler<SessionReadRequest, SessionReadResponse> = async (params) => {
    return deps.readSession(params);
  };

  registry.register("session.read", SessionReadRequestSchema, SessionReadResponseSchema, handler, {
    mutating: false,
  });
}
