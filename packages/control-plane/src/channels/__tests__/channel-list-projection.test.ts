// ChannelListProjection tests — Plan-002 Phase 3 (T3.4).
//
// Coverage (mapped to the dispatched spec_coverage):
//   I3 (the headline AC; Spec-002 §Interfaces And Contracts line 87, C5 + I3):
//       for an existing session, the `ChannelList` projection returns the
//       bootstrap "main" channel — exactly one channel, named "main", state
//       "active", with a valid UUID id. The bootstrap main channel is a
//       PROJECTED STRUCTURAL INVARIANT (1:1 with the session, id a pure
//       function of the session id via the shared `deriveMainChannelId`); it is
//       NOT born from a `ChannelCreated` event. The control plane has no
//       channels table; the projection SYNTHESIZES this channel from its own
//       data (the `sessions` row + the `session_memberships` count), which is
//       correct because every session that exists has the bootstrap main
//       channel by that invariant (Plan-002 line 94: "projects whatever
//       channels currently exist regardless of who created them"). See
//       channel-list-projection.ts header.
//   AC1 (partial; Spec-002 AC1): the default-channel projection is LIVE (the
//       projection is non-empty / the bootstrap channel is present) for a
//       session that is in a state where invites can be accepted — supporting
//       live-join non-disruption. The bootstrap channel is NOT gated behind any
//       "channel created" event; it is present the moment the session exists.
//
// Plus behavioral coverage of the T3.4 projection surface:
//   * Shape conformance (C5): the returned envelope round-trips cleanly through
//     `ChannelListResponseSchema` — proves "response shape matches Spec-002:87
//     projection".
//   * Determinism: the same `sessionId` yields a byte-identical channel `id`
//     across two separate `list()` calls (the projection holds no state).
//   * participantCount: a session with N active members reports
//     `participantCount === N`; adding an active member is reflected.
//   * participantCount filter: only `active` memberships are counted —
//     `pending` / `suspended` / `revoked` rows are excluded (pins the
//     `state = 'active'` filter choice documented in
//     channel-list-projection.ts:76-94; a regression to "count all rows" must
//     fail here).
//   * Absent session: a `sessionId` with no row returns `null` — mirroring
//     `readSession`'s null-on-absent convention
//     (session-directory-service.ts:494-504) exactly.
//
// Harness: the in-process PGlite pattern from
// `sessions/__tests__/session-directory-service.test.ts` — a fresh ephemeral
// PGlite per test, `applyMigrations` for the full Plan-002 schema, and the same
// `adaptPGlite`/`wrap` PGlite -> Querier adapter. Sessions are seeded via
// `SessionDirectoryService.createSession` (the real create path) rather than
// hand-rolled INSERTs, so the test exercises the projection against rows shaped
// exactly as production writes them (owner membership at `state = 'active'`).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ChannelListResponseSchema,
  deriveMainChannelId,
  type ChannelListResponse,
  type ParticipantId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { ChannelListProjection } from "../channel-list-projection.js";
import { SessionDirectoryService } from "../../sessions/session-directory-service.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids. The brand validators accept any RFC 9562
// UUID; real id generation is daemon-side (the service treats ids as opaque).
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000d4001" as SessionId;
const ABSENT_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000d4099" as SessionId;
const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000d4b01" as ParticipantId;
const SECOND_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000d4b02" as ParticipantId;
const PENDING_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000d4b03" as ParticipantId;

// RFC 9562 §4: a canonical UUID string. The projection's derived id is a
// version-8 (custom/deterministic) UUID; this regex pins the 8-4-4-4-12 hex
// layout AND the version-8 + variant-10 nibbles the derivation stamps, so a
// regression that emits a non-UUID or the wrong version surfaces here in
// addition to the Zod-schema round-trip below.
const UUID_V8_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (mirrors session-directory-service.test.ts:89-134)
// ----------------------------------------------------------------------------
//
// PGlite#query and pg.Pool#query both satisfy the `Querier` interface
// structurally, but TypeScript's structural typing trips on `params` being
// optional in PGlite's signature vs required in pg.Pool's; the thin wrapper
// makes the call site ergonomic and keeps the in-transaction code path on the
// same interface as the outside code path.

