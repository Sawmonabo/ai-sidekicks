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
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MembershipId,
  MembershipRole,
  ParticipantId,
  SessionId,
} from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../migration-runner.js";
import {
  SessionDirectoryService,
  createPgPoolQuerier,
  createSessionDirectoryServiceFromPool,
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
// Logging-proxy adapter (Codex R4)
// ----------------------------------------------------------------------------
//
// `wrapWithLog` returns a `Querier` that captures every SQL statement issued
// — including queries inside `transaction(...)` callbacks. The recursive
// composition (the `tx` passed to the user callback is itself a logging
// proxy) is load-bearing: without it the captured array would only see
// outer-Querier queries and miss every in-transaction query, including the
// `SELECT ... FOR UPDATE` whose position we want to assert.
//
// Each capture entry is tagged with a `querierId` so callers can discriminate
// WHICH Querier instance issued each statement (outer vs in-tx). The
// `transaction(fn)` impl re-wraps the inner `tx` with a fresh tx-scoped id
// (`${querierId}.tx-${n}`), so a regression that routes an in-tx statement
// (e.g. `FOR UPDATE`) through the outer `this.#querier` instead of the
// `tx` inside the transaction callback shows up as a wrong querierId on
// that entry. Under pg.Pool semantics this distinction is load-bearing:
// the outer Querier would check out a DIFFERENT pool client than the
// transaction's held client, and the lock would land on the wrong
// connection — failing to serialize concurrent createSession calls.
//
// `exec` is forwarded through the underlying querier without capture
// because no test currently asserts on the exec stream and the migration
// runner is the only `exec()` caller in PR #4. If a future test needs to
// assert on multi-statement batches, extend the proxy to push `exec`
// payloads as a sentinel entry.
interface CapturedQuery {
  readonly querierId: string;
  readonly sql: string;
}

let txCounter = 0;

function wrapWithLog(inner: Querier, captured: CapturedQuery[], querierId: string): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      captured.push({ querierId, sql });
      return inner.query<T>(sql, params);
    },
    exec: async (sql: string): Promise<void> => {
      // Not captured — see helper docstring. Forwarded unchanged.
      await inner.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      // Re-wrap the inner `tx` with the same logging proxy so in-tx
      // queries land in the same `captured` array. Without this the
      // FOR UPDATE inside `createSession`'s transaction callback would
      // never appear in the capture stream.
      //
      // The tx-scoped querierId is derived from the outer id with a
      // monotonic suffix so:
      //   (a) it is GUARANTEED distinct from the outer id (load-bearing
      //       for the R4 discriminator assertion);
      //   (b) the `${querierId}.tx-` prefix is grep-friendly for tests
      //       that want to assert "this came from inside a transaction";
      //   (c) the counter ticks across all wrapWithLog instances — fine
      //       because no test asserts on the exact suffix value, only on
      //       the prefix / non-equality with the outer id.
      const txId = `${querierId}.tx-${++txCounter}`;
      return inner.transaction((tx) => fn(wrapWithLog(tx, captured, txId)));
    },
  };
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

  // --------------------------------------------------------------------------
  // Codex R4 — explicit row lock between session upsert and owner probe
  // --------------------------------------------------------------------------
  //
  // Test strategy choice (documented per orchestrator's instructions):
  //
  //   We pin the lock-acquisition behavior with a logging proxy that
  //   captures the SQL stream issued during `createSession` and asserts
  //   that a `SELECT ... FOR UPDATE` appears in the right position
  //   relative to the session upsert, the owner-mismatch probe, and the
  //   owner-membership upsert. Removing the explicit lock from the
  //   service body makes this test fail; reordering the lock to a
  //   semantically wrong position (before the upsert, after the probe)
  //   also fails.
  //
  // Why we do NOT add a true concurrency test:
  //
  //   PGlite is in-process, single-connection-per-instance, and
  //   serializes statements at the driver boundary. There is no way to
  //   simulate two genuinely concurrent transactions on the same
  //   sessionId without a multi-connection harness. Production wiring
  //   (Plan-001 PR #5) composes a `Querier` from `pg.Pool` against a
  //   real Postgres instance — that PR can host a true concurrency
  //   test if the team decides one is needed beyond the lock-presence
  //   regression check pinned here.
  //
  // Why we do NOT add a defensive direct-tx "manually lock then probe"
  // test (orchestrator's option #3):
  //
  //   That path is already covered by the existing R3 test
  //   "createSession with an existing sessionId but a different owner is
  //   rejected (Codex P1)" — it exercises the application-layer probe
  //   via two sequential service calls. A second probe-test does not
  //   pin the FOR UPDATE; only the logging proxy does.
  it("createSession acquires SELECT FOR UPDATE on the sessions row before the owner probe (Codex R4)", async () => {
    // BL-069 §4 + the R3 owner-mismatch guard close the create-time TOFU
    // invariant for sequential callers; R4 closes the residual where two
    // concurrent createSession calls under READ COMMITTED can both read
    // an empty owner set in their respective snapshots and both INSERT
    // an `(S, *, 'owner')` row (UNIQUE(session_id, participant_id) does
    // not collide on different participants). The fix: an explicit
    // `SELECT id FROM sessions WHERE id = $1 FOR UPDATE` between the
    // session upsert and the owner-mismatch probe. This test pins the
    // lock-acquisition position so a future refactor that removes or
    // misplaces the lock surfaces here.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [OWNER_PARTICIPANT_ID]);

    // Wrap the test querier in a logging proxy that captures every SQL
    // statement issued — including queries inside `transaction(...)`
    // (the recursive wrapping mirrors `wrap()` above so in-tx queries are
    // captured, not just outer-Querier queries). Each capture entry is
    // tagged with a `querierId` so the assertions below can discriminate
    // outer-Querier statements from in-tx-Querier statements — see the
    // "wrong-Querier regression" block at the bottom for why that
    // discrimination is the load-bearing piece under pg.Pool (T5.5).
    const OUTER_ID = "outer";
    const captured: CapturedQuery[] = [];
    const loggingQuerier: Querier = wrapWithLog(ctx.querier, captured, OUTER_ID);
    const service = new SessionDirectoryService(loggingQuerier);

    await service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });

    // The four load-bearing statements inside `createSession`'s
    // transaction, identified by stable SQL fragments:
    //   1. session upsert        — `INSERT INTO sessions ... ON CONFLICT (id)`
    //   2. row lock              — `FROM sessions WHERE id = $1 FOR UPDATE`
    //   3. owner-mismatch probe  — `FROM session_memberships ... role = 'owner'`
    //   4. owner-membership ups. — `INSERT INTO session_memberships`
    //
    // Whitespace-tolerant patterns (vitest's `toMatch` accepts RegExp).
    // `\b` after a table name is defensive: without it, regex 1 would
    // substring-match `INSERT INTO sessions_archive ... ON CONFLICT (id)`
    // (the `[\s\S]*` between table name and conflict target swallows the
    // suffix). Same gap applies to regexes 3 and 4 — `session_memberships`
    // is a prefix of a hypothetical `session_memberships_history`. Regexes
    // requiring `\s+` immediately after the table name (the FOR UPDATE
    // probe and its count-check at the bottom) are already safe because
    // an underscore-suffix would not satisfy the whitespace assertion.
    const sessionUpsertIdx = captured.findIndex((entry) =>
      /INSERT\s+INTO\s+sessions\b[\s\S]*ON\s+CONFLICT\s*\(\s*id\s*\)/i.test(entry.sql),
    );
    const forUpdateIdx = captured.findIndex((entry) =>
      /FROM\s+sessions\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(entry.sql),
    );
    const ownerProbeIdx = captured.findIndex((entry) =>
      /FROM\s+session_memberships\b[\s\S]*role\s*=\s*'owner'/i.test(entry.sql),
    );
    const membershipUpsertIdx = captured.findIndex((entry) =>
      /INSERT\s+INTO\s+session_memberships\b/i.test(entry.sql),
    );

    // All four statements MUST be present.
    expect(sessionUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(forUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(ownerProbeIdx).toBeGreaterThanOrEqual(0);
    expect(membershipUpsertIdx).toBeGreaterThanOrEqual(0);

    // Ordering: upsert -> FOR UPDATE -> owner probe -> membership upsert.
    // The lock MUST come AFTER the upsert so the row exists for
    // FOR UPDATE to grip; it MUST come BEFORE the owner-mismatch probe
    // so the probe runs under the lock; the membership upsert is the
    // tail of the transaction.
    expect(sessionUpsertIdx).toBeLessThan(forUpdateIdx);
    expect(forUpdateIdx).toBeLessThan(ownerProbeIdx);
    expect(ownerProbeIdx).toBeLessThan(membershipUpsertIdx);

    // Also assert that exactly one FOR UPDATE was issued — guards
    // against a future regression that lifts the lock to the outer
    // Querier (where it would lock the wrong connection / no connection
    // at all under pg.Pool semantics) or that issues it twice.
    const forUpdateCount = captured.filter((entry) =>
      /FROM\s+sessions\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(entry.sql),
    ).length;
    expect(forUpdateCount).toBe(1);

    // ----- Wrong-Querier regression discriminator (Plan-001 T5.6) -----
    //
    // Each of the four load-bearing statements MUST have been issued
    // through the in-tx Querier (the `tx` passed to the `transaction(fn)`
    // callback), NOT through the outer `this.#querier`. The wrapWithLog
    // proxy assigns the outer Querier `querierId = "outer"` and re-wraps
    // the in-tx Querier with a fresh `"outer.tx-<n>"` id, so the load-
    // bearing assertion is `entry.querierId !== OUTER_ID`.
    //
    // Why this matters under pg.Pool (T5.5): the outer Querier checks
    // out a one-shot connection from the pool per call; the
    // `transaction(fn)` Querier holds a SPECIFIC client across BEGIN /
    // inner statements / COMMIT. A regression that routes any of these
    // statements through `this.#querier` instead of the in-tx `tx` —
    // most dangerously the `FOR UPDATE` — would lock a row on a
    // DIFFERENT pool client than the one running the transaction, and
    // the lock would release on that side-client's return-to-pool
    // instead of being held across the transaction's commit. Concurrent
    // createSession calls would no longer serialize on the row lock.
    //
    // The pre-T5.6 assertions (presence + ordering + count) could not
    // discriminate this case because the captured array was a flat
    // string stream with no provenance. The tagged shape closes that
    // residual.
    const sessionUpsertEntry = captured[sessionUpsertIdx];
    const forUpdateEntry = captured[forUpdateIdx];
    const ownerProbeEntry = captured[ownerProbeIdx];
    const membershipUpsertEntry = captured[membershipUpsertIdx];
    expect(sessionUpsertEntry).toBeDefined();
    expect(forUpdateEntry).toBeDefined();
    expect(ownerProbeEntry).toBeDefined();
    expect(membershipUpsertEntry).toBeDefined();
    if (
      sessionUpsertEntry === undefined ||
      forUpdateEntry === undefined ||
      ownerProbeEntry === undefined ||
      membershipUpsertEntry === undefined
    ) {
      return;
    }
    // The FOR UPDATE is the most safety-critical of the four; it is the
    // direct manifestation of I-001-1 (lock-ordering: sessions →
    // session_memberships). Calling it out by name keeps the failure
    // message diagnostic-friendly under regression.
    expect(forUpdateEntry.querierId).not.toBe(OUTER_ID);
    expect(forUpdateEntry.querierId).toMatch(/^outer\.tx-\d+$/);
    // The remaining three transaction statements must ALSO run through
    // the in-tx Querier — they share the transaction's atomicity and
    // would suffer the same pool-checkout split-brain if any were
    // routed through the outer Querier.
    expect(sessionUpsertEntry.querierId).not.toBe(OUTER_ID);
    expect(ownerProbeEntry.querierId).not.toBe(OUTER_ID);
    expect(membershipUpsertEntry.querierId).not.toBe(OUTER_ID);
    // All four statements must come from the SAME in-tx Querier
    // (createSession only opens one transaction; emission across two
    // distinct tx-scoped ids would mean either a nested or a sibling
    // transaction was introduced, both of which would break the
    // single-COMMIT atomicity guarantee asserted elsewhere).
    expect(sessionUpsertEntry.querierId).toBe(forUpdateEntry.querierId);
    expect(ownerProbeEntry.querierId).toBe(forUpdateEntry.querierId);
    expect(membershipUpsertEntry.querierId).toBe(forUpdateEntry.querierId);

    // Final correctness check: exactly one owner-membership row exists
    // (the lock did not perturb the canonical write path).
    const probe = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_memberships WHERE session_id = $1",
      [SESSION_ID],
    );
    const probeRow = probe.rows[0];
    expect(probeRow).toBeDefined();
    if (probeRow === undefined) return;
    expect(Number.parseInt(probeRow.count, 10)).toBe(1);
  });

  it("createSession with same logical owner but UPPERCASE UUID is idempotent (Codex P2 — UUID casing)", async () => {
    // Codex P2 / R5: the owner-mismatch guard added in R3 compared
    // `participant_id` against `input.ownerParticipantId` via strict
    // string equality. Postgres canonicalizes UUIDs to lowercase on
    // storage/return (RFC 9562 admits both cases as valid input), so a
    // caller that passes the same logical owner UUID with uppercase hex
    // digits on retry would falsely trip the "different owner" throw —
    // breaking BL-069's idempotent-upsert invariant for any caller whose
    // ParticipantId source happens to use uppercase. The fix normalizes
    // both sides via `.toLowerCase()` before equality. This test pins
    // the idempotency for the uppercase-retry path; a regression that
    // dropped the normalization would surface here as a thrown error
    // and a duplicate owner-membership row count > 1.
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1)", [OWNER_PARTICIPANT_ID]);

    // First create: owner UUID in canonical lowercase form (the
    // `OWNER_PARTICIPANT_ID` fixture is already lowercase).
    const first = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });
    const firstOwnerMembership = first.memberships[0];
    expect(firstOwnerMembership).toBeDefined();
    if (firstOwnerMembership === undefined) return;
    const firstMembershipId: MembershipId = firstOwnerMembership.id;

    // Second create: same sessionId + same logical owner UUID, but
    // UPPERCASED. RFC 9562 admits both cases; the brand has no runtime
    // case-validator. Without the .toLowerCase() normalization in the
    // owner-mismatch guard, this call throws.
    const uppercaseOwner: ParticipantId = OWNER_PARTICIPANT_ID.toUpperCase() as ParticipantId;
    await expect(
      ctx.service.createSession({
        sessionId: SESSION_ID,
        ownerParticipantId: uppercaseOwner,
      }),
    ).resolves.not.toThrow();

    // Direct row probe: exactly ONE owner-membership row, and the
    // original membership id is preserved. The `sessions` table is not
    // re-probed here for cardinality — the existing first P2 test
    // ("a second createSession with the same sessionId returns the same
    // row, not a new one") already pins `COUNT(*) FROM sessions = 1`
    // for the same-sessionId-retry path; UNIQUE PK on `sessions.id`
    // makes a duplicate row a structural impossibility, so re-asserting
    // it here would be noise.
    const membershipsProbe = await ctx.querier.query<{ id: string; participant_id: string }>(
      `SELECT id, participant_id FROM session_memberships
        WHERE session_id = $1 AND role = 'owner'`,
      [SESSION_ID],
    );
    expect(membershipsProbe.rows).toHaveLength(1);
    const persistedMembership = membershipsProbe.rows[0];
    expect(persistedMembership).toBeDefined();
    if (persistedMembership === undefined) return;
    expect(persistedMembership.id).toBe(firstMembershipId);
    // The persisted participant_id is canonical lowercase regardless of
    // which casing the caller used on either create call (Postgres
    // returns the storage form).
    expect(persistedMembership.participant_id).toBe(OWNER_PARTICIPANT_ID);
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

  it("joinSession rejects role: 'owner' (Codex P1 — privilege escalation)", async () => {
    // Codex P1 / R5: `joinSession` previously took
    // `role?: MembershipRole | undefined`, which includes `"owner"`.
    // BL-069 §4 binds owner identity at `createSession` time via TOFU,
    // and the membership upsert collides on UNIQUE(session_id,
    // participant_id) — keying on the (session, participant) PAIR, not
    // on the role. A new participant calling
    // `joinSession({ sessionId: S, participantId: P_new, role: "owner" })`
    // would silently INSERT a second `(S, P_new, 'owner')` row,
    // granting P_new owner privileges without invitation, elevation,
    // or promotion.
    //
    // The fix has two layers:
    //   1. Compile-time: `JoinSessionInput.role` narrows to
    //      `NonOwnerMembershipRole` (i.e. `MembershipRole` minus
    //      `"owner"`), rejecting TypeScript callers at type-check time.
    //   2. Runtime: a guard at the very top of `joinSession` throws
    //      with a typed error message that names BL-069 §4 and points
    //      to Plan-002 for the legitimate ownership-transfer path.
    //
    // This test exercises the runtime guard (layer 2). The cast through
    // `MembershipRole` bypasses the compile-time narrowing — that's
    // intentional, since the runtime guard is the SECOND defense and
    // must be exercised to verify it fires for dynamic / cross-language
    // callers that don't see the TypeScript types.
    //
    // Plan-002 owns ownership-transfer / co-owner promotion flows; this
    // test does not exercise those (they have their own promotion path,
    // not `joinSession`).
    await ctx.querier.query("INSERT INTO participants (id) VALUES ($1), ($2)", [
      OWNER_PARTICIPANT_ID,
      SECOND_PARTICIPANT_ID,
    ]);
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });

    // The cast is the load-bearing piece: `JoinSessionInput.role` is
    // `NonOwnerMembershipRole | undefined` at compile time, so we need
    // to widen back to `MembershipRole` to construct the privilege-
    // escalation payload. The runtime guard is what we're testing.
    const escalation = {
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "owner" as MembershipRole,
    } as JoinSessionInput;

    // Error message MUST name BL-069 §4 (so an operator reading the log
    // can correlate the rejection to the governing invariant) and MUST
    // point to Plan-002 (so the legitimate ownership-transfer path is
    // discoverable from the error). We assert on substrings rather than
    // the full message so future doc-link adjustments don't break the
    // test.
    await expect(ctx.service.joinSession(escalation)).rejects.toThrow(/BL-069/);
    await expect(ctx.service.joinSession(escalation)).rejects.toThrow(/Plan-002/);

    // Direct row probe: zero new owner-membership rows for the
    // attacking participant. The original P1 owner row stays intact
    // (count = 1 across all owners; participant_id = OWNER_PARTICIPANT_ID).
    // A regression that lost the runtime guard would surface here as
    // count = 2 with (P1, P2) participants both holding 'owner'.
    const ownerRows = await ctx.querier.query<{ participant_id: string }>(
      `SELECT participant_id FROM session_memberships
        WHERE session_id = $1 AND role = 'owner'
        ORDER BY participant_id`,
      [SESSION_ID],
    );
    expect(ownerRows.rows).toHaveLength(1);
    const ownerRow = ownerRows.rows[0];
    expect(ownerRow).toBeDefined();
    if (ownerRow === undefined) return;
    expect(ownerRow.participant_id).toBe(OWNER_PARTICIPANT_ID);

    // Defense in depth: SECOND_PARTICIPANT_ID has no membership row of
    // ANY role for this session — the guard fires before any row write.
    const escalatorRows = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_memberships WHERE session_id = $1 AND participant_id = $2",
      [SESSION_ID, SECOND_PARTICIPANT_ID],
    );
    const escalatorRow = escalatorRows.rows[0];
    expect(escalatorRow).toBeDefined();
    if (escalatorRow === undefined) return;
    expect(Number.parseInt(escalatorRow.count, 10)).toBe(0);
  });

  it("joinSession rejects role: 'owner' BEFORE the session-existence probe (Codex P1 — fail fast)", async () => {
    // The owner-rejection runtime guard fires BEFORE the
    // session-existence probe so a privilege-escalation attempt against
    // a NON-EXISTENT sessionId surfaces as the same throw a caller
    // against an existing session would see, rather than as `null`.
    // Otherwise a probe-then-throw ordering would leak existence
    // information AND let the attacker distinguish "session doesn't
    // exist" from "you're not allowed to do that". This test pins the
    // ordering — a regression that swapped the two would surface here
    // as a `null` return instead of a thrown error.
    //
    // No participant rows are seeded; the session also doesn't exist.
    // The throw must still fire on the role check first.
    const escalation = {
      sessionId: SESSION_ID, // never created
      participantId: SECOND_PARTICIPANT_ID,
      role: "owner" as MembershipRole,
    } as JoinSessionInput;

    // Both error-message substrings (`/BL-069/` and `/Plan-002/`) are
    // asserted here for parallelism with the first owner-rejection test
    // above — they share the same throw path, so a regression that
    // dropped either substring would surface here as well as in that
    // test.
    await expect(ctx.service.joinSession(escalation)).rejects.toThrow(/BL-069/);
    await expect(ctx.service.joinSession(escalation)).rejects.toThrow(/Plan-002/);
  });
});

