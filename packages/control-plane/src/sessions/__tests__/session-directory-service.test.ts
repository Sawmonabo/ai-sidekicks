// P1/P2/P3: SessionDirectoryService — Plan-001 PR #4 acceptance gates.
//
// P1: SessionCreate returns stable session id and persists to directory
//     (Spec-001 AC1, AC2).
// P2: Second SessionCreate by same client does not silently fork
//     (Spec-001 AC5; BL-069 idempotent-upsert invariant).
// P3: SessionJoin verifies membership and returns existing membership id
//     (Spec-001 AC4, AC5). NOTE: the plan body's "returns existing
//     timeline cursor" phrasing is satisfied by membership-reuse alone in
//     PR #4 — `SessionJoinResponse` has no cursor field on the wire
//     (`{ sessionId, participantId, membershipId, sharedMetadata }`).
//     Cursor reuse is exercised by Plan-001 PR #5 SDK composition via
//     SessionRead, where the daemon-supplied authoritative cursor is
//     overlaid on the control plane's placeholder.
//
// Migration-runner coverage: matches the runtime-daemon test shape for
// `applyMigrations` idempotency (re-call on a migrated handle is a no-op,
// schema_migrations row stays singleton). Postgres has a different
// concurrency model from SQLite, so there's no analogue to runtime-daemon's
// `worker_threads`-driven `BEGIN IMMEDIATE` race test — see the migration-
// runner header for the full rationale.
//
// Database lifecycle: each test gets a fresh ephemeral PGlite instance
// (in-memory mode — no tmpdir cleanup needed). PGlite is single-connection
// per instance, which matches our service's stateless query pattern; the
// production wiring (Plan-001 PR #5) composes a `Querier` from `pg.Pool`
// where the per-call connection checkout is automatic.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MembershipId, ParticipantId, SessionId } from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../migration-runner.js";
import {
  SessionDirectoryService,
  type CreateSessionInput,
  type JoinSessionInput,
} from "../session-directory-service.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

// UUID v4 fixtures — these stand in for the daemon-assigned UUID v7 values
// per BL-069 (the v4 schema validator in `EventCursorSchema`/`SessionIdSchema`
// accepts any RFC 9562 UUID). Real UUID v7 generation is daemon-side; the
// service treats the id as opaque.
const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;
const SECOND_SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a002" as SessionId;
const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-00000000b001" as ParticipantId;
const SECOND_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000000b002" as ParticipantId;

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter
// ----------------------------------------------------------------------------
//
// PGlite#query and pg.Pool#query both return `Promise<Results<T>>` /
// `Promise<QueryResult<T>>` shapes that satisfy the `Querier` interface
// structurally — but TypeScript's structural typing trips on the `params`
// parameter being optional in PGlite's signature vs required in pg.Pool's.
// A thin wrapper makes both ergonomic.
//
// PGlite expects parameters as `any[]`; the `Querier` interface uses
// `ReadonlyArray<unknown>`. The cast at the boundary is safe because both
// drivers serialize parameters to the Postgres wire format in the same way.
//
// `exec()` maps to PGlite's `pg.exec(sql)` — the simple-query-protocol
// path that accepts multi-statement batches like `BEGIN; ...; COMMIT;`.
// `pg.exec` returns `Array<Results>` (one entry per statement); the
// Querier contract returns `void` so we discard the per-statement results
// (the migration runner doesn't read rows from the batch — its idempotency
// barrier is the `hasMigrationApplied` probe via `query()` instead).
function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

// PGlite's `PGlite` and `Transaction` types share a structurally compatible
// `query` + `exec` surface. The test `Querier.transaction` adapter wraps
// `pg.transaction(fn)` and re-wraps the inner `tx` as a `Querier` so the
// in-transaction code path uses the same interface as the outside code path.
//
// Nested `tx.transaction(...)` is intentionally not allowed (Postgres does
// not support nested transactions without SAVEPOINTs and we have no such
// requirement in PR #4); calling it throws at runtime — see the Querier
// docstring in migration-runner.ts.
function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      // PGlite's `query` signature requires `params` as `any[]` (mutable),
      // not `ReadonlyArray<unknown>`. The spread copy decouples the
      // mutability claim without copying parameter values themselves.
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        // Already inside a `pg.transaction(fn)` callback. PGlite's
        // `Transaction` does not expose `transaction(...)` (no nested
        // transactions). Throwing here matches what production `pg.Pool`
        // adapters will do — Postgres semantics, not a test substrate
        // limitation.
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => {
        return fn(wrap(tx));
      });
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  // PGlite exposes `transaction(fn)`; PGlite's `Transaction` does not.
  // Structural check via the property that distinguishes the two types.
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
  service: SessionDirectoryService;
}