function adaptPGlite(handle: PGlite): Querier {
  return wrap(handle);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      // PGlite's `query` requires `params` as `any[]` (mutable). The spread
      // copy decouples the mutability claim without copying parameter values.
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        // Already inside a `pg.transaction(fn)` callback — PGlite's
        // `Transaction` exposes no nested `transaction(...)`. The throw matches
        // production pg.Pool adapters (Postgres semantics, not a test-substrate
        // limitation).
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => fn(wrap(tx)));
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  // PGlite exposes `transaction(fn)`; its `Transaction` does not. Structural
  // discriminator via the property that distinguishes the two types.
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  readonly querier: Querier;
  readonly directory: SessionDirectoryService;
  readonly projection: ChannelListProjection;
}

let ctx: TestContext;

beforeEach(async () => {
  // In-memory PGlite (no `dataDir`) — fresh schema per test. The first query
  // implicitly awaits readiness; `applyMigrations` doubles as the readiness
  // checkpoint AND the schema bootstrap (v1 + v2, the full Plan-002 set).
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = {
    querier,
    directory: new SessionDirectoryService(querier),
    projection: new ChannelListProjection(querier),
  };
});

// Seed an identity-anchor row in `participants`. `session_memberships`
// declares `participant_id UUID NOT NULL REFERENCES participants(id)`
// (0001-initial.ts:123), a non-deferrable FK, so any participant id used in a
// membership row MUST pre-exist in `participants` — the same seeding the
// directory-service suite does before every createSession/joinSession
// (session-directory-service.test.ts:265). Plan-018 owns real participant
// registration; tests insert the bare id anchor directly. `ON CONFLICT (id)
// DO NOTHING` keeps the helper idempotent so a participant can be seeded once
// and reused across helpers within a test.
async function seedParticipant(participantId: ParticipantId): Promise<void> {
  await ctx.querier.query("INSERT INTO participants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [
    participantId,
  ]);
}

// Seed a session with its owner membership via the real create path, so the
// projection runs against rows shaped exactly as production writes them. The
// owner participant anchor is seeded first to satisfy the membership FK.
async function createSession(sessionId: SessionId, ownerId: ParticipantId): Promise<void> {
  await seedParticipant(ownerId);
  await ctx.directory.createSession({ sessionId, ownerParticipantId: ownerId });
}

