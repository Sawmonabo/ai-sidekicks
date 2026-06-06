// AttachService — Plan-003 Phase 3 (T3.2, runtime-node attach handler).
//
// Responsibilities (this task, T3.2):
//   * attach — admit a runtime node into a session by upserting its
//     `runtime_node_attachments` row, returning the wire
//     `RuntimeNodeAttachResponse` (`{attachmentId, state, readOnly, attachedAt}`).
//     Three load-bearing behaviors (Spec-003 line 53; Plan-003 §Invariants):
//       - P1 (NULL-floor unconditional admission): when the session's
//         `min_client_version` floor is NULL ("no floor"), EVERY daemon version
//         is admitted with `readOnly = false`. The floor read + the readOnly
//         derivation live here; the BELOW-FLOOR semver comparison that can flip
//         `readOnly` to `true` is T3.3's extension (see `#deriveReadOnly`).
//       - P9 (single active attachment — I-003-5): a node already actively
//         attached to ANOTHER session is refused with the typed
//         `RuntimeNodeAttachConflictException`; a reconnect of a node whose row
//         for THIS session is `offline` reactivates it (offline -> registering).
//       - P10 (revocation is terminal): a re-attach against a row in the
//         terminal `revoked` state for THIS session is refused with the typed
//         `RuntimeNodeAttachRevokedException` — never reactivated.
//
// Invariant fidelity (this task's `verifies_invariant`):
//   * I-003-3 (attach must not mutate session_memberships): the attach flow
//     writes ONLY `runtime_node_attachments` and acquires NO `session_memberships`
//     lock — it never references, SELECTs FOR UPDATE, or UPDATEs that table. The
//     runtime-node attach domain is entirely disjoint from the membership domain
//     Plan-001/Plan-002 own (cross-plan-dependencies.md §1; 0003-runtime-nodes.ts
//     header "Cross-plan boundary"). T3.2's test asserts the byte-for-byte
//     no-mutation property by re-SELECTing a seeded membership row's columns
//     after a successful attach.
//   * I-003-5 (single active attachment): enforced at the DATABASE layer by the
//     partial-unique `idx_node_attachments_active` (one active-state row per
//     node across all sessions). The service does not re-check this in
//     application code — it lets the index raise `23505` on the cross-session
//     second-active-attach and translates that to the typed conflict refusal
//     (the no-TOCTOU posture: the unique index is the single source of truth, so
//     two racing attaches cannot both win).
//
// Atomicity: the floor read, the upsert, and (on the revoked path) the
// post-upsert verify-SELECT share ONE `Querier.transaction(...)` commit
// boundary, mirroring MembershipService / SessionDirectoryService. A thrown
// refusal rolls the transaction back (the `pg.Pool` + PGlite adapters both
// auto-`ROLLBACK` on throw and re-raise), so a refused attach leaves
// `runtime_node_attachments` byte-for-byte unchanged.
//
// Dependency injection (mirrors MembershipService / SessionDirectoryService):
//   * `Querier` — the minimal SQL surface declared in
//     `sessions/migration-runner.ts`. The service body NEVER imports `pg`
//     directly. The production pool-wiring (a `createAttachServiceFromPool`
//     factory and the runtime-node tRPC router that composes it) is DEFERRED to
//     T3.8 (`runtime-node-router.factory.ts`); this task ships only the
//     `Querier`-injected service, so the test substrate (in-process PGlite) and
//     the eventual production surface (`pg.Pool`) stay interchangeable without a
//     runtime branch.
//
// Cross-task boundaries (DO NOT CROSS in T3.2):
//   * `runtime_node_attachments` / `runtime_node_presence` table DDL — owned by
//     `migrations/0003-runtime-nodes.ts` (Plan-003 Phase 3). This service only
//     INSERT/UPDATE/SELECTs rows; it never ALTERs the schema.
//   * The below-floor semver comparison + `VERSION_FLOOR_EXCEEDED` write-refusal
//     — owned by T3.3 / T3.4 (see `#deriveReadOnly`). This task derives
//     `readOnly = false` unconditionally (the NULL-floor branch is the whole P1
//     contract; the non-NULL branch is a deferred-to-T3.3 placeholder).
//   * `runtime_node.*` durable event emission (`runtime_node.registered` /
//     `.online`) — owned by Plan-006 Tier 4 wiring. This service mutates the row
//     only; it emits no event.
//   * Detach (offline/revoke transitions) — owned by T3.7.
//   * The tRPC router + errorFormatter that lift the typed `.code` onto the wire
//     envelope and map each refusal to HTTP 409 / tRPC `CONFLICT` — T3.4 / T3.8.
//
// Refs: Spec-003 line 53 (NULL-floor admission); Plan-003 §Invariants I-003-3
// (no session_memberships mutation) / I-003-5 (single active attachment) + T3.2
// (P1 / P9 / P10); docs/architecture/schemas/shared-postgres-schema.md §Runtime
// Node Attachments (the `idx_node_attachments_node` + `idx_node_attachments_active`
// indexes); docs/architecture/contracts/api-payload-contracts.md §Plan-003
// (RuntimeNodeAttach request/response); `memberships/membership-service.ts` (the
// `Querier`-injected service idiom this mirrors).

