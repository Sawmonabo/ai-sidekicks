// Control-plane runtime-node attach-refusal exceptions — Plan-003 Phase 3.
//
// Mirrors the typed-exception idiom established at
// `sessions/errors.ts` (`ResourceLimitExceededException`) and reused by
// `memberships/membership-service.ts` / `invites/invite-service.ts`: a class
// `extends Error` whose stable `readonly code` literal the transport layer
// lifts onto the wire envelope. The runtime-node-router catch-arm (T3.8)
// rethrows each as `new TRPCError({ code: "CONFLICT", message, cause })`
// (HTTP 409) and the shared `errorFormatter` projects `code` + `message` onto
// `shape.data.aisError` — the same two-part wiring T3.4 details. This module
// only DECLARES the typed throwables; the router/formatter round-trip is NOT
// authored here (the runtime-node router does not exist until T3.8).
//
// CODE PLACEMENT (deliberate, mirrors the established control-plane precedent).
// These codes are `code` + `message` on a CONFLICT — they carry NO structured
// wire payload a client destructures — so the stable `code` literals are
// defined LOCALLY here as `as const` constants (asserted by the attach-service
// tests) AND registered as rows in
// `docs/architecture/contracts/error-contracts.md` §Runtime Node. They are
// NOT hoisted into `packages/contracts/src/error.ts`, matching the local
// `INVITE_*_CODE` (invite-service.ts) / `MEMBERSHIP_*_CODE`
// (membership-service.ts) constants. Contrast `VERSION_FLOOR_EXCEEDED` (its
// `version.floor_exceeded` code + structured `VersionFloorExceededError`
// payload live in `contracts/src/error.ts` BECAUSE that payload is consumed
// cross-package) — a different category, and a different task (T3.4).
//
// The error namespace is `runtime_node.*` so the codes stay co-located with
// their resource (a runtime-node attach refusal is `runtime_node.revoked_terminal`
// / `runtime_node.session_conflict`, NOT a `membership.*` or `session.*` code).
// The revoked-refusal code carries a `_terminal` suffix so it does not collide
// with the `runtime_node.revoked` EVENT name (the lifecycle transition INTO
// revoked, in `RUNTIME_NODE_EVENT_NAMES`); this is the REFUSAL of an attach
// against an already-revoked row, a distinct concept.
//
// FUTURE SHAPE — this file ships two typed exceptions. Plan-001's decision-log
// (sessions/errors.ts header; trpc.ts errorFormatter note) gates the
// `AisWireException` base-class refactor at 3+ exceptions sharing the
// formatter; T3.4 adds the third (`VersionFloorExceededException`) and performs
// that refactor. Building the base class at two is premature abstraction, so we
// mirror `ResourceLimitExceededException` directly.
//
// Refs: Plan-003 Phase 3 T3.2 (attach refusals), §Invariants I-003-5
// (single-active-session via `idx_node_attachments_active`); Spec-003 line 118
// (one active session at a time in v1), line 69 (reconnect under same node
// identity); docs/domain/runtime-node-model.md line 52 (a `revoked` node is "no
// longer trusted or allowed to participate" — revocation is terminal);
// docs/architecture/contracts/error-contracts.md §Runtime Node.

/**
 * Stable wire code for an attach refused because the node's existing
 * `runtime_node_attachments` row for this session is `revoked`. Revocation is
 * terminal — a `revoked` row is never reactivated on reconnect (Plan-003 T3.2 /
 * P10; runtime-node-model.md line 52). Registered as a CONFLICT (HTTP 409) row
 * in error-contracts.md §Runtime Node. The `_terminal` suffix on both the
 * identifier and the wire value keeps this REFUSAL code distinct from the
 * `runtime_node.revoked` EVENT name (see this module's header).
 */
export const RUNTIME_NODE_REVOKED_TERMINAL_CODE = "runtime_node.revoked_terminal" as const;

/**
 * Stable wire code for an attach refused because the node is already actively
 * attached to ANOTHER session. The refusal is enforced at the database by the
 * `idx_node_attachments_active` partial-unique index (Plan-003 §Invariants
 * I-003-5; Spec-003 line 118 — "one active session at a time in v1"): a second
 * active attach raises SQLSTATE `23505`, which the attach service catches and
 * rethrows as this typed exception. Registered as a CONFLICT (HTTP 409) row in
 * error-contracts.md §Runtime Node.
 */
export const RUNTIME_NODE_SESSION_CONFLICT_CODE = "runtime_node.session_conflict" as const;

/**
 * Thrown by `AttachService.attach` when the node's existing attachment row for
 * the target session is in state `revoked`. A revoked node is "no longer
 * trusted or allowed to participate in the session"
 * (docs/domain/runtime-node-model.md line 52), so revocation is TERMINAL: the
 * row is refused rather than reactivated (the `offline` reconnect path
 * reactivates; the `revoked` path does not). The transport layer (T3.8) maps
 * this to a CONFLICT (HTTP 409) response.
 */
export class RuntimeNodeRevokedException extends Error {
  readonly code: typeof RUNTIME_NODE_REVOKED_TERMINAL_CODE = RUNTIME_NODE_REVOKED_TERMINAL_CODE;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeRevokedException";
  }
}

/**
 * Thrown by `AttachService.attach` when the node is already actively attached to
 * a DIFFERENT session (the cross-session case). Detected by catching the
 * Postgres unique-violation (SQLSTATE `23505`) raised by the
 * `idx_node_attachments_active` partial-unique index — the storage-layer
 * enforcement of Plan-003 I-003-5 (single active session) — and rethrowing it
 * typed rather than as a bare 500. The transport layer (T3.8) maps this to a
 * CONFLICT (HTTP 409) response.
 */
export class RuntimeNodeSessionConflictException extends Error {
  readonly code: typeof RUNTIME_NODE_SESSION_CONFLICT_CODE = RUNTIME_NODE_SESSION_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeSessionConflictException";
  }
}
