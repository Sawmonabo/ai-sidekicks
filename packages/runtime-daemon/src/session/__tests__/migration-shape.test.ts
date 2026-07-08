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
// (Plan-001 version-1 tables + Plan-003 version-2 tables + Plan-005
// version-3 tables). Alphabetical by SQLite's `ORDER BY name` so the
// assertion is stable across SQLite versions. Kept separate from
// `PLAN_001_TABLES` so the snapshot loop's 0001-immutability guard is
// unaffected by the 0002 / 0003 additions.
const ALL_EXPECTED_TABLES: ReadonlyArray<string> = [
  "driver_capabilities",
  "driver_contract_meta",
  "driver_tools",
  "node_capabilities",
  "node_trust_state",
  "participant_keys",
  "runtime_bindings",
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
    // After version-3 (Plan-005) the DB holds the full ten-table set: the
    // four Plan-001 tables, the two Plan-003 tables (node_capabilities,
    // node_trust_state), and the four Plan-005 tables (runtime_bindings,
    // driver_capabilities, driver_tools, driver_contract_meta).
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

  it("anchors schema_version rows at versions [1, 2, 3]", () => {
    // The `ORDER BY version` is load-bearing: without it the row order is
    // insertion-order luck and the assertion would silently stop pinning
    // which versions landed.
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("is idempotent when applyMigrations runs twice", () => {
    // Second invocation must be a no-op (the migration runner short-
    // circuits via hasMigrationApplied per version). Re-running must not
    // throw, must not double-insert any schema_version anchor row, must
    // not duplicate tables. Three DISTINCT versions [1, 2, 3] is not
    // duplication.
    applyMigrations(db);
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows).toHaveLength(3);
    expect(versionRows.map((r) => r.version)).toEqual([1, 2, 3]);
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

// Plan-005 PR #159 — version-3 migration-shape coverage.
//
// Pins the column set, NOT NULL flags, primary-key shape, DEFAULT clauses,
// and CHECK-constraint enforcement of the four Plan-005 Local SQLite tables
// (`runtime_bindings`, `driver_capabilities`, `driver_tools`,
// `driver_contract_meta`). Schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Driver and Runtime Binding Tables (Plan-005)" /
// `migrations/0003-runtime-bindings.ts`.
//
// Asserted via PRAGMA table_info (explicit field-by-field) plus behavioral
// CHECK-rejection inserts, NOT `toMatchSnapshot`, so this block adds no
// entries to the 0001 immutability `.snap` file. Scope is the four new tables
// only. The CHECK-rejection tests verify the provider-output defense-in-depth
// layer actually fires (column presence alone would not prove the bound
// landed), encoding the spec_coverage cites:
//   * `Spec-005 §Required Behavior` — driver-contract operations persist provider session
//     handles (runtime_bindings is the persistence surface).
//   * `Spec-005 §Required Behavior` — provider-owned resume handles persisted separately from
//     canonical run ids (runtime_bindings.resume_handle is nullable + distinct
//     from id / run_id).
describe("0003-runtime-bindings migration shape", () => {
  let db: DatabaseType;

  beforeEach(() => {
    // Mirror the 0001/0002 blocks: in-memory DB, applyPragmas +
    // applyMigrations (which now applies version-1, version-2, and version-3).
    // applyPragmas enables foreign_keys = ON; CHECK constraints are always
    // enforced regardless of pragma state.
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("pins the column shape, single-column PK, and resume_handle nullability of `runtime_bindings`", () => {
    const columns = db
      .prepare("PRAGMA table_info(runtime_bindings)")
      .all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL.
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "run_id",
      "driver_name",
      "contract_version",
      "resume_handle",
      "runtime_metadata",
      "created_at",
      "updated_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // Single-column PK on `id`; all others pk === 0.
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of [
      "run_id",
      "driver_name",
      "contract_version",
      "resume_handle",
      "runtime_metadata",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(other)?.pk).toBe(0);
    }

    // `Spec-005 §Required Behavior` — resume_handle (provider-owned handle) is persisted
    // SEPARATELY from the canonical `id` / `run_id` and is NULLABLE (a run may
    // exist before the provider issues a resume handle).
    expect(byName.get("resume_handle")?.notnull).toBe(0);

    // NOT NULL columns per the schema doc. `id` is intentionally EXCLUDED:
    // the canonical block declares it `id TEXT PRIMARY KEY` with no explicit
    // `NOT NULL`, and SQLite does NOT imply NOT NULL on a non-INTEGER PRIMARY
    // KEY column — `PRAGMA table_info.notnull` reports 0 for such a PK (a
    // documented SQLite quirk; an `INTEGER PRIMARY KEY` rowid-alias would be
    // the sole exception). This matches the existing `session_events.id`
    // shape. The NOT NULL discipline on `id` is upheld at the write seam
    // (T2.2 always supplies a generated id), not by the DDL.
    for (const required of [
      "run_id",
      "driver_name",
      "contract_version",
      "runtime_metadata",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }

    // runtime_metadata carries the JSON default `'{}'`.
    expect(byName.get("runtime_metadata")?.dflt_value).toBe("'{}'");
  });

  it("creates the `idx_runtime_bindings_run` index on run_id", () => {
    const indexes = db.prepare("PRAGMA index_list(runtime_bindings)").all() as ReadonlyArray<{
      name: string;
    }>;
    expect(indexes.map((i) => i.name)).toContain("idx_runtime_bindings_run");

    const indexedColumns = db
      .prepare("PRAGMA index_info(idx_runtime_bindings_run)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(indexedColumns.map((c) => c.name)).toEqual(["run_id"]);
  });

  // Helper: a fully-populated valid runtime_bindings row that individual
  // tests mutate one field at a time to exercise a single CHECK in isolation.
  function insertRuntimeBinding(overrides: {
    contract_version?: string;
    resume_handle?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO runtime_bindings
         (id, run_id, driver_name, contract_version, resume_handle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "binding-1",
      "run-1",
      "claude",
      overrides.contract_version ?? "1.0.0",
      overrides.resume_handle === undefined ? null : overrides.resume_handle,
      "2026-06-15T00:00:00.000Z",
      "2026-06-15T00:00:00.000Z",
    );
  }

  it("accepts a valid runtime_bindings row (baseline for the CHECK-rejection cases)", () => {
    expect(() => {
      insertRuntimeBinding({ contract_version: "1.0.0", resume_handle: "opaque-handle" });
    }).not.toThrow();
  });

  it("accepts a NULL resume_handle (the nullable provider-handle path)", () => {
    expect(() => {
      insertRuntimeBinding({ resume_handle: null });
    }).not.toThrow();
  });

  it("rejects an empty contract_version via the length CHECK", () => {
    expect(() => {
      insertRuntimeBinding({ contract_version: "" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("rejects an over-length (>64) contract_version via the length CHECK", () => {
    expect(() => {
      insertRuntimeBinding({ contract_version: "9".repeat(65) });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("accepts a contract_version at the 64-char boundary", () => {
    // Pins the ACCEPT edge of the `<= 64` length CHECK (the 65-char reject
    // above only pins the reject side). A `<= 64` → `< 64` off-by-one would
    // reject valid 64-char versions while every reject case still passed.
    // Mirrors the standalone resume_handle 4096-accept block below.
    expect(() => {
      insertRuntimeBinding({ contract_version: "9".repeat(64) });
    }).not.toThrow();
  });

  it("rejects a NUL-containing contract_version via the instr CHECK", () => {
    expect(() => {
      insertRuntimeBinding({ contract_version: `1.0.0${String.fromCharCode(0)}x` });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("rejects an empty (non-NULL) resume_handle via the length CHECK", () => {
    expect(() => {
      insertRuntimeBinding({ resume_handle: "" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("rejects an over-length (>4096) resume_handle via the length CHECK", () => {
    expect(() => {
      insertRuntimeBinding({ resume_handle: "h".repeat(4097) });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("accepts a resume_handle at the 4096-char boundary", () => {
    expect(() => {
      insertRuntimeBinding({ resume_handle: "h".repeat(4096) });
    }).not.toThrow();
  });

  it("rejects a NUL-containing resume_handle via the instr CHECK", () => {
    expect(() => {
      insertRuntimeBinding({ resume_handle: `handle${String.fromCharCode(0)}x` });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("pins the column shape and composite PK of `driver_capabilities`", () => {
    const columns = db
      .prepare("PRAGMA table_info(driver_capabilities)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((c) => c.name)).toEqual([
      "driver_name",
      "capability_flag",
      "supported",
      "refreshed_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));
    // Composite PK (driver_name, capability_flag): 1-based in declaration order.
    expect(byName.get("driver_name")?.pk).toBe(1);
    expect(byName.get("capability_flag")?.pk).toBe(2);
    expect(byName.get("supported")?.pk).toBe(0);
    expect(byName.get("refreshed_at")?.pk).toBe(0);

    // Every column is NOT NULL per the DDL. Both composite-PK columns
    // (driver_name, capability_flag) carry an EXPLICIT `NOT NULL` in the
    // CREATE TABLE, so PRAGMA table_info reports notnull=1 for them — unlike
    // the runtime_bindings.id / driver_contract_meta.driver_name single-PK
    // columns above, which omit the explicit `NOT NULL` and hit the SQLite
    // non-INTEGER-PK quirk. Mirrors the driver_tools NOT NULL loop below.
    for (const required of ["driver_name", "capability_flag", "supported", "refreshed_at"]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }

    // supported carries the integer (boolean) default 0.
    expect(byName.get("supported")?.dflt_value).toBe("0");
  });

  it("enforces the capability_flag CHECK on `driver_capabilities`", () => {
    const insertFlag = (flag: string): void => {
      db.prepare(
        `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
         VALUES (?, ?, 1, ?)`,
      ).run("claude", flag, "2026-06-15T00:00:00.000Z");
    };
    // All seven canonical flags are accepted.
    for (const flag of [
      "resume",
      "steer",
      "interactive_requests",
      "mcp",
      "tool_calls",
      "reasoning_stream",
      "model_mutation",
    ]) {
      expect(() => {
        insertFlag(flag);
      }).not.toThrow();
    }
    // An undeclared flag is rejected by the CHECK IN constraint. `pause` is the
    // canonical excluded flag per `Spec-005 §Required Behavior` + ADR-011.
    expect(() => {
      insertFlag("pause");
    }).toThrow(/CHECK constraint failed/i);
  });

  it("pins the column shape and composite PK of `driver_tools`", () => {
    const columns = db
      .prepare("PRAGMA table_info(driver_tools)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((c) => c.name)).toEqual([
      "driver_name",
      "tool_name",
      "idempotency_class",
      "description",
      "refreshed_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));
    // Composite PK (driver_name, tool_name).
    expect(byName.get("driver_name")?.pk).toBe(1);
    expect(byName.get("tool_name")?.pk).toBe(2);
    expect(byName.get("idempotency_class")?.pk).toBe(0);
    expect(byName.get("description")?.pk).toBe(0);
    expect(byName.get("refreshed_at")?.pk).toBe(0);

    // description is nullable; all other columns are NOT NULL.
    expect(byName.get("description")?.notnull).toBe(0);
    for (const required of ["driver_name", "tool_name", "idempotency_class", "refreshed_at"]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
  });

  it("enforces the idempotency_class CHECK on `driver_tools`", () => {
    const insertTool = (idempotencyClass: string): void => {
      db.prepare(
        `INSERT INTO driver_tools (driver_name, tool_name, idempotency_class, refreshed_at)
         VALUES (?, ?, ?, ?)`,
      ).run("claude", `tool-${idempotencyClass}`, idempotencyClass, "2026-06-15T00:00:00.000Z");
    };
    // The three canonical idempotency classes are accepted.
    for (const idempotencyClass of ["idempotent", "compensable", "manual_reconcile_only"]) {
      expect(() => {
        insertTool(idempotencyClass);
      }).not.toThrow();
    }
    // An out-of-enum value is rejected.
    expect(() => {
      insertTool("best_effort");
    }).toThrow(/CHECK constraint failed/i);
  });

  it("pins the column shape and single-column PK of `driver_contract_meta`", () => {
    const columns = db
      .prepare("PRAGMA table_info(driver_contract_meta)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((c) => c.name)).toEqual(["driver_name", "contract_version", "refreshed_at"]);

    const byName = new Map(columns.map((c) => [c.name, c]));
    // Single-column PK on driver_name (per-driver parent row).
    expect(byName.get("driver_name")?.pk).toBe(1);
    expect(byName.get("contract_version")?.pk).toBe(0);
    expect(byName.get("refreshed_at")?.pk).toBe(0);

    // contract_version + refreshed_at are NOT NULL. `driver_name` is the PK
    // column declared `driver_name TEXT PRIMARY KEY` (no explicit NOT NULL),
    // so SQLite reports notnull=0 for it (same non-INTEGER-PK quirk as
    // runtime_bindings.id above) — the doc does not put an explicit NOT NULL
    // on this PK, unlike node_trust_state.node_id which is `TEXT NOT NULL
    // PRIMARY KEY`.
    expect(byName.get("driver_name")?.notnull).toBe(0);
    expect(byName.get("contract_version")?.notnull).toBe(1);
    expect(byName.get("refreshed_at")?.notnull).toBe(1);
  });

  it("enforces the contract_version CHECK on `driver_contract_meta` (mirrors runtime_bindings)", () => {
    const insertMeta = (contractVersion: string, driverName = "claude"): void => {
      // driverName is parameterized (default "claude") so the two ACCEPT cases
      // can use distinct PK rows: driver_contract_meta.driver_name is the PK, so
      // a second successful insert with the same name would hit a UNIQUE
      // constraint (not a CHECK), failing `.not.toThrow()`. Reject cases fail on
      // the CHECK before the PK is evaluated, so they keep the default name.
      db.prepare(
        `INSERT INTO driver_contract_meta (driver_name, contract_version, refreshed_at)
         VALUES (?, ?, ?)`,
      ).run(driverName, contractVersion, "2026-06-15T00:00:00.000Z");
    };
    // Valid version accepted.
    expect(() => {
      insertMeta("2.1.0");
    }).not.toThrow();
    // Empty / over-length / NUL-containing rejected — same bound as
    // runtime_bindings.contract_version (the two are kept consistent).
    expect(() => {
      insertMeta("");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertMeta("9".repeat(65));
    }).toThrow(/CHECK constraint failed/i);
    // Accept edge of the `<= 64` length CHECK — pins the boundary so a
    // `<= 64` → `< 64` off-by-one is caught (mirrors the runtime_bindings
    // 64-char accept case + the resume_handle 4096-accept precedent). Uses a
    // distinct PK ("codex") to avoid colliding with the "2.1.0" accept row.
    expect(() => {
      insertMeta("9".repeat(64), "codex");
    }).not.toThrow();
    expect(() => {
      insertMeta(`2.1.0${String.fromCharCode(0)}x`);
    }).toThrow(/CHECK constraint failed/i);
  });
});
