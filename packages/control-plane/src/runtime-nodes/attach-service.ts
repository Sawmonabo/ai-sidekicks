// AttachService — Plan-003 Phase 3 (T3.2 + T3.3, runtime-node attach flow).
//
// Responsibilities:
//   * attach (T3.2 — the floor-INDEPENDENT attach mechanics) — admit a runtime
//     node into a session by writing `runtime_node_attachments`, enforcing the
//     load-bearing Plan-003 invariants:
//       - I-003-3 (attach is separate from membership): the attach path writes
//         ONLY `runtime_node_attachments`. It acquires NO `session_memberships`
//         lock and issues NO INSERT/UPDATE/DELETE against `session_memberships`
//         (Plan-003 §Invariants I-003-3; Spec-003 §Required Behavior line 47).
//         Conflating the two would invert the trust model (accepting an invite
//         must not auto-attach a node).
//       - I-003-5 (single active session): the upsert reactivates an `offline`
//         row on reconnect under the same node identity (Spec-003 line 69 / line
//         94), while a node already active in ANOTHER session is refused — the
//         `idx_node_attachments_active` partial-unique index raises SQLSTATE
//         `23505`, caught and rethrown as a typed CONFLICT (Plan-003 §Invariants
//         I-003-5; Spec-003 line 118 — "one active session at a time in v1").
//
//   * floor comparison (T3.3 — the version-floor permission verdict) — derive
//     the response `readOnly` flag from the daemon's reported `clientVersion`
//     versus the session's `sessions.min_client_version` floor:
//       - I-003-1 (admit-in-read-only / never-eject): a below-floor daemon is
//         ADMITTED, not rejected — it stays joined (state `registering`, the
//         SAME row) and its reads succeed; only the derived `readOnly` flag is
//         `true` (Spec-003 line 53; ADR-018 §Decision #4; Plan-003 §Invariants
//         I-003-1; api-payload-contracts.md:490, :497).
//
// Floor → `readOnly` derivation (Spec-003 §Required Behavior line 53). At attach
// the control plane verifies the daemon's reported version against the session's
// `sessions.min_client_version` floor. `readOnly` is the PERMISSION axis,
// ORTHOGONAL to the liveness `state` (a node may be `online` + `readOnly`;
// api-payload-contracts.md:496-497) — the floor verdict never changes the
// persisted state or the admission decision, only the flag. Two branches, both
// in `#deriveReadOnly`:
//   - NULL floor (T3.2/P1) → `readOnly: false`: the session imposes no floor, so
//     all daemons are admitted at full read/write permission.
//   - Non-NULL floor (T3.3/P2,P3) → `readOnly = !isAtOrAboveFloor(...)`: at/above
//     the floor → `false` (read/write); strictly below → `true` (read-only,
//     still joined). The comparison is semver-aware MAJOR.MINOR, NOT
//     lexicographic (ADR-018 §Decision #1) — see the `isAtOrAboveFloor` helper.
//
// T3.4 later CONSUMES the below-floor (`readOnly: true`) verdict to emit the
// typed structured `VERSION_FLOOR_EXCEEDED` payload on the write path (its
// `contracts/src/error.ts` home + the `AisWireException` base-class refactor are
// T3.4's). T3.5/T3.6/T3.7 EXTEND this class (multiple nodes / heartbeat +
// presence / detach + revoke). Capability declaration is NOT an `AttachService`
// extension: it is a separate daemon-side Plan-003 Phase 2 service (see the
// `registering -> online` note below).
//
// State on attach is `registering`, NOT `online`. Per I-003-2 a newly attached
// node defaults to non-online until capability declaration succeeds
// (`runtime_node.online` emits only after `runtime_node.capability_declared` —
// Spec-003 §Default Behavior line 57). The `registering -> online` transition is
// owned by Plan-003 Phase 2's daemon-side node-capability-service (which emits
// `runtime_node.capability_declared`, gating `online` per I-003-2) — NOT T3.3
// (floor comparison only) and NOT this attach call.
//
// Dependency injection (mirrors MembershipService / SessionDirectoryService /
// InviteService):
//   * `Querier` — the minimal SQL surface declared in
//     `sessions/migration-runner.ts`. The service body NEVER imports `pg`
//     directly; the production concretion is composed by
//     `createAttachServiceFromPool` at the bottom via the shared
//     `createPgPoolQuerier` adapter Plan-001 owns. This keeps the test surface
//     (in-process PGlite) and the production surface (`pg.Pool`)
//     interchangeable without a runtime branch.
//
// Cross-plan / cross-task boundaries (DO NOT CROSS in T3.2):
//   * `runtime_node_attachments` / `runtime_node_presence` table DDL — owned by
//     `migrations/0003-runtime-nodes.ts` (Plan-003 Phase 3 T3.1). This service
//     only INSERT/SELECT/UPDATEs rows; it never ALTERs the schema.
//   * `runtime_node.*` audit-event emission — owned by Plan-006 Tier 4 (the
//     daemon-side producers + the canonical writer). This service mutates the
//     attachment row only; it emits no event.
//   * The router/`errorFormatter` round-trip (rethrow typed throw as a tRPC
//     CONFLICT 409, project onto `shape.data.aisError`) — owned by T3.4 / T3.8.
//     This service THROWS the typed `errors.ts` exceptions; the transport wiring
//     is not authored here (the runtime-node router does not yet exist).
//
// Refs: Spec-003 §Required Behavior (line 47 attach-membership separation, line
// 53 floor verification / NULL-floor permissive), §Fallback Behavior (line 69
// reconnect under same identity), §Resolved Questions (line 118 one active
// session in v1); Plan-003 §Invariants I-003-2 / I-003-3 / I-003-5; Plan-003
// Phase 3 T3.2 §Step; docs/architecture/contracts/api-payload-contracts.md
// §Tier 3 Plan-003 (RuntimeNodeAttach request/response, lines 486-499);
// docs/domain/runtime-node-model.md line 52 (revocation terminality).

