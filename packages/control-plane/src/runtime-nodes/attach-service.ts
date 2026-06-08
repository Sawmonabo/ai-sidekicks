// AttachService — Plan-003 Phase 3 (T3.2 + T3.3 + T3.7, runtime-node attach +
// detach handler).
//
// Responsibilities (T3.2 attach flow + T3.3 version-floor verdict + T3.7 detach):
//   * attach — admit a runtime node into a session by upserting its
//     `runtime_node_attachments` row, returning the wire
//     `RuntimeNodeAttachResponse` (`{attachmentId, state, readOnly, attachedAt}`).
//     Three load-bearing behaviors (Spec-003 line 53; Plan-003 §Invariants):
//       - P1/P2/P3 (version-floor verdict): the floor read + the `readOnly`
//         derivation live here (`#deriveReadOnly`). A NULL floor ("no floor")
//         admits EVERY daemon version with `readOnly = false` (P1). A non-NULL
//         floor compares the daemon's `clientVersion`: at/above floor admits
//         read-write (P2, `readOnly = false`); below floor admits READ-ONLY
//         (P3, `readOnly = true`) — admit-not-eject per I-003-1 (the node stays
//         joined and reads succeed; the `VERSION_FLOOR_EXCEEDED` write refusal
//         is T3.4's downstream enforcement).
//       - P9 (single active attachment — I-003-5): a node already actively
//         attached to ANOTHER session is refused with the typed
//         `RuntimeNodeAttachConflictException`; a reconnect of a node whose row
//         for THIS session is `offline` reactivates it (offline -> registering).
//       - P10 (revocation is terminal): a re-attach against a row in the
//         terminal `revoked` state for THIS session is refused with the typed
//         `RuntimeNodeAttachRevokedException` — never reactivated.
//   * detach — the clean-disconnect `offline` transition (T3.7; Spec-003 line 69
//     "an explicit `detach` retires the node"). Moves the node's SINGLE active
//     attachment to `offline` across two orthogonal axes: the SLOT axis
//     (`runtime_node_attachments.state -> offline`, guarded to active states) and
//     the LIVENESS axis (`runtime_node_presence.health_state -> offline`, UPDATE-
//     only). Resolves the one active row by `nodeId` alone (I-003-5 — the request
//     carries no `sessionId`). Idempotent: a node with no active attachment is a
//     clean `null` no-op (presence untouched). Writes the terminal state
//     `offline` ONLY — it is NOT a `revoked` producer (see the detach scope note
//     under Cross-task boundaries). Never touches `session_memberships` (I-003-3).
//
// Invariant fidelity (this task's `verifies_invariant`):
//   * I-003-3 (attach must not mutate session_memberships): the attach flow
//     writes ONLY `runtime_node_attachments` and acquires NO `session_memberships`
//     lock — it never references, SELECTs FOR UPDATE, or UPDATEs that table. The
//     runtime-node attach domain is entirely disjoint from the membership domain
//     Plan-001/Plan-002 own (cross-plan-dependencies.md §1; 0003-runtime-nodes.ts
//     header "Cross-plan boundary"). T3.2's test asserts the byte-for-byte
//     no-mutation property by re-SELECTing a seeded membership row's columns
//     after a successful attach. The DETACH path holds the same invariant: it
//     writes ONLY the two runtime-node tables (`runtime_node_attachments` +
//     `runtime_node_presence`) and never references `session_memberships`, so an
//     offline/detached node retains its membership (Spec-003 line 51). P8 asserts
//     the byte-for-byte membership no-mutation across a detach (snapshot + count,
//     the same two disjoint mutation modes as the attach test).
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
// `runtime_node_attachments` byte-for-byte unchanged. Detach is likewise atomic:
// the guarded attachment UPDATE (slot axis) and the conditional presence UPDATE
// (liveness axis) share ONE `Querier.transaction(...)` commit boundary, so the
// two axes never diverge — a torn detach can never leave the slot `offline` while
// presence stays `online` (or vice versa).
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
// Cross-task boundaries (DO NOT CROSS in T3.2 / T3.7):
//   * `runtime_node_attachments` / `runtime_node_presence` table DDL — owned by
//     `migrations/0003-runtime-nodes.ts` (Plan-003 Phase 3). This service only
//     INSERT/UPDATE/SELECTs rows; it never ALTERs the schema.
//   * The `VERSION_FLOOR_EXCEEDED` write-refusal — owned by T3.4. The below-floor
//     comparison that derives the read-only verdict at attach lands HERE (T3.3,
//     see `#deriveReadOnly`): a below-floor daemon is admitted `readOnly = true`
//     (admit-not-eject, I-003-1). T3.4 enforces the typed refusal on that
//     read-only daemon's subsequent WRITE — this service only sets the verdict.
//   * `runtime_node.*` durable event emission (`runtime_node.registered` /
//     `.online` / `.offline`) — owned by Plan-006 Tier 4 wiring. This service
//     mutates the row only; it emits no event (so detach's `reason` is dropped —
//     the durable `runtime_node.offline` audit event is V1.1-gated; CP-003-1).
//   * The `revoked` trust-revocation producer — the AUTHORITY / admin path that
//     writes `runtime_node_attachments.state = 'revoked'`. NOT in scope here:
//     `revoked` is a trust decision issued by an authority ABOUT the node
//     (Spec-003 line 70 — never self-asserted), whose proper home is a Cedar-
//     gated authority surface (ADR-012), NOT this daemon-facing detach (a daemon
//     cannot self-revoke; the wire `RuntimeNodeDetachRequest` carries no
//     disposition discriminator). The `revoked` STATE itself + attach's P10
//     terminal-re-attach refusal already ship — only the ungated producer is
//     deferred. detach (T3.7) writes the terminal state `offline` ONLY.
//   * The tRPC router + errorFormatter that lift the typed `.code` onto the wire
//     envelope and map each refusal to HTTP 409 / tRPC `CONFLICT` — T3.4 / T3.8.
//
// Refs: Spec-003 line 53 (version-floor admission), line 47 (attach is a separate
// step from membership acceptance — I-003-3), line 51 (detach/offline must not
// revoke membership by default — I-003-3), line 69 (an explicit `detach` retires
// the node), line 70 (`revoked` is authority-issued, never self-asserted);
// Plan-003 §Invariants I-003-1 (admit below-floor read-only, never eject) /
// I-003-3 (no session_memberships mutation, attach AND detach) / I-003-5 (single
// active attachment — detach resolves the one active row by `nodeId`) + T3.2
// (P1 / P9 / P10) + T3.3 (P2 / P3 floor comparison) + T3.7 (detach `offline`
// transition, P8); docs/architecture/schemas/shared-postgres-schema.md §Runtime
// Node Attachments (the `idx_node_attachments_node` + `idx_node_attachments_active`
// indexes); docs/architecture/contracts/api-payload-contracts.md §Plan-003
// (RuntimeNodeAttach + RuntimeNodeDetach request/response); `memberships/membership-service.ts`
// (the `Querier`-injected service idiom + the no-membership-mutation precedent
// this mirrors).

