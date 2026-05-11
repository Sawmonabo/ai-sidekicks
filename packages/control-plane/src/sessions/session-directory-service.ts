// SessionDirectoryService — Plan-001 PR #4.
//
// Responsibilities (per Spec-001 + plan body §PR #4):
//   * createSession  — daemon-assigned UUID v7 lands in the shared
//                      directory; idempotent on retry per BL-069 invariant
//                      (no silent fork on second create with same id).
//   * readSession    — point-lookup by sessionId, returns the snapshot
//                      shape the wire contract publishes.
//   * joinSession    — by-(sessionId, participantId) UNIQUE-constrained
//                      membership upsert; returns the canonical
//                      membershipId on both first-join and rejoin paths
//                      (no silent membership fork).
//
// What this service does NOT do (deferred):
//   * Identity-handle resolution — the wire contract carries
//     `identityHandle: string`, but Plan-018 owns identity-handle ->
//     participantId resolution. Plan-001 PR #4 takes a participantId
//     directly on the internal `joinSession` boundary; the wire layer
//     binding (Plan-001 PR #5 SDK + the eventual tRPC router) is where
//     identityHandle gets resolved.
//   * Session-event payload storage — per ADR-017, shared Postgres stores
//     coordination metadata only; per-daemon local SQLite is authoritative
//     for the event log. Plan-001 PR #3 owns the local event service.
//   * Timeline cursor composition — `SessionJoinResponse` has no cursor
//     field; cursor authority lives in `SessionRead` (Plan-001 PR #5 SDK
//     composes the cursor by calling SessionRead after SessionJoin).
//   * Connection pool construction — production wiring composes a `Querier`
//     from `pg.Pool`; that wiring lands in Plan-001 PR #5 alongside the SDK
//     integration. PR #4 typing against the `Querier` interface keeps the
//     test surface (in-process pglite) and production surface (`pg.Pool`)
//     interchangeable.
//
// Cross-plan ownership boundaries (DO NOT CROSS):
//   * `participants` table additive columns — Plan-018 owns
//     display_name/identity_ref/metadata + the identity_mappings side
//     table. Plan-001 PR #4 does NOT insert participant rows; the schema
//     doc states "no participant rows are inserted before Plan-018's
//     registration flow lands — the anchor table exists only so FK
//     constraints in Plan-001/002/003 tables can be declared at migration
//     time". `createSession` and `joinSession` both REQUIRE a caller-
//     supplied `participantId`; identity resolution lives upstream
//     (Plan-001 PR #5 SDK + the eventual tRPC router; Plan-018 once
//     the registration flow lands).
//   * Invite-driven membership flows — Plan-002 owns. PR #4 only handles
//     the create-session-with-owner and direct-join-by-participantId
//     paths. `joinSession`'s upsert preserves any existing role/state on
//     conflict — it is NOT a reactivation primitive (a `suspended` or
//     `revoked` membership stays put). Reactivation semantics belong to
//     Plan-002's suspend/revoke/reactivate state machine.

import type { Pool, PoolClient } from "pg";

import type {
  ChannelSummary,
  EventCursor,
  MembershipId,
  MembershipRole,
  MembershipState,
  MembershipSummary,
  NonOwnerMembershipRole,
  ParticipantId,
  SessionCreateResponse,
  SessionId,
  SessionJoinResponse,
  SessionReadResponse,
  SessionSnapshot,
  SessionState,
} from "@ai-sidekicks/contracts";
import { EventCursorSchema } from "@ai-sidekicks/contracts";

import type { Querier } from "./migration-runner.js";

// --------------------------------------------------------------------------
// Placeholder cursor returned by `readSession`. See `readSession` docstring
// — the control plane has no event log per ADR-017, so it cannot synthesize
// a real Plan-006 cursor. PR #5's SDK composition layer queries the
// daemon's local event service for the authoritative cursor and overrides
// this field. Consumers MUST NOT treat the value as a real cursor.
//
// We construct via `EventCursorSchema.parse(...)` rather than `as EventCursor`
// so that any future Plan-006 tightening of the schema (e.g. requiring a
// `<sequence>_<monotonic_ns>` shape) surfaces as an import-time validation
// failure instead of silently passing a malformed value through to consumers
// at runtime.
// --------------------------------------------------------------------------

const CONTROL_PLANE_PLACEHOLDER_CURSOR: EventCursor =
  EventCursorSchema.parse("control-plane:no-cursor");

// --------------------------------------------------------------------------
// Internal row shapes — the JSON-readable shape returned by `pg.Pool#query`
// and `PGlite#query`. Both drivers map column names to the keys below
// because Postgres column identifiers are folded to lowercase by default
// and the schema uses `snake_case` columns.
// --------------------------------------------------------------------------

