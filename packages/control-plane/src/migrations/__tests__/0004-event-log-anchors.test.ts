// Plan-006 T3.3 — `0004-event-log-anchors.ts` migration shape regression.
//
// Phase 3 acceptance criterion: applying `0004` against a Postgres DB already
// migrated through `0003` creates `event_log_anchors` with the exact column
// set, the `end_sequence >= start_sequence` CHECK, the four-column UNIQUE key,
// the `sessions` FK, and both anchored_at-DESC indexes; idempotent under the
// runner.
//
// This file pins nine load-bearing properties of
// `EVENT_LOG_ANCHORS_MIGRATION_SQL`:
//
//   P1 — the table exists only AFTER applying v4 (probe
//        `information_schema.tables`): absent at the "migrated through 0003"
//        baseline, present after.
//   P2 — `schema_migrations` carries (1, ...), (2, ...), (3, ...), and
//        (4, 'Event log anchors (integrity witness)').
//   P3 — exact column set (the AC): EXACTLY the 8 columns of the canonical DDL,
//        with their declared types and nullability.
//   P4 — the `CHECK (end_sequence >= start_sequence)` rejects an inverted range.
//   P5 — THE KEY: an identical `(session_id, node_id, start_sequence,
//        end_sequence)` collides, while a WIDER range sharing `start_sequence`
//        coexists. This is the `Spec-006 §Post-Compaction Integrity`
//        coverage-not-exact-start property at the DDL layer, and it is the
//        reason `end_sequence` is in the key at all.
//   P6 — the `session_id` FK to `sessions(id)` is enforced (`23503`), which is
//        also what keeps node-scope sentinel anchors out of V1 storage.
//   P7 — both `anchored_at DESC` indexes exist on the right columns.
//   P8 — `anchored_at` carries a `now()` DEFAULT but an explicit write wins.
//        The daemon's timestamp is part of the signed commitment, so the
//        default must never silently replace it.
//   P9 — driver HYDRATION of the four non-TEXT columns, pinned because the
//        store's read/write path depends on it and the two drivers DIVERGE.
//
// ----------------------------------------------------------------------------
// Why this file uses direct-exec v1 + v2 + v3 bootstrap + direct-exec v4
// ----------------------------------------------------------------------------
//
// This file exercises `EVENT_LOG_ANCHORS_MIGRATION_SQL` semantics in isolation
// at the SQL layer. Post Plan-006 T3.3, `applyMigrations()` iterates
// `MIGRATIONS = [v1, v2, v3, v4]` and applies ALL FOUR in one call, so using
// `applyMigrations()` in this file's `beforeEach` would pre-apply v4 —
// defeating P1's "the table should not yet exist" probe and P2-P8's "apply v4
// cleanly, then probe" structure. Instead `beforeEach` direct-execs v1, v2, and
// v3 so each test starts at exactly the AC's precondition, mirroring the
// pattern `0003-runtime-nodes.test.ts` states in full. Canonical-path runner
// coverage (the v1..v4 loop and its idempotency) lives in
// `sessions/__tests__/migration-runner.test.ts`.
//
// The `adaptPGlite` helper is a local copy for the same reason the sibling
// files give: the dispatch contract forbids exporting a new test fixture from
// `packages/control-plane/`, and the helper is small enough that an
// `internal/` extraction would add more indirection than it removes.
//
// Refs: Plan-006 T3.3, ADR-017,
// `docs/architecture/schemas/shared-postgres-schema.md` §Event Log Anchors
// (Plan-006 — Integrity Witness).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATION_SQL } from "../0001-initial.js";
import { SESSION_INVITES_MIGRATION_SQL } from "../0002-session-invites.js";
import { RUNTIME_NODES_MIGRATION_SQL } from "../0003-runtime-nodes.js";
import { EVENT_LOG_ANCHORS_MIGRATION_SQL } from "../0004-event-log-anchors.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

const SESSION_ID = "01970000-0000-7000-8000-00000000a001";
const ABSENT_SESSION_ID = "01970000-0000-7000-8000-00000000dead";
const NODE_ID = "node-alpha";
const ANCHORED_AT = "2026-08-04T00:00:00.000Z";

