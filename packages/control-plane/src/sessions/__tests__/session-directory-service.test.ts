// SessionDirectoryService acceptance gates.
//
// P1: SessionCreate returns stable session id and persists to directory.
// P2: Second SessionCreate by same client does not silently fork — the
//     idempotent-upsert invariant.
//
// Migration-runner coverage: matches the runtime-daemon test shape for
// `applyMigrations` idempotency (re-call on a migrated handle is a no-op,
// schema_migrations rows stay stable at the registered MIGRATIONS set).
// The canonical path applies v1, v2, and
// v3; the dedicated `migration-runner.test.ts` test file pins the R1+R2
// canonical-path properties directly, while THIS file's idempotency block
// proves the composition-level integration (running the migration runner
// through the directory-service test fixture preserves the same shape).
// Postgres has a different concurrency model from SQLite, so there's no
// analogue to runtime-daemon's `worker_threads`-driven `BEGIN IMMEDIATE`
// race test — see the migration-runner header for the full rationale.
//
// Database lifecycle: each test gets a fresh ephemeral PGlite instance
// (in-memory mode — no tmpdir cleanup needed). PGlite is single-connection
// per instance, which matches our service's stateless query pattern; the
// production wiring composes a `Querier` from `pg.Pool` where the
// per-call connection checkout is automatic.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserId, SessionId } from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../migration-runner.js";
import {
  SessionDirectoryService,
  createPgPoolQuerier,
  createSessionDirectoryServiceFromPool,
  type CreateSessionInput,
} from "../session-directory-service.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