import type {
  NodeState,
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
} from "@ai-sidekicks/contracts";
import {
  EVENT_ENVELOPE_VERSION_PATTERN,
  RuntimeNodeAttachRequestSchema,
} from "@ai-sidekicks/contracts";
import type { Pool } from "pg";

import { createPgPoolQuerier } from "../sessions/session-directory-service.js";
import type { Querier } from "../sessions/migration-runner.js";
import { RuntimeNodeRevokedException, RuntimeNodeSessionConflictException } from "./errors.js";

// --------------------------------------------------------------------------
// SQLSTATE + index identifiers for the cross-session refusal detection.
// --------------------------------------------------------------------------
//
// The cross-session refusal (I-003-5) is detected by catching the Postgres
// unique-violation raised by the partial-unique active index. `pg` and PGlite
// both surface a Postgres error with `.code` = the SQLSTATE and `.constraint` =
// the offending index name (verified empirically against PGlite 0.x: a partial-
// unique violation throws `{ code: "23505", constraint: <index>, message:
// 'duplicate key value violates unique constraint "<index>"' }`; `pg`'s
// `DatabaseError` exposes the identical `.code` / `.constraint` fields). We gate
// on BOTH so the typed rethrow is ATTRIBUTABLE to the single-active-session
// index specifically — the composite `idx_node_attachments_node` is the upsert
// `ON CONFLICT` target (handled by `DO UPDATE`, so it never raises here), which
// leaves `idx_node_attachments_active` as the only 23505 source, but gating on
// `.constraint` keeps the detection robust if that ever changes. SQLSTATE
// `23505` is the Postgres `unique_violation` class (stable across versions).
const SQLSTATE_UNIQUE_VIOLATION = "23505" as const;
const ACTIVE_ATTACHMENT_INDEX = "idx_node_attachments_active" as const;

// `runtime_node_attachments.state` value a fresh / reactivated attachment lands
// in: `registering`. NOT `online` — per I-003-2 the node is non-online until its
// capability declaration succeeds (Spec-003 §Default Behavior line 57); the
// `registering -> online` transition is the capability service's, not this
// attach call's. Typed against the contract `NodeState` so a future enum change
// surfaces at `tsc`.
const ATTACH_INITIAL_STATE: NodeState = "registering";

// --------------------------------------------------------------------------
// Internal row shapes — the JSON-readable shape `pg.Pool#query` /
// `PGlite#query` return. Postgres folds column identifiers to lowercase and the
// schema uses snake_case columns, so both drivers map onto these keys (mirrors
// the internal-row idiom in membership-service.ts / session-directory-service.ts).
// --------------------------------------------------------------------------