function merkleRootFixture(fill = 0x11): Buffer {
  return Buffer.alloc(32, fill);
}

function rootSignatureFixture(fill = 0x22): Buffer {
  return Buffer.alloc(64, fill);
}

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => fn(wrap(tx)));
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  for (const migrationSql of [
    INITIAL_MIGRATION_SQL,
    SESSION_INVITES_MIGRATION_SQL,
    RUNTIME_NODES_MIGRATION_SQL,
  ]) {
    // Each exec is wrapped in a transaction so the migration body and its
    // `schema_migrations` INSERT commit atomically — the same boundary the
    // canonical `applyMigrations` uses, inlined here.
    await querier.transaction(async (tx) => {
      await tx.exec(migrationSql);
    });
  }
  ctx = { pg, querier };
});

afterEach(async () => {
  // PGlite's `close()` releases the WASM heap; not awaiting could leak across
  // tests under vitest's parallel-file isolation.
  await ctx.pg.close();
});

async function applyEventLogAnchorsMigration(querier: Querier): Promise<void> {
  await querier.transaction(async (tx) => {
    await tx.exec(EVENT_LOG_ANCHORS_MIGRATION_SQL);
  });
}

// Seed the FK ancestor. P6 deliberately skips it.
async function seedSession(querier: Querier): Promise<void> {
  await querier.query("INSERT INTO sessions (id) VALUES ($1)", [SESSION_ID]);
}

async function insertAnchor(
  querier: Querier,
  overrides: {
    sessionId?: string;
    nodeId?: string;
    startSequence: number;
    endSequence: number;
    anchoredAt?: string | null;
  },
): Promise<void> {
  if (overrides.anchoredAt === null) {
    // Omit the column entirely so the DDL DEFAULT fires (P8's control arm).
    await querier.query(
      `INSERT INTO event_log_anchors
         (session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        overrides.sessionId ?? SESSION_ID,
        overrides.nodeId ?? NODE_ID,
        overrides.startSequence,
        overrides.endSequence,
        merkleRootFixture(),
        rootSignatureFixture(),
      ],
    );
    return;
  }
  await querier.query(
    `INSERT INTO event_log_anchors
       (session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      overrides.sessionId ?? SESSION_ID,
      overrides.nodeId ?? NODE_ID,
      overrides.startSequence,
      overrides.endSequence,
      merkleRootFixture(),
      rootSignatureFixture(),
      overrides.anchoredAt ?? ANCHORED_AT,
    ],
  );
}

// ----------------------------------------------------------------------------
// P1 — the table exists after applying v4
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P1 — the table exists after v4)", () => {
  it("creates event_log_anchors in the public schema", async () => {
    const before = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'event_log_anchors'`,
    );
    expect(before.rows).toEqual([]);

    await applyEventLogAnchorsMigration(ctx.querier);

    const after = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'event_log_anchors'`,
    );
    expect(after.rows.map((row) => row.table_name)).toEqual(["event_log_anchors"]);
  });
});

// ----------------------------------------------------------------------------
// P2 — schema_migrations anchor rows
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P2 — schema_migrations anchor rows)", () => {
  it("inserts (4, 'Event log anchors (integrity witness)') alongside (1..3)", async () => {
    await applyEventLogAnchorsMigration(ctx.querier);

    const probe = await ctx.querier.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    // The description is pinned defensively: `hasMigrationApplied` keys on
    // `version` alone, so a copy-pasted description would slip past every
    // version-only probe while making manual migration debugging misleading.
    expect(probe.rows[3]?.description).toBe("Event log anchors (integrity witness)");
  });
});