import type {
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  NodeState,
} from "@ai-sidekicks/contracts";
import { RuntimeNodeAttachRequestSchema } from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";
import { RuntimeNodeAttachConflictException, RuntimeNodeAttachRevokedException } from "./errors.js";

// The partial-unique index whose `23505` signals the I-003-5 cross-session
// second-active-attach (one active-state row per node across all sessions).
// Asserted on the caught error's `.constraint` so an UNRELATED unique violation
// (e.g. a future constraint) is not silently mistranslated into the typed
// conflict refusal — it rethrows as the raw error instead.
const ACTIVE_ATTACHMENT_INDEX = "idx_node_attachments_active";

// Postgres SQLSTATE for unique_violation. Both `pg` (`DatabaseError`) and PGlite
// expose it as `error.code` and the offending index as `error.constraint`
// (the portable `NoticeOrError` surface — empirically confirmed against both
// adapters), so the catch below narrows to that shape rather than `instanceof`
// a driver-specific error class (the service body never imports `pg`).
const UNIQUE_VIOLATION_SQLSTATE = "23505";

// The terminal liveness state a `revoked` attachment row carries. A re-attach
// against a row in this state is refused (P10); every OTHER non-active state
// (only `offline` in practice) is reactivated by the upsert's DO UPDATE.
const REVOKED_STATE: NodeState = "revoked";

// The liveness state a freshly-admitted / reactivated attachment enters. The
// node advances to `online` only after the Plan-006 registration/capability
// handshake (out of scope here); attach lands it at `registering`.
const REGISTERING_STATE: NodeState = "registering";

// Internal row shape returned by `pg.Pool#query` / `PGlite#query`. Postgres
// folds column identifiers to lowercase and the schema uses snake_case, so both
// drivers map onto these keys (mirrors the `MembershipRow` idiom in
// membership-service.ts).
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

// Narrow an unknown thrown value to the portable `DatabaseError` surface
// (`{ code?, constraint? }`) without depending on a driver-specific class. Used
// to distinguish the I-003-5 active-index `23505` (which becomes the typed
// conflict refusal) from every other thrown error (which rethrows unchanged).
function asDatabaseError(error: unknown): {
  code?: string | undefined;
  constraint?: string | undefined;
} {
  // Optional fields are typed `key?: T | undefined` (not bare `key?:`) because
  // the object literal below assigns an explicit `undefined`, which under
  // `exactOptionalPropertyTypes: true` is NOT assignable to a bare-optional
  // property (TS2375). Same `key?: T | undefined` convention the contracts
  // package documents for its optional wire fields (runtime-node.ts).
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
  };
}