// Insert a membership row directly at an arbitrary state — used to seed
// non-`active` rows that the public service surface (createSession/joinSession)
// never produces, so the `state = 'active'` count filter can be exercised
// against `pending`/`suspended`/`revoked` rows. Seeds the participant anchor
// first to satisfy the FK.
async function insertMembership(
  sessionId: SessionId,
  participantId: ParticipantId,
  state: string,
): Promise<void> {
  await seedParticipant(participantId);
  await ctx.querier.query(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, 'viewer', $3, now())`,
    [sessionId, participantId, state],
  );
}

describe("ChannelListProjection.list", () => {
  it("I3: ChannelList returns the bootstrap main channel projected for an existing session", async () => {
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID);

    const result = await ctx.projection.list({ sessionId: SESSION_ID });

    // The projection is live the moment the session exists — the bootstrap
    // main channel is a projected structural invariant, not born from a
    // `ChannelCreated` event.
    expect(result).not.toBeNull();
    const channels = result!.channels;
    // EXACTLY ONE channel — the bootstrap "main" channel.
    expect(channels).toHaveLength(1);

    const mainChannel = channels[0]!;
    expect(mainChannel.name).toBe("main");
    expect(mainChannel.state).toBe("active");
    // Delegation assertion: the projected id is the shared
    // `deriveMainChannelId` (THE single source of truth in
    // `@ai-sidekicks/contracts`), proving the projection delegates to the
    // shared derivation rather than a local copy. This id is byte-identical
    // to the daemon's projected main-channel id for the same session.
    expect(mainChannel.id).toBe(deriveMainChannelId(SESSION_ID));
    // The id is a valid version-8 UUID (passes the `ChannelId` brand's
    // `z.string().uuid()` validator — verified shape here, schema round-trip
    // below).
    expect(mainChannel.id).toMatch(UUID_V8_RE);
    // Owner-only session → exactly one active member.
    expect(mainChannel.participantCount).toBe(1);
  });

  it("AC1 (partial): the default channel is present for a session ready to accept invites", async () => {
    // A freshly-created session is in a state where invites can be issued and
    // accepted (Plan-002 Phase 2). The projection must already be non-empty at
    // that point — the bootstrap channel supports live-join non-disruption and
    // is NOT gated behind any channel-creation step. This is a focused
    // assertion that the bootstrap channel is live at invite-accept time.
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID);

    const result = await ctx.projection.list({ sessionId: SESSION_ID });

    expect(result).not.toBeNull();
    expect(result!.channels).toHaveLength(1);
    expect(result!.channels[0]!.name).toBe("main");
  });

  it("C5: the response round-trips cleanly through ChannelListResponseSchema", async () => {
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID);

    const result = await ctx.projection.list({ sessionId: SESSION_ID });

    // Guard the null path BEFORE the round-trip so the shape-conformance claim
    // is actually exercised (a silently-null result would otherwise bypass it).
    expect(result).not.toBeNull();
    // `.parse` throws on any drift — proves the projected shape matches the
    // canonical Spec-002:87 wire contract (strict object, optional `name`
    // present, non-negative-integer `participantCount`, branded ids).
    const parsed: ChannelListResponse = ChannelListResponseSchema.parse(result!);
    expect(parsed.channels).toHaveLength(1);
  });

  it("derives a deterministic id — same sessionId yields a byte-identical id across calls", async () => {
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID);

    const first = await ctx.projection.list({ sessionId: SESSION_ID });
    const second = await ctx.projection.list({ sessionId: SESSION_ID });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.channels[0]!.id).toBe(second!.channels[0]!.id);
  });

  it("derives DISTINCT ids for distinct sessions", async () => {
    // A second session must not collide with the first on the synthesized
    // channel id — the derivation mixes the sessionId into the hash input.
    const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000d4002" as SessionId;
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID);
    await createSession(OTHER_SESSION_ID, OWNER_PARTICIPANT_ID);

    const first = await ctx.projection.list({ sessionId: SESSION_ID });
    const other = await ctx.projection.list({ sessionId: OTHER_SESSION_ID });

    expect(first!.channels[0]!.id).not.toBe(other!.channels[0]!.id);
  });

  it("participantCount reflects the number of active members", async () => {
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID);

    // Owner only → 1.
    const beforeJoin = await ctx.projection.list({ sessionId: SESSION_ID });
    expect(beforeJoin!.channels[0]!.participantCount).toBe(1);

    // Add a second active member via the real join path → 2. Seed the
    // participant anchor first to satisfy the membership FK.
    await seedParticipant(SECOND_PARTICIPANT_ID);
    await ctx.directory.joinSession({
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "viewer",
    });
    const afterJoin = await ctx.projection.list({ sessionId: SESSION_ID });
    expect(afterJoin!.channels[0]!.participantCount).toBe(2);
  });

  it("participantCount counts ONLY active memberships (excludes pending/suspended/revoked)", async () => {
    // Pins the `state = 'active'` filter choice (channel-list-projection.ts:76-94):
    // a `pending` invitee (Plan-002 invite issued, not yet accepted), a
    // `suspended` member, and a `revoked` former member are NOT present in the
    // channel and MUST NOT inflate the live participant count. A regression to
    // "count all rows" would report 4 here instead of 1 and fail this test.
    await createSession(SESSION_ID, OWNER_PARTICIPANT_ID); // owner: active

    await insertMembership(SESSION_ID, PENDING_PARTICIPANT_ID, "pending");
    await insertMembership(SESSION_ID, SECOND_PARTICIPANT_ID, "suspended");
    await insertMembership(
      SESSION_ID,
      "01970000-0000-7000-8000-0000000d4b04" as ParticipantId,
      "revoked",
    );

    const result = await ctx.projection.list({ sessionId: SESSION_ID });

    // Only the owner's `active` membership is counted.
    expect(result!.channels[0]!.participantCount).toBe(1);
  });

  it("returns null for a session that does not exist (mirrors readSession's null-on-absent)", async () => {
    // No session row was created for ABSENT_SESSION_ID. The projection mirrors
    // `readSession`'s `Promise<… | null>` convention exactly — a strict `null`,
    // which the future tRPC router maps to a NOT_FOUND envelope.
    const result = await ctx.projection.list({ sessionId: ABSENT_SESSION_ID });

    expect(result).toBe(null);
  });
});
