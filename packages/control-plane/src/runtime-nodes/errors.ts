// Control-plane runtime-node domain exceptions (Plan-003 Phase 3, T3.2 + T3.4
// + T3.9).
//
// Every class here extends `AisWireException` (`../ais-wire-exception.ts`) — the
// cross-domain base the tRPC `errorFormatter` (`sessions/trpc.ts`) matches with
// a single `instanceof` to project the typed `.code` onto the wire
// `shape.data.aisError` envelope. The attach/capability-update refusals are
// code+message-only — they carry NO `details` payload (they inherit the base's
// `details === undefined`), matching their registry-only wire codes (no
// Details/Schema in `@ai-sidekicks/contracts`): no acceptance criterion needs
// structured detail, and a conflicting-session-id detail would risk
// cross-session info-leak (see error-contracts.md §Runtime Node / error.ts
// header on `RUNTIME_NODE_*_CODE`).
//
// Transport wiring is LIVE as of T3.4: the runtime-node router catch-arms
// (`runtime-node-router.factory.ts`) map each refusal to HTTP 409 / tRPC
// `CONFLICT`, and the shared `errorFormatter` projects every `AisWireException`
// subclass onto `shape.data.aisError` via the base `instanceof` (T3.4 collapsed
// the per-class formatter branches onto the base and landed the deferred
// runtime-node projection). T3.4 also ADDS the version-floor throwable below
// (`VersionFloorExceededException` — the typed `VERSION_FLOOR_EXCEEDED`
// write-refusal a below-floor read-only node receives on a write attempt,
// ADR-018 §Decision #4 / I-003-1), distinct from the two attach-time refusals.
//
// Throw discipline (identical to MembershipService / SessionDirectoryService):
// throw from inside the `Querier.transaction(...)` callback OR the service body.
// The `pg.Pool` and PGlite adapters both auto-run `ROLLBACK` on throw and
// re-raise, so a thrown refusal leaves `runtime_node_attachments` byte-for-byte
// unchanged (the no-mutation property the T3.2 conflict/revoked tests assert).
//
// Refs: Plan-003 §Invariants I-003-1 (admit below-floor read-only, write-refuse
// with typed VERSION_FLOOR_EXCEEDED, never eject) / I-003-2 (cannot drive
// registering -> online) / I-003-5 (single active attachment) + T3.2 (P9
// conflict / P10 revoked) + T3.4 (version-floor write-refusal) + T3.9
// (capability-update conflict); docs/architecture/contracts/error-contracts.md
// §Runtime Node + §Version; ADR-018 §Decision #4 (version-floor write-refusal);
// `@ai-sidekicks/contracts` `RUNTIME_NODE_ATTACH_CONFLICT_CODE` /
// `RUNTIME_NODE_ATTACH_REVOKED_CODE` /
// `RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE` / `VERSION_FLOOR_EXCEEDED_CODE`;
// `../ais-wire-exception.ts` (the base) + `sessions/errors.ts` (the
// session-domain sibling subclass).

import {
  RUNTIME_NODE_ATTACH_CONFLICT_CODE,
  RUNTIME_NODE_ATTACH_REVOKED_CODE,
  RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE,
  VERSION_FLOOR_EXCEEDED_CODE,
} from "@ai-sidekicks/contracts";

import { AisWireException } from "../ais-wire-exception.js";

/**
 * Thrown by `AttachService.attach` (Plan-003 T3.2) for BOTH attach conflict
 * triggers — one typed code, two call sites, distinct messages:
 *   1. Cross-session active collision (P9 / I-003-5: a node has at most one
 *      attachment in an active state across all sessions). The node is already
 *      actively attached to a DIFFERENT session — the collision the partial-unique
 *      `idx_node_attachments_active` index raises as a `23505` at the database
 *      layer; the service catches that and rethrows this typed refusal. TRANSIENT
 *      — the node may attach elsewhere once it detaches from its current active
 *      session.
 *   2. Cross-owner same-session reconnect (Spec-003 line 116 — a reconnect is the
 *      same local daemon, so the owner participant is IMMUTABLE; Spec-003 line
 *      123 — never destroy historical node provenance on reconnect). A DIFFERENT
 *      participant attempts to reattach to an existing `(node_id, session_id)` row
 *      owned by another participant. The upsert's DO UPDATE
 *      `WHERE ... participant_id = EXCLUDED.participant_id` suppresses the update
 *      (zero RETURNING rows), and the service's zero-row verify discriminates the
 *      cross-owner cause and throws this typed refusal rather than overwriting the
 *      owner.
 * The transport layer maps both to HTTP 409 (a conflict, not a terminal state).
 *
 * No-info-leak stance: case 1 references the offending `nodeId` ONLY — never the
 * OTHER session's id (a caller attaching node N learns N is busy elsewhere, not
 * WHICH session holds it). Case 2 references `nodeId` + the caller's OWN
 * `sessionId` ONLY — never the owning `participant_id` (the caller learns the row
 * belongs to a different participant, not WHICH one).
 */
