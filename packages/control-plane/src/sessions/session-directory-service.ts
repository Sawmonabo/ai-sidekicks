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
//     table. Plan-001 PR #4 INSERTs minimal anchor rows (DEFAULT VALUES);
//     the schema doc explicitly notes "no participant rows are inserted
//     before Plan-018's registration flow lands" — Plan-001's owner-
//     participant minting is a deliberate exception, narrow to the
//     owner-membership bootstrap and documented at the call site.
//   * Invite-driven membership flows — Plan-002 owns. PR #4 only handles
//     the create-session-with-owner and direct-join-by-participantId
//     paths.

import type {
  ChannelSummary,
  EventCursor,
  MembershipId,
  MembershipRole,
  MembershipState,
  MembershipSummary,
  ParticipantId,
  SessionCreateResponse,
  SessionId,
  SessionJoinResponse,
  SessionReadResponse,
  SessionSnapshot,
  SessionState,
} from "@ai-sidekicks/contracts";

import type { Querier } from "./migration-runner.js";

// --------------------------------------------------------------------------
// Placeholder cursor returned by `readSession`. See `readSession` docstring
// — the control plane has no event log per ADR-017, so it cannot synthesize
// a real Plan-006 cursor. PR #5's SDK composition layer queries the
// daemon's local event service for the authoritative cursor and overrides
// this field. The value passes `EventCursorSchema` (min/max length) so the
// wire shape stays inhabited; consumers MUST NOT treat it as a real cursor.
// --------------------------------------------------------------------------

const CONTROL_PLANE_PLACEHOLDER_CURSOR: EventCursor = "control-plane:no-cursor" as EventCursor;

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

interface ParticipantIdRow {
  readonly id: string;
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
 * `ownerParticipantId` is optional. When omitted, this service mints a fresh
 * `participants` row via `INSERT INTO participants DEFAULT VALUES` and uses
 * the returned id. This is the V1 path because Plan-018 (identity +
 * registration) hasn't landed; once it does, the daemon will resolve a
 * participantId out-of-band before calling create. Documenting this as a
 * narrow exception to the schema doc's "no participant rows before Plan-018"
 * note: the owner-membership bootstrap requires a real participant row at
 * create time.
 */
export interface CreateSessionInput {
  readonly sessionId: SessionId;
  readonly ownerParticipantId?: ParticipantId | undefined;
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
 */
export interface JoinSessionInput {
  readonly sessionId: SessionId;
  readonly participantId: ParticipantId;
  readonly role?: MembershipRole | undefined;
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
   * On second create with the same `sessionId`:
   *   * The existing row's `created_at` and id are preserved.
   *   * The `updated_at` value is preserved (the no-op assignment).
   *   * The owner-membership row is also `ON CONFLICT (session_id,
   *     participant_id) DO UPDATE SET updated_at = ...` — no silent
   *     duplicate membership.
   *   * The response shape mirrors a first-create call so the caller's
   *     state machine doesn't need a retry-detect branch.
   */
  async createSession(input: CreateSessionInput): Promise<SessionCreateResponse> {
    // Resolve the owner participant first. If the caller supplied one,
    // honor it (Plan-018 will route through here once the registration
    // flow lands); otherwise mint a fresh anchor row.
    //
    // The `participants` insert is INTENTIONALLY outside the
    // `sessions`/`session_memberships` upsert — it represents a stable
    // identity that outlives the session. On retry-after-crash the
    // daemon will already have a participantId from the first attempt
    // and pass it explicitly, avoiding the duplicate-anchor case.
    let ownerParticipantId: ParticipantId;
    if (input.ownerParticipantId !== undefined) {
      ownerParticipantId = input.ownerParticipantId;
    } else {
      const participantInsert = await this.#querier.query<ParticipantIdRow>(
        "INSERT INTO participants DEFAULT VALUES RETURNING id",
      );
      const participantRow: ParticipantIdRow | undefined = participantInsert.rows[0];
      if (participantRow === undefined) {
        throw new Error(
          "SessionDirectoryService.createSession: INSERT INTO participants returned no row",
        );
      }
      ownerParticipantId = participantRow.id as ParticipantId;
    }

    // Idempotent session upsert — see method-level docstring for the
    // DO UPDATE-vs-DO NOTHING rationale.
    //
    // `config` and `metadata` are JSONB; pg + pglite both accept a JS
    // object directly (the driver serializes via JSON.stringify). The
    // `?? null` on the optional inputs lets the column DEFAULT '{}'
    // apply when the caller omits the field.
    const sessionUpsert = await this.#querier.query<SessionRow>(
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
    const sessionRow: SessionRow | undefined = sessionUpsert.rows[0];
    if (sessionRow === undefined) {
      throw new Error(
        `SessionDirectoryService.createSession: session upsert returned no row for id=${String(input.sessionId)}`,
      );
    }

    // Owner-membership upsert. Same DO UPDATE pattern so RETURNING * yields
    // a row regardless of first-create vs retry. UNIQUE(session_id,
    // participant_id) is the conflict target.
    const membershipUpsert = await this.#querier.query<MembershipRow>(
      `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
       VALUES ($1, $2, 'owner', 'active', now())
       ON CONFLICT (session_id, participant_id)
       DO UPDATE SET updated_at = session_memberships.updated_at
       RETURNING id, session_id, participant_id, role, state, joined_at, updated_at`,
      [input.sessionId, ownerParticipantId],
    );
    const membershipRow: MembershipRow | undefined = membershipUpsert.rows[0];
    if (membershipRow === undefined) {
      throw new Error(
        `SessionDirectoryService.createSession: owner-membership upsert returned no row for session=${String(input.sessionId)} owner=${String(ownerParticipantId)}`,
      );
    }

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