let ctx: TestContext;

beforeEach(async () => {
  // In-memory PGlite (no `dataDir` argument) — fresh schema per test.
  // PGlite is single-connection-per-instance; that matches Postgres
  // semantics for a single checkout from a pool, which is sufficient for
  // every test here (no concurrent-write coverage in PR #4).
  const pg: PGlite = new PGlite();
  // PGlite emits a `ready` event but `await new PGlite()` doesn't directly
  // resolve to a ready state — the first `query` implicitly awaits. We
  // call `applyMigrations` immediately, which serves as the readiness
  // checkpoint AND the schema bootstrap.
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = {
    pg,
    querier,
    service: new SessionDirectoryService(querier),
  };
});

afterEach(async () => {
  // PGlite's `close()` releases the WASM heap and any IndexedDB / OPFS
  // backing (for persistent variants). For in-memory instances it's a
  // freed-heap signal; not awaiting could leak across tests under
  // vitest's parallel-file isolation.
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// P1 — SessionCreate returns stable session id and persists to directory
// ----------------------------------------------------------------------------

describe("SessionDirectoryService — P1 (create persists with stable id)", () => {
  it("createSession with a daemon-supplied UUID v7 returns the same id and persists a sessions row", async () => {
    // BL-069: the daemon mints UUID v7 locally and passes it on the create
    // call. The control-plane row's id MUST equal the supplied id (no
    // server-side regeneration).
    const input: CreateSessionInput = {
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
      config: { greeting: "hello" },
      metadata: { tag: "p1" },
    };
    // Owner participant must exist before the membership FK can resolve.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [OWNER_PARTICIPANT_ID]);

    const response = await ctx.service.createSession(input);

    // Returned id matches the supplied id (BL-069 invariant).
    expect(response.sessionId).toBe(SESSION_ID);
    // Default session state is 'provisioning' per the schema column DEFAULT.
    expect(response.state).toBe("provisioning");
    // The owner-membership row is materialized at create time.
    expect(response.memberships).toHaveLength(1);
    const ownerMembership = response.memberships[0];
    expect(ownerMembership).toBeDefined();
    if (ownerMembership === undefined) return;
    expect(ownerMembership.participantId).toBe(OWNER_PARTICIPANT_ID);
    expect(ownerMembership.role).toBe("owner");
    expect(ownerMembership.state).toBe("active");
    // Channels live in the daemon's local event log, not the control plane
    // (ADR-017). The wire shape requires the field — empty array is the
    // canonical "no channel metadata here" signal.
    expect(response.channels).toEqual([]);

    // Direct row probe — proves the persistence side, independent of the
    // service's read path. Spec-001 AC2 says the create lands in the
    // directory; this is the load-bearing assertion.
    const probe = await ctx.querier.query<{ id: string; state: string }>(
      "SELECT id, state FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(probe.rows).toHaveLength(1);
    const row = probe.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.id).toBe(SESSION_ID);
    expect(row.state).toBe("provisioning");
  });

  it("readSession round-trips the persisted snapshot", async () => {
    // The wire contract for SessionRead is the read-side proof of
    // persistence. P1 covers the write side; the round-trip here is the
    // smallest assertion that the persistence is queryable through the
    // service surface (not just by the test's direct SQL probe).
    //
    // Both `config` and `metadata` are exercised so a future regression
    // that swaps the JSONB hydration order (config <-> metadata) surfaces
    // here as well as in P2 — the read-side proof should mirror the
    // read surface across both fields.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [OWNER_PARTICIPANT_ID]);
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
      config: { greeting: "hello" },
      metadata: { tag: "round-trip" },
    });

    const read = await ctx.service.readSession(SESSION_ID);
    expect(read).not.toBeNull();
    if (read === null) return;
    expect(read.session.id).toBe(SESSION_ID);
    expect(read.session.state).toBe("provisioning");
    expect(read.session.config).toEqual({ greeting: "hello" });
    expect(read.session.metadata).toEqual({ tag: "round-trip" });
    // ISO 8601 with offset per `SessionSnapshotSchema.createdAt` —
    // `.toISOString()` always emits a `Z`-suffixed UTC timestamp.
    expect(read.session.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(read.session.updatedAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // The placeholder cursor is intentionally NOT asserted on its
    // contents — see `SessionDirectoryService.readSession` docstring;
    // the SDK layer (PR #5) overrides this with a real cursor.
    expect(read.timelineCursors.latest).toBeDefined();
  });

  it("readSession returns null for an unknown session id", async () => {
    const read = await ctx.service.readSession(SESSION_ID);
    expect(read).toBeNull();
  });

  it("createSession is atomic — a missing-participant FK violation leaves no orphan session row", async () => {
    // B2 atomicity guard: the session upsert and owner-membership upsert
    // run inside a single `Querier.transaction(...)` block, so a failure
    // on the membership upsert (FK violation against a participant id
    // that does not exist, or any transient error) MUST roll back the
    // session row.
    //
    // Without the transaction wrapper, the session row would commit
    // before the membership upsert ran, leaving an orphan visible to
    // `readSession` and admin queries. A retry would treat the orphan
    // as canonical state via the idempotent upsert and re-fail on the
    // membership step — cementing the corruption.
    const before = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions",
    );
    const beforeRow = before.rows[0];
    expect(beforeRow).toBeDefined();
    if (beforeRow === undefined) return;
    expect(Number.parseInt(beforeRow.count, 10)).toBe(0);

    // Note: OWNER_PARTICIPANT_ID is intentionally NOT inserted — the
    // membership upsert's FK against `participants(id)` will throw.
    await expect(
      ctx.service.createSession({
        sessionId: SESSION_ID,
        ownerParticipantId: OWNER_PARTICIPANT_ID,
      }),
    ).rejects.toThrow();

    const after = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    const afterRow = after.rows[0];
    expect(afterRow).toBeDefined();
    if (afterRow === undefined) return;
    expect(Number.parseInt(afterRow.count, 10)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// P2 — Second SessionCreate by same client does not silently fork
// ----------------------------------------------------------------------------

describe("SessionDirectoryService — P2 (idempotent re-create does not fork)", () => {
  it("a second createSession with the same sessionId returns the same row, not a new one", async () => {
    // BL-069: idempotent upsert via `ON CONFLICT (id) DO UPDATE SET
    // updated_at = sessions.updated_at RETURNING *`. A retry-after-crash
    // (network blip mid-create, daemon restart between request send and
    // ack) MUST yield the same row, not a sibling.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [OWNER_PARTICIPANT_ID]);

    const first = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
      config: { phase: "first" },
      metadata: { phase: "first" },
    });
    const firstOwnerMembership = first.memberships[0];
    expect(firstOwnerMembership).toBeDefined();
    if (firstOwnerMembership === undefined) return;
    const firstMembershipId: MembershipId = firstOwnerMembership.id;

    // Second call: same sessionId, same owner. Different config/metadata
    // payloads to prove the upsert does NOT clobber the original — a
    // `DO UPDATE SET config = EXCLUDED.config` regression would lose the
    // first-call's payload.
    const second = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
      config: { phase: "second" },
      metadata: { phase: "second" },
    });
    const secondOwnerMembership = second.memberships[0];
    expect(secondOwnerMembership).toBeDefined();
    if (secondOwnerMembership === undefined) return;
    const secondMembershipId: MembershipId = secondOwnerMembership.id;

    // The session id is preserved (no forked row).
    expect(second.sessionId).toBe(SESSION_ID);
    expect(second.sessionId).toBe(first.sessionId);
    // Membership id is preserved (no forked owner-membership row).
    expect(secondMembershipId).toBe(firstMembershipId);

    // Direct row probe: exactly ONE sessions row, exactly ONE
    // session_memberships row. The schema's UNIQUE(session_id,
    // participant_id) on session_memberships is the load-bearing seam
    // for the membership uniqueness; the upsert pattern is what protects
    // the SESSIONS uniqueness on retry.
    const sessionsCount = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    const sessionsRow = sessionsCount.rows[0];
    expect(sessionsRow).toBeDefined();
    if (sessionsRow === undefined) return;
    expect(Number.parseInt(sessionsRow.count, 10)).toBe(1);

    const membershipsCount = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_memberships WHERE session_id = $1",
      [SESSION_ID],
    );
    const membershipsRow = membershipsCount.rows[0];
    expect(membershipsRow).toBeDefined();
    if (membershipsRow === undefined) return;
    expect(Number.parseInt(membershipsRow.count, 10)).toBe(1);

    // Verify the original config/metadata survived (the upsert is a
    // no-op on the data columns, by design — see service docstring).
    const persistedRow = await ctx.querier.query<{
      config: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>("SELECT config, metadata FROM sessions WHERE id = $1", [SESSION_ID]);
    const persisted = persistedRow.rows[0];
    expect(persisted).toBeDefined();
    if (persisted === undefined) return;
    expect(persisted.config).toEqual({ phase: "first" });
    expect(persisted.metadata).toEqual({ phase: "first" });
  });

  it("two distinct sessionIds from the same owner produce two distinct rows", async () => {
    // The "same client" P2 invariant is keyed by sessionId, NOT by owner.
    // Two distinct sessionIds from the same daemon MUST land as two rows —
    // that's the normal multi-session case, not a fork. This test pins
    // the boundary so a future regression that keys idempotency on
    // owner instead of sessionId surfaces immediately.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [OWNER_PARTICIPANT_ID]);

    const a = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });
    const b = await ctx.service.createSession({
      sessionId: SECOND_SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });

    expect(a.sessionId).not.toBe(b.sessionId);
    const sessionsCount = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions",
    );
    const sessionsRow = sessionsCount.rows[0];
    expect(sessionsRow).toBeDefined();
    if (sessionsRow === undefined) return;
    expect(Number.parseInt(sessionsRow.count, 10)).toBe(2);
  });

  it("createSession with an existing sessionId but a different owner is rejected (Codex P1)", async () => {
    // Codex P1 / R2: the owner-mismatch guard inside `createSession`'s
    // transaction. BL-069 invariant #4 — "owner identity is bound at the
    // first authenticated RPC via PASETO v4 trust-on-first-use" — means a
    // second create with the same `sessionId` but a DIFFERENT
    // `ownerParticipantId` is NOT a retry; it is an attempt to bind a
    // second owner. Without the guard, the membership upsert's
    // UNIQUE(session_id, participant_id) target — which keys on the
    // (session, participant) PAIR, not on the role — silently inserts a
    // second `(S, P2, 'owner')` row, granting P2 owner privileges
    // without invitation/elevation. R1 dropped the auto-mint participant
    // (B1) which closed the most-likely path; the residual gap (an
    // explicit caller passing a mismatched ownerParticipantId) survived
    // until Codex caught it. This test pins the residual.
    //
    // Plan-002 owns ownership-transfer / co-owner promotion flows; that
    // is NOT a regression target for this test — the guard fires at
    // create time only.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1), ($2)", [
      OWNER_PARTICIPANT_ID,
      SECOND_PARTICIPANT_ID,
    ]);

    // First create: P1 binds owner.
    const first = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });
    const firstOwnerMembership = first.memberships[0];
    expect(firstOwnerMembership).toBeDefined();
    if (firstOwnerMembership === undefined) return;
    expect(firstOwnerMembership.participantId).toBe(OWNER_PARTICIPANT_ID);

    // Second create: same sessionId, DIFFERENT participant. MUST throw.
    // The error message includes the sessionId so an operator reading
    // the log can correlate the rejection to the offending request.
    await expect(
      ctx.service.createSession({
        sessionId: SESSION_ID,
        ownerParticipantId: SECOND_PARTICIPANT_ID,
      }),
    ).rejects.toThrow(SESSION_ID);

    // Direct row probe: the failed second create MUST NOT have inserted
    // a second owner-membership row, AND the original P1 owner row
    // MUST be intact. A regression that loses the guard would surface
    // here as count = 2 with (P1, P2) participants. The transaction
    // wrapper guarantees the failed call leaves no residue regardless
    // of when in the body the throw fires.
    const probe = await ctx.querier.query<{ participant_id: string; role: string }>(
      `SELECT participant_id, role FROM session_memberships
        WHERE session_id = $1 ORDER BY participant_id`,
      [SESSION_ID],
    );
    expect(probe.rows).toHaveLength(1);
    const persistedOwner = probe.rows[0];
    expect(persistedOwner).toBeDefined();
    if (persistedOwner === undefined) return;
    expect(persistedOwner.participant_id).toBe(OWNER_PARTICIPANT_ID);
    expect(persistedOwner.role).toBe("owner");

    // Same-owner retry must still be idempotent — the guard does NOT
    // turn into a "first-create-only" gate. A third call with the
    // ORIGINAL owner returns the same response shape and leaves the
    // row count unchanged.
    const retry = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });
    const retryOwnerMembership = retry.memberships[0];
    expect(retryOwnerMembership).toBeDefined();
    if (retryOwnerMembership === undefined) return;
    expect(retryOwnerMembership.id).toBe(firstOwnerMembership.id);

    const probeAfterRetry = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_memberships WHERE session_id = $1",
      [SESSION_ID],
    );
    const probeAfterRetryRow = probeAfterRetry.rows[0];
    expect(probeAfterRetryRow).toBeDefined();
    if (probeAfterRetryRow === undefined) return;
    expect(Number.parseInt(probeAfterRetryRow.count, 10)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// P3 — SessionJoin verifies membership and returns canonical id on rejoin
// ----------------------------------------------------------------------------
//
// IMPORTANT: the plan body's "returns existing timeline cursor" phrasing
// resolves to membership-reuse only in PR #4 — see the file-level header
// for the contract-shape rationale. The cursor is composed at the SDK
// layer (PR #5) by calling SessionRead after SessionJoin.

describe("SessionDirectoryService — P3 (join is idempotent on canonical membership)", () => {
  it("first join inserts a membership; second join returns the same membership id", async () => {
    // Setup: owner already exists, session already exists. The joiner is
    // a different participant joining for the first time.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1), ($2)", [
      OWNER_PARTICIPANT_ID,
      SECOND_PARTICIPANT_ID,
    ]);
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });

    const joinInput: JoinSessionInput = {
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "collaborator",
    };

    const firstJoin = await ctx.service.joinSession(joinInput);
    expect(firstJoin).not.toBeNull();
    if (firstJoin === null) return;
    expect(firstJoin.sessionId).toBe(SESSION_ID);
    expect(firstJoin.participantId).toBe(SECOND_PARTICIPANT_ID);
    const firstMembershipId: MembershipId = firstJoin.membershipId;

    // The wire contract publishes `sharedMetadata` as the session's
    // metadata column; we created the session with `{}` defaults so the
    // payload is the empty object.
    expect(firstJoin.sharedMetadata).toEqual({});

    // Re-join: same sessionId + same participantId. AC5 invariant —
    // membership id is canonical, no fork.
    const secondJoin = await ctx.service.joinSession(joinInput);
    expect(secondJoin).not.toBeNull();
    if (secondJoin === null) return;
    expect(secondJoin.membershipId).toBe(firstMembershipId);

    // Direct probe: exactly TWO membership rows for this session
    // (owner + the rejoining collaborator). A regression that lost the
    // UNIQUE(session_id, participant_id) constraint or used `INSERT`
    // without `ON CONFLICT` would surface here as 3 rows.
    const probe = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_memberships WHERE session_id = $1",
      [SESSION_ID],
    );
    const probeRow = probe.rows[0];
    expect(probeRow).toBeDefined();
    if (probeRow === undefined) return;
    expect(Number.parseInt(probeRow.count, 10)).toBe(2);
  });

  it("joinSession returns null for an unknown session id", async () => {
    // Setup the participant so the joinSession call fails on the SESSION
    // probe, not on a membership FK constraint.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [SECOND_PARTICIPANT_ID]);
    const result = await ctx.service.joinSession({
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
    });
    expect(result).toBeNull();
  });

  it("joinSession preserves an existing suspended membership row on rejoin", async () => {
    // joinSession is NOT a reactivation primitive — see service docstring.
    // The upsert preserves both `role` and `state` on conflict so a
    // future Plan-002 reviewer reading the call site cannot mistake it
    // for a safe re-activation path. This test pins the preserve-on-
    // conflict behavior explicitly so a regression that swaps the upsert
    // to `DO UPDATE SET role = EXCLUDED.role, state = 'active'` surfaces
    // immediately as a failed assertion.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1), ($2)", [
      OWNER_PARTICIPANT_ID,
      SECOND_PARTICIPANT_ID,
    ]);
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });

    // Step 1: first join as `collaborator` — the upsert inserts a fresh
    // row in state `active`.
    const firstJoin = await ctx.service.joinSession({
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "collaborator",
    });
    expect(firstJoin).not.toBeNull();
    if (firstJoin === null) return;
    const firstMembershipId: MembershipId = firstJoin.membershipId;

    // Step 2: out-of-band lifecycle transition (Plan-002's territory in
    // the real system; we simulate it here with a direct UPDATE so the
    // test does not depend on Plan-002 having landed). Move the row to
    // `suspended`.
    await ctx.querier.query("UPDATE session_memberships SET state = 'suspended' WHERE id = $1", [
      firstMembershipId,
    ]);

    // Step 3: re-join with a different role (`viewer`). The upsert
    // collides on UNIQUE(session_id, participant_id) and the conflict
    // clause touches only `updated_at` — the role argument is ignored,
    // and the suspended state is preserved.
    const secondJoin = await ctx.service.joinSession({
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "viewer",
    });
    expect(secondJoin).not.toBeNull();
    if (secondJoin === null) return;
    expect(secondJoin.membershipId).toBe(firstMembershipId);

    // Direct probe: row state is unchanged. A regression that
    // reactivated on join would surface as `state = 'active'` and/or
    // `role = 'viewer'` here.
    const probe = await ctx.querier.query<{ role: string; state: string }>(
      "SELECT role, state FROM session_memberships WHERE id = $1",
      [firstMembershipId],
    );
    const probeRow = probe.rows[0];
    expect(probeRow).toBeDefined();
    if (probeRow === undefined) return;
    expect(probeRow.role).toBe("collaborator");
    expect(probeRow.state).toBe("suspended");
  });
});

