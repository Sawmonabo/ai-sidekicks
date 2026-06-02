// Plan-001 D5 — migration-shape regression test.
//
// Verifies I-001-3 (forward-declared schema shape is immutable at Tier 1).
// If a future plan reshapes any column in `0001-initial.ts` (rename, type
// change, NOT NULL drop, CHECK relaxation), this test fails fast so the
// drift is caught at PR review rather than at a downstream consumer's
// runtime.
//
// Path: ships at `src/session/__tests__/migration-shape.test.ts` to match
// the package vitest discovery glob `src/**/__tests__/**/*.test.ts`. The
// Plan-001 T3.4 cited path `migrations/test/` would be silently skipped by
// that glob — see the §Decision Log erratum recorded with this PR.
//
// Schema source-of-truth is `docs/architecture/schemas/local-sqlite-schema.md`
// + `0001-initial.ts` inline SQL. Forward-declared columns
// (`session_events.pii_payload`, `prev_hash`, `row_hash`, `daemon_signature`,
// `participant_signature`) ship in Plan-001 per §Cross-Plan Forward-Declared
// Schema with semantics owned by Plan-006 / Plan-022.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, applyPragmas } from "../migration-runner.js";

// The canonical Plan-001 tables. Order is intentional (alphabetical by
// SQLite's ORDER BY name) so the assertion is stable across SQLite versions.
// This constant drives the per-table snapshot loop below — it is the
// I-001-3 immutable-shape guard for the 0001 tables, so the Plan-003
// version-2 tables are NOT added here (their shape is pinned by the
// separate `0002-runtime-node migration shape` describe block).
const PLAN_001_TABLES: ReadonlyArray<string> = [
  "participant_keys",
  "schema_version",
  "session_events",
  "session_snapshots",
];

// The full set of tables present after ALL migrations have applied
// (Plan-001 version-1 tables + Plan-003 version-2 tables). Alphabetical by
// SQLite's `ORDER BY name` so the assertion is stable across SQLite
// versions. Kept separate from `PLAN_001_TABLES` so the snapshot loop's
// 0001-immutability guard is unaffected by the 0002 additions.
const ALL_EXPECTED_TABLES: ReadonlyArray<string> = [
  "node_capabilities",
  "node_trust_state",
  "participant_keys",
  "schema_version",
  "session_events",
  "session_snapshots",
];

// PRAGMA table_info column shape (better-sqlite3 returns these field names).
interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  // 1-based ordinal within the primary key; 0 if the column is not part of
  // the PK. Composite PKs therefore yield pk values 2, 3, ... — hence
  // `number`, not a binary union.
  pk: number;
}

describe("0001-initial migration shape", () => {
  let db: DatabaseType;

  beforeEach(() => {
    // In-memory DB — no FS cleanup required. Construct via Database directly
    // (mirrors session-service.test.ts pattern) so the test exercises the
    // applyPragmas + applyMigrations sequence the canonical openDatabase
    // wrapper composes. openDatabase itself requires a file path; the
    // in-memory equivalent applies the same two functions inline.
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates exactly the expected tables after all migrations", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as ReadonlyArray<{ name: string }>;
    // After version-2 (Plan-003) the DB holds the full six-table set:
    // the four Plan-001 tables plus node_capabilities + node_trust_state.
    expect(rows.map((r) => r.name)).toEqual(ALL_EXPECTED_TABLES);
  });

  for (const table of PLAN_001_TABLES) {
    it(`pins the column shape of \`${table}\``, () => {
      // PRAGMA table_info returns rows in CID (creation) order — stable
      // across SQLite versions because the column order is fixed by the
      // CREATE TABLE DDL.
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as ReadonlyArray<PragmaColumn>;
      // Snapshot per table so a column rename / type change / NOT NULL
      // flip surfaces as a diff against the checked-in `.snap` file.
      // Adding a new column to a Plan-001-owned table requires updating
      // the snapshot AND the canonical schema doc in the same PR.
      expect(columns).toMatchSnapshot();
    });
  }

  it("includes forward-declared integrity columns on session_events", () => {
    const columns = db
      .prepare("PRAGMA table_info(session_events)")
      .all() as ReadonlyArray<PragmaColumn>;
    const byName = new Map(columns.map((c) => [c.name, c]));

    // Plan-006 forward-decl: hash-chain + signature columns. NOT NULL
    // for prev_hash / row_hash / daemon_signature (placeholder bytes
    // satisfy the constraint per Plan-001 §Forward-declared columns).
    // participant_signature is nullable per the same block.
    expect(byName.get("prev_hash")?.notnull).toBe(1);
    expect(byName.get("row_hash")?.notnull).toBe(1);
    expect(byName.get("daemon_signature")?.notnull).toBe(1);
    expect(byName.get("participant_signature")?.notnull).toBe(0);

    // Plan-022 forward-decl: PII payload column ships at Tier 1 with
    // crypto-shred semantics owned by Plan-022. Nullable per same block
    // (Plan-001 writes NULL for every V1 event — no V1 SessionEvent
    // variant carries PII).
    expect(byName.has("pii_payload")).toBe(true);
    expect(byName.get("pii_payload")?.notnull).toBe(0);

    // monotonic_ns ships as Plan-001 owned (process.hrtime.bigint() at
    // emit; within-daemon ordering per Spec-015 §Clock Handling, BL-062).
    expect(byName.get("monotonic_ns")?.notnull).toBe(1);
  });

  it("anchors schema_version rows at versions [1, 2]", () => {
    // The `ORDER BY version` is load-bearing: without it the row order is
    // insertion-order luck and the assertion would silently stop pinning
    // which versions landed.
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows.map((r) => r.version)).toEqual([1, 2]);
  });

  it("is idempotent when applyMigrations runs twice", () => {
    // Second invocation must be a no-op (the migration runner short-
    // circuits via hasMigrationApplied per version). Re-running must not
    // throw, must not double-insert either schema_version anchor row, must
    // not duplicate tables. Two DISTINCT versions [1, 2] is not duplication.
    applyMigrations(db);
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows).toHaveLength(2);
    expect(versionRows.map((r) => r.version)).toEqual([1, 2]);
  });
});