interface AttachmentRow {
  readonly id: string;
  readonly state: string;
  readonly attached_at: Date | string;
}

// `TIMESTAMPTZ` is hydrated as a JS `Date` by `pg` and as an ISO 8601 string by
// PGlite. The response contract requires ISO 8601 (`attachedAt: string`), so
// normalize both forms (mirrors `toIsoString` in membership-service.ts /
// session-directory-service.ts).
function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// Narrow an unknown thrown value to a Postgres unique-violation on the
// active-attachment index. Defensive about the error shape (a thrown non-object,
// or an object missing `.code` / `.constraint`) so a malformed throw falls
// through to the caller's rethrow rather than being mis-classified as the
// cross-session refusal.
function isActiveAttachmentUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === SQLSTATE_UNIQUE_VIOLATION && candidate.constraint === ACTIVE_ATTACHMENT_INDEX
  );
}

// Parse a strict "MAJOR.MINOR" string into its two integer segments. Validates
// against the canonical `EVENT_ENVELOPE_VERSION_PATTERN` (contracts/event.ts) —
// the SAME regex the wire brand enforces — and throws on a malformed operand
// rather than returning a sentinel.
function parseMajorMinor(version: string): readonly [major: number, minor: number] {
  // Match with capture groups rather than `.test()` + `.split(".")`: one scan,
  // and the matched groups are the two integer segments directly. A non-match is
  // a malformed operand — throw (see `isAtOrAboveFloor` JSDoc for why fail-loud).
  const match = EVENT_ENVELOPE_VERSION_PATTERN.exec(version);
  const majorText = match?.[1];
  const minorText = match?.[2];
  if (majorText === undefined || minorText === undefined) {
    throw new Error(
      `AttachService: version '${version}' is not a valid "MAJOR.MINOR" string (per ADR-018 §Decision #1 / EVENT_ENVELOPE_VERSION_PATTERN); cannot perform a floor comparison.`,
    );
  }
  // The pattern's two capture groups each match a non-negative integer with no
  // leading zeros, so `Number.parseInt(_, 10)` is exact and total here.
  return [Number.parseInt(majorText, 10), Number.parseInt(minorText, 10)] as const;
}

/**
 * Compare a daemon's reported `clientVersion` against a session's
 * `min_client_version` floor and report whether it meets or exceeds the floor.
 * Returns `true` iff `clientVersion >= floor`.
 *
 * The comparison is semver-aware MAJOR.MINOR — MAJOR dominates, MINOR breaks the
 * tie — NOT lexicographic (api-payload-contracts.md:490; ADR-018 §Decision #1,
 * where MAJOR bumps are breaking and MINORs are additive-only). Lexicographic
 * string comparison is the trap this guards against: as strings `"10.0" < "2.0"`
 * and `"1.10" < "1.5"`, both WRONG. We parse each operand to integer segments and
 * compare numerically: at/above floor → `true`; strictly below → `false`.
 *
 * FAIL-LOUD on malformed input (hardened, deliberate). `clientVersion` is
 * brand-validated upstream (`RuntimeNodeAttachRequestSchema.parse` runs it through
 * `EventEnvelopeVersionSchema`), so the only operand that can be malformed in the
 * live path is the `floor`: it is read from `sessions.min_client_version` via a
 * row-shape CAST, not a runtime parse, and that column is a bare `TEXT` with NO
 * CHECK constraint (0001-initial.ts:104) and no validating write path today. A
 * corrupt floor is therefore a control-plane DATA-INTEGRITY violation. This
 * comparator does NOT assume the floor is well-formed: `parseMajorMinor` throws.
 *
 * The rationale is surfacing-vs-masking, NOT a security inversion. A tolerant
 * parse of a corrupt floor would be fail-safe RESTRICTIVE, not permissive:
 * `Number("garbage") -> NaN`, `clientMajor > NaN` is `false`, so the verdict is
 * `false` -> `readOnly = true`. Read-only is the SAFE direction — the corrupt
 * floor would not over-grant. The hazard is the SILENCE: a tolerant parse would
 * treat the session as if it carried an unsatisfiable floor and flag every client
 * read-only with no signal that the stored floor is garbage. Throwing instead
 * surfaces the corruption (rolls the attach transaction back -> a 500 the
 * operator sees) rather than masking a data-integrity bug as a fleet-wide
 * read-only downgrade.
 *
 * `floor` is typed plain `string` (not `EventEnvelopeVersion`): it is an
 * unbranded DB value, so asserting the brand would claim a guarantee it does not
 * carry — the runtime regex check is the real guard.
 *
 * @param clientVersion the daemon's reported attach version ("MAJOR.MINOR").
 * @param floor the session's non-NULL `min_client_version` ("MAJOR.MINOR").
 */