interface SessionRow {
  readonly id: string;
  readonly state: string;
  readonly config: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly min_client_version: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface MembershipRow {
  readonly id: string;
  readonly session_id: string;
  readonly participant_id: string;
  readonly role: string;
  readonly state: string;
  readonly joined_at: Date | string | null;
  readonly updated_at: Date | string;
}

// --------------------------------------------------------------------------
// Public service surface
// --------------------------------------------------------------------------

/**
 * Input shape for `createSession`.
 *
 * `sessionId` is daemon-assigned UUID v7 per BL-069 — the daemon mints the
 * id locally and presents it on the create call. The `gen_random_uuid()`
 * DEFAULT on the schema column exists for the rare control-plane-originated
 * row (admin provisioning); Plan-001 PR #4's create path always supplies
 * the id explicitly.
 *
 * `ownerParticipantId` is REQUIRED. The schema doc
 * (`docs/architecture/schemas/shared-postgres-schema.md` §participants)
 * states "no participant rows are inserted before Plan-018's registration
 * flow lands — the anchor table exists only so FK constraints in Plan-001/
 * 002/003 tables can be declared at migration time". This service is a
 * faithful Postgres adapter; identity resolution belongs upstream. Until
 * Plan-018 lands the registration flow, the wire-layer SDK in Plan-001
 * PR #5 is responsible for resolving identity to a `participantId` before
 * invoking this service. (An earlier draft of PR #4 minted a fresh
 * participant row inline when this field was omitted; that path violated
 * the schema-doc invariant AND opened a concurrency window where two
 * concurrent retries with the same `sessionId` minted two participant
 * rows and inserted two `owner` membership rows — UNIQUE(session_id,
 * participant_id) does not collide on different participant ids. R1
 * dropped the auto-mint, closing the most-likely path; the residual
 * UNIQUE-shape gap — an explicit caller passing a mismatched
 * `ownerParticipantId` on retry — is closed by the owner-mismatch
 * guard inside `createSession`'s transaction; see that method for the
 * full trace. R4 closed the final residual — concurrent createSession
 * callers racing the owner-mismatch probe under READ COMMITTED — by
 * adding an explicit `SELECT ... FOR UPDATE` row lock between the
 * session upsert and the probe so T1 and T2 serialize on the lock
 * instead of both observing an empty owner set in their respective
 * snapshots.)
 *
 * Forward-declared columns (not in this input shape):
 *   * `min_client_version` — Plan-003 owns attach-flow enforcement per
 *     ADR-018. Column declared in `0001-initial.ts` so the schema is
 *     stable across plans, but PR #4 does not write it; the column lands
 *     as NULL on every create. Plan-003 will pick up the input shape on
 *     the read+write side at the same time.
 */
export interface CreateSessionInput {
  readonly sessionId: SessionId;
  readonly ownerParticipantId: ParticipantId;
  readonly config?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Input shape for `joinSession`.
 *
 * The wire contract carries `identityHandle: string`, but Plan-018 owns
 * identity-handle resolution. The internal service surface here takes a
 * resolved participantId; the wire-layer binding (Plan-001 PR #5 SDK +
 * the eventual tRPC router) is where identityHandle gets resolved.
 *
 * `role` defaults to "viewer" — the schema column DEFAULT — when omitted.
 *
 * `role` is typed as `NonOwnerMembershipRole` (i.e. `MembershipRole` minus
 * `"owner"`) per the Codex P1 finding (round 5 review of PR #4): admitting
 * `"owner"` here would let any caller mint a second owner-membership row
 * without going through the BL-069 §4 TOFU bootstrap or Plan-002's
 * promotion / elevation flow. The narrower type is the FIRST defense
 * (compile-time rejection for TypeScript callers); `joinSession`'s body
 * runs a runtime guard as the SECOND defense for dynamic callers that cast
 * around the type system.
 */
export interface JoinSessionInput {
  readonly sessionId: SessionId;
  readonly participantId: ParticipantId;
  readonly role?: NonOwnerMembershipRole | undefined;
}

export class SessionDirectoryService {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Create (or idempotently re-create) a session.
   *
   * BL-069 invariant: the daemon mints UUID v7 for `sessionId` and presents
   * it here. The upsert pattern below is `ON CONFLICT (id) DO UPDATE SET
   * updated_at = sessions.updated_at` — note that `sessions.updated_at`
   * (the existing row's value) is assigned, NOT `now()`. This is a no-op
   * write that exists solely to make `RETURNING *` yield a row on every
   * attempt, letting the caller distinguish retry-after-crash from silent
   * write loss. `DO NOTHING` would skip RETURNING on conflict.
   *
   * On second create with the same `sessionId` and SAME `ownerParticipantId`:
   *   * The existing row's `created_at` and id are preserved.
   *   * The `updated_at` value is preserved (the no-op assignment).
   *   * The owner-membership row is also `ON CONFLICT (session_id,
   *     participant_id) DO UPDATE SET updated_at = ...` — no silent
   *     duplicate membership.
   *   * The response shape mirrors a first-create call so the caller's
   *     state machine doesn't need a retry-detect branch.
   *
   * On second create with the same `sessionId` but a DIFFERENT
   * `ownerParticipantId`: throws (BL-069 invariant #4 — owner identity is
   * bound at the first create via TOFU). Without this guard the membership
   * upsert's UNIQUE(session_id, participant_id) conflict target — which
   * keys on the (session, participant) PAIR, not on the role — would
   * silently INSERT a second `(S, P2, 'owner')` row, granting P2 owner
   * privileges without invitation/elevation. See the in-method
   * "Owner-mismatch guard" comment for the full failure trace; Plan-002
   * owns ownership transfer / co-owner promotion flows separately.
   *
   * Atomicity: the session upsert, the explicit `SELECT ... FOR UPDATE`
   * row lock, the owner-mismatch probe, and the owner-membership upsert
   * all run inside a single `Querier.transaction(...)` block. Without the
   * transaction wrapper, a failure on the membership upsert (FK violation
   * on a stale `ownerParticipantId`, connection drop, process crash
   * between statements) would leave a committed `sessions` row with no
   * owner-membership — orphaned, visible to `readSession` and admin
   * queries, and undetectable from a retry (which would re-run the same
   * upsert pair as a no-op on the now-committed session row, then succeed
   * on the membership and present the orphan as if it were the canonical
   * state). The transaction collapses all four statements to one commit
   * boundary so a partial failure leaves the directory unchanged.
   *
   * Concurrent createSession callers: two transactions T1(sessionId=S,
   * owner=P1) and T2(sessionId=S, owner=P2) racing on the same `S` are
   * serialized at the explicit `SELECT id FROM sessions WHERE id = $1 FOR
   * UPDATE` issued between the session upsert and the owner-mismatch
   * probe. Under Postgres `READ COMMITTED` (the default), without a
   * holder-side row lock the owner-mismatch probe in T2 can read its
   * snapshot before T1 commits its `(S, P1, 'owner')` membership row,
   * see no existing owners, and proceed to INSERT `(S, P2, 'owner')` —
   * UNIQUE(session_id, participant_id) does not collide on different
   * participants. The implicit row lock acquired by the `INSERT ... ON
   * CONFLICT DO UPDATE` session upsert *should* serialize T2 against T1
   * in the same way; the explicit FOR UPDATE here makes the serialization
   * intent visible to reviewers, inoculates against future schema changes
   * (DEFAULTs, triggers, INSTEAD OF rules) that could alter the implicit
   * lock semantics, and closes the gap regardless of which driver
   * (pglite, pg.Pool) backs the `Querier`. The lock is released at the
   * transaction's COMMIT/ROLLBACK.
   *
   * Lock-acquisition order: this service acquires `sessions` (via the
   * explicit `SELECT ... FOR UPDATE`) BEFORE writing to
   * `session_memberships`. Downstream flows that touch both tables in
   * one transaction — Plan-002's ownership-transfer and co-owner
   * promotion paths in particular — MUST follow the same order
   * (`sessions` → `session_memberships`) to avoid a cross-flow deadlock
   * where T1 holds `sessions` waiting for `session_memberships` while
   * T2 holds `session_memberships` waiting for `sessions`. Deviating
   * from this order requires a coordinated change to this service's
   * lock order, not just to the deviating caller.
   *
   * Why no error-handler around `transaction(...)`: PGlite's
   * `pg.transaction(fn)` (and the `pg`-side equivalent that PR #5 will
   * compose for `pg.Pool`) auto-rolls-back on throw and re-raises the
   * underlying error. Adding a manual `ROLLBACK` here would race the
   * driver's auto-rollback path; the directory service relies on the
   * driver-supplied semantics.
   */
  async createSession(input: CreateSessionInput): Promise<SessionCreateResponse> {
    // Both writes share one commit boundary — see method-level docstring
    // for the orphan-session rationale.
    //
    // The transaction callback receives a `Querier` bound to the same
    // connection so the routing concern (which connection to use) stays
    // encapsulated inside the adapter; the service body sees the same
    // surface as outside-transaction code.
    const { sessionRow, membershipRow } = await this.#querier.transaction(async (tx) => {
      // Idempotent session upsert — see method-level docstring for the
      // DO UPDATE-vs-DO NOTHING rationale.
      //
      // `config` and `metadata` are JSONB; pg + pglite both accept a JS
      // object directly (the driver serializes via JSON.stringify). The
      // `COALESCE(... , '{}'::jsonb)` lets the column DEFAULT apply when
      // the caller omits the field (we pass NULL in that case).
      const sessionUpsert = await tx.query<SessionRow>(
        `INSERT INTO sessions (id, config, metadata)
         VALUES ($1, COALESCE($2, '{}'::jsonb), COALESCE($3, '{}'::jsonb))
         ON CONFLICT (id) DO UPDATE SET updated_at = sessions.updated_at
         RETURNING id, state, config, metadata, min_client_version, created_at, updated_at`,
        [
          input.sessionId,
          input.config !== undefined ? JSON.stringify(input.config) : null,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        ],
      );
      const session: SessionRow | undefined = sessionUpsert.rows[0];
      if (session === undefined) {
        throw new Error(
          `SessionDirectoryService.createSession: session upsert returned no row for id=${String(input.sessionId)}`,
        );
      }

      // Explicit row lock — see method docstring §"Concurrent
      // createSession callers" for the READ COMMITTED race rationale and
      // §"Lock-acquisition order" for the cross-plan order constraint
      // Plan-002 must honor.
      await tx.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [input.sessionId]);

      // Owner-mismatch guard (Codex P1, residual of B1).
      //
      // BL-069 invariant #4: "owner identity is bound at the first
      // authenticated RPC via PASETO v4 trust-on-first-use." The session
      // upsert above is idempotent on `sessions.id`, but the owner-
      // membership upsert below collides on UNIQUE(session_id,
      // participant_id) — a conflict target that cares about the
      // (session, participant) PAIR, not the role. Without this probe a
      // second `createSession({sessionId: S, ownerParticipantId: P2})`
      // for an existing session S already owned by P1 would INSERT a
      // SECOND `(S, P2, 'owner')` row instead of conflicting; P2 would
      // silently obtain owner privileges without going through any
      // promotion / elevation flow. R1 dropped the auto-mint participant
      // (B1) which closed the most-likely path to that bug, but the
      // residual UNIQUE-shape gap survived: an explicit caller passing a
      // mismatched ownerParticipantId would still escalate.
      //
      // The probe is INSIDE the same `tx` so it sees the same snapshot
      // the membership upsert below will write into — a concurrent
      // racer cannot slip a contradicting owner row in between probe
      // and insert. We probe `session_memberships` (not `sessions`)
      // because the question is about owner identity, not session
      // existence; the session row was just upserted moments ago in the
      // same tx, so a `sessions`-side probe wouldn't tell us anything
      // useful about the owner.
      //
      // Same-owner re-create stays idempotent — when the probe returns
      // rows that include this `ownerParticipantId`, we proceed and let
      // the upsert below DO UPDATE the existing row. Only a true
      // mismatch (existing owners do NOT include this participantId)
      // throws.
      //
      // Plan-002 owns ownership transfer / co-owner flows. Those flows
      // will go through their own promotion / elevation paths; this
      // create-time guard does NOT impose a "single owner forever"
      // invariant — it only enforces the create-time TOFU rule per
      // BL-069 §4 + Spec-001 §Default Behavior ("A newly created
      // session defaults to one `owner` membership for the creator").
      const existingOwners = await tx.query<{ participant_id: string }>(
        `SELECT participant_id FROM session_memberships
          WHERE session_id = $1 AND role = 'owner'`,
        [input.sessionId],
      );
      if (existingOwners.rows.length > 0) {
        // UUID-casing normalization (Codex P2, round 5).
        //
        // RFC 9562 §4 specifies UUIDs are case-insensitive, but Postgres
        // stores them in canonical lowercase form and returns them as
        // lowercase strings (the `uuid` type's text-output convention).
        // A caller passing `ParticipantId` with uppercase hex digits —
        // valid per the brand's `z.uuid()` parser, which accepts both
        // cases — would fail strict string equality against the
        // lowercase row value, falsely tripping the owner-mismatch
        // throw on a same-owner re-create. Normalizing both sides to
        // lowercase before equality preserves idempotency for the
        // logical UUID. We chose the in-TypeScript approach (vs an
        // SQL-side `participant_id <> $2::uuid`) so the rejection-path
        // test can drive the comparison through plain TypeScript and
        // doesn't need to rely on the substrate's UUID-cast semantics.
        // Both sides are normalized symmetrically as defense against
        // substrate drift — Postgres returns canonical lowercase today,
        // but a future driver/substrate that does not could falsely
        // trip this guard from the row side.
        const inputLower = input.ownerParticipantId.toLowerCase();
        const matchedExisting = existingOwners.rows.some(
          (row) => row.participant_id.toLowerCase() === inputLower,
        );
        if (!matchedExisting) {
          throw new Error(
            `SessionDirectoryService.createSession: session ${String(input.sessionId)} already exists with a different owner; createSession is idempotent only when called with the same ownerParticipantId. Owner promotion/transfer is owned by Plan-002.`,
          );
        }
        // Same owner re-creating — fall through to the idempotent
        // membership upsert (DO UPDATE no-op on conflict).
      }

      // Owner-membership upsert. Same DO UPDATE pattern so RETURNING *
      // yields a row regardless of first-create vs retry.
      // UNIQUE(session_id, participant_id) is the conflict target.
      const membershipUpsert = await tx.query<MembershipRow>(
        `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
         VALUES ($1, $2, 'owner', 'active', now())
         ON CONFLICT (session_id, participant_id)
         DO UPDATE SET updated_at = session_memberships.updated_at
         RETURNING id, session_id, participant_id, role, state, joined_at, updated_at`,
        [input.sessionId, input.ownerParticipantId],
      );
      const membership: MembershipRow | undefined = membershipUpsert.rows[0];
      if (membership === undefined) {
        throw new Error(
          `SessionDirectoryService.createSession: owner-membership upsert returned no row for session=${String(input.sessionId)} owner=${String(input.ownerParticipantId)}`,
        );
      }

      return { sessionRow: session, membershipRow: membership };
    });

    // Channels are NOT a control-plane concern — channel metadata is
    // owned by the per-daemon local event log (see
    // `packages/runtime-daemon/src/session/session-projector.ts`). The
    // wire contract requires a `channels: ChannelSummary[]` field; PR #4
    // returns an empty array as the canonical "control plane has no
    // channel metadata" signal. PR #5's SDK composition layer will merge
    // the daemon's projected channels with this empty list — the merge
    // step is what produces the user-visible channel list (always
    // including the synthesized "main" channel per AC1).
    const channels: ChannelSummary[] = [];

    return {
      sessionId: sessionRow.id as SessionId,
      state: sessionRow.state as SessionState,
      memberships: [hydrateMembershipSummary(membershipRow)],
      channels,
    };
  }

