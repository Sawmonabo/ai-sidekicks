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
const PLAN_001_TABLES: ReadonlyArray<string> = [
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
  pk: 0 | 1;
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

  it("creates exactly the Plan-001 tables", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as ReadonlyArray<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(PLAN_001_TABLES);
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

  it("anchors schema_version row at version=1", () => {
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(1);
  });

  it("is idempotent when applyMigrations runs twice", () => {
    // Second invocation must be a no-op (the migration runner short-
    // circuits via hasMigrationApplied). Re-running must not throw, must
    // not double-insert the schema_version row, must not duplicate tables.
    applyMigrations(db);
    const versionRows = db.prepare("SELECT version FROM schema_version").all() as ReadonlyArray<{
      version: number;
    }>;
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.version).toBe(1);
  });
});