// Plan-003 PR #135 — version-2 migration-shape coverage.
//
// Pins the column set, NOT NULL flags, primary-key shape, and the two
// DEFAULT clauses of the Plan-003 Local SQLite tables (`node_capabilities`,
// `node_trust_state`). Schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Runtime Node Local Tables (Plan-003)" / `migrations/0002-runtime-node.ts`.
//
// Asserted via PRAGMA table_info (explicit field-by-field), NOT
// `toMatchSnapshot`, so this block adds no entries to the 0001 immutability
// `.snap` file. Scope is the two new tables only — Postgres-table absence
// and Plan-001 upstream-presence are a separate structural guard (T1.7),
// not pinned here.
describe("0002-runtime-node migration shape", () => {
  let db: DatabaseType;

  beforeEach(() => {
    // Mirror the 0001 block's setup: in-memory DB, applyPragmas +
    // applyMigrations (which now applies both version-1 and version-2).
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("pins the column shape and composite PK of `node_capabilities`", () => {
    const columns = db
      .prepare("PRAGMA table_info(node_capabilities)")
      .all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL.
    expect(columns.map((c) => c.name)).toEqual([
      "node_id",
      "capability_key",
      "capability_value",
      "updated_at",
    ]);

    // Every column is NOT NULL per the schema doc.
    expect(columns.every((c) => c.notnull === 1)).toBe(true);

    // Composite primary key (node_id, capability_key): SQLite numbers the
    // PK members 1-based in declaration order; non-PK columns are pk === 0.
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("node_id")?.pk).toBe(1);
    expect(byName.get("capability_key")?.pk).toBe(2);
    expect(byName.get("capability_value")?.pk).toBe(0);
    expect(byName.get("updated_at")?.pk).toBe(0);

    // capability_value carries the JSON default `'{}'`.
    expect(byName.get("capability_value")?.dflt_value).toBe("'{}'");
  });

  it("pins the column shape and single-column PK of `node_trust_state`", () => {
    const columns = db
      .prepare("PRAGMA table_info(node_trust_state)")
      .all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order.
    expect(columns.map((c) => c.name)).toEqual([
      "node_id",
      "trust_level",
      "established_at",
      "updated_at",
    ]);

    // Every column is NOT NULL per the schema doc.
    expect(columns.every((c) => c.notnull === 1)).toBe(true);

    // Single-column primary key on node_id; all others pk === 0.
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("node_id")?.pk).toBe(1);
    expect(byName.get("trust_level")?.pk).toBe(0);
    expect(byName.get("established_at")?.pk).toBe(0);
    expect(byName.get("updated_at")?.pk).toBe(0);

    // trust_level carries the default `'untrusted'`.
    expect(byName.get("trust_level")?.dflt_value).toBe("'untrusted'");
  });
});
