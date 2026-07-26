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

import { applyMigrations, applyPragmas, openDatabase } from "../migration-runner.js";

// Bound to exported identifiers so `Plan-010 §References` can anchor at the
// two forward-FK tests durably. The docs-corpus symbol gate matches an
// identifier-shaped anchor PRESENT IN THE FILE, which a spaced `it(...)` title
// can never be — so that row previously anchored at the imported
// `applyPragmas` helper, which kept validating after either test was renamed
// or deleted and so presented the behaviour as covered when it was not
// (Codex review, PR #254 round 5). Renaming or removing either test now forces
// a change to the identifier the citation names, breaking the cite loudly.
export const WRITE_INERT_ON_PARENTLESS_DB_TEST: string =
  "ships write-inert on a parent-less db: the referencing INSERT fails to compile, not as an FK violation";
export const FORWARD_REFERENCES_DML_ENFORCEMENT_TEST: string =
  "enforces the forward REFERENCES clauses at DML time under foreign_keys = ON";

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
// version-3 tables + Plan-010 version-4 tables). Alphabetical by SQLite's
// `ORDER BY name` — BINARY collation, so `_` (0x5F) sorts before every
// lowercase letter and `run_execution_contexts` precedes `runtime_bindings`.
// Kept separate from `PLAN_001_TABLES` so the snapshot loop's
// 0001-immutability guard is unaffected by the 0002 / 0003 / 0004 additions.
const ALL_EXPECTED_TABLES: ReadonlyArray<string> = [
  "branch_contexts",
  "driver_capabilities",
  "driver_contract_meta",
  "driver_tools",
  "ephemeral_clones",
  "node_capabilities",
  "node_trust_state",
  "participant_keys",
  "run_execution_contexts",
  "runtime_bindings",
  "schema_version",
  "session_events",
  "session_snapshots",
  "worktrees",
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
    // (mirrors session-service.test.ts pattern) so this block exercises the
    // applyPragmas + applyMigrations pair as separate steps — the same
    // sequence the canonical openDatabase wrapper composes internally.
    // openDatabase accepts ":memory:" just as well (the 0004 block below
    // opens that way, as do sibling daemon test files); the inline spelling
    // here mirrors the sibling test, it is not a factory limitation.
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
    // After version-4 (Plan-010) the DB holds the full fourteen-table set:
    // the four Plan-001 tables, the two Plan-003 tables (node_capabilities,
    // node_trust_state), the four Plan-005 tables (runtime_bindings,
    // driver_capabilities, driver_tools, driver_contract_meta), and the
    // four Plan-010 tables (worktrees, ephemeral_clones, branch_contexts,
    // run_execution_contexts).
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

  it("anchors schema_version rows at versions [1, 2, 3, 4]", () => {
    // The `ORDER BY version` is load-bearing: without it the row order is
    // insertion-order luck and the assertion would silently stop pinning
    // which versions landed.
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it("is idempotent when applyMigrations runs twice", () => {
    // Second invocation must be a no-op (the migration runner short-
    // circuits via hasMigrationApplied per version). Re-running must not
    // throw, must not double-insert any schema_version anchor row, must
    // not duplicate tables. Four DISTINCT versions [1, 2, 3, 4] is not
    // duplication.
    applyMigrations(db);
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows).toHaveLength(4);
    expect(versionRows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
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

// Plan-010 PR #253 — version-4 migration-shape coverage.
//
// Pins the column set, NOT NULL flags, primary-key shape, DEFAULT clauses,
// index shape (including the two partial-unique indexes), and the behavioral
// CHECK / UNIQUE / FK enforcement of the four Plan-010 Local SQLite tables
// (`worktrees`, `ephemeral_clones`, `branch_contexts`,
// `run_execution_contexts`). Schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Workspace and Git Tables (Plan-009, Plan-010, Plan-011)" /
// `migrations/0004-worktree-lifecycle.ts`.
//
// Asserted via PRAGMA table_info / index_list / index_info (explicit
// field-by-field) plus behavioral rejection inserts, NOT `toMatchSnapshot`,
// so this block adds no entries to the 0001 immutability `.snap` file.
// The cross-migration table census and runner-guard idempotency (double
// apply) are pinned by the shared 0001-block tests above and not re-tested
// here. Fresh-apply and the version-4 anchor row ARE re-asserted below, but
// only on a parent-less handle, where the claim is narrower: the CREATEs and
// the anchor row land atomically even though the forward REFERENCES targets
// do not exist.
//
// Shape-checkable spec/invariant cites:
//   * Spec-010 §State And Data Implications — worktree records persist
//     branch, mount, lifecycle state, and creating-session/run provenance
//     (I-010-3); the per-run execution binding persists workspace, mode,
//     roots, and git_common_dir with mode-conditional root identity; branch
//     context is a polymorphic carrier whose at-most-one-root CHECK holds
//     (I-010-5).
//   * I-010-4 — the partial-unique `idx_worktrees_active_branch` (WHERE
//     state NOT IN 'retired', 'failed') is the at-most-one-live-checkout
//     race arbiter.
//   * I-010-2 (DDL half) — the CHECK clauses ship verbatim inside the
//     exported migration constant; byte-lockstep with the `worktree.ts`
//     contract enums is owned by the T1.4 conformance test, NOT asserted
//     here.
//
// Plan-009 fixture stubs (B23 forward-reference ordering): the migration's
// `REFERENCES repo_mounts(id)` / `REFERENCES workspaces(id)` clauses target
// Plan-009 Phase 2 tables that no migration creates yet. SQLite resolves FK
// targets lazily at DML time, so the CREATEs apply on a fresh db and the
// referencing INSERT is what fails while a parent table is absent — as a
// `SQLITE_ERROR` statement-compile failure (`no such table: main.<parent>`),
// NOT a `FOREIGN KEY constraint failed` violation. That shipped write-inert
// state is pinned by its own test below; the stub-backed handle this block
// otherwise uses reaches the true FK-constraint class, where the parent
// TABLE exists and only the parent ROW is missing. The insert-shaped tests
// below therefore create minimal id-only FIXTURE STUBS for the two parent
// tables — NOT verbatim Plan-009 DDL (Plan-009 owns those tables' real
// shape). Plain CREATE (not IF NOT EXISTS) on purpose: when
// Plan-009's migration lands the real tables, this fixture throws "table
// already exists" — the loud signal to replace the stubs with fixture rows
// against the real DDL.
describe("0004-worktree-lifecycle migration shape", () => {
  let db: DatabaseType;

  const FIXTURE_TIMESTAMP: string = "2026-07-05T00:00:00.000Z";

  beforeEach(() => {
    // Canonical factory (Plan-001): ":memory:" is better-sqlite3's in-memory
    // database-path spelling, so `openDatabase` composes the pinned
    // applyPragmas → applyMigrations order for this block too. The migration
    // itself applies BEFORE the stubs below exist, so every run of this
    // block exercises the B23 lazy-FK forward reference.
    db = openDatabase(":memory:");
    db.exec(`
      -- FIXTURE STUBS pending Plan-009 Phase 2 (NOT verbatim Plan-009 DDL —
      -- Plan-009 owns the real repo_mounts / workspaces shape). Minimal
      -- id-only parents so the version-4 REFERENCES clauses resolve at DML
      -- time under foreign_keys = ON.
      CREATE TABLE repo_mounts (id TEXT PRIMARY KEY);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    `);
    db.prepare("INSERT INTO repo_mounts (id) VALUES (?)").run("mount-1");
    db.prepare("INSERT INTO workspaces (id) VALUES (?)").run("workspace-1");
  });

  afterEach(() => {
    db.close();
  });

  // Helpers: fully-populated valid rows; tests override the identity /
  // constraint-relevant fields to exercise one constraint at a time. Every
  // referenced parent row is created by the test before use (including in
  // reject cases), so a rejection is attributable to the constraint under
  // test — never to a dangling FK.

  function insertWorktreeRow(overrides: {
    id: string;
    repoMountId?: string;
    branchName?: string;
    state?: string;
  }): void {
    db.prepare(
      `INSERT INTO worktrees
         (id, repo_mount_id, created_by_session_id, created_by_run_id, branch_name, fs_root, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      overrides.repoMountId ?? "mount-1",
      "session-1",
      null,
      overrides.branchName ?? "feature/checkout",
      `/execution-roots/worktrees/${overrides.id}`,
      overrides.state ?? "ready",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  // State transitions (not just inserts) move rows across the
  // `idx_worktrees_active_branch` predicate boundary, so the arbiter's
  // index-entry REMOVAL and re-INSERT paths need their own driver.
  function updateWorktreeState(worktreeId: string, state: string): void {
    db.prepare("UPDATE worktrees SET state = ?, updated_at = ? WHERE id = ?").run(
      state,
      FIXTURE_TIMESTAMP,
      worktreeId,
    );
  }

  function insertEphemeralCloneRow(overrides: {
    id: string;
    state?: string;
    cleanupPolicy?: string;
  }): void {
    db.prepare(
      `INSERT INTO ephemeral_clones
         (id, workspace_id, clone_root, branch_name, cleanup_policy, state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      "workspace-1",
      `/execution-roots/clones/${overrides.id}`,
      "feature/clone-head",
      overrides.cleanupPolicy ?? "on_run_complete",
      overrides.state ?? "ready",
      "2026-07-06T00:00:00.000Z",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  function insertBranchContextRow(overrides: {
    id: string;
    worktreeId?: string | null;
    ephemeralCloneId?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO branch_contexts
         (id, workspace_id, worktree_id, ephemeral_clone_id, base_branch, head_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      "workspace-1",
      overrides.worktreeId === undefined ? null : overrides.worktreeId,
      overrides.ephemeralCloneId === undefined ? null : overrides.ephemeralCloneId,
      "main",
      "feature/checkout",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  function insertRunExecutionContextRow(overrides: {
    runId: string;
    executionMode: string;
    worktreeId?: string | null;
    ephemeralCloneId?: string | null;
    branchContextId?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO run_execution_contexts
         (run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir, worktree_id, ephemeral_clone_id, branch_context_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.runId,
      "session-1",
      "workspace-1",
      overrides.executionMode,
      "/execution-roots/run-root",
      "/repo/.git",
      overrides.worktreeId === undefined ? null : overrides.worktreeId,
      overrides.ephemeralCloneId === undefined ? null : overrides.ephemeralCloneId,
      overrides.branchContextId === undefined ? null : overrides.branchContextId,
      FIXTURE_TIMESTAMP,
    );
  }

  it("applies on a fresh db whose FK-target tables (repo_mounts, workspaces) do not exist yet", () => {
    // B23 forward-reference ordering: SQLite resolves REFERENCES targets
    // lazily at DML time, so the version-4 CREATEs land on a database that
    // has never seen a Plan-009 migration. This second handle gets NO
    // fixture stubs — the assertion is on the migration alone.
    const freshDb: DatabaseType = openDatabase(":memory:");
    try {
      const tableRows = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as ReadonlyArray<{ name: string }>;
      const tableNames: ReadonlyArray<string> = tableRows.map((row) => row.name);
      for (const plan010Table of [
        "worktrees",
        "ephemeral_clones",
        "branch_contexts",
        "run_execution_contexts",
      ]) {
        expect(tableNames).toContain(plan010Table);
      }
      // The migration must NOT create the Plan-009 parents itself — the
      // stubs in beforeEach are test fixture, not migration content.
      expect(tableNames).not.toContain("repo_mounts");
      expect(tableNames).not.toContain("workspaces");
      // The version-4 anchor row landed atomically with the CREATEs.
      const anchorRow = freshDb
        .prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = 4")
        .get() as { count: number };
      expect(anchorRow.count).toBe(1);
    } finally {
      freshDb.close();
    }
  });

  it(WRITE_INERT_ON_PARENTLESS_DB_TEST, () => {
    // The state the daemon actually ships in until Plan-009 Phase 2 lands.
    // Empirically discovered against the pinned toolchain (better-sqlite3
    // 12.9.0 / SQLite 3.53.0): with the parent TABLE absent, SQLite refuses
    // the statement outright — `SQLITE_ERROR: no such table:
    // main.repo_mounts` — and never reaches constraint evaluation, so the
    // error class is NOT the `FOREIGN KEY constraint failed`
    // (SQLITE_CONSTRAINT_FOREIGNKEY) the stub-backed negative control below
    // produces, where the parent TABLE exists and only the parent ROW is
    // missing. Any future caller that discriminates FK failures by message
    // would miss this one, so both halves are pinned. The throw actually
    // surfaces at prepare(), before a value is bound; prepare and run stay
    // inside one block so the pin does not depend on which phase raises.
    const parentlessDb: DatabaseType = openDatabase(":memory:");
    try {
      expect(parentlessDb.pragma("foreign_keys", { simple: true })).toBe(1);

      let observedError: unknown;
      try {
        parentlessDb
          .prepare(
            `INSERT INTO worktrees
               (id, repo_mount_id, created_by_session_id, branch_name, fs_root, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "worktree-parentless",
            "mount-1",
            "session-1",
            "feature/parentless",
            "/execution-roots/worktrees/worktree-parentless",
            "ready",
            FIXTURE_TIMESTAMP,
            FIXTURE_TIMESTAMP,
          );
      } catch (error) {
        observedError = error;
      }
      expect(observedError).toBeInstanceOf(Error);
      // `code` is better-sqlite3's SqliteError discriminator — the crisp half
      // of the pin; the message text is the brittle half.
      expect((observedError as { code?: string }).code).toBe("SQLITE_ERROR");
      expect((observedError as Error).message).toMatch(/no such table: main\.repo_mounts/i);
      expect((observedError as Error).message).not.toMatch(/FOREIGN KEY constraint failed/i);

      // The `workspaces` forward reference is inert by the same mechanism.
      expect(() => {
        parentlessDb
          .prepare(
            `INSERT INTO ephemeral_clones
               (id, workspace_id, clone_root, branch_name, cleanup_policy, state, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "clone-parentless",
            "workspace-1",
            "/execution-roots/clones/clone-parentless",
            "feature/clone-head",
            "on_run_complete",
            "ready",
            "2026-07-06T00:00:00.000Z",
            FIXTURE_TIMESTAMP,
            FIXTURE_TIMESTAMP,
          );
      }).toThrow(/no such table: main\.workspaces/i);
    } finally {
      parentlessDb.close();
    }
  });

  it(FORWARD_REFERENCES_DML_ENFORCEMENT_TEST, () => {
    // Negative control for the fixture-stub pattern: proves FK enforcement
    // is live on this handle, so the stub-backed accepts in this block pass
    // because the parents exist — not because enforcement is silently off —
    // and proves the REFERENCES clauses shipped un-stripped.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => {
      insertWorktreeRow({ id: "worktree-dangling", repoMountId: "missing-mount" });
    }).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => {
      insertWorktreeRow({ id: "worktree-stubbed" });
    }).not.toThrow();
  });

  it("pins the column shape, single-column PK, and provenance columns of `worktrees`", () => {
    const columns = db.prepare("PRAGMA table_info(worktrees)").all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL.
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "repo_mount_id",
      "created_by_session_id",
      "created_by_run_id",
      "branch_name",
      "fs_root",
      "state",
      "created_at",
      "updated_at",
      "cleaned_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // Single-column PK on `id`; all others pk === 0.
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of [
      "repo_mount_id",
      "created_by_session_id",
      "created_by_run_id",
      "branch_name",
      "fs_root",
      "state",
      "created_at",
      "updated_at",
      "cleaned_at",
    ]) {
      expect(byName.get(other)?.pk).toBe(0);
    }

    // I-010-3 provenance: created_by_session_id is mandatory;
    // created_by_run_id is nullable (NULL = pre-run explicit prepare).
    expect(byName.get("created_by_session_id")?.notnull).toBe(1);
    expect(byName.get("created_by_run_id")?.notnull).toBe(0);

    // NOT NULL columns per the DDL. `id` is excluded: `id TEXT PRIMARY KEY`
    // without an explicit `NOT NULL` reports notnull=0 (the SQLite
    // non-INTEGER-PK quirk documented on the 0003 block above).
    for (const required of [
      "repo_mount_id",
      "branch_name",
      "fs_root",
      "state",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    // cleaned_at is the nullable async disk-cleanup stamp.
    expect(byName.get("cleaned_at")?.notnull).toBe(0);

    // state defaults to 'creating'.
    expect(byName.get("state")?.dflt_value).toBe("'creating'");
  });

  it("creates idx_worktrees_repo and the partial-unique idx_worktrees_active_branch", () => {
    const indexes = db.prepare("PRAGMA index_list(worktrees)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      partial: 0 | 1;
    }>;
    const byIndexName = new Map(indexes.map((index) => [index.name, index]));

    expect(byIndexName.get("idx_worktrees_repo")?.unique).toBe(0);
    const repoIndexColumns = db
      .prepare("PRAGMA index_info(idx_worktrees_repo)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(repoIndexColumns.map((c) => c.name)).toEqual(["repo_mount_id"]);

    // I-010-4 race arbiter: UNIQUE + partial (WHERE state NOT IN
    // ('retired', 'failed')) on (repo_mount_id, branch_name).
    expect(byIndexName.get("idx_worktrees_active_branch")?.unique).toBe(1);
    expect(byIndexName.get("idx_worktrees_active_branch")?.partial).toBe(1);
    const activeBranchColumns = db
      .prepare("PRAGMA index_info(idx_worktrees_active_branch)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(activeBranchColumns.map((c) => c.name)).toEqual(["repo_mount_id", "branch_name"]);
  });

  it("admits a second worktree on the same (mount, branch) once the first is retired", () => {
    insertWorktreeRow({ id: "worktree-retired", branchName: "feature/login", state: "retired" });
    expect(() => {
      insertWorktreeRow({ id: "worktree-live", branchName: "feature/login", state: "ready" });
    }).not.toThrow();
  });

  it("rejects two live worktrees on the same (mount, branch) via idx_worktrees_active_branch", () => {
    insertWorktreeRow({ id: "worktree-first-live", branchName: "feature/login", state: "ready" });
    expect(() => {
      insertWorktreeRow({
        id: "worktree-second-live",
        branchName: "feature/login",
        state: "creating",
      });
    }).toThrow(/UNIQUE constraint failed/i);
  });

  it("treats 'failed' as non-live but 'merged' as still holding the branch", () => {
    // Predicate edges of `WHERE state NOT IN ('retired', 'failed')`: a
    // failed checkout releases the branch; a merged checkout still exists
    // on disk and still holds it (schema-doc comment: "any non-retired,
    // non-failed state, including 'merged'").
    insertWorktreeRow({
      id: "worktree-failed",
      branchName: "feature/failed-then-retry",
      state: "failed",
    });
    expect(() => {
      insertWorktreeRow({
        id: "worktree-retry",
        branchName: "feature/failed-then-retry",
        state: "ready",
      });
    }).not.toThrow();

    insertWorktreeRow({
      id: "worktree-merged",
      branchName: "feature/merged-still-held",
      state: "merged",
    });
    expect(() => {
      insertWorktreeRow({
        id: "worktree-after-merge",
        branchName: "feature/merged-still-held",
        state: "ready",
      });
    }).toThrow(/UNIQUE constraint failed/i);
  });

  it("readmits a live worktree on the same (mount, branch) after the holder is UPDATEd to 'retired'", () => {
    // The production retire-then-recreate lifecycle. The already-retired
    // INSERT cases above never place an entry in the partial index at all;
    // this is the only path that exercises index-entry REMOVAL, because the
    // first row genuinely occupies the index before the UPDATE evicts it.
    insertWorktreeRow({ id: "worktree-holder", branchName: "feature/recreate", state: "ready" });
    updateWorktreeState("worktree-holder", "retired");
    expect(() => {
      insertWorktreeRow({
        id: "worktree-recreated",
        branchName: "feature/recreate",
        state: "creating",
      });
    }).not.toThrow();
  });

  it("rejects an UPDATE that moves a non-live worktree back into the live set on a held (mount, branch)", () => {
    // The reverse transition: the arbiter must also fire on the index-entry
    // INSERT an UPDATE drives, not only on row INSERT. A resurrect-on-retry
    // bug would otherwise put two live checkouts on one branch — exactly the
    // I-010-4 race the partial index exists to arbitrate.
    insertWorktreeRow({ id: "worktree-live", branchName: "feature/resurrect", state: "ready" });
    insertWorktreeRow({
      id: "worktree-retired",
      branchName: "feature/resurrect",
      state: "retired",
    });
    expect(() => {
      updateWorktreeState("worktree-retired", "ready");
    }).toThrow(/UNIQUE constraint failed/i);
  });

  it("enforces the state CHECK on `worktrees`", () => {
    // Behavioral proof that SQLite enforces the enum. T1.4's conformance test
    // string-extracts the CHECK text from the migration constant, which
    // cannot show the constraint fires. Each accept takes a distinct branch
    // so the live states do not collide on idx_worktrees_active_branch.
    for (const state of ["creating", "ready", "dirty", "merged", "retired", "failed"]) {
      expect(() => {
        insertWorktreeRow({
          id: `worktree-state-${state}`,
          branchName: `feature/state-${state}`,
          state,
        });
      }).not.toThrow();
    }
    expect(() => {
      insertWorktreeRow({
        id: "worktree-state-archived",
        branchName: "feature/state-archived",
        state: "archived",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("pins the column shape and TTL/cleanup bookkeeping of `ephemeral_clones`", () => {
    const columns = db
      .prepare("PRAGMA table_info(ephemeral_clones)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "workspace_id",
      "clone_root",
      "branch_name",
      "cleanup_policy",
      "state",
      "expires_at",
      "created_at",
      "updated_at",
      "cleaned_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // Single-column PK on `id` (notnull=0 per the non-INTEGER-PK quirk). The
    // pk === 0 sweep over every other column is what makes "single-column" an
    // assertion rather than a comment — widening to a composite PK would
    // otherwise pass. Mirrors the `worktrees` loop above.
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of [
      "workspace_id",
      "clone_root",
      "branch_name",
      "cleanup_policy",
      "state",
      "expires_at",
      "created_at",
      "updated_at",
      "cleaned_at",
    ]) {
      expect(byName.get(other)?.pk).toBe(0);
    }

    // TTL deadline is mandatory; cleaned_at is the nullable cleanup stamp.
    for (const required of [
      "workspace_id",
      "clone_root",
      "branch_name",
      "cleanup_policy",
      "state",
      "expires_at",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    expect(byName.get("cleaned_at")?.notnull).toBe(0);

    // DEFAULT clauses: cleanup_policy 'on_run_complete', state 'creating'.
    expect(byName.get("cleanup_policy")?.dflt_value).toBe("'on_run_complete'");
    expect(byName.get("state")?.dflt_value).toBe("'creating'");
  });

  it("creates idx_ephemeral_clones_workspace and the (state, expires_at) sweep index, both non-unique", () => {
    const indexes = db.prepare("PRAGMA index_list(ephemeral_clones)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
    }>;
    const byIndexName = new Map(indexes.map((index) => [index.name, index]));

    // `unique === 0` is load-bearing, not decoration: an accidental
    // CREATE UNIQUE INDEX here would cap the workspace at one ephemeral clone
    // and the whole daemon at one clone per (state, TTL deadline) — a
    // functional break that index_info alone cannot see.
    expect(byIndexName.get("idx_ephemeral_clones_workspace")?.unique).toBe(0);
    const workspaceIndexColumns = db
      .prepare("PRAGMA index_info(idx_ephemeral_clones_workspace)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(workspaceIndexColumns.map((c) => c.name)).toEqual(["workspace_id"]);

    // The sweep index serves the cleanup tick: scan by state, then TTL
    // deadline — column order is load-bearing.
    expect(byIndexName.get("idx_ephemeral_clones_sweep")?.unique).toBe(0);
    const sweepIndexColumns = db
      .prepare("PRAGMA index_info(idx_ephemeral_clones_sweep)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(sweepIndexColumns.map((c) => c.name)).toEqual(["state", "expires_at"]);
  });

  it("enforces the state CHECK on `ephemeral_clones`", () => {
    // The clone enum is NARROWER than the worktree enum — no 'dirty', no
    // 'merged' (a clone is disposable, never merged in place). 'dirty' is
    // therefore the sharpest out-of-enum probe: it is valid for `worktrees`
    // and must still be rejected here.
    for (const state of ["creating", "ready", "retired", "failed"]) {
      expect(() => {
        insertEphemeralCloneRow({ id: `clone-state-${state}`, state });
      }).not.toThrow();
    }
    expect(() => {
      insertEphemeralCloneRow({ id: "clone-state-dirty", state: "dirty" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the cleanup_policy CHECK on `ephemeral_clones`", () => {
    for (const cleanupPolicy of ["on_run_complete", "manual"]) {
      expect(() => {
        insertEphemeralCloneRow({ id: `clone-policy-${cleanupPolicy}`, cleanupPolicy });
      }).not.toThrow();
    }
    // 'never' is the plausible-but-undeclared policy: a caller wanting a
    // clone that outlives its run must use 'manual', not invent a third value.
    expect(() => {
      insertEphemeralCloneRow({ id: "clone-policy-never", cleanupPolicy: "never" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("pins the column shape and polymorphic-root nullability of `branch_contexts`", () => {
    const columns = db
      .prepare("PRAGMA table_info(branch_contexts)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "workspace_id",
      "worktree_id",
      "ephemeral_clone_id",
      "base_branch",
      "head_branch",
      "upstream_ref",
      "created_at",
      "updated_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // Single-column PK on `id` (notnull=0 per the non-INTEGER-PK quirk); the
    // pk === 0 sweep is what makes "single-column" an assertion rather than a
    // comment (mirrors the `worktrees` / `ephemeral_clones` loops above).
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of [
      "workspace_id",
      "worktree_id",
      "ephemeral_clone_id",
      "base_branch",
      "head_branch",
      "upstream_ref",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(other)?.pk).toBe(0);
    }

    // Polymorphic root ids and upstream_ref are nullable; everything else
    // is mandatory.
    for (const nullable of ["worktree_id", "ephemeral_clone_id", "upstream_ref"]) {
      expect(byName.get(nullable)?.notnull).toBe(0);
    }
    for (const required of [
      "workspace_id",
      "base_branch",
      "head_branch",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
  });

  it("creates idx_branch_contexts_workspace and the partial-unique idx_branch_contexts_worktree_workspace", () => {
    const indexes = db.prepare("PRAGMA index_list(branch_contexts)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      partial: 0 | 1;
    }>;
    const byIndexName = new Map(indexes.map((index) => [index.name, index]));

    // Non-unique lookup index: a UNIQUE here would cap the workspace at one
    // branch context, breaking every multi-root workspace.
    expect(byIndexName.get("idx_branch_contexts_workspace")?.unique).toBe(0);
    const workspaceIndexColumns = db
      .prepare("PRAGMA index_info(idx_branch_contexts_workspace)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(workspaceIndexColumns.map((c) => c.name)).toEqual(["workspace_id"]);

    // One binding row per (workspace, worktree) — the D-010-15 upsert
    // target: UNIQUE + partial (WHERE worktree_id IS NOT NULL). The
    // `partial === 1` metadata assertion is the ONLY guard on the WHERE
    // clause's presence: SQLite already treats NULLs as distinct in a unique
    // index, so dropping the predicate would change neither accept nor reject
    // behavior — the predicate buys index size and partial-index planning,
    // not uniqueness. The uniqueness itself is pinned behaviorally below.
    expect(byIndexName.get("idx_branch_contexts_worktree_workspace")?.unique).toBe(1);
    expect(byIndexName.get("idx_branch_contexts_worktree_workspace")?.partial).toBe(1);
    const worktreeWorkspaceColumns = db
      .prepare("PRAGMA index_info(idx_branch_contexts_worktree_workspace)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(worktreeWorkspaceColumns.map((c) => c.name)).toEqual(["worktree_id", "workspace_id"]);
  });

  it("rejects a second branch_contexts row on the same (worktree_id, workspace_id)", () => {
    // The behavioral half of the D-010-15 upsert target. Without it the index
    // is metadata-only: mutating the predicate to
    // `WHERE ephemeral_clone_id IS NOT NULL` leaves unique / partial /
    // index_info identical and every other assertion in this block green,
    // because nothing else ever puts two rows on one worktree_id.
    insertWorktreeRow({ id: "worktree-1" });
    // The helper pins workspace_id to "workspace-1", so both rows share the
    // workspace and collide on the full indexed pair.
    insertBranchContextRow({ id: "branch-context-first", worktreeId: "worktree-1" });
    // Column-qualified rather than the block's loose /UNIQUE/ matcher:
    // branch_contexts also carries the PK autoindex on `id`, so naming the
    // pair is what proves the PARTIAL index fired and not a duplicate id.
    expect(() => {
      insertBranchContextRow({ id: "branch-context-duplicate", worktreeId: "worktree-1" });
    }).toThrow(
      /UNIQUE constraint failed: branch_contexts\.worktree_id, branch_contexts\.workspace_id/i,
    );
  });

  it("admits multiple branch-mode branch_contexts rows in one workspace (worktree_id NULL on each)", () => {
    // Branch-mode representability (I-010-5): the main checkout carries no
    // Plan-010 root row, and one workspace may hold many such contexts. This
    // guards the branch-mode ARM, not the partial predicate — a NOT NULL on
    // worktree_id, a COALESCE(worktree_id, '') index expression, or an
    // at-most-one-root CHECK tightened to exactly-one would each break it.
    // It is deliberately NOT a predicate pin: under SQLite's NULL
    // distinctness these rows never enter the unique index at all, whether
    // the predicate is the shipped one, a mutated one, or absent.
    insertBranchContextRow({ id: "branch-context-branch-mode-a" });
    expect(() => {
      insertBranchContextRow({ id: "branch-context-branch-mode-b" });
    }).not.toThrow();
  });

  it("accepts one branch_contexts row per polymorphic arm (worktree-bound, clone-bound, neither)", () => {
    insertWorktreeRow({ id: "worktree-1" });
    insertEphemeralCloneRow({ id: "clone-1" });
    // I-010-5 representability: worktree rows reference the worktree, clone
    // rows the clone, branch-mode rows neither.
    expect(() => {
      insertBranchContextRow({ id: "branch-context-worktree", worktreeId: "worktree-1" });
    }).not.toThrow();
    expect(() => {
      insertBranchContextRow({ id: "branch-context-clone", ephemeralCloneId: "clone-1" });
    }).not.toThrow();
    expect(() => {
      insertBranchContextRow({ id: "branch-context-branch-mode" });
    }).not.toThrow();
  });

  it("rejects a branch_contexts row carrying both worktree_id and ephemeral_clone_id", () => {
    insertWorktreeRow({ id: "worktree-1" });
    insertEphemeralCloneRow({ id: "clone-1" });
    // Both parents exist, so the rejection below is the at-most-one-root
    // CHECK — not an FK failure.
    expect(() => {
      insertBranchContextRow({
        id: "branch-context-both",
        worktreeId: "worktree-1",
        ephemeralCloneId: "clone-1",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("pins the column shape of `run_execution_contexts` (git_common_dir NOT NULL)", () => {
    const columns = db
      .prepare("PRAGMA table_info(run_execution_contexts)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((c) => c.name)).toEqual([
      "run_id",
      "session_id",
      "workspace_id",
      "execution_mode",
      "execution_root",
      "git_common_dir",
      "worktree_id",
      "ephemeral_clone_id",
      "branch_context_id",
      "created_at",
      "released_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // PK on run_id — event-sourced run id, PRIMARY KEY without FK
    // (notnull=0 per the non-INTEGER-PK quirk). The pk === 0 sweep pins the
    // PK as single-column: at-most-one execution context per run is the
    // whole point, and a composite PK would silently allow several.
    expect(byName.get("run_id")?.pk).toBe(1);
    for (const other of [
      "session_id",
      "workspace_id",
      "execution_mode",
      "execution_root",
      "git_common_dir",
      "worktree_id",
      "ephemeral_clone_id",
      "branch_context_id",
      "created_at",
      "released_at",
    ]) {
      expect(byName.get(other)?.pk).toBe(0);
    }

    // git_common_dir is mandatory (the surviving canonical git dir for
    // snapshot-ref ops), alongside the other required binding columns.
    for (const required of [
      "session_id",
      "workspace_id",
      "execution_mode",
      "execution_root",
      "git_common_dir",
      "created_at",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    // Mode-conditional root ids and the run-terminal release stamp are
    // nullable.
    for (const nullable of [
      "worktree_id",
      "ephemeral_clone_id",
      "branch_context_id",
      "released_at",
    ]) {
      expect(byName.get(nullable)?.notnull).toBe(0);
    }

    // Unlike workspaces.execution_mode, a run's mode carries NO row default:
    // execution mode is always explicit run setup data.
    expect(byName.get("execution_mode")?.dflt_value).toBeNull();
  });

  it("creates idx_run_execution_contexts_workspace as a non-unique lookup index", () => {
    const indexes = db.prepare("PRAGMA index_list(run_execution_contexts)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
    }>;
    const byIndexName = new Map(indexes.map((index) => [index.name, index]));

    // A UNIQUE here would cap the workspace at one run execution context
    // ever — the workspace is the many side of this relation.
    expect(byIndexName.get("idx_run_execution_contexts_workspace")?.unique).toBe(0);
    const workspaceIndexColumns = db
      .prepare("PRAGMA index_info(idx_run_execution_contexts_workspace)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(workspaceIndexColumns.map((c) => c.name)).toEqual(["workspace_id"]);
  });

  it("accepts one in-shape run_execution_contexts row per execution mode", () => {
    insertWorktreeRow({ id: "worktree-1" });
    insertEphemeralCloneRow({ id: "clone-1" });
    insertBranchContextRow({ id: "branch-context-worktree", worktreeId: "worktree-1" });
    insertBranchContextRow({ id: "branch-context-clone", ephemeralCloneId: "clone-1" });
    insertBranchContextRow({ id: "branch-context-branch-mode" });

    // The four arms of the mode-conditional CHECK, one accept each. NOTE
    // 'ephemeral clone' is spelled with a SPACE in the DDL enum.
    expect(() => {
      insertRunExecutionContextRow({ runId: "run-read-only", executionMode: "read-only" });
    }).not.toThrow();
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-branch",
        executionMode: "branch",
        branchContextId: "branch-context-branch-mode",
      });
    }).not.toThrow();
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-worktree",
        executionMode: "worktree",
        worktreeId: "worktree-1",
        branchContextId: "branch-context-worktree",
      });
    }).not.toThrow();
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-ephemeral-clone",
        executionMode: "ephemeral clone",
        ephemeralCloneId: "clone-1",
        branchContextId: "branch-context-clone",
      });
    }).not.toThrow();
  });

  it("enforces the execution_mode CHECK on `run_execution_contexts`", () => {
    // Accepts for all four canonical modes live in the test above; this is
    // the missing reject half. An out-of-enum mode ALSO fails the
    // mode-conditional CHECK (no OR arm matches it), so the loose
    // /CHECK constraint failed/ matcher used elsewhere in this block could
    // not tell the two apart — the matcher below names the enum CHECK's own
    // expression to prove which constraint fired. It stops at the opening
    // paren on purpose: byte-lockstep with the `worktree.ts` contract enums
    // is T1.4's job, not this block's.
    //
    // 'ephemeral-clone' (hyphen) is the sharpest probe: the DDL spells that
    // mode with a SPACE, so the hyphen is the exact typo a caller would make.
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-hyphenated-mode",
        executionMode: "ephemeral-clone",
      });
    }).toThrow(/CHECK constraint failed: execution_mode IN \(/i);
  });

  it("rejects a worktree-mode row missing worktree_id", () => {
    insertWorktreeRow({ id: "worktree-1" });
    insertBranchContextRow({ id: "branch-context-worktree", worktreeId: "worktree-1" });
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-worktree-incomplete",
        executionMode: "worktree",
        branchContextId: "branch-context-worktree",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("rejects an ephemeral-clone-mode row carrying worktree_id", () => {
    insertWorktreeRow({ id: "worktree-1" });
    insertEphemeralCloneRow({ id: "clone-1" });
    insertBranchContextRow({ id: "branch-context-clone", ephemeralCloneId: "clone-1" });
    // Every referenced parent exists, so the mode-conditional CHECK — not
    // an FK — is what rejects the cross-mode contamination.
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-clone-with-worktree",
        executionMode: "ephemeral clone",
        ephemeralCloneId: "clone-1",
        worktreeId: "worktree-1",
        branchContextId: "branch-context-clone",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("rejects a read-only row carrying branch_context_id", () => {
    insertBranchContextRow({ id: "branch-context-branch-mode" });
    expect(() => {
      insertRunExecutionContextRow({
        runId: "run-read-only-with-context",
        executionMode: "read-only",
        branchContextId: "branch-context-branch-mode",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("rejects a run_execution_contexts row omitting git_common_dir", () => {
    // git_common_dir has no DEFAULT, so omitting it from the column list
    // resolves to NULL and the NOT NULL constraint (not a CHECK) rejects.
    expect(() => {
      db.prepare(
        `INSERT INTO run_execution_contexts
           (run_id, session_id, workspace_id, execution_mode, execution_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "run-no-git-common-dir",
        "session-1",
        "workspace-1",
        "read-only",
        "/execution-roots/run-root",
        FIXTURE_TIMESTAMP,
      );
    }).toThrow(/NOT NULL constraint failed: run_execution_contexts\.git_common_dir/i);
  });
});