// ----------------------------------------------------------------------------
// P3 — exact column set (the AC)
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P3 — exact column set)", () => {
  it("creates EXACTLY the 8 canonical columns with their declared types", async () => {
    await applyEventLogAnchorsMigration(ctx.querier);

    const probe = await ctx.querier.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'event_log_anchors'
        ORDER BY ordinal_position ASC`,
    );

    // Declaration order, which the canonical DDL fixes.
    expect(probe.rows.map((row) => row.column_name)).toEqual([
      "id",
      "session_id",
      "node_id",
      "start_sequence",
      "end_sequence",
      "merkle_root",
      "root_signature",
      "anchored_at",
    ]);

    const byName = new Map(probe.rows.map((row) => [row.column_name, row]));
    expect(byName.get("id")?.data_type).toBe("uuid");
    expect(byName.get("session_id")?.data_type).toBe("uuid");
    expect(byName.get("node_id")?.data_type).toBe("text");
    expect(byName.get("start_sequence")?.data_type).toBe("bigint");
    expect(byName.get("end_sequence")?.data_type).toBe("bigint");
    expect(byName.get("merkle_root")?.data_type).toBe("bytea");
    expect(byName.get("root_signature")?.data_type).toBe("bytea");
    expect(byName.get("anchored_at")?.data_type).toBe("timestamp with time zone");

    // EVERY column is NOT NULL. There is no such thing as a partially-known
    // anchor: a witness missing its root, its signature, or either range
    // endpoint witnesses nothing.
    for (const row of probe.rows) {
      expect(row.is_nullable, `${row.column_name} must be NOT NULL`).toBe("NO");
    }

    // Exactly two defaults, both server-generated conveniences.
    expect(byName.get("id")?.column_default).toContain("gen_random_uuid()");
    expect(byName.get("anchored_at")?.column_default).toContain("now()");
    for (const row of probe.rows.filter(
      (candidate) => candidate.column_name !== "id" && candidate.column_name !== "anchored_at",
    )) {
      expect(row.column_default, `${row.column_name} must carry no DEFAULT`).toBeNull();
    }
  });
});

// ----------------------------------------------------------------------------
// P4 — the range CHECK
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P4 — CHECK end_sequence >= start_sequence)", () => {
  it("rejects an inverted range and accepts a single-row range", async () => {
    await applyEventLogAnchorsMigration(ctx.querier);
    await seedSession(ctx.querier);

    await expect(
      insertAnchor(ctx.querier, { startSequence: 1000, endSequence: 999 }),
    ).rejects.toThrow();

    // A single-row anchor is legitimate, not degenerate: a compaction range one
    // row wide needs exactly this.
    await expect(
      insertAnchor(ctx.querier, { startSequence: 7, endSequence: 7 }),
    ).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// P5 — THE KEY: coverage, not exact-start
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P5 — four-column UNIQUE key)", () => {
  it("collides on an identical range but admits a wider anchor sharing start_sequence", async () => {
    await applyEventLogAnchorsMigration(ctx.querier);
    await seedSession(ctx.querier);

    // The routine cadence anchor.
    await insertAnchor(ctx.querier, { startSequence: 1, endSequence: 1000 });

    // The wider compaction-covering anchor. SAME start_sequence, and it MUST
    // land — a compactor about to discard [1,5000] needs a covering witness and
    // the [1,1000] anchor does not cover it. A three-column key would reject
    // this insert and leave the compaction range unwitnessed
    // (`Spec-006 §Post-Compaction Integrity`).
    await expect(
      insertAnchor(ctx.querier, { startSequence: 1, endSequence: 5000 }),
    ).resolves.toBeUndefined();

    // A genuine re-upload of the IDENTICAL range. This is the only thing the
    // key dedups.
    await expect(
      insertAnchor(ctx.querier, { startSequence: 1, endSequence: 1000 }),
    ).rejects.toThrow();

    // The key is per-(session, node): the same range on another node's chain is
    // a different commitment, not a duplicate.
    await expect(
      insertAnchor(ctx.querier, { nodeId: "node-beta", startSequence: 1, endSequence: 1000 }),
    ).resolves.toBeUndefined();

    const probe = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM event_log_anchors",
    );
    expect(probe.rows[0]?.count).toBe("3");
  });

  it("absorbs an identical-range re-upload under ON CONFLICT DO NOTHING", async () => {
    // The store's idempotency mechanism, asserted at the DDL layer: the second
    // insert affects ZERO rows rather than raising, and `RETURNING` is the
    // discriminator the store reads.
    await applyEventLogAnchorsMigration(ctx.querier);
    await seedSession(ctx.querier);

    const insertSql = `INSERT INTO event_log_anchors
        (session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
      ON CONFLICT (session_id, node_id, start_sequence, end_sequence) DO NOTHING
      RETURNING id`;
    const params = [
      SESSION_ID,
      NODE_ID,
      1,
      1000,
      merkleRootFixture(),
      rootSignatureFixture(),
      ANCHORED_AT,
    ];

    const first = await ctx.querier.query<{ id: string }>(insertSql, params);
    const second = await ctx.querier.query<{ id: string }>(insertSql, params);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// P6 — the sessions FK
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P6 — session_id FK)", () => {
  it("refuses an anchor naming a session that does not exist (23503)", async () => {
    await applyEventLogAnchorsMigration(ctx.querier);
    // Deliberately NOT seeding the session.

    let observedCode: unknown;
    try {
      await insertAnchor(ctx.querier, {
        sessionId: ABSENT_SESSION_ID,
        startSequence: 1,
        endSequence: 1000,
      });
    } catch (error) {
      observedCode = (error as { code?: unknown }).code;
    }
    // The specific SQLSTATE is load-bearing: `anchor-store.ts` branches on it
    // to turn an unknown session into a terminal `NOT_FOUND` rather than a
    // retriable 500.
    expect(observedCode).toBe("23503");
  });
});

// ----------------------------------------------------------------------------
// P7 — the two read indexes
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P7 — anchored_at DESC indexes)", () => {
  it("creates the session and node lookup indexes with their DESC ordering", async () => {
    await applyEventLogAnchorsMigration(ctx.querier);

    const probe = await ctx.querier.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'event_log_anchors'
        ORDER BY indexname ASC`,
    );
    const byName = new Map(probe.rows.map((row) => [row.indexname, row.indexdef]));

    // Two explicit indexes plus the PK and UNIQUE constraint indexes.
    expect(byName.has("idx_event_log_anchors_session")).toBe(true);
    expect(byName.has("idx_event_log_anchors_node")).toBe(true);

    // The DESC is the point: both read paths want the most recent anchors
    // first, and an index built ASC would not serve that ordering from the
    // index alone.
    expect(byName.get("idx_event_log_anchors_session")).toContain("anchored_at DESC");
    expect(byName.get("idx_event_log_anchors_session")).toContain("session_id");
    expect(byName.get("idx_event_log_anchors_node")).toContain("anchored_at DESC");
    expect(byName.get("idx_event_log_anchors_node")).toContain("node_id");
  });
});

