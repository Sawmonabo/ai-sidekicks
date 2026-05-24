// MembershipService — Plan-002 Phase 2 (T2.3, MembershipUpdate handler).
//
// Responsibilities (this task, T2.3):
//   * updateMembership — apply a `MembershipUpdate` (the Spec-002 line 83
//     discriminated union: `change_role` / `suspend` / `revoke` /
//     `reactivate`) against a `session_memberships` row, enforcing the two
//     load-bearing Plan-002 invariants:
//       - I-002-1 (owner elevation requires an existing owner): a
//         `{action: "change_role", newRole: "owner"}` MUST be issued by an
//         actor who already holds active `owner` membership in the SAME
//         session, and the target MUST already hold active membership
//         (Spec-002 §Required Behavior line 49). A non-owner cannot
//         self-elevate. → typed error `membership.permission_denied`.
//       - I-002-2 (last-owner-cannot-leave): the system MUST prevent the
//         last remaining active owner from leaving a session (Spec-002
//         §Required Behavior line 50). The load-bearing property is "a
//         session never reaches zero active owners via a MembershipUpdate",
//         so the guard fires on ANY action that would remove the sole
//         remaining active owner — self `revoke` / `suspend` of that owner,
//         AND a `change_role` demoting that owner to a non-owner role.
//         → typed error `membership.last_owner`.
//
// Permission model (a deliberate scope decision — see RESULT concerns).
// Spec-002 lines 49-50 name only two guards explicitly: owner-elevation
// (line 49) and last-owner-cannot-leave (line 50). The row-level authority
// for WHO may apply each action is the Permission Matrix in
// docs/architecture/security-architecture.md §Permission Matrix — which
// Spec-002 line 82 designates as the membership-permission authority. That
// matrix scopes `Elevate member role` (line 300) and `Suspend/revoke member`
// (line 301) to `owner` only — every non-owner column is `No`. ADR-007's
// owner-centric layered-trust model is the frame; the matrix is the per-action
// source. This service adopts that OWNER-ONLY-DEFAULT reading: every
// `MembershipUpdate` requires the actor to hold active `owner` membership in
// the target's session, with ONE carve-out — a participant may always attempt
// to leave their OWN membership (a self-targeted `revoke` / `suspend`), which
// is then subject to the I-002-2 last-owner guard. `reactivate` is not an
// enumerated matrix row; it inherits owner-only by INVERSION of the documented
// owner-only `Suspend/revoke member` row (line 301) — a participant who cannot
// suspend or revoke a member certainly cannot un-suspend one. The narrow
// alternative (guard ONLY the two Spec-002 named cases, allow any actor every
// other action) was rejected because it contradicts the matrix and leaves a
// hole where a non-owner could `revoke` an owner — inverting the permission
// graph I-002-1 exists to protect. This choice is broader than the strict
// `verifies_invariant` (I-002-1 / I-002-2) mandate; T2.5's full P1-P10 sweep
// and the wire/router layer may refine it. See RESULT for the follow-up note.
//
// Atomicity + lock-ordering (I-002-4, inherited from Plan-001 I-001-1):
//   The permission read, the owner-count read, and the state mutation MUST
//   share ONE `Querier.transaction(...)` commit boundary so the guards
//   cannot be raced (a concurrent demote/revoke cannot slip between a
//   count-owners read and the mutation). Within that transaction this
//   service acquires the parent `sessions` row lock
//   (`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`) BEFORE touching
//   `session_memberships`, matching the canonical Plan-001 order
//   (`sessions` → `session_memberships`) that SessionDirectoryService
//   documents. T2.4 writes the lock-ordering regression test (P9) against
//   the callers built here, so the FOR UPDATE on `sessions` is load-bearing
//   even though this task's `verifies_invariant` is I-002-1 / I-002-2.
//
// Actor identity (a design constraint, not a schema field). `MembershipUpdate`
// carries NO actor/caller field and NO sessionId — the `membershipId` is a
// globally-unique UUID that identifies its session via the row's FK. I-002-1
// requires knowing WHO issues the call, so `updateMembership` takes the
// acting participant as an explicit first parameter (mirroring the
// explicit-caller-identity convention of `JoinSessionInput.participantId`,
// NOT an ambient request context). The session is derived from the target
// row's `session_id`; the actor's membership is then looked up in that same
// session to check `role === 'owner'` AND `state === 'active'`.
//
// Dependency injection (mirrors SessionDirectoryService / InviteService):
//   * `Querier` — the minimal SQL surface declared in
//     `sessions/migration-runner.ts`. The service body NEVER imports `pg`
//     directly; the production concretion is composed by
//     `createMembershipServiceFromPool` at the bottom via the shared
//     `createPgPoolQuerier` adapter Plan-001 owns. This keeps the test
//     surface (in-process PGlite) and the production surface (`pg.Pool`)
//     interchangeable without a runtime branch.
//
// Cross-plan / cross-task boundaries (DO NOT CROSS in T2.3):
//   * `session_memberships` table DDL — owned by `migrations/0001-initial.ts`
//     (Plan-001). This service only SELECT/UPDATEs rows; it never ALTERs the
//     schema.
//   * Audit-event emission (`session.update.membership`) — owned by Plan-006.
//     This service mutates the row only; it emits no event.
//   * Invite-accept membership creation — owned by InviteService (T2.2).
//   * `MembershipUpdateResponse` wire type — `@ai-sidekicks/contracts` does
//     not yet export it (verified at T2.3 authoring time); the shape is
//     declared locally here per the api-payload-contracts.md wire form. See
//     RESULT for the follow-up recommending it land in contracts.
//
// Refs: Spec-002 §Required Behavior (lines 49-50), §Interfaces And Contracts
// (line 83), Plan-002 §Invariants I-002-1 / I-002-2 / I-002-4,
// docs/architecture/contracts/api-payload-contracts.md §MembershipUpdate
// (lines 400-410), docs/architecture/security-architecture.md
// §Permission Matrix (lines 300-301, the per-action owner-only authority),
// ADR-007 (collaboration trust + permission model).