  /**
   * Point-lookup by sessionId. Returns `null` for unknown sessions.
   *
   * `timelineCursors.latest` is intentionally a placeholder string: per
   * ADR-017 the control plane has no event log, so it cannot synthesize a
   * real cursor. Plan-001 PR #5's SDK composition layer queries the
   * daemon's local event service for the real cursor and overrides this
   * field. Returning a placeholder rather than throwing keeps the wire
   * shape inhabited so consumers don't need to special-case this path.
   *
   * The placeholder is NOT a wire-stable value — the SDK composition step
   * is the authoritative cursor source. Tests that exercise the wire
   * shape directly (P3 in this PR) intentionally do NOT assert on this
   * field's contents.
   */
  async readSession(sessionId: SessionId): Promise<SessionReadResponse | null> {
    const probe = await this.#querier.query<SessionRow>(
      `SELECT id, state, config, metadata, min_client_version, created_at, updated_at
         FROM sessions
        WHERE id = $1`,
      [sessionId],
    );
    const row: SessionRow | undefined = probe.rows[0];
    if (row === undefined) {
      return null;
    }
    const session: SessionSnapshot = hydrateSessionSnapshot(row);
    return {
      session,
      timelineCursors: {
        // See method-level docstring for the placeholder rationale. The
        // value passes EventCursorSchema (min/max length) but is NOT a
        // wire-stable Plan-006 cursor; PR #5's SDK composition layer
        // overrides this field with the daemon's authoritative cursor.
        latest: CONTROL_PLANE_PLACEHOLDER_CURSOR,
      },
    };
  }