// ----------------------------------------------------------------------------
// Migration-runner idempotency + concurrency safety
// ----------------------------------------------------------------------------
//
// Parity coverage with `packages/runtime-daemon/src/session/__tests__/
// session-service.test.ts` (the `applyMigrations is idempotent ...` block).
// Postgres has a different concurrency primitive than SQLite (advisory
// locks vs `BEGIN IMMEDIATE`) but the test surface mirrors the same two
// invariants: (a) re-running on a migrated DB is a no-op; (b) concurrent
// runners on a fresh DB serialize cleanly without `42P07 relation already
// exists`. The Codex-R8 concurrency test below covers (b); the existing
// "no-op" test covers (a).

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

  it("applyMigrations is concurrency-safe — concurrent calls on the same fresh database serialize via advisory lock (Codex R8)", async () => {
    // Codex R8 (P2): the prior runner observed "not applied" at the outer
    // probe, opened the transaction, and ran `CREATE TABLE participants`
    // unconditionally. Two concurrent racers under shared Postgres (rolling
    // deploys, multi-replica daemons) could both pass the unguarded outer
    // probe and both proceed into the transaction; the second would then
    // crash with `42P07 relation already exists`, surfacing the concurrent
    // boot as a startup failure rather than the idempotent no-op the API
    // contract promises.
    //
    // The fix is the canonical Postgres "lock-and-re-probe" pattern:
    // acquire `pg_advisory_xact_lock(MIGRATION_LOCK_ID)` inside the
    // transaction, re-probe under the lock, and only run the DDL if the
    // re-probe still misses. See `applyMigrations` docstring and file
    // header in `migration-runner.ts` for the full mechanism.
    //
    // Test substrate — what PGlite CAN and CANNOT model:
    //
    // PGlite IS genuinely concurrent at the JS event-queue level under
    // `Promise.all([apply, apply])`: the two outer probes interleave and
    // BOTH return `false` BEFORE either runner enters its transaction
    // (verified empirically by tracing — A's outer probe returns false,
    // B's outer probe returns false, THEN A enters the transaction). So
    // the outer-probe race that the lock-and-re-probe pattern defends
    // against IS exercised here, just like `pg.Pool` against shared
    // Postgres would exercise it.
    //
    // The only thing PGlite CANNOT model is multi-connection lock
    // contention at the database level: a real `pg.Pool` would have T2's
    // `pg_advisory_xact_lock` SQL BLOCK on T1's still-held lock at the
    // Postgres server. PGlite's single-connection-per-instance model
    // serializes the second transaction at the JS event-queue layer
    // (B's `tx.query("SELECT pg_advisory_xact_lock(...)")` queues
    // behind A's transaction completing) rather than at the lock level
    // — but the IN-TRANSACTION re-probe still sees A's committed
    // `schema_migrations` row and short-circuits, so the observable
    // outcome (no `42P07`, single migration row, lock SQL emitted) is
    // identical to the `pg.Pool` substrate.
    //
    // We pin two assertions against PGlite, both load-bearing here:
    //
    //   (a) End-state correctness — `Promise.all([apply, apply])` on a
    //       fresh DB resolves with no throw; the migration lands
    //       exactly once (`schema_migrations` row count = 1,
    //       `participants` table exists). This IS load-bearing on
    //       PGlite: empirically, the pre-R8 broken shape (no advisory
    //       lock around the transaction) DOES throw `relation
    //       "participants" already exists` on PGlite under
    //       `Promise.all`, because both outer probes race to false and
    //       both transactions execute the unguarded `CREATE TABLE`.
    //       Removing the lock would crash this assertion.
    //
    //   (b) Lock-query presence — the captured SQL stream MUST contain
    //       `pg_advisory_xact_lock(...)`. This is the explicit-emission
    //       guarantee — it would catch a regression that kept end-state
    //       correctness via some other mechanism (e.g., wrapping the
    //       DDL in `IF NOT EXISTS`) but silently dropped the
    //       cross-connection serialization that `pg.Pool` substrates
    //       require.
    //
    // Note on `wrapWithLog`: only `query()` is captured (see helper
    // docstring above); the migration DDL goes through `exec()` and is
    // NOT in the stream. The advisory lock goes through `query()` so it
    // IS in the stream — sufficient for assertion (b).
    //
    // We construct a fresh PGlite inside the test (rather than reusing
    // `ctx.pg`) because `beforeEach` already migrated `ctx.pg`; the
    // outer probe would short-circuit and the lock would never be
    // exercised.
    const pg = new PGlite();
    try {
      const captured: CapturedQuery[] = [];
      const querier = wrapWithLog(adaptPGlite(pg), captured, "migration");

      // Two concurrent calls. Both MUST resolve; neither MUST throw.
      await expect(
        Promise.all([applyMigrations(querier), applyMigrations(querier)]),
      ).resolves.toEqual([undefined, undefined]);

      // (a) End-state correctness: migration landed exactly once.
      const migrationsProbe = await pg.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(migrationsProbe.rows).toEqual([{ version: 1 }]);

      const participantsProbe = await pg.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'participants'
         ) AS exists`,
      );
      expect(participantsProbe.rows[0]?.exists).toBe(true);

      // (b) Lock-query presence: the runner that entered the transaction
      // issued the advisory lock. Assert "at least one" rather than
      // "exactly one" — empirically both outer probes race to false on
      // PGlite (see docstring), so both runners reach the in-transaction
      // lock SQL and the captured count is typically 2; but this is a
      // scheduler-timing detail. The load-bearing claim is that the lock
      // IS issued at least once, not how many times.
      const lockCount = captured.filter((entry) => /pg_advisory_xact_lock/i.test(entry.sql)).length;
      expect(lockCount).toBeGreaterThanOrEqual(1);
    } finally {
      await pg.close();
    }
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

// ----------------------------------------------------------------------------
// createPgPoolQuerier — pool-checkout-and-release path (Plan-001 T5.5)
// ----------------------------------------------------------------------------
//
// Phase 4 shipped `SessionDirectoryService` typed against `Querier`, with the
// PGlite-backed concretion exercised in the P1/P2/P3 blocks above. T5.5 lands
// the `pg.Pool`-backed concretion that production wiring will use; this
// describe block pins the adapter contract:
//
//   * `query()` and `exec()` route through `pool.query()` (one-shot
//     auto-checkout-and-release), NOT through `pool.connect()`. Using
//     `connect()` here would force the caller to manage release and leak
//     connections on caller-side throws.
//
//   * `transaction(fn)` checks out ONE client via `pool.connect()`, holds
//     it across BEGIN / inner statements / COMMIT, and releases on every
//     exit path. Without a held client, each inner statement would land on
//     a DIFFERENT pooled connection — BEGIN on one, the inner SQL on
//     others, COMMIT on yet another — and the transaction would dissolve
//     (advisory locks, FOR UPDATE row locks, server-side prepared
//     statements all rely on per-connection state).
//
//   * The inner `Querier` passed to `fn` routes ALL three methods through
//     the held client, not back through the pool. Recursive `transaction`
//     throws — Postgres has no native nested transactions without
//     SAVEPOINTs and Plan-001 has no SAVEPOINT requirement.
//
//   * `client.release()` runs in a `finally` so the connection returns to
//     the pool whether the path terminated in COMMIT success, application
//     error + ROLLBACK, COMMIT-time error, or ROLLBACK error itself. Pool
//     leaks under any sustained error rate without the `finally`.
//
//   * On error inside `fn`, the adapter issues `ROLLBACK` and re-raises
//     the underlying error. pg.Pool has no auto-rollback (unlike PGlite's
//     `pg.transaction(fn)`); without manual ROLLBACK, the client returns
//     to the pool in `25P02 current transaction is aborted` state and the
//     next checkout receives a poisoned client.
//
// Test substrate choice — hand-rolled mock pool, not pg-mem or real PG:
//
//   The behavioral correctness of the service SQL (the `createSession`
//   four-statement sequence, the join's two-statement sequence) is already
//   proven in the PGlite path above. T5.5's load-bearing claim is the
//   ADAPTER CONTRACT — that `transaction()` holds one connection across
//   BEGIN/COMMIT and releases on every exit, that `query()`/`exec()` route
//   through the pool's one-shot path, and that the in-transaction inner
//   Querier routes through the held client. Mock spies prove this directly
//   and precisely. A pg-mem swap would only PARTIALLY validate (pg-mem
//   doesn't implement `pg_advisory_xact_lock` faithfully), and a real
//   Postgres-in-CI substrate is out of scope for this PR (would require
//   CI workflow changes).
//
//   The Spec-001 AC1 / AC2 / AC4 assertions are routed through the same
//   mock substrate: the service body runs against `createPgPoolQuerier(
//   mockPool)`, and we assert the AC-load-bearing behavior at the
//   service-response shape level (one session id, one membership, COMMIT
//   issued before resolve, idempotent membership id on rejoin).
//
//   If a future PR needs deeper validation against a real Postgres — in
//   particular T5.6's lock-ordering strengthening — that PR adds the
//   substrate. T5.5 lands the composer and the adapter-contract tests.

// ----------------------------------------------------------------------------
// MockPool / MockPoolClient — canned-response substrate
// ----------------------------------------------------------------------------

interface MockPoolCall {
  readonly kind: "pool.query" | "client.query" | "client.release" | "pool.connect";
  // `sql` / `params` are present on `query` calls and absent on `connect` /
  // `release`. `exactOptionalPropertyTypes: true` (the repo's strict config)
  // distinguishes "key missing" from "key present with value `undefined`";
  // since the params array MAY be `undefined` at the Querier boundary
  // (caller omits params), we explicitly admit the union here rather than
  // relying on the implicit optional-as-`| undefined` widening.
  readonly sql?: string | undefined;
  readonly params?: ReadonlyArray<unknown> | undefined;
}

// A canned response can be either rows to return or an error to throw. Tests
// queue responses in service-issue order; the mock pool/client dequeues on
// each `query()` call. An empty queue signals an unexpected SQL statement —
// the assertion failure points the reader at the off-by-one issue.
type CannedResponse =
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<Record<string, unknown>> }
  | { readonly kind: "error"; readonly error: Error };

interface MockPool extends Pool {
  readonly _calls: MockPoolCall[];
  readonly _clients: MockPoolClient[];
  _connectImpl?: () => Promise<MockPoolClient> | MockPoolClient;
  _queryImpl?: CannedResponse[];
}

interface MockPoolClient extends PoolClient {
  readonly _calls: MockPoolCall[];
  _queryImpl?: CannedResponse[];
  _released: boolean;
}

function makeMockPool(): MockPool {
  const calls: MockPoolCall[] = [];
  const clients: MockPoolClient[] = [];
  // The `as unknown as MockPool` cast bypasses the `extends EventEmitter`
  // surface of `pg.Pool` — the adapter never touches the event API and the
  // tests assert on the routing/lifecycle methods only.
  const pool = {
    _calls: calls,
    _clients: clients,
    query: vi.fn(
      async <R extends QueryResultRow>(
        sql: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<QueryResult<R>> => {
        calls.push({ kind: "pool.query", sql, params });
        const response = pool._queryImpl?.shift();
        if (response === undefined) {
          throw new Error(
            `MockPool.query received unexpected statement (no canned response queued): ${sql}`,
          );
        }
        if (response.kind === "error") {
          throw response.error;
        }
        return {
          rows: response.rows as R[],
          command: "",
          rowCount: response.rows.length,
          oid: 0,
          fields: [],
        };
      },
    ),
    connect: vi.fn(async (): Promise<MockPoolClient> => {
      calls.push({ kind: "pool.connect" });
      if (pool._connectImpl !== undefined) {
        return await pool._connectImpl();
      }
      const client = makeMockPoolClient();
      clients.push(client);
      return client;
    }),
  } as unknown as MockPool;
  return pool;
}

function makeMockPoolClient(): MockPoolClient {
  const calls: MockPoolCall[] = [];
  // Same EventEmitter-surface bypass as MockPool — the adapter only touches
  // `query()` and `release()`. Default behavior: when `_queryImpl` is not
  // set, every query returns empty rows (the "I only care about routing /
  // lifecycle, not row contents" path). Tests that assert on specific
  // canned rows (the AC tests + the ROLLBACK / COMMIT failure tests) set
  // `_queryImpl` to a per-test FIFO queue.
  const client = {
    _calls: calls,
    _released: false,
    query: vi.fn(
      async <R extends QueryResultRow>(
        sql: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<QueryResult<R>> => {
        calls.push({ kind: "client.query", sql, params });
        if (client._queryImpl !== undefined) {
          const response = client._queryImpl.shift();
          if (response === undefined) {
            throw new Error(
              `MockPoolClient.query received unexpected statement (no canned response queued): ${sql}`,
            );
          }
          if (response.kind === "error") {
            throw response.error;
          }
          return {
            rows: response.rows as R[],
            command: "",
            rowCount: response.rows.length,
            oid: 0,
            fields: [],
          };
        }
        // No canned responses queued — return empty rows. The lifecycle /
        // routing assertions don't depend on row contents; queueing a
        // FIFO for every test would be ceremony without payoff.
        return {
          rows: [] as R[],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        };
      },
    ),
    release: vi.fn((): void => {
      calls.push({ kind: "client.release" });
      client._released = true;
    }),
  } as unknown as MockPoolClient;
  return client;
}

// Canonical canned-response sequences. Each helper builds the canned rows
// the service body will dequeue in order — the service's SQL stream for
// each method is deterministic, so the queue position is stable.

function cannedRowsForCreateSession(): CannedResponse[] {
  // The service issues, inside the transaction (after BEGIN):
  //   1. session upsert        -> 1 SessionRow
  //   2. SELECT ... FOR UPDATE -> 1 row (id only)
  //   3. owner-mismatch probe  -> 0 rows (no existing owner)
  //   4. membership upsert     -> 1 MembershipRow
  // Then COMMIT.
  return [
    {
      kind: "rows",
      rows: [
        {
          id: SESSION_ID,
          state: "provisioning",
          config: {},
          metadata: {},
          min_client_version: null,
          created_at: new Date("2026-05-09T00:00:00Z"),
          updated_at: new Date("2026-05-09T00:00:00Z"),
        },
      ],
    },
    { kind: "rows", rows: [{ id: SESSION_ID }] },
    { kind: "rows", rows: [] },
    {
      kind: "rows",
      rows: [
        {
          id: "01970000-0000-7000-8000-00000000c001",
          session_id: SESSION_ID,
          participant_id: OWNER_PARTICIPANT_ID,
          role: "owner",
          state: "active",
          joined_at: new Date("2026-05-09T00:00:00Z"),
          updated_at: new Date("2026-05-09T00:00:00Z"),
        },
      ],
    },
  ];
}

function cannedRowsForJoinSession(opts: {
  readonly participantId: ParticipantId;
  readonly membershipId: string;
}): CannedResponse[] {
  // The service issues, outside any transaction:
  //   1. session probe      -> 1 SessionRow
  //   2. membership upsert  -> 1 MembershipRow
  return [
    {
      kind: "rows",
      rows: [
        {
          id: SESSION_ID,
          state: "provisioning",
          config: {},
          metadata: {},
          min_client_version: null,
          created_at: new Date("2026-05-09T00:00:00Z"),
          updated_at: new Date("2026-05-09T00:00:00Z"),
        },
      ],
    },
    {
      kind: "rows",
      rows: [
        {
          id: opts.membershipId,
          session_id: SESSION_ID,
          participant_id: opts.participantId,
          role: "collaborator",
          state: "active",
          joined_at: new Date("2026-05-09T00:00:00Z"),
          updated_at: new Date("2026-05-09T00:00:00Z"),
        },
      ],
    },
  ];
}

describe("createPgPoolQuerier — pool-checkout-and-release path", () => {
  // --------------------------------------------------------------------------
  // Adapter-contract assertions
  // --------------------------------------------------------------------------
  //
  // Pure-mock tests on the adapter directly (no service body). These pin the
  // routing and lifecycle contract precisely — `query` lands on the pool's
  // one-shot path, `transaction` checks out + releases, inner SQL routes
  // through the held client, nested-transaction throws, ROLLBACK fires on
  // error.

  it("query() routes through pool.query() (one-shot auto-checkout) and not through pool.connect()", async () => {
    // The Querier#query contract is "issue a single statement and return
    // its rows". `pg.Pool#query()` internally connect()s + releases on each
    // call; using `pool.connect()` here would force the adapter to manage
    // release and leak connections on caller-side throws.
    const pool = makeMockPool();
    pool._queryImpl = [{ kind: "rows", rows: [{ count: "1" }] }];
    const querier = createPgPoolQuerier(pool);

    const result = await querier.query<{ count: string }>("SELECT 1 AS count", []);
    expect(result.rows).toEqual([{ count: "1" }]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool._clients).toHaveLength(0);
  });

  it("query() spreads ReadonlyArray params into a mutable array at the pg.Pool boundary", async () => {
    // pg's `query()` parameter array is typed as `unknown[]` (mutable). The
    // adapter spreads the ReadonlyArray to satisfy the mutability claim
    // without copying values. A regression that passed the ReadonlyArray
    // through unchanged would surface as a TS error on the next build, but
    // we pin the runtime shape here too so a future refactor that bypasses
    // the typecheck doesn't silently break parameter handling.
    const pool = makeMockPool();
    pool._queryImpl = [{ kind: "rows", rows: [] }];
    const querier = createPgPoolQuerier(pool);
    const params: ReadonlyArray<unknown> = Object.freeze(["alpha", 42]);

    await querier.query<unknown>("SELECT $1, $2", params);

    expect(pool.query).toHaveBeenCalledWith("SELECT $1, $2", ["alpha", 42]);
    // The captured params array MUST NOT be the frozen input array — that
    // would leak the immutability constraint into pg's serializer (which
    // expects to be free to mutate the array internally on bind).
    const captured = pool._calls.find((c) => c.kind === "pool.query")?.params;
    expect(captured).not.toBe(params);
    expect(Object.isFrozen(captured)).toBe(false);
  });

  it("exec() routes through pool.query(sql) with no params (simple query protocol)", async () => {
    // Querier#exec is the multi-statement-batch path (simple query protocol).
    // Without a values array, pg's Client#query() falls through to the simple
    // protocol which permits `BEGIN; ...; COMMIT;` style batches — what the
    // migration runner's INITIAL_MIGRATION_SQL body needs.
    const pool = makeMockPool();
    pool._queryImpl = [{ kind: "rows", rows: [] }];
    const querier = createPgPoolQuerier(pool);

    await querier.exec("CREATE TABLE t (id int); INSERT INTO t VALUES (1);");

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith("CREATE TABLE t (id int); INSERT INTO t VALUES (1);");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("transaction(fn) checks out ONE client, holds it across BEGIN/inner/COMMIT, and releases on commit", async () => {
    // The load-bearing claim: connection affinity across the transaction
    // boundary. Without a held client, each inner statement would land on
    // a DIFFERENT pooled connection — BEGIN on one, inner SQL on others,
    // COMMIT on yet another — dissolving the transaction. Advisory locks
    // (`pg_advisory_xact_lock`, used by the migration runner) and FOR
    // UPDATE row locks (used by `createSession`'s lock-ordering pattern)
    // would not survive across statements.
    const pool = makeMockPool();
    const querier = createPgPoolQuerier(pool);

    const result = await querier.transaction(async (tx) => {
      await tx.query("SELECT 1");
      await tx.query("SELECT 2", [42]);
      return "done";
    });

    expect(result).toBe("done");
    // Exactly ONE pool.connect() — held across BEGIN/inner/COMMIT.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    // No pool.query() — all inner statements landed on the held client.
    expect(pool.query).not.toHaveBeenCalled();
    // BEGIN -> inner -> inner -> COMMIT, all on the same client.
    const clientSql = client._calls.filter((c) => c.kind === "client.query").map((c) => c.sql);
    expect(clientSql).toEqual(["BEGIN", "SELECT 1", "SELECT 2", "COMMIT"]);
    // Release fires exactly once, AFTER COMMIT, in the `finally`.
    expect(client.release).toHaveBeenCalledTimes(1);
    const lastCall = client._calls[client._calls.length - 1];
    expect(lastCall?.kind).toBe("client.release");
  });

  it("transaction(fn) inner Querier routes ALL statements through the held client, not the pool", async () => {
    // The inner Querier passed to `fn` MUST route query() AND exec() through
    // the same held client. A regression that routed inner query() through
    // `pool.query()` (which checks out a different pooled client per call)
    // would leave the inner SQL running OUTSIDE the BEGIN/COMMIT span — the
    // transaction boundary would only enclose BEGIN and COMMIT themselves,
    // and any FOR UPDATE / advisory lock acquired by inner SQL would land
    // on the wrong connection. This is the central correctness concern
    // T5.6's lock-ordering test (next PR) discriminates more aggressively.
    const pool = makeMockPool();
    const querier = createPgPoolQuerier(pool);

    await querier.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [9000000001n]);
      await tx.exec("CREATE TEMP TABLE t (id int)");
      return undefined;
    });

    expect(pool.query).not.toHaveBeenCalled();
    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    const clientSql = client._calls.filter((c) => c.kind === "client.query").map((c) => c.sql);
    expect(clientSql).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock($1)",
      "CREATE TEMP TABLE t (id int)",
      "COMMIT",
    ]);
  });

  it("transaction(fn) inner Querier rejects nested transaction()", async () => {
    // Postgres has no native nested transactions without SAVEPOINTs and
    // Plan-001 has no SAVEPOINT requirement. The PGlite test adapter throws
    // on nested call (see `wrap()` at the top of this file); the pg.Pool
    // adapter matches — same failure mode across substrates.
    const pool = makeMockPool();
    const querier = createPgPoolQuerier(pool);

    await expect(
      querier.transaction(async (tx) => {
        await tx.transaction(async () => undefined);
      }),
    ).rejects.toThrow(/nested transactions are not supported/);

    // After the throw the outer transaction's catch block issues ROLLBACK
    // and the `finally` releases — defense in depth: a regression that
    // swallowed the nested-transaction throw would leave the connection
    // checked out with BEGIN outstanding. Pin the lifecycle here so that
    // failure mode surfaces too.
    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    expect(client.release).toHaveBeenCalledTimes(1);
    const clientSql = client._calls.filter((c) => c.kind === "client.query").map((c) => c.sql);
    // BEGIN issued, ROLLBACK issued (no COMMIT — fn threw), then release.
    expect(clientSql).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("transaction(fn) issues ROLLBACK on application error and re-raises the original error", async () => {
    // pg.Pool has no auto-rollback (unlike PGlite's `pg.transaction(fn)`).
    // Without manual ROLLBACK, an aborted transaction would stay open on
    // the client until release, the client would return to the pool in an
    // aborted state, and the next checkout would receive a client stuck in
    // `25P02 current transaction is aborted`. This test pins both the
    // ROLLBACK emission AND the original-error preservation.
    const pool = makeMockPool();
    const querier = createPgPoolQuerier(pool);
    const sentinel = new Error("application-level rejection");

    await expect(
      querier.transaction(async (tx) => {
        await tx.query("SELECT 1");
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);

    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    const clientSql = client._calls.filter((c) => c.kind === "client.query").map((c) => c.sql);
    // BEGIN -> inner -> ROLLBACK (no COMMIT — fn threw).
    expect(clientSql).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
    // Release fires in the outer `finally`, AFTER the ROLLBACK.
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("transaction(fn) re-raises the ORIGINAL error even if ROLLBACK itself throws (no masking)", async () => {
    // If ROLLBACK fails (e.g., the underlying connection was already
    // terminated), the caller still needs to see the ORIGINAL `fn` error
    // — that is what they need to diagnose. A regression that bubbled the
    // ROLLBACK error instead would mask the actual fault. The adapter's
    // inner try/catch around ROLLBACK is what defends against this.
    const pool = makeMockPool();
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      // First query is BEGIN (succeeds), second is the inner fn body
      // (succeeds), third is ROLLBACK (throws). Canned responses:
      client._queryImpl = [
        { kind: "rows", rows: [] }, // BEGIN
        { kind: "rows", rows: [] }, // inner
        { kind: "error", error: new Error("ROLLBACK failed at the wire") },
      ];
      return client;
    };
    const querier = createPgPoolQuerier(pool);
    const originalError = new Error("the error the caller actually wants");

    await expect(
      querier.transaction(async (tx) => {
        await tx.query("SELECT 1");
        throw originalError;
      }),
    ).rejects.toBe(originalError);

    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    // Release MUST still fire — the `finally` runs regardless of how the
    // ROLLBACK path terminated. Without this guarantee, a connection leak
    // accumulates under sustained error-then-rollback-failure rate.
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("transaction(fn) releases the client even when COMMIT itself throws", async () => {
    // Postgres can defer constraint violations until COMMIT (e.g., DEFERRED
    // constraints). On a COMMIT throw, the transaction has already been
    // rolled back server-side by Postgres — no follow-up ROLLBACK is
    // needed (one would itself error on a non-existent transaction). The
    // adapter just re-raises the COMMIT error. But the `finally` MUST
    // still release the client, or every deferred-constraint violation
    // would leak a connection.
    const pool = makeMockPool();
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      client._queryImpl = [
        { kind: "rows", rows: [] }, // BEGIN
        { kind: "rows", rows: [] }, // inner
        { kind: "error", error: new Error("deferred constraint violation at COMMIT") },
      ];
      return client;
    };
    const querier = createPgPoolQuerier(pool);

    await expect(
      querier.transaction(async (tx) => {
        await tx.query("SELECT 1");
        return undefined;
      }),
    ).rejects.toThrow(/deferred constraint violation/);

    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    const clientSql = client._calls.filter((c) => c.kind === "client.query").map((c) => c.sql);
    // BEGIN -> inner -> COMMIT (which threw). NO follow-up ROLLBACK —
    // Postgres has already rolled the transaction back server-side in
    // response to the failed COMMIT, and issuing ROLLBACK against a
    // non-existent transaction would itself error.
    expect(clientSql).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    // Release fires in `finally` — connection returns to pool.
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("transaction(fn) releases the client even when BEGIN itself throws", async () => {
    // BEGIN can fail at the wire level (lost connection, server restart).
    // The `finally` MUST release regardless — otherwise the connection
    // leaks. We do NOT issue ROLLBACK because no transaction was ever
    // opened.
    const pool = makeMockPool();
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      client._queryImpl = [{ kind: "error", error: new Error("BEGIN failed at the wire") }];
      return client;
    };
    const querier = createPgPoolQuerier(pool);

    await expect(
      querier.transaction(async () => {
        // Never reached — BEGIN threw before fn ran.
        return undefined;
      }),
    ).rejects.toThrow(/BEGIN failed/);

    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    // Release fires even though BEGIN threw before any inner statement.
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Spec-001 AC1 — createSession through pg.Pool yields stable shape
  // --------------------------------------------------------------------------

  it("Spec-001 AC1: createSession through the pg.Pool-backed Querier yields one stable session id, one owner membership, one default channel (empty)", async () => {
    // AC1 says "createSession yields one stable session id, one owner
    // membership, one default channel". The behavioral correctness of the
    // SQL itself is already proven in the PGlite path (P1 block above).
    // What T5.5 needs to prove is that the SAME service code, when run
    // against the pg.Pool-backed Querier, ROUTES through the right
    // substrate (the held client for the transaction) and produces the
    // contract-shape response. The control plane has no event log per
    // ADR-017, so `channels` is the empty array (the canonical "no channel
    // metadata here" signal); PR #5's SDK composition layer merges the
    // daemon's projected channels with this empty list to produce the
    // user-visible channel list.
    const pool = makeMockPool();
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      client._queryImpl = [
        { kind: "rows", rows: [] }, // BEGIN
        ...cannedRowsForCreateSession(),
        { kind: "rows", rows: [] }, // COMMIT
      ];
      return client;
    };
    const service = createSessionDirectoryServiceFromPool(pool);

    const response = await service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });

    // Contract-shape assertions: one stable id, one owner membership, one
    // default (empty) channels array. Mirrors the PGlite-path P1 assertion
    // surface — same response shape across both substrates.
    expect(response.sessionId).toBe(SESSION_ID);
    expect(response.state).toBe("provisioning");
    expect(response.memberships).toHaveLength(1);
    const ownerMembership = response.memberships[0];
    expect(ownerMembership).toBeDefined();
    if (ownerMembership === undefined) return;
    expect(ownerMembership.participantId).toBe(OWNER_PARTICIPANT_ID);
    expect(ownerMembership.role).toBe("owner");
    expect(ownerMembership.state).toBe("active");
    expect(response.channels).toEqual([]);

    // Routing assertions: createSession opened a transaction. All four
    // body statements MUST have landed on the held client, NOT on the
    // pool's one-shot path. The pool.query mock was never called.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Spec-001 AC2 — durability (COMMIT before resolve)
  // --------------------------------------------------------------------------

  it("Spec-001 AC2: COMMIT is awaited before the createSession promise resolves (session is committed before caller observes the response)", async () => {
    // AC2 says "session record is durable (committed) through the pg.Pool
    // transaction substrate before any caller observes the response".
    // The adapter contract guarantees this: `transaction(fn)` awaits
    // `client.query("COMMIT")` BEFORE returning the result. A regression
    // that issued COMMIT after the return — or fire-and-forgot the COMMIT
    // — would let the caller observe the response with the row still
    // sitting in the transaction's uncommitted snapshot; a concurrent
    // reader (or a crash before the deferred COMMIT lands) would lose
    // the row. This test pins the awaiting-COMMIT contract.
    let commitCompleted = false;
    // `commitResolvedAt` is written from inside the stamped `client.query`
    // mock below (asynchronously, during `COMMIT`); `let ... | undefined`
    // captures the "not-yet-written" state for the `expect(...).toBeDefined()`
    // assertion. `createResolvedAt` is captured synchronously after the
    // `await service.createSession(...)` completes; `const` is the right
    // declaration for a write-once value at outer scope.
    let commitResolvedAt: number | undefined;

    const pool = makeMockPool();
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      const cannedResponses: CannedResponse[] = [
        { kind: "rows", rows: [] }, // BEGIN
        ...cannedRowsForCreateSession(),
      ];
      // Replace the client.query mock with a per-call stamped variant so
      // we can pin the timestamp at which COMMIT resolved relative to the
      // outer createSession resolution. `pg.PoolClient#query` is an
      // overloaded surface (string + values, QueryConfig, QueryArrayConfig,
      // callbacks); the cast through `unknown` is the canonical narrowing
      // for a vitest mock that only needs to honor the string+values path
      // the adapter actually uses.
      const stampedQuery = vi.fn(
        async (
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Promise<QueryResult<Record<string, unknown>>> => {
          client._calls.push({ kind: "client.query", sql, params });
          if (sql === "COMMIT") {
            // The COMMIT path: await a microtask so any race between
            // COMMIT-await and the outer resolve surfaces — without
            // awaiting COMMIT, the outer resolve would land before this
            // microtask completes and `commitResolvedAt` would be unset
            // when `createResolvedAt` is captured.
            await Promise.resolve();
            commitCompleted = true;
            commitResolvedAt = performance.now();
            return {
              rows: [],
              command: "",
              rowCount: 0,
              oid: 0,
              fields: [],
            };
          }
          const response = cannedResponses.shift();
          if (response === undefined) {
            throw new Error(`Unexpected client.query: ${sql}`);
          }
          if (response.kind === "error") throw response.error;
          return {
            rows: response.rows as Record<string, unknown>[],
            command: "",
            rowCount: response.rows.length,
            oid: 0,
            fields: [],
          };
        },
      );
      client.query = stampedQuery as unknown as typeof client.query;
      return client;
    };
    const service = createSessionDirectoryServiceFromPool(pool);

    await service.createSession({
      sessionId: SESSION_ID,
      ownerParticipantId: OWNER_PARTICIPANT_ID,
    });
    const createResolvedAt = performance.now();

    // The load-bearing assertion: the caller observed the response AFTER
    // COMMIT had fully resolved. A regression that returned the result
    // before awaiting COMMIT would surface here as `commitCompleted ===
    // false` at this point (the COMMIT microtask would still be pending).
    expect(commitCompleted).toBe(true);
    expect(commitResolvedAt).toBeDefined();
    if (commitResolvedAt === undefined) return;
    expect(commitResolvedAt).toBeLessThanOrEqual(createResolvedAt);

    // Defense in depth: client.release fires after COMMIT, not after the
    // service body's response composition. The `finally` block runs
    // synchronously after COMMIT's await completes.
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    const clientCallKinds = client._calls.map((c) =>
      c.kind === "client.query" ? `query:${c.sql}` : c.kind,
    );
    // COMMIT immediately followed by release — no callback runs between.
    const commitIdx = clientCallKinds.indexOf("query:COMMIT");
    const releaseIdx = clientCallKinds.indexOf("client.release");
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBe(commitIdx + 1);
  });

  // --------------------------------------------------------------------------
  // Spec-001 AC4 — second joinSession returns same membership id
  // --------------------------------------------------------------------------

  it("Spec-001 AC4: a second joinSession through the pg.Pool-backed Querier returns the same membership id (canonical, no fork) via the pool's one-shot path", async () => {
    // AC4 says "second joinSession returns the same session id, existing
    // membership state, and existing event history". The current
    // `joinSession` implementation does NOT open a transaction — it issues
    // two stateless queries (session probe + membership upsert). Both MUST
    // route through `pool.query()` (one-shot auto-checkout), NOT through
    // `pool.connect()`. The idempotency (same membership id on rejoin) is
    // already proven in the PGlite-path P3 block; what T5.5 needs to pin
    // is that the SAME response shape lands when the service runs against
    // the pg.Pool-backed Querier, AND that the routing uses the one-shot
    // path.
    const MEMBERSHIP_ID = "01970000-0000-7000-8000-00000000c777";
    const pool = makeMockPool();
    // First call: 2 statements. Second call: same 2 statements. Total = 4
    // canned responses through pool.query. The membership upsert canned
    // row returns the SAME id both times, simulating the ON CONFLICT
    // DO UPDATE upsert that the PGlite path proves end-to-end.
    pool._queryImpl = [
      ...cannedRowsForJoinSession({
        participantId: SECOND_PARTICIPANT_ID,
        membershipId: MEMBERSHIP_ID,
      }),
      ...cannedRowsForJoinSession({
        participantId: SECOND_PARTICIPANT_ID,
        membershipId: MEMBERSHIP_ID,
      }),
    ];
    const service = createSessionDirectoryServiceFromPool(pool);

    const firstJoin = await service.joinSession({
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "collaborator",
    });
    expect(firstJoin).not.toBeNull();
    if (firstJoin === null) return;
    expect(firstJoin.membershipId).toBe(MEMBERSHIP_ID);

    const secondJoin = await service.joinSession({
      sessionId: SESSION_ID,
      participantId: SECOND_PARTICIPANT_ID,
      role: "collaborator",
    });
    expect(secondJoin).not.toBeNull();
    if (secondJoin === null) return;
    // Canonical membership id — no fork on rejoin. AC4 invariant.
    expect(secondJoin.membershipId).toBe(firstJoin.membershipId);
    expect(secondJoin.sessionId).toBe(SESSION_ID);

    // Routing assertions: joinSession DOES NOT open a transaction. All
    // four statements (2 per join) MUST land on the pool's one-shot path
    // (`pool.query`), NOT on `pool.connect()` + held client. A regression
    // that wrapped joinSession in `transaction()` would surface as
    // `pool.connect` being called instead — and would unnecessarily hold
    // a checked-out client across two stateless reads.
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool._clients).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // createSessionDirectoryServiceFromPool — convenience factory shape
  // --------------------------------------------------------------------------

  it("createSessionDirectoryServiceFromPool returns a SessionDirectoryService instance backed by the pool", async () => {
    // The factory is a one-liner over `new SessionDirectoryService(
    // createPgPoolQuerier(pool))` — its only job is to spare consumers
    // the two-step construction. This test pins the export shape (the
    // returned object IS a SessionDirectoryService) and that it routes
    // through the same adapter as the explicit composition would.
    const pool = makeMockPool();
    pool._queryImpl = [
      { kind: "rows", rows: [] }, // readSession session probe -> not-found
    ];
    const service = createSessionDirectoryServiceFromPool(pool);

    expect(service).toBeInstanceOf(SessionDirectoryService);
    // Run a stateless read through the service to prove the factory
    // composition actually wired the pool — the canned not-found
    // response gives us a deterministic shape to assert on.
    const result = await service.readSession(SESSION_ID);
    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
