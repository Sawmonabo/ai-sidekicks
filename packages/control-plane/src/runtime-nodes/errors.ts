// Control-plane runtime-node domain exceptions (Plan-003 Phase 3, T3.2).
//
// Mirrors the `ResourceLimitExceededException` idiom in `sessions/errors.ts`:
// a typed `Error` subclass whose stable `readonly code` literal projects
// directly into the transport-layer envelope. Both classes here are
// code+message-only — they carry NO `details` payload, matching their
// registry-only wire codes (no Details/Schema in `@ai-sidekicks/contracts`):
// no acceptance criterion needs structured detail, and a conflicting-session-id
// detail would risk cross-session info-leak (see error-contracts.md §Runtime
// Node / error.ts header on `RUNTIME_NODE_ATTACH_*_CODE`).
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
// Refs: Plan-003 §Invariants I-003-5 (single active attachment) + T3.2
// (P9 conflict / P10 revoked); docs/architecture/contracts/error-contracts.md
// §Runtime Node; `@ai-sidekicks/contracts` `RUNTIME_NODE_ATTACH_CONFLICT_CODE`
// / `RUNTIME_NODE_ATTACH_REVOKED_CODE`; `sessions/errors.ts` (the typed-code
// idiom this mirrors).

import {
  RUNTIME_NODE_ATTACH_CONFLICT_CODE,
  RUNTIME_NODE_ATTACH_REVOKED_CODE,
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