export function isAtOrAboveFloor(clientVersion: string, floor: string): boolean {
  const [clientMajor, clientMinor] = parseMajorMinor(clientVersion);
  const [floorMajor, floorMinor] = parseMajorMinor(floor);
  if (clientMajor !== floorMajor) {
    return clientMajor > floorMajor;
  }
  return clientMinor >= floorMinor;
}

export class AttachService {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Attach a runtime node to a session, writing `runtime_node_attachments` and
   * enforcing I-003-3 (no membership mutation) and I-003-5 (single active
   * session, reconnect reactivation, revocation terminality).
   *
   * @param input the validated-at-boundary `RuntimeNodeAttachRequest`.
   * @returns the `RuntimeNodeAttachResponse` projection of the attached row.
   * @throws RuntimeNodeRevokedException when the existing `(node_id, session_id)`
   *   row is `revoked` — revocation is terminal (P10).
   * @throws RuntimeNodeSessionConflictException when the node is already active
   *   in a DIFFERENT session — the `idx_node_attachments_active` partial-unique
   *   index raises `23505`, rethrown typed (P9, I-003-5).
   *
   * Transaction sequence (the revoked-state read takes a `FOR UPDATE` row lock,
   * so a concurrent revoke (T3.7) and this attach serialize on that row and the
   * terminal-revocation guard cannot be clobbered — see step 2's lock rationale):
   *   1. Resolve the session floor (`sessions.min_client_version`) and derive the
   *      `readOnly` verdict via `#deriveReadOnly`: a NULL floor admits at full
   *      permission (T3.2/P1); a non-NULL floor is compared semver-aware against
   *      `clientVersion`, below-floor → `readOnly: true` (T3.3/P2,P3, I-003-1).
   *   2. Read the existing `(node_id, session_id)` row's state `FOR UPDATE`, if
   *      any. If it is `revoked`, throw — terminal, never reactivated. The lock
   *      serializes against a concurrent revoke so the guard cannot be raced.
   *   3. Upsert: `INSERT ... ON CONFLICT (node_id, session_id) DO UPDATE` against
   *      the composite `idx_node_attachments_node` key. A prior `offline` row for
   *      the same node + session is reactivated to `registering` (reconnect — a
   *      plain INSERT would violate the composite unique key). The
   *      `idx_node_attachments_active` partial-unique index raises `23505` iff
   *      the node is already active in another session — caught and rethrown as
   *      the typed cross-session CONFLICT.
   *
   * No `session_memberships` lock or write occurs anywhere in this method
   * (I-003-3). No error-handler wraps the bare `transaction(...)` mutation: the
   * PGlite and `pg.Pool` adapters both auto-`ROLLBACK` on throw and re-raise, so
   * a thrown guard leaves `runtime_node_attachments` byte-for-byte unchanged.
   */
  async attach(input: RuntimeNodeAttachRequest): Promise<RuntimeNodeAttachResponse> {
    // Trust-boundary validation. Parse rather than trust the caller — a
    // service-layer fail-fast that surfaces schema drift before any row is read
    // or mutated (mirrors MembershipService.updateMembership / InviteService).
    const validated: RuntimeNodeAttachRequest = RuntimeNodeAttachRequestSchema.parse(input);

    return this.#querier.transaction(async (transaction) => {
      // (1) Resolve the session floor. NULL = no floor = admit unconditionally
      // (Spec-003 line 53). A missing session row surfaces as `undefined`; the
      // FK on the upsert below is the authoritative existence guard, so we read
      // the floor defensively (`?? null`) and let a non-existent session fail at
      // the INSERT's `session_id` FK (`23503`) rather than duplicating an
      // existence probe.
      //
      // DEFERRAL (intentional, NOT an oversight): a non-existent `sessionId`
      // raises a raw FK `23503` that propagates as an untyped 500. Mapping that
      // to a typed 404/validation error is the runtime-node router/auth layer's
      // job (T3.8), which validates session existence + caller authz before the
      // service is reached. T3.2 owns only the floor + attach mechanics, so it
      // does not pre-empt that guard with a redundant typed existence probe here.
      const floorProbe = await transaction.query<{ min_client_version: string | null }>(
        "SELECT min_client_version FROM sessions WHERE id = $1",
        [validated.sessionId],
      );
      const sessionFloor: string | null = floorProbe.rows[0]?.min_client_version ?? null;
      const readOnly: boolean = this.#deriveReadOnly(sessionFloor, validated.clientVersion);

      // (2) Terminal-revocation guard. Read the existing row for this exact
      // (node_id, session_id) pair `FOR UPDATE` — a ROW LOCK, not a plain read.
      // The lock is what closes the concurrent-revoke-vs-attach race: an attach
      // and a revoke (T3.7) that target the same row serialize on it, and the
      // two orderings both reach the correct verdict.
      //   - attach acquires the lock first → revoke blocks until this txn
      //     commits, then applies on top → the node ends revoked (revoke wins,
      //     as it must — revocation is terminal).
      //   - revoke acquires the lock first → commits the `revoked` state → this
      //     locked re-read observes `revoked` → the guard below throws.
      // WITHOUT the lock the read is non-repeatable: a revoke committing between
      // a plain read and the upsert would be silently CLOBBERED — step (3)'s
      // `DO UPDATE` would reactivate the just-revoked row to `registering`,
      // violating the terminality of P10 / I-003-5. We mirror the house lock
      // clause exactly (`FOR UPDATE`, as membership-service.ts:299 /
      // session-directory-service.ts use to lock a row they will then mutate);
      // `runtime_node_attachments` has no incoming FK, so `FOR UPDATE` vs
      // `FOR NO KEY UPDATE` is behaviorally identical here and `FOR UPDATE` is
      // the uniform precedent. The DO UPDATE carries NO redundant
      // `WHERE state <> 'revoked'` — the lock already serializes the orderings,
      // and a WHERE guard would only mask, not fix, an unlocked read.
      // On a first attach the probe matches zero rows and locks nothing, so the
      // clean-INSERT path is unchanged. A `revoked` row is refused; an `offline`
      // row (or no row) falls through to the upsert, which reactivates / inserts.
      const existingProbe = await transaction.query<{ state: string }>(
        "SELECT state FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2 FOR UPDATE",
        [validated.nodeId, validated.sessionId],
      );
      const existingState: string | undefined = existingProbe.rows[0]?.state;
      if (existingState === "revoked") {
        throw new RuntimeNodeRevokedException(
          `AttachService.attach: node ${String(validated.nodeId)} is revoked for session ${String(validated.sessionId)}; revocation is terminal — a new attachment is refused (Plan-003 T3.2/P10, runtime-node-model.md line 52).`,
        );
      }

      // (3) Upsert against the composite (node_id, session_id) key. On conflict
      // (a prior row for this same node + session — the `offline` reconnect path)
      // reactivate to `registering` and refresh the declared capabilities /
      // reported version / attach timestamp. A first attach inserts a new row.
      // The `idx_node_attachments_active` partial-unique index raises `23505` iff
      // this node already holds an active row in ANOTHER session (I-003-5) — the
      // catch below rethrows that typed.
      try {
        const upserted = await transaction.query<AttachmentRow>(
          `INSERT INTO runtime_node_attachments
             (session_id, participant_id, node_id, capabilities, client_version, state)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT (node_id, session_id) DO UPDATE
             SET participant_id = EXCLUDED.participant_id,
                 capabilities   = EXCLUDED.capabilities,
                 client_version = EXCLUDED.client_version,
                 state          = EXCLUDED.state,
                 attached_at    = now()
           RETURNING id, state, attached_at`,
          [
            validated.sessionId,
            validated.participantId,
            validated.nodeId,
            JSON.stringify(validated.capabilities),
            validated.clientVersion,
            ATTACH_INITIAL_STATE,
          ],
        );

        const attachmentRow: AttachmentRow | undefined = upserted.rows[0];
        if (attachmentRow === undefined) {
          // `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` always returns the
          // affected row (inserted or updated). A missing row is an impossible
          // driver state, not a domain condition — throw rather than fabricate a
          // response (mirrors the no-RETURNING-row guard in membership-service.ts).
          throw new Error(
            `AttachService.attach: upsert returned no row for node ${String(validated.nodeId)} in session ${String(validated.sessionId)}`,
          );
        }

        return {
          attachmentId: attachmentRow.id,
          state: attachmentRow.state as NodeState,
          readOnly,
          attachedAt: toIsoString(attachmentRow.attached_at),
        };
      } catch (error: unknown) {
        // Cross-session refusal (I-003-5). The partial-unique active index
        // rejected a second active attach for a node already active elsewhere.
        // Rethrow typed so the transport layer surfaces a CONFLICT (409), not a
        // bare 500. Any other error (FK violation, connection fault, the
        // impossible no-row above) propagates unchanged for the adapter to
        // ROLLBACK and re-raise.
        if (isActiveAttachmentUniqueViolation(error)) {
          throw new RuntimeNodeSessionConflictException(
            `AttachService.attach: node ${String(validated.nodeId)} is already actively attached to another session; a runtime node may participate in one active session at a time in v1 (Plan-003 I-003-5, Spec-003 line 118).`,
          );
        }
        throw error;
      }
    });
  }

  /**
   * Derive the response `readOnly` flag from the session floor and the daemon's
   * reported version. `readOnly` is the PERMISSION axis — orthogonal to the
   * liveness `state` (api-payload-contracts.md:496-497). This method NEVER
   * changes the persisted state or the admission decision; a below-floor node is
   * still admitted (still `registering`, still joined, the SAME row is written),
   * it is merely flagged read-only. Admit-in-read-only / never-eject is I-003-1.
   *
   *   - NULL floor → `false`: the session imposes no floor, so all daemons are
   *     admitted at full read/write permission (Spec-003 line 53; T3.2/P1).
   *   - Non-NULL floor → `!isAtOrAboveFloor(clientVersion, floor)`: at/above the
   *     floor → `false` (full read/write; P2); strictly below → `true` (admitted
   *     read-only — the node stays joined and reads succeed; P3 / I-003-1 /
   *     ADR-018 §Decision #4). The comparison is semver-aware MAJOR.MINOR, NOT
   *     lexicographic (ADR-018 §Decision #1) — see `isAtOrAboveFloor`.
   *
   * T3.4 later CONSUMES the below-floor (`readOnly: true`) verdict to emit the
   * typed `VERSION_FLOOR_EXCEEDED` payload on the write path; that emit is not
   * this method's concern.
   *
   * @param sessionFloor the session's `min_client_version` (`null` = no floor).
   * @param clientVersion the daemon's reported attach version ("MAJOR.MINOR").
   */
  #deriveReadOnly(sessionFloor: string | null, clientVersion: string): boolean {
    if (sessionFloor === null) {
      return false;
    }
    return !isAtOrAboveFloor(clientVersion, sessionFloor);
  }
}

// --------------------------------------------------------------------------
// pg.Pool -> AttachService factory
// --------------------------------------------------------------------------
//
// Convenience one-liner for production wiring: composes a `Querier` from a
// `pg.Pool` via the shared `createPgPoolQuerier` adapter Plan-001 owns and
// constructs the service in one call, mirroring `createMembershipServiceFromPool`
// / `createInviteServiceFromPool` / `createSessionDirectoryServiceFromPool`. The
// `FOR UPDATE` revoked-read + the upsert inherit the held-client transaction
// semantics (BEGIN/COMMIT/ROLLBACK on one connection) that adapter documents.
// That single held connection is the necessary substrate for the row lock: the
// lock acquired by the `FOR UPDATE` probe is what serializes the concurrent-
// revoke race (step 2), and a lock is only held for the life of its transaction —
// so the read and the upsert MUST run on the one held client for the guard to
// hold. The shared boundary alone does not close the race; the lock does.

/**
 * Compose an `AttachService` from a `pg.Pool`.
 */
export function createAttachServiceFromPool(pool: Pool): AttachService {
  return new AttachService(createPgPoolQuerier(pool));
}