export class AttachService {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Attach a runtime node to a session (Spec-003 line 53; Plan-003 T3.2).
   *
   * @param request the runtime-node attach payload. Validated at the boundary
   *   (`RuntimeNodeAttachRequestSchema.parse`) before any row is read or
   *   written — a service-layer fail-fast that surfaces schema drift (e.g. a
   *   malformed `clientVersion` or unknown key) before touching the database,
   *   mirroring MembershipService.updateMembership's boundary parse.
   * @returns the `RuntimeNodeAttachResponse` projection of the upserted row.
   * @throws RuntimeNodeAttachConflictException when the node is already actively
   *   attached to a DIFFERENT session (P9 / I-003-5 — the active-index `23505`).
   * @throws RuntimeNodeAttachRevokedException when the node's row for THIS
   *   session is in the terminal `revoked` state (P10).
   *
   * Transaction sequence (ONE commit boundary):
   *   1. Read the session's `min_client_version` floor.
   *   2. Derive `readOnly` from (floor, clientVersion) via `#deriveReadOnly`.
   *   3. Upsert the attachment row — `INSERT ... ON CONFLICT (node_id,
   *      session_id) DO UPDATE ... WHERE state <> 'revoked' RETURNING`. The
   *      conflict arbiter is the TOTAL `idx_node_attachments_node` unique; the
   *      DO UPDATE reactivates an `offline` row (P9 reconnect) and is SUPPRESSED
   *      for a `revoked` row (its WHERE is false), yielding zero RETURNING rows.
   *   4a. Non-empty RETURNING -> map the row to the response (the admit /
   *       reconnect happy path, P1 / P9 reconnect).
   *   4b. Empty RETURNING -> the DO UPDATE was suppressed: verify the existing
   *       row for THIS session is `revoked` and throw the terminal refusal
   *       (P10). A genuinely-absent row (no conflict, so the INSERT would have
   *       inserted and RETURNING would be non-empty) cannot reach this branch;
   *       the verify-SELECT defends the substrate-generality edge.
   *   5. A `23505` on `idx_node_attachments_active` — a SECOND active attach for
   *      this node in ANOTHER session — is caught and rethrown as the typed
   *      conflict refusal (P9 cross-session). It can arise from the INSERT (a
   *      fresh cross-session attach) OR the DO UPDATE (reactivating an `offline`
   *      row while the node is active elsewhere); the guard keys on the
   *      constraint name + SQLSTATE, so both phases translate identically. The
   *      catch rethrows IMMEDIATELY with no further query — a `23505` aborts the
   *      Postgres transaction (`25P02`), so any post-error query in the same
   *      transaction would fail; the typed throw then rolls the transaction back.
   */
  async attach(request: RuntimeNodeAttachRequest): Promise<RuntimeNodeAttachResponse> {
    // Trust-boundary validation — parse rather than trust the caller. Surfaces
    // schema drift before any row is read or mutated (mirrors
    // MembershipService.updateMembership / InviteService.createInvite).
    const validated: RuntimeNodeAttachRequest = RuntimeNodeAttachRequestSchema.parse(request);

    return this.#querier.transaction(async (transaction) => {
      // (1) Read the per-session version floor. NULL = "no floor" (every daemon
      // version admitted) per `sessions.min_client_version` (0001-initial.ts
      // line 104; ADR-018 §Decision #1). A missing session row surfaces as
      // `floorRow === undefined`; we treat that as "no floor" here — session
      // existence/authorization is the router's gate (T3.8), not this service's
      // (the FK on `runtime_node_attachments.session_id` would also reject an
      // INSERT against a non-existent session at step 3).
      const floorProbe = await transaction.query<{ min_client_version: string | null }>(
        "SELECT min_client_version FROM sessions WHERE id = $1",
        [validated.sessionId],
      );
      const floorRow: { min_client_version: string | null } | undefined = floorProbe.rows[0];
      const floor: string | null = floorRow === undefined ? null : floorRow.min_client_version;

      // (2) Derive the PERMISSION axis (orthogonal to the LIVENESS `state`).
      const readOnly: boolean = this.#deriveReadOnly(floor, validated.clientVersion);

      // (3) Upsert. The conflict arbiter is the TOTAL `(node_id, session_id)`
      // unique (`idx_node_attachments_node`); `capabilities` is a JS object
      // bound to the JSONB column (both `pg` and PGlite serialize an object
      // parameter to JSON for a JSONB column); `client_version` (the branded
      // MAJOR.MINOR string) is stored as TEXT. The DO UPDATE's
      // `WHERE state <> 'revoked'` reactivates an `offline` row (P9 reconnect)
      // and is SUPPRESSED for a `revoked` row (P10 -> zero RETURNING rows).
      //
      // `validated.healthState` is parsed at the boundary but DELIBERATELY NOT
      // persisted here: `state` is hard-pinned to `registering` (Spec-003 line 57
      // / I-003-2) — a node advances to `online` ONLY via the capability-
      // declaration handshake (T3.9), and presence/health lands on the first
      // heartbeat (T3.6 owns `runtime_node_presence`). Do NOT "fix" the dropped
      // field by writing health at attach; that would skip the handshake gate.
      let upserted: { rows: ReadonlyArray<AttachmentRow> };
      try {
        upserted = await transaction.query<AttachmentRow>(
          `INSERT INTO runtime_node_attachments
             (session_id, participant_id, node_id, capabilities, client_version, state)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (node_id, session_id) DO UPDATE
             SET participant_id = EXCLUDED.participant_id,
                 capabilities   = EXCLUDED.capabilities,
                 client_version = EXCLUDED.client_version,
                 state          = $6
           WHERE runtime_node_attachments.state <> $7
           RETURNING id, state, attached_at`,
          [
            validated.sessionId,
            validated.participantId,
            validated.nodeId,
            validated.capabilities,
            validated.clientVersion,
            REGISTERING_STATE,
            REVOKED_STATE,
          ],
        );
      } catch (error: unknown) {
        // (5) Cross-session second-active-attach. The partial-unique
        // `idx_node_attachments_active` raised `23505` because this node already
        // holds an active-state row in ANOTHER session (I-003-5). The `23505` can
        // originate from EITHER statement phase, both translated identically:
        //   - the INSERT — a FRESH cross-session attach (no row yet for THIS
        //     session, so the upsert inserts a new active row -> a second active
        //     row for the node); or
        //   - the DO UPDATE — REACTIVATING an `offline` row for THIS session
        //     (offline -> registering) while the node is active elsewhere, which
        //     creates the second active row during the update.
        // The guard keys on the constraint NAME + SQLSTATE (not the statement
        // position), so both phases land here. Translate to the typed conflict
        // refusal. The message names the `nodeId` ONLY — never the other
        // session's id (no cross-session info-leak). Any OTHER unique violation
        // (different constraint) or non-`23505` error rethrows unchanged.
        // Rethrow IMMEDIATELY — no follow-up query — because the `23505` has
        // aborted the transaction (a subsequent query would `25P02`); the throw
        // rolls it back.
        const databaseError = asDatabaseError(error);
        if (
          databaseError.code === UNIQUE_VIOLATION_SQLSTATE &&
          databaseError.constraint === ACTIVE_ATTACHMENT_INDEX
        ) {
          throw new RuntimeNodeAttachConflictException(
            `Runtime node ${String(validated.nodeId)} is already actively attached to another session; detach before attaching elsewhere.`,
          );
        }
        throw error;
      }

      const upsertedRow: AttachmentRow | undefined = upserted.rows[0];

      // (4b) Zero RETURNING rows => the DO UPDATE was suppressed by
      // `WHERE state <> 'revoked'`, i.e. the existing row for THIS session is in
      // the terminal `revoked` state (P10 — revocation is terminal). Verify that
      // explicitly (a successful zero-row update does NOT abort the transaction,
      // so this read is safe) so a genuinely-absent row is not mis-reported as
      // revoked. The message names the caller's OWN `sessionId` (the session
      // whose attachment was revoked) — no other session's identity is disclosed.
      if (upsertedRow === undefined) {
        const existingProbe = await transaction.query<{ state: string }>(
          "SELECT state FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2",
          [validated.nodeId, validated.sessionId],
        );
        const existingRow: { state: string } | undefined = existingProbe.rows[0];
        if (existingRow !== undefined && existingRow.state === REVOKED_STATE) {
          throw new RuntimeNodeAttachRevokedException(
            `Runtime node ${String(validated.nodeId)}'s attachment to session ${String(validated.sessionId)} was revoked; revocation is terminal.`,
          );
        }
        // Defensive: a zero-row upsert with no revoked row is an impossible
        // substrate state (the conflict either updated a non-revoked row -> one
        // RETURNING row, or inserted a fresh row -> one RETURNING row). Surface
        // it as a hard error rather than masquerading as a revoked refusal.
        throw new Error(
          `AttachService.attach: upsert returned no row for node ${String(validated.nodeId)} in session ${String(validated.sessionId)} and no revoked row was found.`,
        );
      }

      // (4a) Admit / reconnect happy path. Map the row to the wire response.
      return {
        attachmentId: upsertedRow.id,
        state: upsertedRow.state as NodeState,
        readOnly,
        attachedAt: toIsoString(upsertedRow.attached_at),
      };
    });
  }

  /**
   * Derive the `readOnly` PERMISSION verdict from the session floor and the
   * daemon's reported `clientVersion`.
   *
   * T3.2 ships the NULL-floor branch — the whole P1 contract: a NULL floor means
   * "no floor", so EVERY daemon version is admitted with `readOnly = false`
   * (Spec-003 line 53). The non-NULL branch is a deferred placeholder that also
   * returns `false`; the below-floor semver comparison that flips it to `true`
   * for a below-floor daemon (admit read-only, never eject — I-003-1 / ADR-018
   * §Decision #4) is T3.3's extension. Isolating the verdict behind this private
   * seam keeps the upsert path stable across that extension: T3.3 changes only
   * this method's non-NULL branch.
   *
   * @param floor the session's `min_client_version` (NULL = no floor).
   * @param _clientVersion the daemon's reported version (unused until T3.3's
   *   semver comparison lands; named with a leading underscore to mark it
   *   intentionally-unread without dropping it from the seam's signature).
   */
  #deriveReadOnly(floor: string | null, _clientVersion: string): boolean {
    if (floor === null) {
      // NULL floor — no version gate. Unconditional read-write admission (P1).
      return false;
    }
    // T3.3 extends: below-floor (semver compare clientVersion < floor, I-003-1)
    // -> readOnly = true. Until then a non-NULL floor still admits read-write
    // (the placeholder preserves the pre-T3.3 admit-all behavior; T3.3 swaps in
    // the comparison without touching the upsert path above).
    return false;
  }
}
