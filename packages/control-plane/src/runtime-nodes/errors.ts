// Control-plane runtime-node domain exceptions (Plan-003 Phase 3, T3.2 + T3.9).
//
// Mirrors the `ResourceLimitExceededException` idiom in `sessions/errors.ts`:
// a typed `Error` subclass whose stable `readonly code` literal projects
// directly into the transport-layer envelope. The three classes here are
// code+message-only — they carry NO `details` payload, matching their
// registry-only wire codes (no Details/Schema in `@ai-sidekicks/contracts`):
// no acceptance criterion needs structured detail, and a conflicting-session-id
// detail would risk cross-session info-leak (see error-contracts.md §Runtime
// Node / error.ts header on `RUNTIME_NODE_*_CODE`).
//
// Transport wiring is DEFERRED (out of scope for T3.2): the runtime-node tRPC
// router + its `errorFormatter` / catch-arm that lift `.code` onto
// `shape.data.aisError` and map each to HTTP 409 / tRPC `CONFLICT` are owned by
// T3.4 (error-formatter wiring) and T3.8 (`runtime-node-router.factory.ts`).
// This task ships only the typed throwables the Phase-3 `AttachService` raises;
// the formatter matches them by `instanceof` once those tasks land. T3.4 will
// additionally EXTEND this module with the version-floor throwable (the typed
// `VERSION_FLOOR_EXCEEDED` write-refusal a below-floor read-only node receives
// on a write attempt — ADR-018 §Decision #4 / I-003-1); both attach-time
// refusals below stay distinct from that floor write-refusal.
//
// Throw discipline (identical to MembershipService / SessionDirectoryService):
// throw from inside the `Querier.transaction(...)` callback OR the service body.
// The `pg.Pool` and PGlite adapters both auto-run `ROLLBACK` on throw and
// re-raise, so a thrown refusal leaves `runtime_node_attachments` byte-for-byte
// unchanged (the no-mutation property the T3.2 conflict/revoked tests assert).
//
// Refs: Plan-003 §Invariants I-003-2 (cannot drive registering -> online) /
// I-003-5 (single active attachment) + T3.2 (P9 conflict / P10 revoked) + T3.9
// (capability-update conflict); docs/architecture/contracts/error-contracts.md
// §Runtime Node; `@ai-sidekicks/contracts` `RUNTIME_NODE_ATTACH_CONFLICT_CODE`
// / `RUNTIME_NODE_ATTACH_REVOKED_CODE` /
// `RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE`; `sessions/errors.ts` (the
// typed-code idiom this mirrors).

import {
  RUNTIME_NODE_ATTACH_CONFLICT_CODE,
  RUNTIME_NODE_ATTACH_REVOKED_CODE,
  RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE,
} from "@ai-sidekicks/contracts";

/**
 * Thrown by `AttachService.attach` when the runtime node is already actively
 * attached to a DIFFERENT session (P9 / I-003-5: a node has at most one
 * attachment in an active state across all sessions). This is the cross-session
 * collision the partial-unique `idx_node_attachments_active` index raises as a
 * `23505` at the database layer; the service catches that and rethrows this
 * typed refusal. TRANSIENT — the node may attach elsewhere once it detaches
 * from its current active session, so the transport layer maps this to HTTP 409
 * (a retryable conflict, not a terminal state).
 *
 * No-info-leak stance: the message references the offending `nodeId` ONLY,
 * never the OTHER session's id — a caller attaching node N learns that N is busy
 * elsewhere, not WHICH session holds it (which it may have no authority to see).
 */
export class RuntimeNodeAttachConflictException extends Error {
  readonly code: typeof RUNTIME_NODE_ATTACH_CONFLICT_CODE = RUNTIME_NODE_ATTACH_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeAttachConflictException";
  }
}

/**
 * Thrown by `AttachService.attach` when the node's attachment row FOR THIS
 * SESSION is in the terminal `revoked` state (P10: revocation is terminal — a
 * revoked attachment is never reactivated by a reconnect, unlike an `offline`
 * row which reattach lifts back to `registering`). The transport layer maps
 * this to HTTP 409.
 *
 * No-info-leak stance: the message references the caller's OWN `sessionId`
 * (the session whose attachment was revoked is the one the caller is attaching
 * to) and the `nodeId` — no other session's identity is disclosed.
 */
export class RuntimeNodeAttachRevokedException extends Error {
  readonly code: typeof RUNTIME_NODE_ATTACH_REVOKED_CODE = RUNTIME_NODE_ATTACH_REVOKED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeAttachRevokedException";
  }
}

/**
 * Thrown by `AttachService.updateCapabilities` (Plan-003 T3.9) for BOTH of the
 * capability-update coordination-snapshot refusals — one typed code, two call
 * sites, distinct messages:
 *   1. No active attachment to refresh. A late `runtimenode.capabilityupdate`
 *      raced past a `detach` (or the T3.6 staleness sweep marked the node
 *      offline), so there is no active row — and thus no `{nodeId, state,
 *      updatedAt}` to return. This mirrors `attach`'s defensive posture (the
 *      service does not assume the router pre-validated the node's liveness).
 *   2. The I-003-2 state-context guard: the request would drive a `registering`
 *      attachment to `online`. The wire VALUE `online` is legal (the 2-value
 *      `RuntimeNodeHealthState`), but applying it to a still-`registering`
 *      attachment is not — bringing a node `online` requires a successful
 *      DAEMON-side capability declaration (Spec-003 line 57), and the control
 *      plane is not the declaration authority (Spec-003 line 52). The permitted
 *      capability-health axis is `online <-> degraded` (Spec-003 §Fallback
 *      Behavior). The other I-003-2 illegal transitions (`offline`/`revoked`)
 *      never reach this method: `healthChanges.state` is the 2-value enum, so
 *      they are rejected at the SCHEMA boundary, not here.
 *
 * No-info-leak stance: both messages name the offending `nodeId` ONLY — never
 * the node's current internal `state` (case 2 names the PUBLIC rule "online
 * requires a daemon-side capability declaration", not "the node is registering")
 * and never another session's id. The transport layer maps this to HTTP 409 /
 * tRPC `CONFLICT` — the same typed-refusal family as the attach refusals above;
 * the formatter wiring (`.code` -> 409) is DEFERRED to T3.4 / T3.8 alongside
 * theirs.
 */
export class RuntimeNodeCapabilityUpdateConflictException extends Error {
  readonly code: typeof RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE =
    RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeCapabilityUpdateConflictException";
  }
}