  /**
   * Idempotent membership upsert by (sessionId, participantId).
   *
   * Behavior:
   *   * First call for a (session, participant) pair INSERTs a new row.
   *   * Subsequent calls return the SAME `membershipId` — no silent fork
   *     (AC5). Realized via `ON CONFLICT (session_id, participant_id)
   *     DO UPDATE SET updated_at = session_memberships.updated_at` so
   *     `RETURNING *` yields the canonical row both ways.
   *   * Returns `null` if the session does not exist (the caller should
   *     surface a typed not-found error to the wire layer).
   *
   * Owner-role rejection (Codex P1, round 5 review of PR #4): `input.role`
   * is typed `NonOwnerMembershipRole`, which excludes `"owner"` at compile
   * time for TypeScript callers. The runtime guard at the very top of this
   * method is the SECOND defense, catching dynamic callers (e.g. JS
   * consumers, tests that cast around the type) that bypass the type
   * system. The check fires BEFORE the session-existence probe so a
   * pathological caller cannot use the response shape (`null` vs throw)
   * to fingerprint which session ids exist; the privilege-escalation
   * rejection takes precedence over the not-found path.
   *
   * Why owner is rejected here: BL-069 §4 binds owner identity at
   * `createSession` time via TOFU. The membership upsert below collides
   * on UNIQUE(session_id, participant_id), which keys on the (session,
   * participant) PAIR — not on the role — so a `joinSession` call with
   * `role: "owner"` from a NEW participant would silently INSERT a second
   * `(S, P_new, 'owner')` row, granting P_new owner privileges without
   * invitation, elevation, or promotion. (Existing-participant rejoin is
   * idempotent — the conflict clause touches only `updated_at` — but
   * that path is not the surface we are guarding against here.) Plan-002
   * owns ownership-transfer / co-owner promotion flows; those flows go
   * through their own promotion paths, not through `joinSession`.
   *
   * NOT a reactivation primitive: on rejoin, an existing `pending` /
   * `suspended` / `revoked` membership row is preserved verbatim — the
   * caller's `role` argument is IGNORED on conflict (the upsert touches
   * only `updated_at`). This is intentional: lifecycle transitions
   * (suspend / revoke / reactivate) are owned by Plan-002's membership
   * state machine, not by the directory's join surface. A wire-layer
   * caller that wants to reactivate a suspended membership MUST go
   * through Plan-002's promotion path; calling `joinSession` again is a
   * no-op on row state. The `joinSession is preserve-on-conflict` test
   * pins this behavior so a future regression that swaps the upsert to
   * `DO UPDATE SET role = EXCLUDED.role, state = 'active'` surfaces
   * immediately.
   *
   * The wire response (`SessionJoinResponse`) carries
   * `{ sessionId, participantId, membershipId, sharedMetadata }` — no
   * timeline cursor. Cursor composition is owned by Plan-001 PR #5's
   * SDK layer, which calls `readSession` after `joinSession` to assemble
   * the post-join state.
   *
   * `sharedMetadata` mirrors the `sessions.metadata` JSONB column. Plan-001
   * PR #4 returns the column verbatim; Plan-002+ may layer policy/filter
   * here when the metadata payload widens.
   */
  async joinSession(input: JoinSessionInput): Promise<SessionJoinResponse | null> {
    // Owner-role rejection (Codex P1, round 5).
    //
    // Fail fast: the check runs BEFORE the session-existence probe so a
    // privilege-escalation attempt against a non-existent sessionId
    // surfaces as the same throw a caller against an existing session
    // would see, rather than as `null` (which would leak existence
    // information AND let the caller distinguish "session doesn't exist"
    // from "you're not allowed to do that"). Dynamic callers (JS
    // consumers, FFI, cross-language clients) that bypass the type
    // system are caught here — both compile-time and runtime defenses
    // are needed; see the type-level rationale in `JoinSessionInput`'s
    // docstring.
    if ((input.role as MembershipRole | undefined) === "owner") {
      throw new Error(
        "SessionDirectoryService.joinSession: 'owner' role cannot be assigned via joinSession; ownership is bound at createSession time per BL-069 §4 (TOFU). Plan-002 owns ownership-transfer / co-owner promotion.",
      );
    }

    const sessionProbe = await this.#querier.query<SessionRow>(
      "SELECT id, state, config, metadata, min_client_version, created_at, updated_at FROM sessions WHERE id = $1",
      [input.sessionId],
    );
    const sessionRow: SessionRow | undefined = sessionProbe.rows[0];
    if (sessionRow === undefined) {
      return null;
    }