export class RuntimeNodeAttachConflictException extends AisWireException {
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
export class RuntimeNodeAttachRevokedException extends AisWireException {
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
 *      raced past a `detach` or `revoke` that retired the SLOT axis
 *      (`runtime_node_attachments.state`), so there is no active row — and thus
 *      no `{nodeId, state, updatedAt}` to return. A liveness-only T3.6 staleness
 *      sweep does NOT trigger this refusal: the sweep writes only
 *      `runtime_node_presence.health_state` and leaves the attachment SLOT active,
 *      so a swept-offline-but-still-attached node is still resolved by the
 *      active-band lookup and CAN still receive a capability update (the two axes
 *      reconcile at READ time — Spec-003 line 72). This mirrors `attach`'s
 *      defensive posture (the service does not assume the router pre-validated the
 *      node's liveness).
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
 * tRPC `CONFLICT` — the same typed-refusal family as the attach refusals above,
 * projected onto `shape.data.aisError` via the shared `AisWireException` base
 * (the formatter wiring landed in T3.4 alongside theirs).
 */
export class RuntimeNodeCapabilityUpdateConflictException extends AisWireException {
  readonly code: typeof RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE =
    RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeCapabilityUpdateConflictException";
  }
}

/**
 * Thrown by `AttachService.updateCapabilities` when a below-floor runtime node —
 * one admitted READ-ONLY at attach because its `clientVersion` is below the
 * session's `min_client_version` floor (T3.3) — attempts the capability WRITE.
 * This is the typed `VERSION_FLOOR_EXCEEDED` write-refusal (I-003-1 / ADR-018
 * §Decision #4 / Spec-003 line 130): the node was admitted (admit-not-eject) and
 * its reads succeed, but the write is refused. The throw rolls the transaction
 * back, leaving the attachment row byte-for-byte unchanged, so the node stays
 * JOINED — never ejected for the floor mismatch.
 *
 * Code+message-only (NO `details`) — and this is DELIBERATE, not an oversight
 * (Option A, advisor-reviewed + user-ratified):
 *   - Spec-003 line 130 and ADR-018 §Decision #4 mandate only a TYPED
 *     `VERSION_FLOOR_EXCEEDED` on write — neither requires structured details.
 *   - The strict `VersionBoundExceededDetails` schema in `@ai-sidekicks/contracts`
 *     (which the `VersionFloorExceededError` HTTP `ErrorResponse` sibling carries
 *     — canonically emitted by the control-plane peer-floor-validation surface,
 *     e.g. Plan-002+ invite-acceptance validating a peer's client floor; see
 *     `packages/contracts/src/error.ts` `version.floor_exceeded shape`) requires
 *     a TWO-sided `acceptedRange {min, max}` describing the receiver's accepted
 *     version range. The runtime-node session floor is ONE-sided
 *     (`sessions.min_client_version` — no `max` exists anywhere), so that schema
 *     CANNOT be populated here. Reusing the strict shape would force inventing a
 *     fictitious `max`. This control-plane write-refusal surface reuses only the
 *     CODE, emitted via the generic `aisError {code, message}` envelope
 *     (canonical `ErrorResponse.details` is optional).
 *   - The `message` carries leak-free upgrade context (nodeId + the daemon's
 *     declared `clientVersion` + the session floor — all caller-legitimate
 *     values the attaching daemon already knows; no other session's identity is
 *     disclosed).
 *
 * `version.floor_exceeded` is thus a SURFACE-POLYMORPHIC code (error-contracts.md
 * §Version): (1) on the JSON-RPC daemon handshake it is a `DaemonHelloAck.reason`
 * discriminator STRING (error-contracts.md §Negotiation Refusals — no `details`
 * payload on that surface); (2) on the control-plane peer-floor-validation
 * surface (Plan-002+ invite-acceptance) it carries the strict two-sided
 * `VersionBoundExceededDetails` in an HTTP `ErrorResponse`; (3) on THIS
 * control-plane runtime-node write-refusal surface it is code+message-only. The
 * transport layer maps this exception to HTTP 409 / tRPC `CONFLICT`
 * (error-contracts.md §Version row).
 */
export class VersionFloorExceededException extends AisWireException {
  readonly code: typeof VERSION_FLOOR_EXCEEDED_CODE = VERSION_FLOOR_EXCEEDED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "VersionFloorExceededException";
  }
}