import type {
  MembershipId,
  MembershipRole,
  MembershipState,
  MembershipUpdate,
  ParticipantId,
} from "@ai-sidekicks/contracts";
import { MembershipUpdateSchema } from "@ai-sidekicks/contracts";
import type { Pool } from "pg";

import { createPgPoolQuerier } from "../sessions/session-directory-service.js";
import type { Querier } from "../sessions/migration-runner.js";

// --------------------------------------------------------------------------
// Typed errors — defined inline (contracts + a separate errors.ts are out of
// scope for T2.3). Mirrors the `ResourceLimitExceededException` idiom in
// `sessions/errors.ts`: a class `extends Error` with a stable `readonly code`
// literal the transport layer lifts onto the wire envelope. The `code` string
// literals are inlined here rather than imported from `@ai-sidekicks/contracts`
// because contracts does not yet export `MEMBERSHIP_PERMISSION_DENIED_CODE` /
// `MEMBERSHIP_LAST_OWNER_CODE` constants (verified at authoring time). See
// RESULT for the follow-up recommending they land in contracts alongside
// `RESOURCE_LIMIT_EXCEEDED_CODE`.
// --------------------------------------------------------------------------

/** Stable wire code for the I-002-1 owner-elevation / owner-only-action guard. */
export const MEMBERSHIP_PERMISSION_DENIED_CODE = "membership.permission_denied" as const;

/** Stable wire code for the I-002-2 last-owner-cannot-leave guard. */
export const MEMBERSHIP_LAST_OWNER_CODE = "membership.last_owner" as const;

/**
 * Thrown by `MembershipService.updateMembership` when the acting participant
 * is not permitted to apply the requested `MembershipUpdate`. Covers the
 * I-002-1 owner-elevation guard (`change_role` → `owner` by a non-owner) and,
 * under this service's owner-only-default permission model, any non-self
 * `MembershipUpdate` issued by a non-owner. The transport layer maps this to
 * an authorization failure (HTTP 403 / tRPC `FORBIDDEN`).
 */