import type {
  EventEnvelopeVersion,
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  RuntimeNodeCapabilityUpdateRequest,
  RuntimeNodeCapabilityUpdateResponse,
  RuntimeNodeDetachRequest,
  NodeState,
} from "@ai-sidekicks/contracts";
import {
  compareEventEnvelopeVersion,
  EventEnvelopeVersionSchema,
  RuntimeNodeAttachRequestSchema,
  RuntimeNodeCapabilityUpdateRequestSchema,
  RuntimeNodeCapabilityUpdateResponseSchema,
  RuntimeNodeDetachRequestSchema,
} from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";
import {
  RuntimeNodeAttachConflictException,
  RuntimeNodeAttachRevokedException,
  RuntimeNodeCapabilityUpdateConflictException,
} from "./errors.js";

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

// The terminal state an explicit `detach` writes. Reused for BOTH detach writes
// (the same literal is valid in both column domains): the attachment SLOT axis
// (`runtime_node_attachments.state` — the clean-disconnect terminal state) and
// the presence LIVENESS axis (`runtime_node_presence.health_state` — the
// `online|degraded|offline` CHECK domain). It is the same liveness-death value
// the T3.6 staleness sweep derives at 60s (Spec-003 line 61), which an explicit
// detach effects IMMEDIATELY instead of waiting for heartbeat staleness
// (Spec-003 line 69 — "an explicit `detach` retires the node").
const OFFLINE_STATE: NodeState = "offline";