// ----------------------------------------------------------------------------
// P8 — anchored_at: DEFAULT exists, explicit write wins
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P8 — anchored_at is the daemon's timestamp)", () => {
  it("keeps an explicitly supplied anchored_at rather than substituting now()", async () => {
    // `anchored_at` is part of what the daemon SIGNED, and the local
    // `pending_anchor_uploads` mirror holds the same value. If the DEFAULT
    // silently replaced it, the two copies of one signed commitment would
    // disagree about when it happened and stop corroborating each other.
    await applyEventLogAnchorsMigration(ctx.querier);
    await seedSession(ctx.querier);

    await insertAnchor(ctx.querier, {
      startSequence: 1,
      endSequence: 1000,
      anchoredAt: ANCHORED_AT,
    });

    const probe = await ctx.querier.query<{ anchored_at: Date }>(
      "SELECT anchored_at FROM event_log_anchors WHERE start_sequence = 1",
    );
    expect(probe.rows[0]?.anchored_at.toISOString()).toBe(ANCHORED_AT);
  });

  it("falls back to now() only when the column is omitted entirely", async () => {
    // The control arm — proving the assertion above is about the WRITE PATH
    // winning, not about the DEFAULT being absent.
    await applyEventLogAnchorsMigration(ctx.querier);
    await seedSession(ctx.querier);

    const beforeInsert = Date.now();
    await insertAnchor(ctx.querier, { startSequence: 1, endSequence: 1000, anchoredAt: null });

    const probe = await ctx.querier.query<{ anchored_at: Date }>(
      "SELECT anchored_at FROM event_log_anchors WHERE start_sequence = 1",
    );
    const stored = probe.rows[0]?.anchored_at;
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    // The DISCRIMINATING assertion. A ±60s window around `now()` cannot tell the
    // default apart from the fixture whenever the two happen to fall close
    // together — and `ANCHORED_AT` is midnight of a day this suite may well run
    // on. Exact non-equality is what actually pins "the daemon's value was
    // omitted, so the column default supplied one instead".
    expect(stored).toBeInstanceOf(Date);
    expect(stored.toISOString()).not.toBe(ANCHORED_AT);
    // And it is genuinely a fresh `now()`, not some other stored constant.
    expect(stored.getTime()).toBeGreaterThanOrEqual(beforeInsert - 1_000);
    expect(stored.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

// ----------------------------------------------------------------------------
// P9 — driver hydration of the non-TEXT columns
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P9 — driver hydration)", () => {
  it("hydrates bytea as bytes, timestamptz as Date, and bigint as a NUMBER under PGlite", async () => {
    // This is a DRIVER-BEHAVIOUR pin, and it exists because the two drivers
    // DIVERGE on `bigint` and a reader could otherwise draw the wrong
    // conclusion from a PGlite-only suite: PGlite hydrates `bigint` as a JS
    // number, while `pg` hydrates it as a STRING to avoid silent precision loss
    // past 2^53 (the reason `hasMigrationApplied` casts its `COUNT(*)::text`).
    //
    // `anchor-store.ts` is unaffected TODAY because its only read is
    // `RETURNING id`, and its header says so. Anything that later reads
    // `start_sequence` / `end_sequence` back MUST normalize across both
    // hydrations — that is what this test is here to make impossible to forget.
    await applyEventLogAnchorsMigration(ctx.querier);
    await seedSession(ctx.querier);
    await insertAnchor(ctx.querier, { startSequence: 1, endSequence: 5000 });

    const probe = await ctx.querier.query<{
      start_sequence: unknown;
      end_sequence: unknown;
      merkle_root: unknown;
      root_signature: unknown;
      anchored_at: unknown;
    }>(
      `SELECT start_sequence, end_sequence, merkle_root, root_signature, anchored_at
         FROM event_log_anchors`,
    );
    const row = probe.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    expect(row.merkle_root).toBeInstanceOf(Uint8Array);
    expect((row.merkle_root as Uint8Array).length).toBe(32);
    expect(row.root_signature).toBeInstanceOf(Uint8Array);
    expect((row.root_signature as Uint8Array).length).toBe(64);
    expect(row.anchored_at).toBeInstanceOf(Date);

    // PGlite-specific; see the comment above before relying on this shape.
    expect(typeof row.start_sequence).toBe("number");
    expect(row.start_sequence).toBe(1);
    expect(row.end_sequence).toBe(5000);
  });
});

// ----------------------------------------------------------------------------
// P10 — runner idempotency over a directly-applied v4
// ----------------------------------------------------------------------------

describe("0004-event-log-anchors migration (P10 — runner idempotency)", () => {
  it("applyMigrations short-circuits cleanly when v4 was applied via direct exec", async () => {
    // The cross-path complement to `sessions/__tests__/migration-runner.test.ts`
    // R2: that test proves the runner is idempotent when v4 came from the runner
    // loop; THIS one proves the per-version outer probe still recognizes a v4
    // applied at the SQL layer. A regression that stopped recognizing
    // pre-applied versions would surface here as `42P07 relation already
    // exists`.
    await applyEventLogAnchorsMigration(ctx.querier);

    await expect(applyMigrations(ctx.querier)).resolves.toBeUndefined();

    const probe = await ctx.querier.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  });
});
