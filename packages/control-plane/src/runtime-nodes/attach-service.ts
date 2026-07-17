// AttachService — Plan-003 Phase 3 (T3.2 + T3.3 + T3.7 + T3.9) + Phase 5
// (T5.0c): runtime-node attach + detach + capability-update + roster-read
// handler.
//
// Responsibilities (T3.2 attach flow + T3.3 version-floor verdict + T3.7 detach
// + T3.9 capability update + T5.0c roster read):
//   * attach — admit a runtime node into a session by upserting its
//     `runtime_node_attachments` row, returning the wire
//     `RuntimeNodeAttachResponse` (`{attachmentId, state, readOnly, attachedAt}`).
//     Three load-bearing behaviors (`Spec-003 §Required Behavior`; Plan-003 §Invariants):
//       - P1/P2/P3 (version-floor verdict): the floor read + the `readOnly`
//         derivation live here (`#deriveReadOnly`). A NULL floor ("no floor")
//         admits EVERY daemon version with `readOnly = false` (P1). A non-NULL
//         floor compares the daemon's `clientVersion`: at/above floor admits
//         read-write (P2, `readOnly = false`); below floor admits READ-ONLY
//         (P3, `readOnly = true`) — admit-not-eject per I-003-1 (the node stays
//         joined and reads succeed; the `VERSION_FLOOR_EXCEEDED` write refusal
//         is enforced later, in `updateCapabilities` (T3.9), via the
//         T3.4-defined `VersionFloorExceededException` — see Cross-task
//         boundaries).
//       - P9 (single active attachment — I-003-5): a node already actively
//         attached to ANOTHER session is refused with the typed
//         `RuntimeNodeAttachConflictException`; a SAME-OWNER reconnect of a node
//         whose row for THIS session is `offline` reactivates it (offline ->
//         registering). The owner participant is IMMUTABLE across reconnect
//         (`Spec-003 §Implementation Notes` — a reconnect is the same daemon), so a DIFFERENT
//         participant reconnecting to that row is REFUSED with the same typed
//         `RuntimeNodeAttachConflictException` rather than overwriting the owner
//         (`Spec-003 §Pitfalls To Avoid` — never destroy historical node provenance).
//       - P10 (revocation is terminal): a re-attach against a row in the
//         terminal `revoked` state for THIS session is refused with the typed
//         `RuntimeNodeAttachRevokedException` — never reactivated.
//   * detach — the clean-disconnect `offline` transition (T3.7; `Spec-003 §Default Behavior`
//     "an explicit `detach` retires the node"). Moves the node's SINGLE active
//     attachment to `offline` across two orthogonal axes: the SLOT axis
//     (`runtime_node_attachments.state -> offline`, guarded to active states) and
//     the LIVENESS axis (`runtime_node_presence.health_state -> offline`, UPDATE-
//     only). Resolves the one active row by `nodeId` alone (I-003-5 — the request
//     carries no `sessionId`). Idempotent: a node with no active attachment is a
//     clean `null` no-op (presence untouched). Writes the terminal state
//     `offline` ONLY — it is NOT a `revoked` producer (see the detach scope note
//     under Cross-task boundaries). Never touches `session_memberships` (I-003-3).
//   * updateCapabilities — the capability-declaration refresh (T3.9; Spec-003
//     `Spec-003 §Default Behavior` "the node declares its capabilities"). Resolves the node's SINGLE
//     active attachment by `nodeId` (I-003-5 — the request carries no
//     `sessionId`), then refreshes its `capabilities` discovery snapshot and
//     applies the resolved next-state, all inside ONE `Querier.transaction(...)`.
//     Enforces TWO refusals that share `runtime-nodes/errors.ts`'s typed family:
//       - the T3.4 `VERSION_FLOOR_EXCEEDED` write-refusal — a below-floor node
//         (admitted read-only at attach, T3.3) is denied the capability WRITE.
//         The read-only verdict is RE-DERIVED here from the CURRENT session floor
//         + the daemon's attach-time `client_version`, then thrown as the typed
//         `VersionFloorExceededException` (admit-not-eject — the throw rolls back,
//         the node stays joined; I-003-1 / ADR-018 §Decision #4 / Spec-003
//         `Spec-003 §Acceptance Criteria` AC4); and
//       - the I-003-2 registering->online guard — driving a still-`registering`
//         attachment to `online` is refused (the typed
//         `RuntimeNodeCapabilityUpdateConflictException`): bringing a node online
//         requires a successful daemon-side capability declaration (Spec-003
//         `Spec-003 §Default Behavior`), and the control plane is not the declaration authority
//         (`Spec-003 §Required Behavior`).
//     A no-active-attachment request (a late update racing a detach / revoke) is
//     the third refusal — also the typed conflict, never a null no-op. A thrown
//     refusal rolls the transaction back, so a refused update leaves
//     `runtime_node_attachments` byte-for-byte unchanged.
//   * readRoster — the session roster projection (T5.0c; Spec-003 §Interfaces
//     And Contracts 2026-06-09 amendment). ONE read-only SELECT
//     returning EVERY `runtime_node_attachments` row for the session — all five
//     `state` values verbatim, no server-side hiding (`Spec-003 §Interfaces And Contracts`; AC2
//     `Spec-003 §Acceptance Criteria` AC2 needs degraded/offline nodes visible) — LEFT-JOINed with the
//     heartbeat-owned presence axis (NULL until the node's first beat) and
//     carrying a per-row `readOnly` verdict derived AT READ TIME via the SAME
//     `#deriveReadOnly` comparator attach uses (`Spec-003 §Acceptance Criteria` AC4 — the read-side
//     surfacing of admit-not-eject, I-003-1). Joins THIS class rather than a
//     second service: the roster is a projection over the SAME
//     `runtime_node_attachments` row lifecycle attach / detach /
//     updateCapabilities own (the T3.9 "not a fragmented second service class"
//     cohesion rationale). Mounted by the sibling router as `runtimenode.roster`
//     — the namespace's FIRST (and only) query, control-plane tRPC ONLY.
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
//     offline/detached node retains its membership (`Spec-003 §Required Behavior`). P8 asserts
//     the byte-for-byte membership no-mutation across a detach (snapshot + count,
//     the same two disjoint mutation modes as the attach test). The ROSTER READ
//     (T5.0c) holds the invariant by the same disjointness: readRoster's single
//     SELECT touches only the two runtime-node tables plus the `sessions` floor
//     column and never references `session_memberships` — asserted by the same
//     snapshot + count pattern across a roster read.
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
// Cross-task boundaries (DO NOT CROSS in T3.2 / T3.7 / T3.9):
//   * `runtime_node_attachments` / `runtime_node_presence` table DDL — owned by
//     `migrations/0003-runtime-nodes.ts` (Plan-003 Phase 3). This service only
//     INSERT/UPDATE/SELECTs rows; it never ALTERs the schema.
//   * The `VERSION_FLOOR_EXCEEDED` write-refusal — the typed
//     `VersionFloorExceededException` class is DEFINED + wire-wired by T3.4
//     (`runtime-nodes/errors.ts`), but it is THROWN here in this service. The
//     attach-time logic only sets the read-only VERDICT (T3.3, `#deriveReadOnly`:
//     a below-floor daemon is admitted `readOnly = true`, admit-not-eject,
//     I-003-1); the typed write-refusal is ENFORCED in this file's
//     `updateCapabilities` (T3.9) — it re-derives the verdict at WRITE time and
//     throws the T3.4 exception when a below-floor node attempts the capability
//     WRITE. So the verdict (T3.3, here) and the enforcement (T3.9, here, via the
//     T3.4-defined throwable) both land in this service; T3.4 owns only the class
//     definition + the transport/formatter wiring (see the last bullet).
//   * `runtime_node.*` durable event emission (`runtime_node.registered` /
//     `.online` / `.offline`) — owned by Plan-006 Tier 4 wiring. This service
//     mutates the row only; it emits no event (so detach's `reason` is dropped —
//     the durable `runtime_node.offline` audit event is V1.1-gated; CP-003-1).
//   * The `revoked` trust-revocation producer — the AUTHORITY / admin path that
//     writes `runtime_node_attachments.state = 'revoked'`. NOT in scope here:
//     `revoked` is a trust decision issued by an authority ABOUT the node
//     (`Spec-003 §Default Behavior` — never self-asserted), whose proper home is a Cedar-
//     gated authority surface (ADR-012), NOT this daemon-facing detach (a daemon
//     cannot self-revoke; the wire `RuntimeNodeDetachRequest` carries no
//     disposition discriminator). The `revoked` STATE itself + attach's P10
//     terminal-re-attach refusal already ship — only the ungated producer is
//     deferred. detach (T3.7) writes the terminal state `offline` ONLY.
//   * Liveness (staleness) derivation — owned by the T3.6 heartbeat sweep, the
//     SINGLE liveness-derivation writer. readRoster (T5.0c) carries
//     `runtime_node_presence.health_state` / `last_heartbeat_at` VERBATIM and
//     never ages a heartbeat into a health verdict — deriving at read time
//     would create a second, racing liveness author (`Spec-003 §Default Behavior`:
//     per-axis single-writer; `Spec-003 §Interfaces And Contracts` — "the read never derives staleness").
//   * The tRPC router + errorFormatter that lift the typed `.code` onto the wire
//     envelope and map each refusal to HTTP 409 / tRPC `CONFLICT` — T3.4 / T3.8.
//
// Refs: `Spec-003 §Required Behavior` (version-floor admission; attach is a
// separate step from membership acceptance — I-003-3; detach/offline must not
// revoke membership by default — I-003-3; multiple runtime nodes per session —
// the roster's `nodes[]`), `Spec-003 §Default Behavior` (the node declares its
// capabilities — updateCapabilities; an explicit `detach` retires the node;
// `revoked` is authority-issued, never self-asserted),
// `Spec-003 §Implementation Notes` (node identity is stable across reconnect if
// the same daemon reattaches — the owner is immutable),
// `Spec-003 §Pitfalls To Avoid` (never destroy historical node provenance when
// a node reconnects: the cross-owner reconnect refusal),
// `Spec-003 §Acceptance Criteria` (below-floor writes are refused
// VERSION_FLOOR_EXCEEDED — the T3.9 write-gate; AC2 — degraded/offline
// distinguishable in the roster; AC3 — multiple nodes coexist),
// `Spec-003 §Interfaces And Contracts` (roster pin — visibility / nullable
// presence / derived readOnly / never-mask / ADR-017 non-collision); Plan-003 §Invariants
// I-003-1 (admit below-floor read-only,
// write-refuse, never eject) / I-003-2 (the control plane cannot drive a node
// registering -> online — the updateCapabilities guard) / I-003-3 (no
// session_memberships mutation, attach AND detach AND the roster read) /
// I-003-5 (single active
// attachment — detach AND updateCapabilities resolve the one active row by
// `nodeId`) + T3.2 (P1 / P9 / P10) + T3.3 (P2 / P3 floor comparison) + T3.7
// (detach `offline` transition, P8) + T3.9 (updateCapabilities — the
// capability-snapshot refresh + the I-003-2 guard + the floor write-refusal)
// + T5.0c (readRoster + the sibling router's first query);
// docs/architecture/schemas/shared-postgres-schema.md §Runtime
// Node Attachments (the `idx_node_attachments_node` + `idx_node_attachments_active`
// indexes); docs/architecture/contracts/api-payload-contracts.md §Plan-003
// (RuntimeNodeAttach + RuntimeNodeDetach + RuntimeNodeCapabilityUpdate
// request/response) + §Runtime-Node Method-Name Registry (the
// RuntimeNodeRoster wire shapes in `docs/architecture/contracts/api-payload-contracts.md §Tier 3: Plan-003 — Runtime Node Attach (Task 4.4)`,
// registry row + procedure-type paragraph in its §Runtime-Node Method-Name Registry (Tier 3) table); `memberships/membership-service.ts`
// (the `Querier`-injected service idiom + the no-membership-mutation precedent
// this mirrors).