// UUID v4 fixtures — these stand in for the daemon-assigned UUID v7 values.
// Real UUID v7 generation is daemon-side; the service treats the id as opaque.
const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a001" as SessionId;
const SECOND_SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000a002" as SessionId;
const OWNER_USER_ID: UserId = "01970000-0000-7000-8000-00000000b001" as UserId;
const SECOND_USER_ID: UserId = "01970000-0000-7000-8000-00000000b002" as UserId;

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
// requirement here); calling it throws at runtime — see the Querier
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
// runner is the only `exec()` caller here. If a future test needs to
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
  // every test here, with no concurrent-write coverage.
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
    // The daemon mints UUID v7 locally and passes it on the create call.
    // The control-plane row's id MUST equal the supplied id (no
    // server-side regeneration).
    const input: CreateSessionInput = {
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
      config: { greeting: "hello" },
      metadata: { tag: "p1" },
    };
    // The owning user must exist before the session's owner FK can resolve.
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [OWNER_USER_ID]);

    const response = await ctx.service.createSession(input);

    // Returned id matches the supplied id.
    expect(response.sessionId).toBe(SESSION_ID);
    // Default session state is 'provisioning' per the schema column DEFAULT.
    expect(response.state).toBe("provisioning");
    // Channels live in the daemon's local event log, not the control plane. The
    // wire shape requires the field — empty array is the canonical "no channel
    // metadata here" signal.
    expect(response.channels).toEqual([]);

    // Direct row probe — proves the persistence side, independent of the
    // service's read path. This is the load-bearing assertion: the create
    // lands in the directory, bound to its owner.
    const probe = await ctx.querier.query<{
      id: string;
      owner_user_id: string;
      state: string;
    }>("SELECT id, owner_user_id, state FROM sessions WHERE id = $1", [SESSION_ID]);
    expect(probe.rows).toHaveLength(1);
    const row = probe.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.id).toBe(SESSION_ID);
    expect(row.owner_user_id).toBe(OWNER_USER_ID);
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
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [OWNER_USER_ID]);
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
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
    // the SDK layer overrides this with a real cursor.
    expect(read.timelineCursors.latest).toBeDefined();
  });

  it("readSession returns null for an unknown session id", async () => {
    const read = await ctx.service.readSession(SESSION_ID);
    expect(read).toBeNull();
  });

  it("createSession refuses an owner who is not a registered user and leaves no session row", async () => {
    // `sessions.owner_user_id` carries a FK to `users(id)` and no
    // DEFAULT, so a create naming an unregistered owner fails at the database
    // rather than materializing a session nobody owns. The refusal happens on
    // the session INSERT itself, inside the transaction, so nothing commits.
    const before = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions",
    );
    const beforeRow = before.rows[0];
    expect(beforeRow).toBeDefined();
    if (beforeRow === undefined) return;
    expect(Number.parseInt(beforeRow.count, 10)).toBe(0);

    // Note: OWNER_USER_ID is intentionally NOT inserted — the session
    // row's owner FK against `users(id)` will throw.
    await expect(
      ctx.service.createSession({
        sessionId: SESSION_ID,
        ownerUserId: OWNER_USER_ID,
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
    // Idempotent upsert via `ON CONFLICT (id) DO UPDATE SET updated_at =
    // sessions.updated_at RETURNING *`. A retry-after-crash (network
    // blip mid-create, daemon restart between request send and ack) MUST
    // yield the same row, not a sibling.
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [OWNER_USER_ID]);

    const first = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
      config: { phase: "first" },
      metadata: { phase: "first" },
    });

    // Second call: same sessionId, same owner. Different config/metadata
    // payloads to prove the upsert does NOT clobber the original — a
    // `DO UPDATE SET config = EXCLUDED.config` regression would lose the
    // first-call's payload.
    const second = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
      config: { phase: "second" },
      metadata: { phase: "second" },
    });

    // The session id is preserved (no forked row).
    expect(second.sessionId).toBe(SESSION_ID);
    expect(second.sessionId).toBe(first.sessionId);

    // Direct row probe: exactly ONE sessions row. The upsert pattern is what
    // protects that uniqueness on retry.
    const sessionsCount = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    const sessionsRow = sessionsCount.rows[0];
    expect(sessionsRow).toBeDefined();
    if (sessionsRow === undefined) return;
    expect(Number.parseInt(sessionsRow.count, 10)).toBe(1);

    // Verify the original owner, config, and metadata survived (the upsert is a
    // no-op on every data column, by design — see service docstring).
    const persistedRow = await ctx.querier.query<{
      owner_user_id: string;
      config: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>("SELECT owner_user_id, config, metadata FROM sessions WHERE id = $1", [SESSION_ID]);
    const persisted = persistedRow.rows[0];
    expect(persisted).toBeDefined();
    if (persisted === undefined) return;
    expect(persisted.owner_user_id).toBe(OWNER_USER_ID);
    expect(persisted.config).toEqual({ phase: "first" });
    expect(persisted.metadata).toEqual({ phase: "first" });
  });

  it("two distinct sessionIds from the same owner produce two distinct rows", async () => {
    // The "same client" P2 invariant is keyed by sessionId, NOT by owner.
    // Two distinct sessionIds from the same daemon MUST land as two rows —
    // that's the normal multi-session case, not a fork. This test pins
    // the boundary so a future regression that keys idempotency on
    // owner instead of sessionId surfaces immediately.
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [OWNER_USER_ID]);

    const a = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
    });
    const b = await ctx.service.createSession({
      sessionId: SECOND_SESSION_ID,
      ownerUserId: OWNER_USER_ID,
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

  it("createSession with an existing sessionId but a different owner is rejected", async () => {
    // The owner-mismatch guard inside `createSession`'s transaction. Owner
    // identity is bound at the first create, so a second create with the same
    // `sessionId` but a DIFFERENT `ownerUserId` is NOT a retry — it is
    // an attempt to take over someone else's session. Without the guard the
    // upsert's conflict clause would silently leave the original owner in place
    // and report success, so the caller would believe it owned a session it
    // does not.
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1), ($2)", [
      OWNER_USER_ID,
      SECOND_USER_ID,
    ]);

    // First create binds the owner.
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
    });

    // Second create: same sessionId, DIFFERENT user. MUST throw. The error
    // message includes the sessionId so an operator reading the log can
    // correlate the rejection to the offending request.
    await expect(
      ctx.service.createSession({
        sessionId: SESSION_ID,
        ownerUserId: SECOND_USER_ID,
      }),
    ).rejects.toThrow(SESSION_ID);

    // Direct row probe: the original owner is intact and no second session row
    // appeared. A regression that lost the guard would surface here as the
    // second caller's id on the row, or as a silent success above.
    const probe = await ctx.querier.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(probe.rows).toHaveLength(1);
    const persistedOwner = probe.rows[0];
    expect(persistedOwner).toBeDefined();
    if (persistedOwner === undefined) return;
    expect(persistedOwner.owner_user_id).toBe(OWNER_USER_ID);

    // Same-owner retry must still be idempotent — the guard does NOT turn into
    // a "first-create-only" gate.
    const retry = await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
    });
    expect(retry.sessionId).toBe(SESSION_ID);

    const probeAfterRetry = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    const probeAfterRetryRow = probeAfterRetry.rows[0];
    expect(probeAfterRetryRow).toBeDefined();
    if (probeAfterRetryRow === undefined) return;
    expect(Number.parseInt(probeAfterRetryRow.count, 10)).toBe(1);
  });

  // --------------------------------------------------------------------------
  // The owner check consumes the upsert's own returned row
  // --------------------------------------------------------------------------
  //
  // Test strategy choice: we pin the statement shape with a logging proxy that
  // captures the SQL stream issued during `createSession`. The property under
  // test is a NEGATIVE one that no row probe can observe — that the owner-
  // mismatch guard reads the persisted owner out of the upsert's own `RETURNING`
  // clause rather than issuing a second read.
  //
  // Why that property is the safety-critical one: a read-then-compare against a
  // separate SELECT reopens the race the single statement closes. Under
  // Postgres `READ COMMITTED`, two transactions creating the same `sessionId`
  // could each take their own snapshot, each see no conflicting owner, and each
  // proceed — which is why the previous separate-table shape needed an explicit
  // `SELECT ... FOR UPDATE` between the upsert and the probe. With the owner on
  // the session row, the upsert's conflict clause is the serialization point and
  // its `RETURNING` is the committed truth, so a second read is not merely
  // redundant: adding one back would be a regression.
  //
  // Why we do NOT add a true concurrency test: PGlite is in-process,
  // single-connection-per-instance, and serializes statements at the driver
  // boundary, so two genuinely concurrent transactions on the same sessionId
  // cannot be simulated without a multi-connection harness.
  it("createSession issues ONE session statement inside the transaction and reads the owner from its RETURNING clause", async () => {
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [OWNER_USER_ID]);

    // Wrap the test querier in a logging proxy that captures every SQL
    // statement issued — including queries inside `transaction(...)` (the
    // recursive wrapping mirrors `wrap()` above so in-tx queries are captured,
    // not just outer-Querier queries). Each capture entry is tagged with a
    // `querierId` so the assertions below can discriminate outer-Querier
    // statements from in-tx-Querier statements — see the "wrong-Querier
    // regression" block at the bottom for why that discrimination is the
    // load-bearing piece under pg.Pool.
    const OUTER_ID = "outer";
    const captured: CapturedQuery[] = [];
    const loggingQuerier: Querier = wrapWithLog(ctx.querier, captured, OUTER_ID);
    const service = new SessionDirectoryService(loggingQuerier);

    await service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
    });

    // The single load-bearing statement, identified by a stable SQL fragment.
    // `\b` after the table name is defensive: without it the pattern would
    // substring-match `INSERT INTO sessions_archive ... ON CONFLICT (id)` (the
    // `[\s\S]*` between table name and conflict target swallows the suffix).
    const upsertPattern = /INSERT\s+INTO\s+sessions\b[\s\S]*ON\s+CONFLICT\s*\(\s*id\s*\)/i;
    const sessionUpsertIdx = captured.findIndex((entry) => upsertPattern.test(entry.sql));
    expect(sessionUpsertIdx).toBeGreaterThanOrEqual(0);

    const sessionUpsertEntry = captured[sessionUpsertIdx];
    expect(sessionUpsertEntry).toBeDefined();
    if (sessionUpsertEntry === undefined) return;

    // The upsert returns the persisted owner — that is what the guard compares
    // against. A regression that dropped the column from `RETURNING` would have
    // to reintroduce a second read to get it.
    expect(sessionUpsertEntry.sql).toMatch(/RETURNING[\s\S]*owner_user_id/i);

    // Exactly one `sessions` statement — no follow-up owner probe, and no
    // `SELECT ... FOR UPDATE`, both of which would mean the guard stopped
    // trusting the upsert's own output.
    expect(captured.filter((entry) => upsertPattern.test(entry.sql))).toHaveLength(1);
    expect(captured.filter((entry) => /FOR\s+UPDATE/i.test(entry.sql))).toHaveLength(0);
    expect(
      captured.filter(
        (entry) => /FROM\s+sessions\b/i.test(entry.sql) && entry.sql !== sessionUpsertEntry.sql,
      ),
    ).toHaveLength(0);

    // ----- Wrong-Querier regression discriminator -----
    //
    // The upsert MUST have been issued through the in-tx Querier (the `tx`
    // passed to the `transaction(fn)` callback), NOT through the outer
    // `this.#querier`. The wrapWithLog proxy assigns the outer Querier
    // `querierId = "outer"` and re-wraps the in-tx Querier with a fresh
    // `"outer.tx-<n>"` id, so the load-bearing assertion is
    // `entry.querierId !== OUTER_ID`.
    //
    // Why this matters under pg.Pool: the outer Querier checks out a one-shot
    // connection from the pool per call; the `transaction(fn)` Querier holds a
    // SPECIFIC client across BEGIN / inner statements / COMMIT. A regression
    // that routed the upsert through `this.#querier` would take its row lock on
    // a DIFFERENT pool client than the one running the transaction, and release
    // it on that side-client's return-to-pool instead of holding it to the
    // commit — so concurrent createSession calls would no longer serialize.
    expect(sessionUpsertEntry.querierId).not.toBe(OUTER_ID);
    expect(sessionUpsertEntry.querierId).toMatch(/^outer\.tx-\d+$/);

    // Final correctness check: exactly one session row, owned by the caller
    // (the statement-shape assertions did not come at the cost of the write).
    const probe = await ctx.querier.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(probe.rows).toHaveLength(1);
    expect(probe.rows[0]?.owner_user_id).toBe(OWNER_USER_ID);
  });

  it("createSession with same logical owner but UPPERCASE UUID is idempotent", async () => {
    // The owner-mismatch guard compares the persisted `owner_user_id` against
    // `input.ownerUserId`. Postgres canonicalizes UUIDs to lowercase on
    // storage and return (RFC 9562 admits both cases as valid input), so under
    // strict string equality a caller that passes the same logical owner UUID
    // with uppercase hex digits on retry would falsely trip the "different
    // owner" throw — breaking the idempotent-upsert contract for any caller
    // whose id source happens to use uppercase. Both sides are normalized via
    // `.toLowerCase()` before equality. A regression that dropped the
    // normalization would surface here as a thrown error.
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [OWNER_USER_ID]);

    // First create: owner UUID in canonical lowercase form (the
    // `OWNER_USER_ID` fixture is already lowercase).
    await ctx.service.createSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER_USER_ID,
    });

    // Second create: same sessionId + same logical owner UUID, but
    // UPPERCASED. RFC 9562 admits both cases; the brand has no runtime
    // case-validator. Without the .toLowerCase() normalization in the
    // owner-mismatch guard, this call throws.
    const uppercaseOwner: UserId = OWNER_USER_ID.toUpperCase() as UserId;
    await expect(
      ctx.service.createSession({
        sessionId: SESSION_ID,
        ownerUserId: uppercaseOwner,
      }),
    ).resolves.not.toThrow();

    // Direct row probe: the persisted owner is canonical lowercase regardless
    // of which casing the caller used on either create call (Postgres returns
    // the storage form), and the retry did not rewrite it.
    const ownerProbe = await ctx.querier.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM sessions WHERE id = $1",
      [SESSION_ID],
    );
    expect(ownerProbe.rows).toHaveLength(1);
    const persistedSession = ownerProbe.rows[0];
    expect(persistedSession).toBeDefined();
    if (persistedSession === undefined) return;
    expect(persistedSession.owner_user_id).toBe(OWNER_USER_ID);
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
    // throw and MUST NOT duplicate the schema_migrations rows. A
    // regression that bypassed the `hasMigrationApplied` short-circuit
    // would surface as a `42P07 relation already exists` error.
    //
    // The expanded canonical-path coverage (R1+R2) lives in the dedicated
    // `migration-runner.test.ts` file; this assertion remains the
    // composition-level proof that running the migration runner through the
    // directory-service test fixture preserves the same idempotency.
    await applyMigrations(ctx.querier);
    await applyMigrations(ctx.querier);
    const probe = await ctx.querier.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(probe.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it("applyMigrations is concurrency-safe — concurrent calls on the same fresh database serialize via advisory lock (Codex R8)", async () => {
    // Codex R8 (P2): the prior runner observed "not applied" at the outer
    // probe, opened the transaction, and ran `CREATE TABLE users`
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
    // outcome (no `42P07`, both migration rows present, lock SQL emitted)
    // is identical to the `pg.Pool` substrate.
    //
    // We pin two assertions against PGlite, both load-bearing here:
    //
    //   (a) End-state correctness — `Promise.all([apply, apply])` on a
    //       fresh DB resolves with no throw; each migration lands exactly
    //       once (`schema_migrations` carries v1 + v2 + v3 anchor rows;
    //       `users` table exists from v1). This IS
    //       load-bearing on PGlite: empirically, the pre-R8 broken shape (no
    //       advisory lock around the transaction) DOES throw `relation
    //       "users" already exists` on PGlite under `Promise.all`,
    //       because both outer probes race to false and both transactions
    //       execute the unguarded `CREATE TABLE`. Removing the lock would
    //       crash this assertion.
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

      // (a) End-state correctness: each migration landed exactly once.
      // Post Amendment 2 the runner iterated `[v1, v2]`; cross-plan amendments
      // Every registered version's anchor row must be present (a regression
      // that drops one surfaces here as a shorter array). The advisory-lock
      // serialization this test exercises is unchanged — concurrent racers
      // still land each version exactly once.
      const migrationsProbe = await pg.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(migrationsProbe.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

      const usersProbe = await pg.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'users'
         ) AS exists`,
      );
      expect(usersProbe.rows[0]?.exists).toBe(true);

      // (b) Lock-query presence: the runner that entered each version's
      // transaction issued the advisory lock. Assert "at least one"
      // rather than "exactly one" — empirically both outer probes race
      // to false on PGlite (see docstring), so both runners reach the
      // in-transaction lock SQL; post Amendment 2 the per-version loop
      // takes a fresh lock per version, so the captured count scales
      // with `MIGRATIONS.length` and is no longer bounded by 2. The
      // load-bearing claim is that the lock IS issued at least once, not
      // how many times.
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
      ctx.querier.query("INSERT INTO sessions (id, owner_user_id, state) VALUES ($1, $2, $3)", [
        SESSION_ID,
        OWNER_USER_ID,
        "not_a_real_state",
      ]),
    ).rejects.toThrow();
  });
});

// ----------------------------------------------------------------------------
// createPgPoolQuerier — pool-checkout-and-release path
// ----------------------------------------------------------------------------
//
// Phase 4 shipped `SessionDirectoryService` typed against `Querier`, with the
// PGlite-backed concretion exercised in the P1/P2/P3 blocks above. lands the
// `pg.Pool`-backed concretion that production wiring will use; this describe
// block pins the adapter contract:
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
//     SAVEPOINTs and has no SAVEPOINT requirement.
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
//   four-statement sequence) is already
//   proven in the PGlite path above. the load-bearing claim is the ADAPTER
//   CONTRACT — that `transaction()` holds one connection across
//   BEGIN/COMMIT and releases on every exit, that `query()`/`exec()` route
//   through the pool's one-shot path, and that the in-transaction inner
//   Querier routes through the held client. Mock spies prove this directly
//   and precisely. A pg-mem swap would only PARTIALLY validate (pg-mem
//   doesn't implement `pg_advisory_xact_lock` faithfully), and a real
//   Postgres-in-CI substrate is out of scope for this PR (would require CI
//   workflow changes).
//
//   Assertions are routed through the same mock substrate: the service
//   body runs against `createPgPoolQuerier(mockPool)`, and we assert the
//   AC-load-bearing behavior at the service-response shape level (one
//   session id, COMMIT issued before resolve, the same id on an idempotent
//   re-create).
//
//   If a future PR needs deeper validation against a real Postgres — in
//   particular the lock-ordering strengthening — that PR adds the
//   substrate. lands the composer and the adapter-contract tests.

// ----------------------------------------------------------------------------
// MockPool / MockPoolClient — canned-response substrate
// ----------------------------------------------------------------------------

interface MockPoolCall {
  readonly kind:
    | "pool.query"
    | "client.query"
    | "client.release"
    | "client.release.destroy"
    | "client.on.error"
    | "client.removeListener.error"
    | "pool.connect";
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
  // Captured 'error' listeners — the transaction adapter subscribes once
  // at acquire to detect connection-level faults, then unsubscribes
  // before `release()`. Tests fire `_emitError(err)` to simulate the
  // socket-broke event the canonical broken-client pattern hinges on.
  readonly _errorListeners: Array<(err: Error) => void>;
  _emitError: (err: Error) => void;
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
  const errorListeners: Array<(err: Error) => void> = [];
  // Same EventEmitter-surface bypass as MockPool — the adapter touches
  // `query()`, `release()`, `on('error', ...)`, and the matching
  // `removeListener('error', ...)`. Default behavior: when `_queryImpl`
  // is not set, every query returns empty rows. Tests that assert on
  // specific canned rows (the AC tests + the ROLLBACK / COMMIT failure
  // tests) set `_queryImpl` to a per-test FIFO queue.
  const client = {
    _calls: calls,
    _released: false,
    _errorListeners: errorListeners,
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
    release: vi.fn((destroy?: Error | boolean): void => {
      // node-postgres `client.release(destroyArg)`: truthy first arg
      // destroys the client. Tag the call so tests can assert on the
      // destroy-vs-return-to-pool path without depending on argv shape.
      calls.push({ kind: destroy ? "client.release.destroy" : "client.release" });
      client._released = true;
    }),
    on: vi.fn((event: string, listener: (err: Error) => void): MockPoolClient => {
      // Only the adapter's 'error' subscription is meaningful here; the
      // other `on()` events (`notification`, `notice`, etc.) are not
      // exercised. Capture for assertion + later replay via _emitError.
      if (event === "error") {
        errorListeners.push(listener);
        calls.push({ kind: "client.on.error" });
      }
      return client;
    }),
    removeListener: vi.fn((event: string, listener: (err: Error) => void): MockPoolClient => {
      if (event === "error") {
        const i = errorListeners.indexOf(listener);
        if (i >= 0) errorListeners.splice(i, 1);
        calls.push({ kind: "client.removeListener.error" });
      }
      return client;
    }),
    _emitError: (err: Error): void => {
      // Replay every captured 'error' listener once. node-postgres fires
      // `'error'` on the client when the underlying socket breaks; the
      // adapter's listener is what trips the `tainted` flag the canonical
      // broken-client pattern hinges on.
      for (const listener of errorListeners) listener(err);
    },
  } as unknown as MockPoolClient;
  return client;
}

// Canonical canned-response sequences. Each helper builds the canned rows
// the service body will dequeue in order — the service's SQL stream for
// each method is deterministic, so the queue position is stable.

function cannedRowsForCreateSession(): CannedResponse[] {
  // The service issues exactly one statement inside the transaction (after
  // BEGIN): the session upsert, returning one SessionRow whose
  // `owner_user_id` is what the owner-mismatch guard compares against. Then
  // COMMIT.
  return [
    {
      kind: "rows",
      rows: [
        {
          id: SESSION_ID,
          owner_user_id: OWNER_USER_ID,
          state: "provisioning",
          config: {},
          metadata: {},
          min_client_version: null,
          created_at: new Date("2026-05-09T00:00:00Z"),
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
    // and any FOR UPDATE / advisory lock acquired by inner SQL would land on
    // the wrong connection. This is the central correctness concern the
    // lock-ordering test (next PR) discriminates more aggressively.
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
    // Postgres has no native nested transactions without SAVEPOINTs and has
    // no SAVEPOINT requirement. The PGlite test adapter throws on nested
    // call (see `wrap()` at the top of this file); the pg.Pool adapter
    // matches — same failure mode across substrates.
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
  // Broken-client destruction — defends against pool poisoning when the
  // underlying socket breaks mid-transaction. The adapter subscribes a `'error'`
  // listener at acquire; the listener trips a `tainted` flag; the `finally` then
  // calls `client.release(error)` (truthy first arg) instead of
  // `client.release()`. node-postgres treats the truthy arg as "disconnect and
  // destroy" rather than "return to idle pool", per
  // https://github.com/brianc/node-postgres/blob/master/docs/pages/apis/pool.mdx.
  // Statement-position classification alone is unreliable — a healthy client can
  // fail COMMIT on a deferred-constraint violation, and a broken client can
  // surface only via the listener after the in-flight query rejected.
  // --------------------------------------------------------------------------

  it("transaction(fn) destroys the client when the 'error' event fires mid-transaction", async () => {
    // Simulate the socket breaking after BEGIN succeeded: the next
    // client.query throws AND the client emits 'error' (real pg
    // behavior on ECONNRESET — the in-flight query rejects and a
    // socket-level error is emitted to listeners). The adapter's
    // listener trips `tainted`; the `finally` MUST destroy via the
    // truthy-arg path so the dead client doesn't poison the pool.
    const pool = makeMockPool();
    const sentinel = new Error("connection terminated unexpectedly (ECONNRESET simulation)");
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      client._queryImpl = [
        { kind: "rows", rows: [] }, // BEGIN succeeds
        { kind: "error", error: sentinel }, // inner query throws — socket gone
        // The adapter then issues ROLLBACK on the application-error path;
        // that ROLLBACK ALSO fails because the connection is dead.
        { kind: "error", error: new Error("ROLLBACK failed — connection dead") },
      ];
      return client;
    };
    const querier = createPgPoolQuerier(pool);

    await expect(
      querier.transaction(async (tx) => {
        // Inside fn: fire the synthetic 'error' event right before the
        // inner query rejects. Real pg fires both — the listener flag
        // is what the broken-client path is built on.
        const client = pool._clients[0];
        if (client !== undefined) client._emitError(sentinel);
        await tx.query("SELECT 1");
        return undefined;
      }),
    ).rejects.toBe(sentinel);

    expect(pool._clients).toHaveLength(1);
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;

    // The adapter subscribed once at acquire and detached once before
    // release. Asymmetric counts would mean a listener leak.
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(client.removeListener).toHaveBeenCalledWith("error", expect.any(Function));

    // Crucially: `release()` was called with a TRUTHY first arg so the
    // pool destroys this client instead of recycling it. Statement-
    // position classification can't distinguish this from a healthy
    // COMMIT-time failure — the listener-driven `tainted` flag does.
    expect(client.release).toHaveBeenCalledTimes(1);
    const lastReleaseKind = client._calls.filter((c) => c.kind.startsWith("client.release"));
    expect(lastReleaseKind.at(-1)?.kind).toBe("client.release.destroy");
  });

  it("transaction(fn) destroys the client when ROLLBACK throws after a failed `fn` (connection-dead inference)", async () => {
    // A successful application-error path that issues ROLLBACK and gets
    // a throw back from the wire is invariably the connection dying
    // mid-`fn` — the in-flight ROLLBACK couldn't reach the server. The
    // 'error' event might race the rejected query, so the adapter also
    // taints inside the swallowed ROLLBACK catch as belt-and-braces.
    const pool = makeMockPool();
    pool._connectImpl = async (): Promise<MockPoolClient> => {
      const client = makeMockPoolClient();
      pool._clients.push(client);
      client._queryImpl = [
        { kind: "rows", rows: [] }, // BEGIN succeeds
        { kind: "rows", rows: [] }, // inner fn body succeeds
        { kind: "error", error: new Error("ROLLBACK failed at the wire") },
      ];
      return client;
    };
    const querier = createPgPoolQuerier(pool);
    const originalError = new Error("application rejection");

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

    // Crucial difference vs the existing "ROLLBACK throws but release
    // still runs" test (line ~1740): that test asserts release is
    // called; this one asserts it is called with TRUTHY first arg
    // (the destroy path). Without this, a sustained app-error-then-
    // ROLLBACK-failure rate would slowly poison the pool with dead
    // clients.
    expect(client.release).toHaveBeenCalledTimes(1);
    const lastReleaseKind = client._calls.filter((c) => c.kind.startsWith("client.release"));
    expect(lastReleaseKind.at(-1)?.kind).toBe("client.release.destroy");
  });

  it("transaction(fn) returns the client to the pool (no destroy) when COMMIT fails on a deferred-constraint violation", async () => {
    // The complement to the destroy-on-error tests above: a deferred-
    // constraint COMMIT failure is NOT a connection-level fault. The
    // 'error' event does not fire; the client is healthy and should
    // return to the idle pool. Asserts the destroy path is NOT taken
    // here — guards against over-destruction that would silently leak
    // pool capacity under sustained deferred-constraint workloads.
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

    expect(client.release).toHaveBeenCalledTimes(1);
    // Healthy client — return to pool, not destroy.
    const lastReleaseKind = client._calls.filter((c) => c.kind.startsWith("client.release"));
    expect(lastReleaseKind.at(-1)?.kind).toBe("client.release");
  });

  // --------------------------------------------------------------------------
  // CreateSession through pg.Pool yields stable shape
  // --------------------------------------------------------------------------

  it("createSession through the pg.Pool-backed Querier yields one stable session id and an empty default channel list", async () => {
    // The behavioral correctness of the SQL itself is already proven in the
    // PGlite path (P1 block above). What this proves is that the SAME service
    // code, when run against the pg.Pool-backed Querier, ROUTES through the
    // right substrate (the held client for the transaction) and produces the
    // contract-shape response. The control plane has no event log, so
    // `channels` is the empty array (the canonical "no channel metadata here"
    // signal); the SDK composition layer merges the daemon's projected channels
    // with this empty list to produce the user-visible channel list.
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
      ownerUserId: OWNER_USER_ID,
    });

    // Contract-shape assertions: one stable id and a default (empty) channels
    // array. Mirrors the PGlite-path P1 assertion surface — same response shape
    // across both substrates.
    expect(response.sessionId).toBe(SESSION_ID);
    expect(response.state).toBe("provisioning");
    expect(response.channels).toEqual([]);

    // Routing assertions: createSession opened a transaction. The body
    // statement MUST have landed on the held client, NOT on the pool's one-shot
    // path. The pool.query mock was never called.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    const client = pool._clients[0];
    expect(client).toBeDefined();
    if (client === undefined) return;
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Durability (COMMIT before resolve)
  // --------------------------------------------------------------------------

  it("COMMIT is awaited before the createSession promise resolves (session is committed before caller observes the response)", async () => {
    // Says "session record is durable (committed) through the pg.Pool
    // transaction substrate before any caller observes the response". The
    // adapter contract guarantees this: `transaction(fn)` awaits
    // `client.query("COMMIT")` BEFORE returning the result. A regression
    // that issued COMMIT after the return — or fire-and-forgot the COMMIT
    // — would let the caller observe the response with the row still
    // sitting in the transaction's uncommitted snapshot; a concurrent
    // reader (or a crash before the deferred COMMIT lands) would lose the
    // row. This test pins the awaiting-COMMIT contract.
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
      ownerUserId: OWNER_USER_ID,
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
    // COMMIT precedes release, and the only call between them is the
    // adapter's `removeListener('error', ...)` cleanup (the symmetric
    // detach to the acquire-time `on('error', ...)` subscription that
    // drives broken-client detection). Strict-adjacency would over-
    // specify — what matters is that no application-side callback runs
    // between COMMIT and release, which the explicit
    // removeListener-only constraint captures without being brittle to
    // future additions to the same cleanup window.
    const commitIdx = clientCallKinds.indexOf("query:COMMIT");
    const releaseIdx = clientCallKinds.findIndex((k) => k.startsWith("client.release"));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(commitIdx);
    const between = clientCallKinds.slice(commitIdx + 1, releaseIdx);
    expect(between).toEqual(["client.removeListener.error"]);
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
