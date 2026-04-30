// `session.read` JSON-RPC handler — Plan-007 Phase 3 (T-007p-3-1).
//
// Spec coverage:
//   * Spec-007 §Required Behavior + §Interfaces And Contracts (lines 71-78) —
//     `session.read` is the V1 vertical-slice READ method: a peer process
//     opens a connection, completes the `daemon.hello` handshake (Plan-007
//     Phase 2 / T-007p-2-4), then dispatches `session.read` to fetch a
//     session's current snapshot + timeline cursor metadata.
//   * Plan-007 §Tier-1 Implementation Tasks (T-007p-3-1) — bind the four
//     `session.*` handlers; this file is the `read` slice.
//   * CP-007-1 — verifies the handler is registered against the canonical
//     method name with the correct mutating-flag (read methods register
//     `mutating: false`).
//
// Invariants this module participates in (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-1 / I-007-6 / I-007-7 / I-007-8 — same posture as the
//     `session.create` slice. See `session-create.ts` for the canonical
//     write-up; this file inherits the same registry-side guarantees.
//
// Why `mutating: false`: `session.read` does not mutate domain state. The
// pre-handshake mutating-op gate's predicate is `isMutating(method) ===
// true`; flagging `read` as `false` means a connection in `pre` or
// `done-incompatible` state can still call `read`. This matches Spec-007
// §Fallback Behavior lines 67-68 — "If version negotiation fails,
// read-only compatibility may continue, but mutating operations must be
// blocked."
//
// What this file does NOT do (deferred to siblings):
//   * Snapshot construction / projection assembly — owned by the daemon's
//     session service / projector (Plan-001 Phase 3). This file consumes
//     the resulting projection through `SessionReadDeps.readSession`.
//   * Cursor materialization — `timelineCursors.latest` is the head of
//     the per-session sequence; `acknowledged` is the optional last-
//     viewed cursor for the calling participant. The deps' implementor
//     is responsible for both.
//   * Test coverage — owned by T-007p-3-4 (sibling task).
//
// BLOCKED-ON-C6 — `register` call site carries a marker for the canonical
// method-name format pending api-payload-contracts.md §Plan-007.

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
 * (Plan-001 Phase 5) supplies the concrete implementation.
 */
export interface SessionReadDeps {
  /**
   * Read a session's current snapshot + timeline cursor metadata per
   * the canonical `SessionReadRequest`. Returns the projection
   * (`SessionReadResponse`) the wire client receives. Domain-side
   * errors (session not found, permission denied, persistence failure)
   * MUST surface as thrown `Error` instances — the registry's
   * `dispatch()` wrapper catches them and applies `mapJsonRpcError`
   * per I-007-8.
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
 * matches Spec-007 §Fallback Behavior — read-only compatibility
 * continues across version-mismatch.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * I-007-6 rejects duplicate registration at register-time.
 */
export function registerSessionRead(registry: MethodRegistry, deps: SessionReadDeps): void {
  const handler: Handler<SessionReadRequest, SessionReadResponse> = async (params) => {
    return deps.readSession(params);
  };

  // BLOCKED-ON-C6: method-name canonical format pending api-payload-contracts.md §Plan-007
  registry.register("session.read", SessionReadRequestSchema, SessionReadResponseSchema, handler, {
    mutating: false,
  });
}