import type {
  EventEnvelopeVersion,
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  RuntimeNodeCapabilityUpdateRequest,
  RuntimeNodeCapabilityUpdateResponse,
  RuntimeNodeDetachRequest,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  NodeState,
} from "@ai-sidekicks/contracts";
import {
  compareEventEnvelopeVersion,
  EventEnvelopeVersionSchema,
  RuntimeNodeAttachRequestSchema,
  RuntimeNodeCapabilityUpdateRequestSchema,
  RuntimeNodeCapabilityUpdateResponseSchema,
  RuntimeNodeDetachRequestSchema,
  RuntimeNodeRosterRequestSchema,
  RuntimeNodeRosterResponseSchema,
} from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";
import {
  RuntimeNodeAttachConflictException,
  RuntimeNodeAttachRevokedException,
  RuntimeNodeCapabilityUpdateConflictException,
  VersionFloorExceededException,
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
// against a row in this state is refused (P10); a non-active `offline` row is
// reactivated by the upsert's DO UPDATE ONLY when the reconnecting participant is
// the row's existing owner (a cross-owner reconnect is suppressed instead — the
// owner is immutable, `Spec-003 §Implementation Notes` + `Spec-003 §Pitfalls To Avoid`).
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
// the T3.6 staleness sweep derives at 60s (`Spec-003 §Default Behavior`), which an explicit
// detach effects IMMEDIATELY instead of waiting for heartbeat staleness
// (`Spec-003 §Default Behavior` — "an explicit `detach` retires the node").
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
// hydrated as a JS `Date` by both `pg` and PGlite (default parsers), then
// normalized via `toIsoString` (mirrors `attached_at` on `AttachmentRow`).
interface CapabilityUpdateRow {
  readonly node_id: string;
  readonly state: string;
  readonly updated_at: Date | string;
}

// Internal row shape returned by the `readRoster` SELECT — one row per
// `runtime_node_attachments` row for the session, carrying the LEFT-JOINed
// presence axis (`health_state` / `last_heartbeat_at` — SQL NULL until the
// node's first heartbeat lands, because presence rows are heartbeat-owned,
// T3.6) and the session's `min_client_version` floor (the per-row `readOnly`
// derivation input; the COLUMN is nullable — NULL floor = "no floor" — while
// the INNER JOIN itself never drops a row, since the FK on
// `runtime_node_attachments.session_id` guarantees the session row exists).
// `capabilities` is JSONB, hydrated as a parsed object by both `pg` and
// PGlite; typed `unknown` here and validated by the response-schema parse —
// never cast. Timestamps follow the `toIsoString` hydration note (a JS
// `Date` under both `pg` and PGlite by default; a string hydration would
// still normalize through the same total `toIsoString`).
interface RosterRow {
  readonly node_id: string;
  readonly participant_id: string;
  readonly state: string;
  readonly health_state: string | null;
  readonly last_heartbeat_at: Date | string | null;
  readonly capabilities: unknown;
  readonly client_version: string;
  readonly attached_at: Date | string;
  readonly min_client_version: string | null;
}

// `TIMESTAMPTZ` is hydrated as a JS `Date` by BOTH drivers' default parsers —
// `pg` (pg-types OID 1184) and PGlite (`types.ts` date parser). The contract
// requires ISO 8601 (`attachedAt: string`); the string arm keeps normalization
// total under custom parsers (mirrors `toIsoString` in membership-service.ts).
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
   * Attach a runtime node to a session (`Spec-003 §Required Behavior`; Plan-003 T3.2).
   *
   * @param request the runtime-node attach payload. Validated at the boundary
   *   (`RuntimeNodeAttachRequestSchema.parse`) before any row is read or
   *   written — a service-layer fail-fast that surfaces schema drift (e.g. a
   *   malformed `clientVersion` or unknown key) before touching the database,
   *   mirroring MembershipService.updateMembership's boundary parse.
   * @returns the `RuntimeNodeAttachResponse` projection of the upserted row.
   * @throws RuntimeNodeAttachConflictException in TWO cases: (1) the node is
   *   already actively attached to a DIFFERENT session (P9 / I-003-5 — the
   *   active-index `23505`); and (2) a DIFFERENT participant attempts to reconnect
   *   to an existing `(node_id, session_id)` row whose owner is another
   *   participant (the owner is immutable across reconnect — `Spec-003 §Implementation Notes` —
   *   so a cross-owner reconnect is refused rather than overwriting the owner).
   * @throws RuntimeNodeAttachRevokedException when the node's row for THIS
   *   session is in the terminal `revoked` state (P10).
   *
   * Transaction sequence (ONE commit boundary):
   *   1. Read the session's `min_client_version` floor.
   *   2. Derive `readOnly` from (floor, clientVersion) via `#deriveReadOnly`.
   *   3. Upsert the attachment row — `INSERT ... ON CONFLICT (node_id,
   *      session_id) DO UPDATE ... WHERE state <> 'revoked' AND participant_id =
   *      EXCLUDED.participant_id RETURNING`. The conflict arbiter is the TOTAL
   *      `idx_node_attachments_node` unique; the DO UPDATE reactivates a
   *      same-owner `offline` row (P9 reconnect) and is SUPPRESSED — yielding zero
   *      RETURNING rows — for a `revoked` row (P10) OR a row owned by a different
   *      participant (cross-owner reconnect). `participant_id` is NOT in the SET,
   *      so the owner is never reassigned (`Spec-003 §Pitfalls To Avoid` — never destroy node
   *      provenance on reconnect).
   *   4a. Non-empty RETURNING -> map the row to the response (the admit /
   *       same-owner reconnect happy path, P1 / P9 reconnect).
   *   4b. Empty RETURNING -> the DO UPDATE was suppressed: re-read the existing
   *       row for THIS session and discriminate the THREE causes in order —
   *       (a) `revoked` -> the terminal refusal (P10), checked first because
   *       revocation is terminal regardless of caller; (b) cross-owner -> the
   *       typed conflict refusal; (c) neither -> a hard error (impossible state).
   *       A genuinely-absent row (no conflict, so the INSERT would have inserted
   *       and RETURNING would be non-empty) cannot reach this branch; the
   *       verify-SELECT defends the substrate-generality edge.
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
      // MAJOR.MINOR string) is stored as TEXT. The DO UPDATE's WHERE has TWO
      // suppressing conditions:
      //   - `state <> 'revoked'` — reactivates an `offline` row (P9 reconnect)
      //     and is SUPPRESSED for a `revoked` row (P10 -> zero RETURNING rows).
      //   - `participant_id = EXCLUDED.participant_id` — the owner participant is
      //     IMMUTABLE across reconnect: a reconnect is the SAME local daemon
      //     (`Spec-003 §Implementation Notes`), so a DIFFERENT participant attempting to reattach
      //     to this `(node_id, session_id)` row is SUPPRESSED (-> zero RETURNING
      //     rows), the same zero-row mechanism the revoked case uses. This is why
      //     `participant_id` is NOT in the SET list: reassigning the owner on a
      //     cross-owner reconnect would destroy node provenance
      //     (`Spec-003 §Pitfalls To Avoid` — never destroy historical node
      //     provenance when a node reconnects).
      // (`EXCLUDED.participant_id` in a DO UPDATE WHERE is valid Postgres — it
      // refers to the would-be-inserted row's value.)
      //
      // `validated.healthState` is parsed at the boundary but DELIBERATELY NOT
      // persisted here: `state` is hard-pinned to `registering` (`Spec-003 §Default Behavior`
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
             SET capabilities   = EXCLUDED.capabilities,
                 client_version = EXCLUDED.client_version,
                 state          = $6
           WHERE runtime_node_attachments.state <> $7
             AND runtime_node_attachments.participant_id = EXCLUDED.participant_id
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

      // (4b) Zero RETURNING rows => the DO UPDATE was suppressed by its WHERE,
      // which now has TWO suppressing conditions, so the existing row for THIS
      // session is in ONE of three states (a successful zero-row update does NOT
      // abort the transaction, so this read is safe). Re-read `state` AND
      // `participant_id` and discriminate the three causes IN ORDER:
      //   (a) revoked-first — the existing row is `revoked`. Terminal REGARDLESS
      //       of who probes it (the owner reconnecting OR another participant), so
      //       it is checked first and unconditionally: revocation is terminal
      //       (P10). The message names the caller's OWN `sessionId` — no other
      //       session's identity is disclosed.
      //   (b) cross-owner — the existing row is owned by a DIFFERENT participant
      //       (its `participant_id` differs from the caller's). A reconnect is the
      //       same daemon (`Spec-003 §Implementation Notes`), so the owner is IMMUTABLE; a
      //       different participant attempting to reattach to this `(node_id,
      //       session_id)` row is refused with the typed conflict. The message
      //       names `nodeId` + the caller's OWN `sessionId` ONLY — never the
      //       owning `participant_id` (no cross-owner info-leak).
      //   (c) impossible — neither cause holds (and a row MUST exist: the upsert
      //       hit ON CONFLICT, so a matching row is present). Surface it as a hard
      //       error rather than masquerading as a typed refusal.
      if (upsertedRow === undefined) {
        const existingProbe = await transaction.query<{ state: string; participant_id: string }>(
          "SELECT state, participant_id FROM runtime_node_attachments WHERE node_id = $1 AND session_id = $2",
          [validated.nodeId, validated.sessionId],
        );
        const existingRow: { state: string; participant_id: string } | undefined =
          existingProbe.rows[0];
        if (existingRow !== undefined && existingRow.state === REVOKED_STATE) {
          // (a) revoked-first — terminal regardless of caller.
          throw new RuntimeNodeAttachRevokedException(
            `Runtime node ${String(validated.nodeId)}'s attachment to session ${String(validated.sessionId)} was revoked; revocation is terminal.`,
          );
        }
        if (existingRow !== undefined && existingRow.participant_id !== validated.participantId) {
          // (b) cross-owner — the owner is immutable across reconnect.
          throw new RuntimeNodeAttachConflictException(
            `Runtime node ${String(validated.nodeId)} is attached to session ${String(validated.sessionId)} under a different participant and cannot be reattached by another participant.`,
          );
        }
        // (c) Defensive: a zero-row upsert that is neither revoked nor cross-owner
        // is an impossible substrate state (the conflict either updated a
        // same-owner non-revoked row -> one RETURNING row, or inserted a fresh row
        // -> one RETURNING row). Surface it as a hard error rather than
        // masquerading as a typed refusal.
        throw new Error(
          `AttachService.attach: upsert returned no row for node ${String(validated.nodeId)} in session ${String(validated.sessionId)} and no revoked or cross-owner row was found.`,
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
   * `Spec-003 §Default Behavior` "an explicit `detach` retires the node"; Plan-003 T3.7).
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
   * ABOUT the node (`Spec-003 §Default Behavior` — never self-asserted), gated on a Cedar /
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
   * offline/detached node retains its membership (`Spec-003 §Required Behavior`). Mirrors the
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
      // (`Spec-003 §Default Behavior`), without waiting for heartbeat staleness. UPDATE-ONLY,
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
   * @throws VersionFloorExceededException (409) when a below-floor node — one
   *   admitted READ-ONLY at attach because its declared `clientVersion` is below
   *   the session's `min_client_version` floor (T3.3) — attempts this capability
   *   WRITE (the typed `VERSION_FLOOR_EXCEEDED` write-refusal; I-003-1 / ADR-018
   *   §Decision #4 / `Spec-003 §Acceptance Criteria`). The node is NOT ejected — the throw
   *   rolls back, leaving its attachment row byte-for-byte unchanged.
   * @throws RuntimeNodeCapabilityUpdateConflictException in two cases, both 409:
   *   (1) no active attachment exists — the SLOT axis was retired by a `detach`
   *   or `revoke` (there is no `{nodeId, state, updatedAt}` to return). A
   *   liveness-only T3.6 staleness sweep does NOT trigger this refusal: the sweep
   *   writes only `runtime_node_presence.health_state` and leaves the attachment
   *   SLOT active, so a swept-offline-but-still-attached node IS still resolved by
   *   the active-band lookup and CAN still receive a capability update (the two
   *   axes reconcile at READ time — `Spec-003 §Default Behavior`); and
   *   (2) the I-003-2 guard — the request would drive a `registering` attachment
   *   to `online` (bringing a node online requires a daemon-side capability
   *   declaration; the control plane is not the declaration authority —
   *   `Spec-003 §Required Behavior` + `Spec-003 §Default Behavior`).
   *
   * Transaction sequence (ONE commit boundary):
   *   1. Resolve the node's SINGLE active attachment `FOR UPDATE` by `nodeId`
   *      within the active-state band (`registering` / `online` / `degraded` —
   *      unambiguous per I-003-5), selecting `client_version` + `session_id` too
   *      (the floor-gate at step 3 needs both).
   *   2. Zero rows -> the no-active-attachment refusal (case 1 above).
   *   3. Version-floor write-gate (I-003-1 / ADR-018 §Decision #4 / Spec-003
   *      `Spec-003 §Acceptance Criteria` AC4): re-derive the read-only verdict at WRITE time from the
   *      CURRENT session floor + the version the daemon declared at attach. A
   *      below-floor node is refused with `VersionFloorExceededException` (typed,
   *      never-eject — the throw rolls back, the attachment row is untouched, the
   *      node stays joined). This precedes the I-003-2 guard: a permission denial
   *      (read-only node) is decided BEFORE the transition-legality check.
   *   4. I-003-2 guard: a `registering` row + a requested `online` health is the
   *      one residual state-context refusal (case 2). EXPLICITLY ALLOWED (not
   *      guarded): `registering -> degraded` (Spec-003 §Fallback Behavior —
   *      capability-validation failure leaves the node degraded), `degraded ->
   *      online` (recovery), and a capabilities-only refresh on any active row.
   *   5. Refresh `capabilities` (the discovery snapshot) and write the resolved
   *      next-state back. `RETURNING node_id, state, now() AS updated_at` — the
   *      `updatedAt` is the transaction-time server clock, sourced TRANSIENTLY,
   *      never a stored column: `attached_at` (the creation timestamp) is NOT
   *      overwritten.
   *   6. Map (`node_id`/`updated_at` -> `nodeId`/`updatedAt`) and parse through
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
   *
   * Floor-gate scope: the version-floor write-refusal (step 3) lives ONLY here,
   * NOT in `heartbeat` or `detach`. A below-floor (read-only) node MUST still
   * heartbeat — else the T3.6 staleness sweep marks it offline (a de-facto
   * ejection) — and MUST be able to `detach` — else it is trapped joined. Gating
   * either would violate I-003-1's never-eject guarantee. `heartbeat` (the
   * separate `HeartbeatService`) and `detach` are therefore naturally ungated;
   * the capability WRITE is the one mutation a read-only node is denied.
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
      // no `sessionId`), and the band EXCLUDES the inactive SLOT states
      // (`offline`, `revoked`) so a late update against a row whose slot was
      // retired (by `detach` or `revoke`) matches no row (the typed refusal
      // below). A liveness-only T3.6 staleness sweep does NOT retire the slot (it
      // writes only `runtime_node_presence.health_state`), so a swept node keeps
      // an active slot and still matches this band. FOR UPDATE locks the row for
      // the transaction's duration so a concurrent detach cannot retire it
      // between this read and the UPDATE below. Single-table query, so the lock
      // covers only the attachment row.
      //
      // `client_version` (the version the daemon declared at attach) and
      // `session_id` (to read THIS session's current floor) are selected here
      // for the version-floor write-gate at step 3.
      const activeProbe = await transaction.query<{
        id: string;
        state: string;
        client_version: string;
        session_id: string;
      }>(
        `SELECT id, state, client_version, session_id
           FROM runtime_node_attachments
          WHERE node_id = $1
            AND state IN ('registering', 'online', 'degraded')
          FOR UPDATE`,
        [validated.nodeId],
      );
      const activeRow:
        | { id: string; state: string; client_version: string; session_id: string }
        | undefined = activeProbe.rows[0];

      // (2) No active attachment -> typed 409 refusal (NOT a 500, NOT a null
      // no-op). capabilityupdate MUST return `{nodeId, state, updatedAt}`; with
      // no active row there is no state to return. This is a legitimate
      // production race — a late update arriving after a `detach` OR `revoke`
      // retired the SLOT axis (`runtime_node_attachments.state`). A liveness-only
      // T3.6 staleness sweep does NOT reach this refusal: the sweep writes only
      // `runtime_node_presence.health_state` and leaves the SLOT active, so a
      // swept-offline-but-still-attached node still matches the active-band lookup
      // above and is updated normally (the two axes reconcile at READ time —
      // `Spec-003 §Default Behavior`). This mirrors attach's defensive posture (the service
      // does not assume the router pre-validated liveness). The message names
      // `nodeId` ONLY (no session, no state — no info-leak).
      if (activeRow === undefined) {
        throw new RuntimeNodeCapabilityUpdateConflictException(
          `Runtime node ${String(validated.nodeId)} has no active attachment to update.`,
        );
      }

      // (3) Version-floor write-gate (I-003-1 / ADR-018 §Decision #4 / Spec-003
      // `Spec-003 §Acceptance Criteria` AC4). Re-derive the read-only verdict at WRITE time from the
      // CURRENT session floor and the version the daemon declared at attach
      // (stored `client_version`). A below-floor node was admitted read-only
      // (T3.3); this is where its capability WRITE is refused — typed,
      // never-eject (the throw rolls the transaction back, leaving the
      // attachment row byte-unchanged, so the node stays joined). This precedes
      // the I-003-2 state-context guard below: a permission denial (the node is
      // read-only) is decided BEFORE we consider whether the requested
      // transition is legal.
      //
      // Read the session floor the SAME way `attach` does — a plain SELECT of
      // `min_client_version`, no lock (the floor is a `sessions`-owned value;
      // this method holds no `sessions` lock and mutates nothing there). The
      // floor is re-read LIVE, not snapshotted at attach: a floor RAISED after a
      // node attached at-or-above it correctly refuses the node's later write
      // (the verdict tracks the current session floor, not the attach-time one).
      // `activeRow.client_version` is parsed+branded through
      // `EventEnvelopeVersionSchema.parse` (never an `as` cast) inside
      // `#deriveReadOnly`, so a malformed stored version throws loud rather than
      // comparing as NaN — the same parse-at-the-boundary discipline `attach`
      // applies to the floor.
      const floorProbe = await transaction.query<{ min_client_version: string | null }>(
        "SELECT min_client_version FROM sessions WHERE id = $1",
        [activeRow.session_id],
      );
      const floorRow: { min_client_version: string | null } | undefined = floorProbe.rows[0];
      const floor: string | null = floorRow === undefined ? null : floorRow.min_client_version;
      if (this.#deriveReadOnly(floor, EventEnvelopeVersionSchema.parse(activeRow.client_version))) {
        throw new VersionFloorExceededException(
          `Runtime node ${String(validated.nodeId)} attached read-only: client version ` +
            `${String(activeRow.client_version)} is below this session's floor ${String(floor)}; ` +
            `writes require an at-or-above-floor client.`,
        );
      }

      // (4) I-003-2 guard — the ONE residual state-context refusal. The wire
      // VALUE `online` is legal (the 2-value `RuntimeNodeHealthState`), but
      // applying it to a still-`registering` attachment is not: bringing a node
      // `online` requires a successful DAEMON-side capability declaration
      // (`Spec-003 §Default Behavior`), and the control plane is not the declaration
      // authority (`Spec-003 §Required Behavior`). EXPLICITLY ALLOWED and NOT guarded here:
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

      // (5) Refresh the discovery snapshot + apply the resolved next-state. The
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

      // (6) Map (`node_id`/`updated_at` -> `nodeId`/`updatedAt`) and parse. The
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
   * Read a session's full runtime-node roster — the `runtimenode.roster`
   * coordination-record projection (Plan-003 T5.0c; Spec-003 §Interfaces And
   * Contracts 2026-06-09 amendment; wire shapes in
   * `docs/architecture/contracts/api-payload-contracts.md §Tier 3: Plan-003 — Runtime Node Attach (Task 4.4)`, registry row in the §Runtime-Node Method-Name Registry (Tier 3) table).
   *
   * FAITHFUL PROJECTION (`Spec-003 §Interfaces And Contracts` / AC2): returns EVERY
   * `runtime_node_attachments` row for the session — all five `state` values
   * verbatim (`registering | online | degraded | offline | revoked`), no
   * server-side hiding — because AC2's distinguishability requires
   * `degraded` / `offline` nodes visible, and the row count is bounded by
   * distinct nodes ever attached (`UNIQUE(node_id, session_id)`).
   *
   * BOTH AXES VERBATIM, NEVER COLLAPSED (`Spec-003 §Default Behavior`): each entry carries
   * the SLOT axis (`runtime_node_attachments.state`) AND the LIVENESS axis
   * (`runtime_node_presence.health_state` + `last_heartbeat_at`, LEFT-JOINed
   * on `node_id` and NULL until the node's first heartbeat — presence rows are
   * heartbeat-owned, T3.6) with NO collapsed health scalar. Reconciling the
   * two axes is the CLIENT's render-time concern; a row whose axes disagree
   * (e.g. slot `online` with swept liveness `offline`) round-trips as stored.
   *
   * NO STALENESS DERIVATION: the read NEVER ages `last_heartbeat_at` into a
   * health verdict — the T3.6 staleness sweep stays the SINGLE
   * liveness-derivation writer (`Spec-003 §Default Behavior` + `Spec-003 §Interfaces And Contracts`). A
   * stale-but-unswept row reports its stored `health_state` verbatim; deriving
   * here would create a second, racing liveness author.
   *
   * DERIVED `readOnly` (`Spec-003 §Interfaces And Contracts` / AC4 / I-003-1): computed
   * per row AT READ TIME from the stored `client_version` against the
   * session's CURRENT `min_client_version` floor via the same
   * `#deriveReadOnly` comparator the attach-time verdict (T3.3) and the T3.9
   * write-gate use — identical semantics by construction (NULL floor ->
   * `false`). This is the read-side surfacing of admit-not-eject: a
   * below-floor node appears in the roster joined, its `state` untouched,
   * with `readOnly = true` — never hidden, never ejected. The stored
   * `client_version` is parsed+branded (`EventEnvelopeVersionSchema.parse`,
   * never an `as` cast) so a corrupted stored version fails CLOSED at the
   * read boundary rather than reaching the comparator as NaN.
   *
   * READ PATH, NOT THE WRITER CHAIN: ONE single-statement SELECT — no
   * `Querier.transaction(...)`, no `FOR UPDATE` (a single statement is already
   * a consistent snapshot, and locking a read would serialize against the
   * attach / detach / capability writers for zero integrity gain). It writes
   * NOTHING: no `session_memberships` access at all (I-003-3), and no durable
   * `runtime_node.*` event (ADR-017 — the control plane has no event log; the
   * read PROJECTS coordination records, so it does not collide with the
   * ADR-017 §Server-Derived Runtime-Node Lifecycle Events V1.1 gate, which
   * governs durable event AUTHORSHIP, not coordination-record reads).
   *
   * @param request the roster-read payload. Validated at the boundary
   *   (`RuntimeNodeRosterRequestSchema.parse`) before any row is read — the
   *   same service-layer fail-fast as `attach` / `detach` /
   *   `updateCapabilities`.
   * @returns the `RuntimeNodeRosterResponse` (`{nodes}`) projection — one
   *   entry per attachment row; EMPTY (`{nodes: []}`) both for a session with
   *   no attachments and for a non-existent session (session
   *   existence/authorization is the router tier's concern, mirroring
   *   `attach`'s missing-session posture; the FK on
   *   `runtime_node_attachments.session_id` guarantees every attachment's
   *   session exists, so the `sessions` JOIN never drops a row).
   */
  async readRoster(request: RuntimeNodeRosterRequest): Promise<RuntimeNodeRosterResponse> {
    // Trust-boundary validation — parse rather than trust the caller,
    // mirroring `attach` / `detach` / `updateCapabilities`. Surfaces schema
    // drift (a malformed `sessionId`, an unknown key) before the database.
    const validated: RuntimeNodeRosterRequest = RuntimeNodeRosterRequestSchema.parse(request);

    // ONE SQL read (no transaction — see the JSDoc's read-path note). INNER
    // JOIN `sessions` carries the floor onto every row; LEFT JOIN presence
    // keeps a never-heartbeated node's entry with SQL NULLs on the liveness
    // axis. Timestamps are NOT `::text`-cast: both drivers hydrate TIMESTAMPTZ
    // as a JS `Date` by default (string tolerated) and `toIsoString`
    // normalizes — the same wire-timestamp path `attach` /
    // `updateCapabilities` ship. ORDER BY is deterministic-read hygiene
    // (attach order, `node_id` tiebreak for same-instant rows), NOT a wire
    // contract — the pinned response shape carries no ordering clause.
    const rosterProbe = await this.#querier.query<RosterRow>(
      `SELECT attachment.node_id,
              attachment.participant_id,
              attachment.state,
              presence.health_state,
              presence.last_heartbeat_at,
              attachment.capabilities,
              attachment.client_version,
              attachment.attached_at,
              floor_session.min_client_version
         FROM runtime_node_attachments AS attachment
         JOIN sessions AS floor_session ON floor_session.id = attachment.session_id
         LEFT JOIN runtime_node_presence AS presence ON presence.node_id = attachment.node_id
        WHERE attachment.session_id = $1
        ORDER BY attachment.attached_at, attachment.node_id`,
      [validated.sessionId],
    );

    // Build plain entry objects and parse the WHOLE response through the
    // contracts schema (the same parse-not-cast posture as
    // `updateCapabilities`' step 6): the parse brands `nodeId` /
    // `participantId` / `clientVersion`, validates both health-axis enums and
    // the ISO 8601 timestamps, and fails CLOSED on any corrupted stored value.
    // `client_version` is ALSO parsed per row BEFORE the response parse
    // because `#deriveReadOnly` requires the branded comparator input — the
    // same parse-at-the-boundary discipline `updateCapabilities` applies to
    // its stored version.
    const nodes = rosterProbe.rows.map((row) => {
      const clientVersion: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse(
        row.client_version,
      );
      return {
        nodeId: row.node_id,
        participantId: row.participant_id,
        state: row.state,
        healthState: row.health_state,
        lastHeartbeatAt: row.last_heartbeat_at === null ? null : toIsoString(row.last_heartbeat_at),
        readOnly: this.#deriveReadOnly(row.min_client_version, clientVersion),
        capabilities: row.capabilities,
        clientVersion,
        attachedAt: toIsoString(row.attached_at),
      };
    });
    return RuntimeNodeRosterResponseSchema.parse({ nodes });
  }

  /**
   * Derive the `readOnly` PERMISSION verdict from the session floor and the
   * daemon's reported `clientVersion`.
   *
   * Two branches, both serving `Spec-003 §Required Behavior` / I-003-1:
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
   * extension — only this method's non-NULL branch gained the comparison. The
   * seam is now shared by THREE call sites — the attach-time verdict (T3.3),
   * the T3.9 write-gate's re-derivation, and the T5.0c per-row roster
   * projection — so all three stay semantically identical by construction (one
   * comparator, no drift).
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