    const role: MembershipRole = input.role ?? "viewer";
    const membershipUpsert = await this.#querier.query<MembershipRow>(
      `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
       VALUES ($1, $2, $3, 'active', now())
       ON CONFLICT (session_id, participant_id)
       DO UPDATE SET updated_at = session_memberships.updated_at
       RETURNING id, session_id, participant_id, role, state, joined_at, updated_at`,
      [input.sessionId, input.participantId, role],
    );
    const membershipRow: MembershipRow | undefined = membershipUpsert.rows[0];
    if (membershipRow === undefined) {
      throw new Error(
        `SessionDirectoryService.joinSession: membership upsert returned no row for session=${String(input.sessionId)} participant=${String(input.participantId)}`,
      );
    }

    return {
      sessionId: sessionRow.id as SessionId,
      participantId: membershipRow.participant_id as ParticipantId,
      membershipId: membershipRow.id as MembershipId,
      sharedMetadata: sessionRow.metadata,
    };
  }
}

// --------------------------------------------------------------------------
// Row hydration
// --------------------------------------------------------------------------
//
// Postgres `TIMESTAMPTZ` columns are returned as either a JS `Date` (the
// `pg` driver's default) or an ISO 8601 string (pglite's default). Both
// drivers expose a `toISOString()` method on the resulting value when it's
// a Date; for strings we pass through. The wire contract requires ISO 8601
// per `SessionSnapshotSchema.createdAt` (`z.iso.datetime({ offset: true })`).
//
// `JSONB` columns are returned as plain JS objects (both drivers parse the
// JSON server-side and hydrate). No JSON.parse is needed at this boundary.

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function hydrateSessionSnapshot(row: SessionRow): SessionSnapshot {
  return {
    id: row.id as SessionId,
    state: row.state as SessionState,
    config: row.config,
    metadata: row.metadata,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function hydrateMembershipSummary(row: MembershipRow): MembershipSummary {
  return {
    id: row.id as MembershipId,
    participantId: row.participant_id as ParticipantId,
    role: row.role as MembershipRole,
    state: row.state as MembershipState,
  };
}

// --------------------------------------------------------------------------
// pg.Pool -> Querier adapter (Plan-001 PR #5 / T5.5)
// --------------------------------------------------------------------------
//
// Production wiring composes a `Querier` from a `pg.Pool` so the same
// `SessionDirectoryService` body (typed against `Querier`) can run against
// shared Postgres in deployment AND against an in-process PGlite instance
// in test. Phase 4 shipped the service driver-agnostic; this adapter is the
// production-side concretion.
//
// Why a free function and not a class: the Querier interface is the only
// surface this composition exposes — it has no per-instance state beyond
// the Pool reference itself, and consumers never need to extend or
// subclass it. A factory keeps the call site one-liner
// (`createSessionDirectoryServiceFromPool(pool)`) without the noise of a
// constructable wrapper.
//
// The three Querier methods map onto three distinct pg.Pool affordances:
//
//   * `query()` -> `pool.query(sql, params)`. pg.Pool's parameterized
//     query helper internally `connect()`s, issues the statement over the
//     extended query protocol, and `release()`s the client back to the
//     pool. One round-trip, automatic checkout management. This is the
//     right primitive for stateless out-of-transaction reads/writes —
//     using `pool.connect()` here would force every Querier consumer to
//     manage release manually, leak connections on caller-side throws,
//     and add a checkout/release round-trip the pool already optimizes
//     away for the one-shot case.
//
//   * `exec()` -> `pool.query(sql)` (no params). Without a values array,
//     pg's `Client#query()` falls through to the simple query protocol
//     which permits multi-statement batches (`BEGIN; ...; COMMIT;`). This
//     is what the migration runner's `INITIAL_MIGRATION_SQL` body needs.
//     Same auto-checkout-and-release semantics as `query()`. The Querier
//     contract returns `void`; we discard the QueryResult.
//
//   * `transaction(fn)` -> `pool.connect()` + manual BEGIN/COMMIT. This
//     is the load-bearing concretion. See `createPgPoolQuerier` docstring
//     for the full mechanism.
//
// Why no error-handler wrapping pool errors: pg propagates `DatabaseError`
// (`pg-protocol`) instances on SQL failures and `Error` instances on
// transport failures; both bubble through unchanged so the service body
// sees the same surface as it would under PGlite (which throws on SQL
// failures from `pg.query()` too). Adding a translation layer here would
// only obscure the underlying driver error in stack traces.

/**
 * Wrap a `pg.Pool` so it satisfies the `Querier` contract.
 *
 * Pool-checkout-and-release semantics:
 *
 *   * `query()` and `exec()` route through `pool.query()`, which
 *     internally checks out a pooled client, runs the statement, and
 *     releases the client on the same call. Two consecutive `query()`
 *     calls MAY land on different pooled connections — that is fine for
 *     stateless statements, but is precisely why `transaction(fn)`
 *     cannot use the same pattern.
 *
 *   * `transaction(fn)` checks out ONE client via `pool.connect()`, holds
 *     it across `BEGIN` / inner statements / `COMMIT`, and releases on
 *     every exit path (commit success, application error, Postgres-side
 *     error during COMMIT, ROLLBACK error). Without a held client, each
 *     inner statement would check out a different pooled connection;
 *     `BEGIN` would land on one client, the inner statements on others,
 *     and `COMMIT` on yet another — the transaction would dissolve, AND
 *     any session-scoped state (advisory locks acquired via
 *     `pg_advisory_xact_lock`, `FOR UPDATE` row locks taken by the
 *     `createSession` ordering, server-side prepared statements) would
 *     not survive across statements.
 *
 *     The inner `Querier` passed to `fn` routes ALL THREE methods —
 *     `query`, `exec`, and `transaction` — through the held client, not
 *     back through the pool. Routing the inner `query()` through the pool
 *     instead of the held client would defeat the entire point of the
 *     transaction substrate (the lock would land on the wrong connection,
 *     or no specific connection at all). The nested-`transaction` call
 *     throws because Postgres has no native nested transactions without
 *     SAVEPOINTs and Plan-001 has no SAVEPOINT requirement — the throw
 *     matches the PGlite adapter's behavior so the failure mode is
 *     identical across substrates.
 *
 * Rollback behavior:
 *
 *   * On error inside `fn`, the adapter issues `ROLLBACK` and re-raises
 *     the underlying error. Unlike PGlite's `pg.transaction(fn)` (which
 *     auto-rolls-back internally), pg.Pool has no auto-rollback — without
 *     this manual ROLLBACK, an aborted transaction would stay open on the
 *     client until release, the client would return to the pool in an
 *     aborted state, and the next checkout would receive a client in a
 *     `25P02 current transaction is aborted` state. The ROLLBACK call is
 *     wrapped in its own try/catch so that a ROLLBACK failure (e.g., the
 *     underlying connection was already terminated) does NOT mask the
 *     original error — we still re-raise the original `fn` error, which
 *     is what the caller actually needs to diagnose.
 *
 *   * On success, `COMMIT` is issued. If COMMIT itself throws (e.g.,
 *     deferred constraint violation surfacing only at commit time), the
 *     adapter does NOT issue ROLLBACK after — at that point the
 *     transaction has already been rolled back server-side by Postgres
 *     in response to the failed COMMIT, and a follow-up ROLLBACK on a
 *     non-existent transaction would itself error. We re-raise the
 *     COMMIT error.
 *
 *   * `client.release()` always runs in the `finally` block so the
 *     connection returns to the pool whether the path terminated in
 *     commit success, application error + ROLLBACK, COMMIT-time error,
 *     or ROLLBACK error itself. Without the `finally`, any throw between
 *     `connect()` and `release()` would leak the connection — the pool
 *     would slowly deplete under any sustained error rate.
 */
export function createPgPoolQuerier(pool: Pool): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      // pg's `query()` parameter array is typed as `unknown[]` (mutable),
      // not `ReadonlyArray<unknown>`. The spread copy decouples the
      // mutability claim at the type boundary without copying parameter
      // values themselves. Mirrors the PGlite adapter pattern in the
      // session-directory-service test file.
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      // Substrate-vs-surface generic-shape mismatch. `pool.query<R extends
      // QueryResultRow>` constrains `R` to `{ [column: string]: any }`,
      // but the Querier surface (`migration-runner.ts:111`) is generic on
      // a free `T` so the service body can declare row shapes that don't
      // match the substrate's index-signature constraint. We take the cast
      // because preserving the Querier-side generic is what keeps the
      // service body interchangeable across substrates — narrowing the
      // surface to `<T extends Record<string, unknown>>` would propagate
      // the pg-specific constraint into the migration-runner Querier
      // contract and into the PGlite test adapter, breaking both. The
      // PGlite test adapter takes the same lateral cast for the same
      // reason (see `wrap()` in the test file).
      const result = await pool.query<Record<string, unknown>>(sql, mutableParams);
      return { rows: result.rows as ReadonlyArray<T> };
    },
    exec: async (sql: string): Promise<void> => {
      // No params -> simple query protocol -> multi-statement batches
      // permitted. See file-level docstring for the protocol rationale.
      await pool.query(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      // Hold ONE client across BEGIN/COMMIT — see method docstring for
      // the connection-affinity rationale.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let result: T;
        try {
          result = await fn(createPoolClientQuerier(client));
        } catch (originalError) {
          // Application error inside `fn`. Issue ROLLBACK and re-raise
          // the original error. The ROLLBACK is wrapped in its own
          // try/catch so a ROLLBACK failure does NOT mask the caller-
          // facing original error.
          try {
            await client.query("ROLLBACK");
          } catch {
            // Intentionally swallowed — the original error is what the
            // caller needs to diagnose, not the ROLLBACK fallout.
          }
          throw originalError;
        }
        await client.query("COMMIT");
        return result;
      } finally {
        // Always release — see method docstring §"finally" for the
        // connection-leak rationale this defends against.
        client.release();
      }
    },
  };
}