// ----------------------------------------------------------------------------
// Migration-runner idempotency
// ----------------------------------------------------------------------------
//
// Parity coverage with `packages/runtime-daemon/src/session/__tests__/
// session-service.test.ts` (the `applyMigrations is idempotent ...` block).
// Postgres has a different concurrency model (no analogue to SQLite's
// writer-vs-writer SQLITE_BUSY race) so this section is intentionally
// narrower than the runtime-daemon coverage; see the migration-runner
// header for the cross-process race-test rationale.

describe("applyMigrations — idempotency", () => {
  it("re-running applyMigrations on a migrated database is a no-op", async () => {
    // beforeEach already ran applyMigrations once. Re-running it MUST NOT
    // throw and MUST NOT duplicate the schema_migrations row. A
    // regression that bypassed the `hasMigrationApplied` short-circuit
    // would surface as a `42P07 relation already exists` error.
    await applyMigrations(ctx.querier);
    await applyMigrations(ctx.querier);
    const probe = await ctx.querier.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(probe.rows).toEqual([{ version: 1 }]);
  });

  it("CHECK constraint rejects an unknown session state at INSERT time", async () => {
    // The schema column `sessions.state` has CHECK(state IN ('provisioning',
    // 'active', 'archived', 'closed', 'purge_requested', 'purged')). PGlite
    // is a real Postgres build (compiled to WASM) and enforces CHECK
    // constraints natively — this test exists to prove the test substrate
    // is faithful to the production substrate's constraint enforcement.
    // A regression to a substrate that DROPS CHECKs (e.g. a hypothetical
    // pg-mem swap) would surface here.
    await expect(
      ctx.querier.query("INSERT INTO sessions (id, state) VALUES ($1, $2)", [
        SESSION_ID,
        "not_a_real_state",
      ]),
    ).rejects.toThrow();
  });
});
