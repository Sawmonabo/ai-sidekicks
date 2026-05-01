// `session.join` JSON-RPC handler — Plan-007 Phase 3 (T-007p-3-1).
//
// Spec coverage:
//   * Spec-007 §Required Behavior + §Interfaces And Contracts (lines 71-78) —
//     `session.join` is the V1 vertical-slice mutating method that admits a
//     participant into an existing session. A peer process opens a
//     connection, completes the `daemon.hello` handshake, then dispatches
//     `session.join` against the daemon-side method registry.
//   * Plan-007 §Tier-1 Implementation Tasks (T-007p-3-1) — bind the four
//     `session.*` handlers; this file is the `join` slice.
//   * CP-007-1 — verifies the handler is registered against the canonical
//     method name with the correct mutating-flag.
//
// Invariants this module participates in (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-1 / I-007-6 / I-007-7 / I-007-8 — same posture as the
//     `session.create` slice. See `session-create.ts` for the canonical
//     write-up; this file inherits the same registry-side guarantees.
//
// Why `mutating: true`: `session.join` mutates domain state — it admits a
// new participant, materializes a `Membership` row, and emits a canonical
// `membership.joined` event. The pre-handshake mutating-op gate
// (`ProtocolNegotiator`) refuses dispatch on connections without a
// compatible handshake; the gate predicate is `isMutating(method) ===
// true`, so this flag is what makes the gate refuse pre-handshake calls.
//
// What this file does NOT do (deferred to siblings):
//   * Domain-side `joinSession` business logic — owned by the daemon's
//     session/control-plane bridge (Plan-001 Phase 5 + downstream
//     `SessionDirectoryService` integration). This file consumes the
//     resulting projection through `SessionJoinDeps.joinSession`.
//   * Identity-handle grammar enforcement beyond wire-layer guards —
//     `IdentityHandleSchema` in `packages/contracts/src/session.ts`
//     applies length cap + whitespace-only + NUL-byte rejection at parse
//     time; the canonical handle grammar (Unicode normalization, zero-
//     width chars, reserved prefixes) is owned by Plan-018. The deps'
//     implementor MUST run the canonical validator before admit.
//   * Test coverage — owned by T-007p-3-4 (sibling task).
//
// Method-name format ratified: dotted-lowercase per
// docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
// Registry (Tier 1 Ratified, lines 291-331). The `register` call site below
// passes `"session.join"`, which matches the canonical regex.

import type {
  Handler,
  MethodRegistry,
  SessionJoinRequest,
  SessionJoinResponse,
} from "@ai-sidekicks/contracts";
import { SessionJoinRequestSchema, SessionJoinResponseSchema } from "@ai-sidekicks/contracts";

/**
 * Dependencies required by `session.join`'s handler closure.
 *
 * The deps interface mirrors the pattern in `session-create.ts`: a
 * single async callback per handler. The bootstrap orchestrator
 * (Plan-001 Phase 5) supplies the concrete implementation.
 */
export interface SessionJoinDeps {
  /**
   * Admit a participant into an existing session per the canonical
   * `SessionJoinRequest`. Returns the projection (`SessionJoinResponse`)
   * the wire client receives — the assigned `participantId` /
   * `membershipId` plus the session's `sharedMetadata` for client-side
   * presence/awareness initialization. Domain-side errors (session not
   * found, identity handle conflict, resource limits, persistence
   * failure) MUST surface as thrown `Error` instances — the registry's
   * `dispatch()` wrapper catches them and applies `mapJsonRpcError`
   * per I-007-8.
   */
  readonly joinSession: (request: SessionJoinRequest) => Promise<SessionJoinResponse>;
}

/**
 * Bind the `session.join` handler onto the supplied method registry.
 *
 * Mutating flag: `mutating: true`. Joining a session mutates domain
 * state; see the `session.create` JSDoc for the gate-predicate
 * rationale.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * I-007-6 rejects duplicate registration at register-time.
 */
export function registerSessionJoin(registry: MethodRegistry, deps: SessionJoinDeps): void {
  const handler: Handler<SessionJoinRequest, SessionJoinResponse> = async (params) => {
    return deps.joinSession(params);
  };

  registry.register("session.join", SessionJoinRequestSchema, SessionJoinResponseSchema, handler, {
    mutating: true,
  });
}