/**
 * Adapt a held `PoolClient` to the `Querier` interface for use inside a
 * `transaction(fn)` callback.
 *
 * All three methods route through the SAME held client so the transaction
 * boundary and any session-scoped state (advisory locks, FOR UPDATE row
 * locks, prepared statements) survive across inner statements. Nested
 * `transaction()` calls throw — Postgres has no native nested transactions
 * without SAVEPOINTs and Plan-001 has no SAVEPOINT requirement. The throw
 * matches the PGlite test adapter's behavior so the failure mode is
 * identical across substrates.
 *
 * This factory is internal-only: callers should reach `pg.Pool` through
 * `createPgPoolQuerier`, which constructs this inner Querier on every
 * `transaction()` entry.
 */
function createPoolClientQuerier(client: PoolClient): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      // Cast rationale identical to `createPgPoolQuerier`'s `query` — see
      // the substrate-vs-surface generic-shape comment there. `client.query`
      // shares the `R extends QueryResultRow` constraint with `pool.query`,
      // so the same lateral cast applies on the held-client path.
      const result = await client.query<Record<string, unknown>>(sql, mutableParams);
      return { rows: result.rows as ReadonlyArray<T> };
    },
    exec: async (sql: string): Promise<void> => {
      await client.query(sql);
    },
    transaction: <T>(_fn: (tx: Querier) => Promise<T>): Promise<T> => {
      // Postgres has no native nested transactions without SAVEPOINTs.
      // Plan-001 has no SAVEPOINT requirement; the throw matches the
      // PGlite test adapter's behavior so the failure mode is identical
      // across substrates. A future plan that needs nested-transaction
      // semantics MUST extend the Querier contract (add a `savepoint(fn)`
      // method) rather than overloading `transaction()` with a
      // substrate-specific shape.
      return Promise.reject(
        new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        ),
      );
    },
  };
}

/**
 * Compose a `SessionDirectoryService` from a `pg.Pool`.
 *
 * Convenience one-liner for production wiring: the SDK / control-plane
 * host (Plan-001 PR #5 and consumers downstream) gets a fully-constructed
 * service in one call instead of the two-step
 * `new SessionDirectoryService(createPgPoolQuerier(pool))`. The factory
 * matches the export-shape Phase 4 anticipated in the in-file note "Plan-
 * 001 PR #5 will compose a `Querier` from `pg.Pool`".
 */
export function createSessionDirectoryServiceFromPool(pool: Pool): SessionDirectoryService {
  return new SessionDirectoryService(createPgPoolQuerier(pool));
}