export class MembershipPermissionDeniedException extends Error {
  readonly code: typeof MEMBERSHIP_PERMISSION_DENIED_CODE = MEMBERSHIP_PERMISSION_DENIED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "MembershipPermissionDeniedException";
  }
}

/**
 * Thrown by `MembershipService.updateMembership` when an action would remove
 * the last remaining active owner from a session (I-002-2). A session with
 * zero active owners is unrecoverable — no participant could issue further
 * `MembershipUpdate` calls or transfer ownership — so this is a one-way door
 * the guard refuses to open. The message directs the owner to transfer
 * ownership first (Spec-002 §Required Behavior line 50). The transport layer
 * maps this to a conflict / precondition-failed response.
 */
export class MembershipLastOwnerException extends Error {
  readonly code: typeof MEMBERSHIP_LAST_OWNER_CODE = MEMBERSHIP_LAST_OWNER_CODE;

  constructor(message: string) {
    super(message);
    this.name = "MembershipLastOwnerException";
  }
}

// --------------------------------------------------------------------------
// MembershipUpdate response — api-payload-contracts.md §MembershipUpdate
// (lines 406-410): `{membershipId, state, role, updatedAt}`. Declared locally
// because `@ai-sidekicks/contracts` does not yet export an
// `MembershipUpdateResponse` type (verified at T2.3 authoring time) — mirrors
// the local `InviteCreateResponse` in invite-service.ts. See RESULT for the
// follow-up recommending it land in `packages/contracts/src/memberships.ts`.
// --------------------------------------------------------------------------

export interface MembershipUpdateResponse {
  membershipId: MembershipId;
  state: MembershipState;
  role: MembershipRole;
  updatedAt: string;
}

// --------------------------------------------------------------------------
// Internal row shape — the JSON-readable shape returned by `pg.Pool#query`
// and `PGlite#query`. Postgres folds column identifiers to lowercase and the
// schema uses snake_case columns, so both drivers map onto these keys.
// Mirrors the MembershipRow internal shape in session-directory-service.ts.
// --------------------------------------------------------------------------

interface MembershipRow {
  readonly id: string;
  readonly session_id: string;
  readonly participant_id: string;
  readonly role: string;
  readonly state: string;
  readonly joined_at: Date | string | null;
  readonly updated_at: Date | string;
}

// `TIMESTAMPTZ` is hydrated as a JS `Date` by `pg` and as an ISO 8601 string
// by PGlite. The response contract requires ISO 8601 (`updatedAt: string`),
// so normalize both forms. Mirrors `toIsoString` in
// session-directory-service.ts / invite-service.ts.
function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// Target membership state for each non-`change_role` action. `reactivate`
// lifts a `suspended` / `revoked` membership back to `active`; `suspend` /
// `revoke` move toward their terminal states. `change_role` does NOT change
// `state` (only `role`), so it is handled on its own branch and is absent
// from this map.
const ACTION_TARGET_STATE: Readonly<Record<"suspend" | "revoke" | "reactivate", MembershipState>> =
  {
    suspend: "suspended",
    revoke: "revoked",
    reactivate: "active",
  };