// Internal row shape returned by `pg.Pool#query` / `PGlite#query`. Postgres
// folds column identifiers to lowercase and the schema uses snake_case, so both
// drivers map onto these keys (mirrors the `MembershipRow` idiom in
// membership-service.ts).
interface AttachmentRow {
  readonly id: string;
  readonly state: string;
  readonly attached_at: Date | string;
}

// Internal row shape returned by the `updateCapabilities` RETURNING clause. The
// LIVENESS `state` plus the node id (mapped to the wire `nodeId`) and the
// transaction-time server clock `now() AS updated_at` (mapped to `updatedAt`).
// `updated_at` is NOT a stored column — the canonical `runtime_node_attachments`
// schema has only `attached_at` (the creation timestamp), which this method must
// never overwrite — so it is sourced transiently from `now()` at write time and
// hydrated as a JS `Date` (`pg`) or an ISO 8601 string (PGlite), normalized via
// `toIsoString` (mirrors `attached_at` on `AttachmentRow`).
interface CapabilityUpdateRow {
  readonly node_id: string;
  readonly state: string;
  readonly updated_at: Date | string;
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
   * Detach a runtime node — the clean-disconnect `offline` transition (Spec-003
   * line 69 "an explicit `detach` retires the node"; Plan-003 T3.7).
   *
   * Retires the node's SINGLE active attachment by `nodeId` alone: the partial
   * active index `idx_node_attachments_active` admits at most one active-state
   * row per node across all sessions (I-003-5), so `nodeId` resolves it
   * unambiguously — the request carries no `sessionId` (the wire shape is
   * `{nodeId, reason?}`). The retirement moves TWO orthogonal axes to `offline`:
   * the attachment SLOT axis (`runtime_node_attachments.state`) and the presence
   * LIVENESS axis (`runtime_node_presence.health_state`).
   *
   * Scope (settled, T3.7): detach writes the TERMINAL state `offline` ONLY. It is
   * NOT a `revoked` producer. `revoked` is an authority-issued trust decision
   * ABOUT the node (Spec-003 line 70 — never self-asserted), gated on a Cedar /
   * ADR-012 authorization surface Phase 3 does not ship; the only V1 caller of
   * detach (T3.8's daemon-initiated `runtimenode.detach`) is a clean disconnect,
   * and a daemon cannot self-revoke. The `revoked` STATE + attach's P10 terminal
   * re-attach refusal already ship; this method declines to invent an ungated,
   * uncalled trust-mutation producer (its home is the future authority surface).
   *
   * @param request the runtime-node detach payload. Validated at the boundary
   *   (`RuntimeNodeDetachRequestSchema.parse`) before any row is touched — the
   *   same service-layer fail-fast as `attach`, surfacing schema drift before the
   *   database.
   * @returns `null` — the no-content wire response (`RuntimeNodeDetachResponseSchema
   *   = z.null()`; there is no `RuntimeNodeDetachResponse` type alias). Detach is
   *   idempotent: a node with no active attachment returns `null` as a clean
   *   no-op.
   *
   * Transaction sequence (ONE commit boundary — both UPDATEs are atomic):
   *   1. Guarded retire of the active attachment row (slot axis): set `state ->
   *      offline` WHERE the row is in an ACTIVE state. Zero rows -> idempotent
   *      no-op (no active attachment), `return null` immediately, presence
   *      untouched.
   *   2. On one retired row, set presence `health_state -> offline` (liveness
   *      axis) — UPDATE-only, a no-op when the node never heartbeated.
   *
   * I-003-3 (attach-membership separation): detach writes ONLY
   * `runtime_node_attachments` + `runtime_node_presence`. It NEVER references,
   * SELECTs FOR UPDATE, INSERTs, UPDATEs, or DELETEs `session_memberships` — an
   * offline/detached node retains its membership (Spec-003 line 51). Mirrors the
   * MembershipService no-mutation precedent (the attach domain is disjoint from
   * the membership domain; cross-plan-dependencies.md §1). P8 asserts the
   * byte-for-byte no-mutation property across a detach (snapshot + count).
   */
  async detach(request: RuntimeNodeDetachRequest): Promise<null> {
    // Trust-boundary validation — parse rather than trust the caller, mirroring
    // `attach`. Surfaces schema drift before any row is touched.
    const validated: RuntimeNodeDetachRequest = RuntimeNodeDetachRequestSchema.parse(request);

    // `validated.reason` is wire-accepted but DELIBERATELY NOT persisted in V1,
    // exactly as `attach` drops `validated.healthState`: there is no `reason`
    // column on `runtime_node_attachments`, and the durable `runtime_node.offline`
    // event that would carry an audit `reason` is Plan-006 / V1.1-gated (no
    // control-plane event log in V1; CP-003-1). Do NOT "fix" the dropped field by
    // inventing a column — that would lead the schema.

    return this.#querier.transaction(async (transaction) => {
      // (1) Slot axis — retire the node's SINGLE active attachment. The
      // `state IN ('registering', 'online', 'degraded')` set is EXACTLY the
      // `idx_node_attachments_active` partial-index predicate in
      // `0003-runtime-nodes.ts`. It is LOAD-BEARING, not a convenience filter:
      //   - it resolves the one active row by `nodeId` alone (I-003-5 guarantees
      //     <=1 active row per node, so no `sessionId` is needed); and
      //   - it protects revocation-terminality (P10) — a lone `revoked` row is
      //     NEVER flipped to `offline`. A naive `WHERE node_id = $1` (no state
      //     guard) would corrupt a `revoked` row, so the guard is required.
      // Setting `state = 'offline'` moves the row OUT of the active partial
      // index, so the write can never collide (the inverse of attach's INSERT-
      // into-active path) — hence no `23505` catch / no floor read is needed.
      const retired = await transaction.query<{ id: string }>(
        `UPDATE runtime_node_attachments
            SET state = $2
          WHERE node_id = $1
            AND state IN ('registering', 'online', 'degraded')
        RETURNING id`,
        [validated.nodeId, OFFLINE_STATE],
      );

      // (1, cont.) Idempotent no-op: no active attachment — the node is already
      // `offline`, `revoked`, or never attached. Return `null` WITHOUT touching
      // presence (presence is heartbeat-owned; detach has nothing to retire).
      if (retired.rows[0] === undefined) {
        return null;
      }

      // (2) Liveness axis — effect the node's liveness-death immediately, the
      // same `health_state = 'offline'` the T3.6 staleness sweep derives at 60s
      // (Spec-003 line 61), without waiting for heartbeat staleness. UPDATE-ONLY,
      // never an upsert/INSERT: presence rows are heartbeat-owned (T3.6 creates
      // the row on the first beat), and `runtime_node_presence.last_heartbeat_at`
      // is `NOT NULL` with no default — an INSERT here would be both wrong
      // (detach is not a heartbeat) and unsatisfiable (no timestamp to write). A
      // node that never heartbeated has no presence row, so this is a clean
      // 0-row no-op. `health_state = 'offline'` is CHECK-valid (the presence
      // domain is `online|degraded|offline`).
      await transaction.query(
        `UPDATE runtime_node_presence
            SET health_state = $2
          WHERE node_id = $1`,
        [validated.nodeId, OFFLINE_STATE],
      );

      return null;
    });
  }

  /**
   * Refresh a runtime node's control-plane discovery snapshot — the
   * `runtimenode.capabilityupdate` coordination-snapshot refresh (Plan-003 T3.9;
   * Spec-003 §Default-Behavior `capabilityupdate` amendment).
   *
   * This is the CONTROL-PLANE half of capability-update: it refreshes the
   * `capabilities` JSONB snapshot (the discovery roster other participants read)
   * on the node's single active attachment and, when `healthChanges` is present,
   * applies the daemon-reported capability-health transition. It is NOT the
   * durable `runtime_node.capability_updated` writer — the control plane has no
   * event log (ADR-017); the daemon's node-capability service stays the event
   * writer. This method only updates the coordination row.
   *
   * @param request the capability-update payload. Validated at the boundary
   *   (`RuntimeNodeCapabilityUpdateRequestSchema.parse`) before any row is read
   *   or written — the same service-layer fail-fast as `attach` / `detach`.
   *   `healthChanges.state` is the 2-value `RuntimeNodeHealthState`
   *   (`online | degraded`), so `offline` / `revoked` are UNCONSTRUCTABLE at the
   *   schema boundary (I-003-2 — make-illegal-states-unrepresentable); this
   *   method never sees them.
   * @returns the `RuntimeNodeCapabilityUpdateResponse` (`{nodeId, state,
   *   updatedAt}`) projection of the refreshed row. Note the request->response
   *   asymmetry: the request's `healthChanges.state` is the 2-value health enum,
   *   while `response.state` is the broad 5-value `NodeState` (the server-derived
   *   liveness projection — e.g. a capabilities-only refresh returns the row's
   *   unchanged `registering` state, which is not a daemon-reportable value).
   * @throws RuntimeNodeCapabilityUpdateConflictException in two cases, both 409:
   *   (1) no active attachment exists (a late update racing a `detach` / the
   *   staleness sweep — there is no `{nodeId, state, updatedAt}` to return); and
   *   (2) the I-003-2 guard — the request would drive a `registering` attachment
   *   to `online` (bringing a node online requires a daemon-side capability
   *   declaration; the control plane is not the declaration authority —
   *   Spec-003 lines 52 / 57).
   *
   * Transaction sequence (ONE commit boundary):
   *   1. Resolve the node's SINGLE active attachment `FOR UPDATE` by `nodeId`
   *      within the active-state band (`registering` / `online` / `degraded` —
   *      unambiguous per I-003-5). Zero rows -> the no-active-attachment refusal
   *      (case 1).
   *   2. I-003-2 guard: a `registering` row + a requested `online` health is the
   *      one residual state-context refusal (case 2). EXPLICITLY ALLOWED (not
   *      guarded): `registering -> degraded` (Spec-003 §Fallback Behavior —
   *      capability-validation failure leaves the node degraded), `degraded ->
   *      online` (recovery), and a capabilities-only refresh on any active row.
   *   3. Refresh `capabilities` (the discovery snapshot) and write the resolved
   *      next-state back. `RETURNING node_id, state, now() AS updated_at` — the
   *      `updatedAt` is the transaction-time server clock, sourced TRANSIENTLY,
   *      never a stored column: `attached_at` (the creation timestamp) is NOT
   *      overwritten.
   *   4. Map (`node_id`/`updated_at` -> `nodeId`/`updatedAt`) and parse through
   *      `RuntimeNodeCapabilityUpdateResponseSchema` (brands `nodeId`, validates
   *      the ISO 8601 `updatedAt`).
   *
   * Write surface — `runtime_node_attachments` ONLY. It writes NO
   * `runtime_node_presence` row and bumps NO `last_heartbeat_at` (the liveness
   * clock is heartbeat-owned, T3.6 — the axes stay orthogonal), mutates NO
   * `session_memberships` (I-003-3 — the runtime-node domain is disjoint from the
   * membership domain), and emits NO durable `runtime_node.*` event (ADR-017 —
   * no control-plane event log). A thrown refusal rolls the transaction back, so
   * a refused update leaves `runtime_node_attachments` byte-for-byte unchanged.
   */
  async updateCapabilities(
    request: RuntimeNodeCapabilityUpdateRequest,
  ): Promise<RuntimeNodeCapabilityUpdateResponse> {
    // Trust-boundary validation — parse rather than trust the caller, mirroring
    // `attach` / `detach`. Surfaces schema drift (a malformed `capabilities`
    // map, an out-of-enum `healthChanges.state`, an unknown key) before any row
    // is read or mutated.
    const validated: RuntimeNodeCapabilityUpdateRequest =
      RuntimeNodeCapabilityUpdateRequestSchema.parse(request);

    // `validated.healthChanges?.reason` is wire-accepted but DELIBERATELY NOT
    // persisted in V1, exactly as `attach` drops `validated.healthState` and
    // `detach` drops `validated.reason`: there is no `reason` column on
    // `runtime_node_attachments`, and the only home for a health-transition audit
    // `reason` is the durable `runtime_node.*` event the control plane does not
    // write (ADR-017 — no control-plane event log; the daemon's node-capability
    // service is the event writer). Do NOT "fix" the dropped field by inventing a
    // column — that would lead the schema. This method reads only
    // `healthChanges?.state` (the liveness transition) below.

    return this.#querier.transaction(async (transaction) => {
      // (1) Resolve the node's SINGLE active attachment FOR UPDATE. The
      // `state IN ('registering', 'online', 'degraded')` set is the same
      // load-bearing active-state filter detach uses — EXACTLY the
      // `idx_node_attachments_active` partial-index predicate
      // (`0003-runtime-nodes.ts`): I-003-5 guarantees <=1 active row per node
      // across all sessions, so `nodeId` alone resolves it (the request carries
      // no `sessionId`), and the band EXCLUDES the inactive states (`offline`,
      // `revoked`) so a late update against a detached / swept / revoked node
      // matches no row (the typed refusal below). FOR UPDATE locks the row for
      // the transaction's duration so a concurrent detach / sweep cannot retire
      // it between this read and the UPDATE below.
      const activeProbe = await transaction.query<{ id: string; state: string }>(
        `SELECT id, state
           FROM runtime_node_attachments
          WHERE node_id = $1
            AND state IN ('registering', 'online', 'degraded')
          FOR UPDATE`,
        [validated.nodeId],
      );
      const activeRow: { id: string; state: string } | undefined = activeProbe.rows[0];

      // (2) No active attachment -> typed 409 refusal (NOT a 500, NOT a null
      // no-op). capabilityupdate MUST return `{nodeId, state, updatedAt}`; with
      // no active row there is no state to return. This is a legitimate
      // production race — a late update arriving after a `detach` retired the
      // node, or after the T3.6 staleness sweep marked it offline — and mirrors
      // attach's defensive posture (the service does not assume the router
      // pre-validated liveness). The message names `nodeId` ONLY (no session, no
      // state — no info-leak).
      if (activeRow === undefined) {
        throw new RuntimeNodeCapabilityUpdateConflictException(
          `Runtime node ${String(validated.nodeId)} has no active attachment to update.`,
        );
      }

      // (3) I-003-2 guard — the ONE residual state-context refusal. The wire
      // VALUE `online` is legal (the 2-value `RuntimeNodeHealthState`), but
      // applying it to a still-`registering` attachment is not: bringing a node
      // `online` requires a successful DAEMON-side capability declaration
      // (Spec-003 line 57), and the control plane is not the declaration
      // authority (Spec-003 line 52). EXPLICITLY ALLOWED and NOT guarded here:
      //   - `registering -> degraded` (Spec-003 §Fallback Behavior — a
      //     capability-validation failure leaves the node degraded);
      //   - `degraded -> online` (recovery — the node was declared online once);
      //   - a capabilities-only refresh (no `healthChanges`) on a registering
      //     row (no liveness transition at all).
      // `offline` / `revoked` cannot reach this guard — they are unconstructable
      // at the schema boundary (the 2-value enum), so this is the SOLE remaining
      // I-003-2 case. The message names the `nodeId` + the PUBLIC RULE, never the
      // node's current `state` (no info-leak — a caller learns the rule, not the
      // node's internal liveness position).
      if (activeRow.state === REGISTERING_STATE && validated.healthChanges?.state === "online") {
        throw new RuntimeNodeCapabilityUpdateConflictException(
          `Runtime node ${String(validated.nodeId)} cannot be brought online via capability update; online requires a daemon-side capability declaration.`,
        );
      }

      // (4) Refresh the discovery snapshot + apply the resolved next-state. The
      // next-state is `healthChanges.state` when present, else the row's current
      // (locked) state written back unchanged — safe under FOR UPDATE and
      // idempotent (a capabilities-only refresh re-writes the same `state`).
      // `capabilities` is the JS object bound DIRECTLY to the JSONB column (no
      // `::jsonb` cast) — the same idiom attach's INSERT uses and its tests prove
      // (both `pg` and PGlite serialize an object parameter for a JSONB column).
      // `now() AS updated_at` is the transaction-time server clock, sourced
      // transiently — it is RETURNED, never written to a column, so `attached_at`
      // (the creation timestamp) is left untouched.
      const nextState: string = validated.healthChanges?.state ?? activeRow.state;
      const refreshed = await transaction.query<CapabilityUpdateRow>(
        `UPDATE runtime_node_attachments
            SET capabilities = $1,
                state        = $2
          WHERE id = $3
        RETURNING node_id, state, now() AS updated_at`,
        [validated.capabilities, nextState, activeRow.id],
      );
      const refreshedRow: CapabilityUpdateRow | undefined = refreshed.rows[0];
      if (refreshedRow === undefined) {
        // Defensive: the row was locked FOR UPDATE one statement earlier, so a
        // zero-row UPDATE here is an impossible substrate state. Surface it as a
        // hard error rather than masquerading as a successful refresh.
        throw new Error(
          `AttachService.updateCapabilities: UPDATE returned no row for node ${String(validated.nodeId)} despite a FOR UPDATE lock.`,
        );
      }

      // (5) Map (`node_id`/`updated_at` -> `nodeId`/`updatedAt`) and parse. The
      // response parse brands `nodeId` and validates the ISO 8601 `updatedAt` —
      // deliberately more hardened than attach's `as NodeState` row-mapping
      // cast, per the plan's explicit "parse the mapped row" instruction.
      return RuntimeNodeCapabilityUpdateResponseSchema.parse({
        nodeId: refreshedRow.node_id,
        state: refreshedRow.state,
        updatedAt: toIsoString(refreshedRow.updated_at),
      });
    });
  }

  /**
   * Derive the `readOnly` PERMISSION verdict from the session floor and the
   * daemon's reported `clientVersion`.
   *
   * Two branches, both serving Spec-003 line 53 / I-003-1:
   *   - NULL floor (P1) — "no floor", so EVERY daemon version is admitted with
   *     `readOnly = false`. Unconditional read-write admission.
   *   - Non-NULL floor (P2/P3) — compare the daemon's `clientVersion` against the
   *     floor via the contracts comparator. A daemon strictly below the floor
   *     (`compareEventEnvelopeVersion(clientVersion, floor) < 0`) is admitted in
   *     read-only state (`readOnly = true`); a daemon AT or ABOVE the floor is
   *     admitted read-write (`readOnly = false`). Below-floor is admit-read-only,
   *     never eject (I-003-1 / ADR-018 §Decision #4) — the node stays joined and
   *     reads succeed; the write refusal (`VERSION_FLOOR_EXCEEDED`) is enforced
   *     downstream (T3.4), not here.
   *
   * Isolating the verdict behind this private seam keeps the upsert path stable:
   * the call site (the transaction body) is unchanged across the T3.2 -> T3.3
   * extension — only this method's non-NULL branch gained the comparison.
   *
   * @param floor the session's raw `min_client_version` DB value (NULL = no
   *   floor). Parsed+branded HERE (not `as`-cast) so a malformed floor throws at
   *   the parse boundary rather than reaching the comparator as NaN.
   * @param clientVersion the daemon's reported version, already branded
   *   `EventEnvelopeVersion` (parsed at the request boundary in `attach`).
   */
  #deriveReadOnly(floor: string | null, clientVersion: EventEnvelopeVersion): boolean {
    if (floor === null) {
      // NULL floor — no version gate. Unconditional read-write admission (P1).
      return false;
    }
    // Non-NULL floor: parse+brand the raw DB value at THIS boundary — never an
    // `as` cast. A cast would let a malformed floor reach the numeric comparator
    // as NaN and silently admit read-write; `.parse` throws loud on a malformed
    // floor (a data-integrity violation) instead. Below floor -> readOnly = true:
    // admit in read-only, never eject (I-003-1 / ADR-018 §Decision #4).
    const floorVersion: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse(floor);
    return compareEventEnvelopeVersion(clientVersion, floorVersion) < 0;
  }
}