export class MembershipService {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Apply a `MembershipUpdate` to its target membership row, enforcing
   * I-002-1 (owner-elevation), I-002-2 (last-owner-cannot-leave), and the
   * owner-only-default permission model (see file header).
   *
   * @param actorParticipantId the participant issuing the call. `MembershipUpdate`
   *   carries no actor field, so identity is passed explicitly (mirrors
   *   `JoinSessionInput.participantId`). I-002-1 requires the issuer of an
   *   owner-elevation to itself be an active owner.
   * @param input the validated-at-boundary `MembershipUpdate`.
   * @returns the updated membership projection, or `null` if the target
   *   `membershipId` does not exist (the wire layer surfaces a typed
   *   not-found error).
   *
   * Transaction sequence (all under ONE commit boundary so the guards cannot
   * be raced):
   *   1. Resolve the target's `session_id` ONLY (the one membership column
   *      with no UPDATE path) by `membershipId`. Return `null` if the target
   *      does not exist.
   *   2. Acquire the parent `sessions` row lock (`... FOR UPDATE`) — I-002-4
   *      canonical order `sessions` → `session_memberships`, BEFORE any
   *      membership READ used by a guard or any mutation. T2.4 (P9) tests
   *      this ordering.
   *   2b. Re-read the FULL target row UNDER the lock. The role/state the
   *      guards consume MUST be the post-lock snapshot: a plain SELECT before
   *      the lock would, under READ COMMITTED, let a concurrent owner action
   *      (e.g. suspending the target) commit between the read and the lock —
   *      the elevation guard would then act on a stale `state='active'` and
   *      could promote an already-suspended member, violating I-002-1's
   *      "target must already hold active membership". Splitting the lookup
   *      (session_id pre-lock, full row post-lock) closes that race.
   *   3. Look up the ACTOR's membership in the SAME session (also post-lock).
   *   4. Permission gate: unless this is a self-targeted leave
   *      (`revoke` / `suspend` where actor === target), the actor MUST hold
   *      active `owner` membership. Owner-elevation (`change_role` →
   *      `owner`) ALWAYS requires an active-owner actor AND an
   *      already-active target (I-002-1).
   *   5. Last-owner gate (I-002-2): if the action would remove the sole
   *      remaining active owner — self `revoke` / `suspend` of that owner,
   *      OR `change_role` demoting that owner — count active owners under the
   *      lock and throw `membership.last_owner` when the count is 1 and the
   *      target is that owner.
   *   6. Mutate the row (`role` for `change_role`; `state` for the others)
   *      and RETURN the projection.
   *
   * Why no error-handler around `transaction(...)`: the PGlite and `pg.Pool`
   * adapters both auto-`ROLLBACK` on throw and re-raise the underlying error
   * (see SessionDirectoryService). A thrown guard therefore leaves
   * `session_memberships` byte-for-byte unchanged — the no-mutation property
   * P6 / P7 assert.
   */
  async updateMembership(
    actorParticipantId: ParticipantId,
    input: MembershipUpdate,
  ): Promise<MembershipUpdateResponse | null> {
    // Trust-boundary validation. Parse rather than trust the caller — a
    // service-layer fail-fast that surfaces schema drift (e.g. a missing
    // `newRole` on `change_role`, or an unknown `action`) before any row is
    // read or mutated. Mirrors InviteService.createInvite's boundary parse.
    const validated: MembershipUpdate = MembershipUpdateSchema.parse(input);

    return this.#querier.transaction(async (transaction) => {
      // (1) Resolve ONLY the target's session_id pre-lock. `session_id` is
      // the single membership column with no UPDATE path in this service, so
      // reading it before the lock is race-free — unlike `role` / `state`,
      // which a concurrent writer can change. Return `null` for an unknown
      // membership (the wire layer surfaces a typed not-found).
      const sessionIdProbe = await transaction.query<{ session_id: string }>(
        "SELECT session_id FROM session_memberships WHERE id = $1",
        [validated.membershipId],
      );
      const sessionIdRow: { session_id: string } | undefined = sessionIdProbe.rows[0];
      if (sessionIdRow === undefined) {
        return null;
      }
      const sessionId: string = sessionIdRow.session_id;

      // (2) Lock the parent session row FIRST (I-002-4 canonical order
      // `sessions` → `session_memberships`). Held across the full-row read,
      // the owner count, and the mutate below so a concurrent demote/revoke/
      // suspend on the same session serializes here rather than racing the
      // guards. T2.4 (P9) pins this ordering.
      await transaction.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);

      // (2b) Re-read the FULL target row UNDER the lock so the I-002-1 /
      // I-002-2 guards consume the post-lock snapshot of `role` / `state`.
      // See method docstring §2b for the READ COMMITTED race a pre-lock full
      // read would leave open (a concurrent suspend stale-ifying the target
      // between read and lock, letting the elevation guard promote an
      // already-suspended member).
      const targetProbe = await transaction.query<MembershipRow>(
        `SELECT id, session_id, participant_id, role, state, joined_at, updated_at
           FROM session_memberships
          WHERE id = $1`,
        [validated.membershipId],
      );
      const targetRow: MembershipRow | undefined = targetProbe.rows[0];
      if (targetRow === undefined) {
        // The row vanished between the pre-lock session_id probe and the
        // locked re-read (a concurrent revoke that hard-deleted it — not a
        // path this service takes, but defended for substrate generality).
        return null;
      }

      // (3) Look up the actor's membership in the SAME session (post-lock).
      const actorProbe = await transaction.query<{ role: string; state: string }>(
        `SELECT role, state FROM session_memberships
          WHERE session_id = $1 AND participant_id = $2`,
        [sessionId, actorParticipantId],
      );
      const actorRow: { role: string; state: string } | undefined = actorProbe.rows[0];
      const actorIsActiveOwner: boolean =
        actorRow !== undefined && actorRow.role === "owner" && actorRow.state === "active";

      // A self-targeted leave is the one action any participant may attempt
      // for their OWN membership (subject to the I-002-2 last-owner guard
      // below). UUID casing is normalized on both sides because Postgres
      // returns canonical lowercase while a caller's `ParticipantId` brand
      // admits either case (RFC 9562 §4) — the same normalization
      // SessionDirectoryService applies to its owner-mismatch guard.
      const isSelfTarget: boolean =
        targetRow.participant_id.toLowerCase() === actorParticipantId.toLowerCase();
      const isLeaveAction: boolean =
        validated.action === "revoke" || validated.action === "suspend";
      const isSelfLeave: boolean = isSelfTarget && isLeaveAction;

      // (4) Permission gate.
      //
      // I-002-1: owner-elevation (`change_role` → `owner`) ALWAYS requires an
      // active-owner actor AND an already-active target. Checked first so the
      // elevation-specific message is the one a non-owner self-elevation
      // attempt sees (the P6 case).
      if (validated.action === "change_role" && validated.newRole === "owner") {
        if (!actorIsActiveOwner) {
          throw new MembershipPermissionDeniedException(
            `MembershipService.updateMembership: owner elevation (change_role -> owner) requires an active owner to issue it; participant ${String(actorParticipantId)} is not an active owner of session ${sessionId} (Plan-002 I-002-1, Spec-002 line 49).`,
          );
        }
        if (targetRow.state !== "active") {
          throw new MembershipPermissionDeniedException(
            `MembershipService.updateMembership: owner elevation requires the target to already hold active membership; membership ${String(validated.membershipId)} is in state '${targetRow.state}' (Plan-002 I-002-1, Spec-002 line 49).`,
          );
        }
      } else if (!isSelfLeave && !actorIsActiveOwner) {
        // Owner-only-default (see file header): every non-self-leave
        // MembershipUpdate requires an active-owner actor. The narrow
        // alternative — guarding only the two Spec-002 named cases — would
        // let a non-owner revoke an owner, inverting the trust graph.
        throw new MembershipPermissionDeniedException(
          `MembershipService.updateMembership: action '${validated.action}' on membership ${String(validated.membershipId)} requires the actor to be an active owner of session ${sessionId}; participant ${String(actorParticipantId)} is not (Plan-002 I-002-1 / ADR-007 owner-centric model, security-architecture.md §Permission Matrix).`,
        );
      }

      // (5) Last-owner gate (I-002-2). The load-bearing property is "a
      // session never reaches zero active owners via a MembershipUpdate", so
      // the guard fires whenever the action would remove the SOLE remaining
      // active owner: a `revoke` / `suspend` of an active owner, OR a
      // `change_role` demoting an active owner to a non-owner role. The
      // owner-count read is INSIDE this transaction (under the session lock
      // from step 2) so a concurrent owner removal cannot race the count.
      const targetIsActiveOwner: boolean =
        targetRow.role === "owner" && targetRow.state === "active";
      if (targetIsActiveOwner) {
        const removesOwnerActiveStatus: boolean =
          validated.action === "revoke" ||
          validated.action === "suspend" ||
          (validated.action === "change_role" && validated.newRole !== "owner");
        if (removesOwnerActiveStatus) {
          const ownerCountProbe = await transaction.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM session_memberships
              WHERE session_id = $1 AND role = 'owner' AND state = 'active'`,
            [sessionId],
          );
          const countRow = ownerCountProbe.rows[0];
          if (countRow === undefined) {
            // `COUNT(*)` always returns exactly one row; a missing row is an
            // impossible driver state, not a domain condition. Throwing here
            // (rather than coalescing to 0) keeps it from masquerading as a
            // `last_owner` error, mirroring the no-row RETURNING guard below.
            throw new Error(
              `MembershipService.updateMembership: owner-count query returned no row for session ${sessionId}`,
            );
          }
          const activeOwnerCount: number = countRow.n;
          if (activeOwnerCount <= 1) {
            throw new MembershipLastOwnerException(
              `MembershipService.updateMembership: cannot ${validated.action} the last active owner of session ${sessionId}; transfer ownership to another participant first (Plan-002 I-002-2, Spec-002 line 50).`,
            );
          }
        }
      }

      // (6) Mutate. `change_role` updates `role` (state untouched); the other
      // three actions update `state` per ACTION_TARGET_STATE. `reactivate`
      // additionally stamps `joined_at` when the row had none (a membership
      // that was never activated) so the activated row carries an activation
      // timestamp; an already-stamped `joined_at` is preserved.
      let mutation: { rows: ReadonlyArray<MembershipRow> };
      if (validated.action === "change_role") {
        mutation = await transaction.query<MembershipRow>(
          `UPDATE session_memberships
              SET role = $2, updated_at = now()
            WHERE id = $1
          RETURNING id, session_id, participant_id, role, state, joined_at, updated_at`,
          [validated.membershipId, validated.newRole],
        );
      } else {
        const targetState: MembershipState = ACTION_TARGET_STATE[validated.action];
        mutation = await transaction.query<MembershipRow>(
          `UPDATE session_memberships
              SET state = $2,
                  joined_at = CASE WHEN $2 = 'active' THEN COALESCE(joined_at, now()) ELSE joined_at END,
                  updated_at = now()
            WHERE id = $1
          RETURNING id, session_id, participant_id, role, state, joined_at, updated_at`,
          [validated.membershipId, targetState],
        );
      }

      const updatedRow: MembershipRow | undefined = mutation.rows[0];
      if (updatedRow === undefined) {
        // The target existed at step 1. `SELECT ... FOR UPDATE` on the parent
        // `sessions` row does NOT cascade a row lock onto `session_memberships`
        // rows through the FK; rather, by convention every `updateMembership`
        // caller acquires that same parent-session lock first (step 2), so
        // concurrent callers on this session serialize here. A missing
        // RETURNING row therefore indicates an out-of-band write/delete of the
        // target row — which this transaction rolls back.
        throw new Error(
          `MembershipService.updateMembership: UPDATE returned no row for membership ${String(validated.membershipId)} in session ${sessionId}`,
        );
      }

      return {
        membershipId: updatedRow.id as MembershipId,
        state: updatedRow.state as MembershipState,
        role: updatedRow.role as MembershipRole,
        updatedAt: toIsoString(updatedRow.updated_at),
      };
    });
  }
}

// --------------------------------------------------------------------------
// pg.Pool -> MembershipService factory
// --------------------------------------------------------------------------
//
// Convenience one-liner for production wiring: composes a `Querier` from a
// `pg.Pool` via the shared `createPgPoolQuerier` adapter Plan-001 owns and
// constructs the service in one call, mirroring
// `createSessionDirectoryServiceFromPool` / `createInviteServiceFromPool`.
// The membership mutation inherits the held-client transaction semantics
// (BEGIN/COMMIT/ROLLBACK on one connection) that adapter documents — load-
// bearing for the FOR UPDATE lock in `updateMembership` to grip the same
// connection across the count + mutate.

/**
 * Compose a `MembershipService` from a `pg.Pool`.
 */
export function createMembershipServiceFromPool(pool: Pool): MembershipService {
  return new MembershipService(createPgPoolQuerier(pool));
}
