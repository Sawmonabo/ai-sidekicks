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

import { DRIVER_CAPABILITY_FLAGS } from "@ai-sidekicks/contracts";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATION_SQL } from "../../migrations/0001-initial.js";
import { RUNTIME_NODE_MIGRATION_SQL } from "../../migrations/0002-runtime-node.js";
import { RUNTIME_BINDINGS_MIGRATION_SQL } from "../../migrations/0003-runtime-bindings.js";
import { WORKTREE_LIFECYCLE_MIGRATION_SQL } from "../../migrations/0004-worktree-lifecycle.js";
import { DAEMON_SIGNING_KEYS_MIGRATION_SQL } from "../../migrations/0005-daemon-signing-keys.js";
import { RUN_LIFECYCLE_TERMINAL_BACKSTOP_MIGRATION_SQL } from "../../migrations/0006-run-lifecycle-terminal-backstop-index.js";
import { PII_PARTICIPANT_ID_MIGRATION_SQL } from "../../migrations/0007-pii-participant-id.js";
import { PENDING_ANCHOR_UPLOADS_MIGRATION_SQL } from "../../migrations/0008-pending-anchor-uploads.js";
import { RETENTION_CLASS_AND_STUB_SIGNATURE_MIGRATION_SQL } from "../../migrations/0009-retention-class-and-stub-signature.js";
import { REPO_WORKSPACES_MIGRATION_SQL } from "../../migrations/0010-repo-workspaces.js";
import { DRIVER_CAPABILITY_CURRENCY_MIGRATION_SQL } from "../../migrations/0011-driver-capability-currency.js";
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
// version-3 tables + Plan-010 version-4 tables + the two Plan-006 tables —
// version-5 `daemon_signing_keys` and version-8 `pending_anchor_uploads` —
// plus the two Plan-009 version-10 tables `repo_mounts` and `workspaces`).
// Version 11 (Plan-005) moves this census by ZERO: it rebuilds
// `driver_capabilities` in place to widen a column CHECK, and the transient
// `driver_capabilities_new` is renamed over the original within the same
// script — a leftover transient would show up here as a nineteenth table.
// Alphabetical by SQLite's `ORDER BY name` — BINARY collation, so
// `_` (0x5F) sorts before every lowercase letter and
// `run_execution_contexts` precedes `runtime_bindings`, while `workspaces`
// precedes `worktrees` on the fifth byte (`s` 0x73 < `t` 0x74). Kept
// separate from `PLAN_001_TABLES` so the snapshot loop's 0001-immutability
// guard is unaffected by the 0002 / 0003 / 0004 / 0005 / 0008 / 0010
// additions.
const ALL_EXPECTED_TABLES: ReadonlyArray<string> = [
  "branch_contexts",
  "daemon_signing_keys",
  "driver_capabilities",
  "driver_contract_meta",
  "driver_tools",
  "ephemeral_clones",
  "node_capabilities",
  "node_trust_state",
  "participant_keys",
  "pending_anchor_uploads",
  "repo_mounts",
  "run_execution_contexts",
  "runtime_bindings",
  "schema_version",
  "session_events",
  "session_snapshots",
  "workspaces",
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
    // After version-11 (Plan-005, which adds no table) the DB holds the full
    // eighteen-table set:
    // the four Plan-001 tables, the two Plan-003 tables (node_capabilities,
    // node_trust_state), the four Plan-005 tables (runtime_bindings,
    // driver_capabilities, driver_tools, driver_contract_meta), the four
    // Plan-010 tables (worktrees, ephemeral_clones, branch_contexts,
    // run_execution_contexts), the two Plan-006 tables
    // (daemon_signing_keys at v5, pending_anchor_uploads at v8), and the two
    // Plan-009 tables (repo_mounts, workspaces at v10). Version 11 rebuilds
    // driver_capabilities rather than adding anything, so this list is also
    // the assertion that its transient `driver_capabilities_new` did not
    // survive the rename.
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

  it("anchors schema_version rows at versions [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]", () => {
    // The `ORDER BY version` is load-bearing: without it the row order is
    // insertion-order luck and the assertion would silently stop pinning
    // which versions landed.
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("is idempotent when applyMigrations runs twice", () => {
    // Second invocation must be a no-op (the migration runner short-
    // circuits via hasMigrationApplied per version). Re-running must not
    // throw, must not double-insert any schema_version anchor row, must
    // not duplicate tables. Twelve DISTINCT versions [1..12] is not
    // duplication.
    //
    // Version 7 makes this arm strictly load-bearing rather than a
    // formality: it is an `ALTER TABLE ... ADD COLUMN`, and SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so a runner guard regression turns a
    // re-apply into a hard "duplicate column name" throw here. Version 6
    // is the same story for `CREATE INDEX` / `CREATE TRIGGER`, versions 8
    // and 10 for `CREATE TABLE` (no `IF NOT EXISTS` in the transcribed DDL
    // either), and version 9 for BOTH at once (two ADD COLUMNs plus a
    // CREATE INDEX). Version 11 raises the stakes again: a guard regression
    // there re-runs a table REBUILD, whose first statement (`CREATE TABLE
    // driver_capabilities_new`) throws "table already exists" only because the
    // rename that consumed it happened inside the SAME script — and whose
    // ALTERs would otherwise throw "duplicate column name" like version 7's.
    // Version 12 is the mildest of the set — its one INSERT carries
    // `ON CONFLICT ... DO NOTHING`, so it is idempotent even without the guard
    // — which is exactly why it is included here rather than trusted: the
    // schema_version anchor row it appends is NOT idempotent on its own.
    applyMigrations(db);
    const versionRows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as ReadonlyArray<{ version: number }>;
    expect(versionRows).toHaveLength(12);
    expect(versionRows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL, then
    // EXTENDED at CID-last by version 11's three `ALTER TABLE ... ADD COLUMN`
    // statements. The schema doc declares `cli_version_raw` /
    // `cli_version_semver` beside `contract_version` and `spawn_config` beside
    // `runtime_metadata` — their LOGICAL positions — while ADD COLUMN can only
    // append, the same `retention_class`-style divergence version 9 produced on
    // `session_events`. Physical order is what PRAGMA reports, so physical
    // order is what this pin records; no Plan-005 read or write depends on it
    // (every statement names its columns).
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "run_id",
      "driver_name",
      "contract_version",
      "resume_handle",
      "runtime_metadata",
      "created_at",
      "updated_at",
      "cli_version_raw",
      "cli_version_semver",
      "spawn_config",
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
      "cli_version_raw",
      "cli_version_semver",
      "spawn_config",
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

    // The version-11 columns in summary; their constraint behaviour is pinned
    // in the `0011-driver-capability-currency migration shape` block below.
    // `spawn_config` is the one NOT NULL addition, and it is NOT NULL only
    // because it carries a DEFAULT — `ADD COLUMN ... NOT NULL` with no default
    // is refused outright by SQLite.
    expect(byName.get("cli_version_raw")?.notnull).toBe(0);
    expect(byName.get("cli_version_semver")?.notnull).toBe(0);
    expect(byName.get("spawn_config")?.notnull).toBe(1);
    expect(byName.get("spawn_config")?.dflt_value).toBe("'{}'");
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
    // The seven version-3 flags remain accepted after the version-11 widening
    // — a CHECK that was widened by REPLACING the table could have dropped one
    // of them, and this loop is what would notice. The other seven admitted
    // values, and the thirteen the backfill covers, are pinned by the
    // `0011-driver-capability-currency migration shape` block below.
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

    // The last two are version-11 additions, appended at CID-last by ALTER
    // TABLE (the schema doc declares them beside `contract_version`).
    expect(columns.map((c) => c.name)).toEqual([
      "driver_name",
      "contract_version",
      "refreshed_at",
      "cli_version_raw",
      "cli_version_semver",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));
    // Single-column PK on driver_name (per-driver parent row).
    expect(byName.get("driver_name")?.pk).toBe(1);
    expect(byName.get("contract_version")?.pk).toBe(0);
    expect(byName.get("refreshed_at")?.pk).toBe(0);
    expect(byName.get("cli_version_raw")?.pk).toBe(0);
    expect(byName.get("cli_version_semver")?.pk).toBe(0);

    // contract_version + refreshed_at are NOT NULL. `driver_name` is the PK
    // column declared `driver_name TEXT PRIMARY KEY` (no explicit NOT NULL),
    // so SQLite reports notnull=0 for it (same non-INTEGER-PK quirk as
    // runtime_bindings.id above) — the doc does not put an explicit NOT NULL
    // on this PK, unlike node_trust_state.node_id which is `TEXT NOT NULL
    // PRIMARY KEY`.
    expect(byName.get("driver_name")?.notnull).toBe(0);
    expect(byName.get("contract_version")?.notnull).toBe(1);
    expect(byName.get("refreshed_at")?.notnull).toBe(1);

    // The version-11 pair is NULLABLE by design: a NULL pair is the cache-MISS
    // signal cold-start hydration refreshes from the driver rather than
    // fabricating a `cliVersion` from cache.
    expect(byName.get("cli_version_raw")?.notnull).toBe(0);
    expect(byName.get("cli_version_semver")?.notnull).toBe(0);
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
// only on a handle migrated through version 4 in ISOLATION, where the claim
// is narrower: the CREATEs and the anchor row land atomically even though
// the forward REFERENCES targets do not exist yet at that point in the
// chain.
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
// Plan-009 parent rows (B23 forward-reference ordering): the migration's
// `REFERENCES repo_mounts(id)` / `REFERENCES workspaces(id)` clauses target
// tables version 4 does not create — Plan-009's version-10 migration does.
// SQLite resolves FK targets lazily at DML time, so the version-4 CREATEs
// apply against absent parents and the referencing INSERT is what fails while
// a parent table is missing — as a `SQLITE_ERROR` statement-compile failure
// (`no such table: main.<parent>`), NOT a `FOREIGN KEY constraint failed`
// violation. BOTH classes stay pinned, on the two handles that can each
// exhibit exactly one: the version-≤4 isolation handle
// (`openDatabaseMigratedThroughVersionFour`) reaches the `SQLITE_ERROR`
// class, and the fully-migrated handle this block otherwise uses reaches the
// true FK-constraint class, where the parent TABLE exists and only the parent
// ROW is missing. The insert-shaped tests below therefore seed FIXTURE ROWS
// against the real Plan-009 DDL that `openDatabase` creates at version 10.
// A stub parent table cannot serve here: the real table already exists on
// that handle, so a plain `CREATE TABLE repo_mounts` would collide with it.
describe("0004-worktree-lifecycle migration shape", () => {
  let db: DatabaseType;

  const FIXTURE_TIMESTAMP: string = "2026-07-05T00:00:00.000Z";

  /**
   * A handle carrying versions 1 through 4 and NOTHING later — the only state
   * in which version 4's forward `REFERENCES` targets are absent, which is the
   * premise the two isolation-scoped tests below pin.
   *
   * The SHIPPED migration constants are exec'd in chain order rather than
   * hand-built DDL: re-encoding the parent-less schema in this file is exactly
   * the drift the census pin above exists to prevent, and `applyMigrations`
   * offers no version ceiling to stop at. Order is load-bearing — each script
   * carries its own `INSERT INTO schema_version`, and version 1 is what creates
   * the table those inserts target.
   */
  function openDatabaseMigratedThroughVersionFour(): DatabaseType {
    const isolatedDb: DatabaseType = new Database(":memory:");
    applyPragmas(isolatedDb);
    isolatedDb.exec(INITIAL_MIGRATION_SQL);
    isolatedDb.exec(RUNTIME_NODE_MIGRATION_SQL);
    isolatedDb.exec(RUNTIME_BINDINGS_MIGRATION_SQL);
    isolatedDb.exec(WORKTREE_LIFECYCLE_MIGRATION_SQL);
    return isolatedDb;
  }

  beforeEach(() => {
    // Canonical factory (Plan-001): ":memory:" is better-sqlite3's in-memory
    // database-path spelling, so `openDatabase` composes the pinned
    // applyPragmas → applyMigrations order for this block too — which now
    // reaches version 10 and therefore creates the real Plan-009 parents.
    db = openDatabase(":memory:");
    // FIXTURE PARENT ROWS against the real Plan-009 DDL, supplying every
    // NOT NULL column those tables declare, so the version-4 REFERENCES
    // clauses resolve at DML time under foreign_keys = ON. The mount is
    // inserted FIRST: `workspaces.repo_mount_id` is itself an enforced FK.
    db.prepare(
      `INSERT INTO repo_mounts
         (id, session_id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "mount-1",
      "session-1",
      "node-alpha",
      "/repos/checkout/src",
      "/repos/checkout",
      "git",
      "attached",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
    db.prepare(
      `INSERT INTO workspaces
         (id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-1",
      "session-1",
      "mount-1",
      "read-only",
      "/repos/checkout",
      "ready",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
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

  it("applies migration 0004 in isolation without creating repo_mounts / workspaces", () => {
    // B23 forward-reference ordering: SQLite resolves REFERENCES targets
    // lazily at DML time, so the version-4 CREATEs land on a database that has
    // never seen a Plan-009 migration. The claim is about migration 0004 IN
    // ISOLATION — it creates its own four tables and neither Plan-009 parent —
    // which a fully-migrated handle can no longer demonstrate, since version 10
    // creates those parents for real.
    const isolatedDb: DatabaseType = openDatabaseMigratedThroughVersionFour();
    try {
      const tableRows = isolatedDb
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
      // Migration 0004 must NOT create the Plan-009 parents itself: they are
      // Plan-009-owned, and a version-4 CREATE of either would collide with
      // version 10's real DDL on every fully-migrated handle.
      expect(tableNames).not.toContain("repo_mounts");
      expect(tableNames).not.toContain("workspaces");
      // The version-4 anchor row landed atomically with the CREATEs.
      const anchorRow = isolatedDb
        .prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = 4")
        .get() as { count: number };
      expect(anchorRow.count).toBe(1);
    } finally {
      isolatedDb.close();
    }
  });

  it(WRITE_INERT_ON_PARENTLESS_DB_TEST, () => {
    // Scoped to a handle carrying versions 1 through 4 only — the point in the
    // chain where version 4's REFERENCES targets genuinely do not exist.
    // SQLite's forward-reference behavior does not stop being true once version
    // 10 supplies them: any migration that ships a REFERENCES clause ahead of
    // its parent inherits exactly this failure class, and a caller that
    // discriminates FK failures by message would miss it.
    //
    // Empirically discovered against the pinned toolchain (better-sqlite3
    // 12.9.0 / SQLite 3.53.0): with the parent TABLE absent, SQLite refuses
    // the statement outright — `SQLITE_ERROR: no such table:
    // main.repo_mounts` — and never reaches constraint evaluation, so the
    // error class is NOT the `FOREIGN KEY constraint failed`
    // (SQLITE_CONSTRAINT_FOREIGNKEY) the real-parent negative control below
    // produces, where the parent TABLE exists and only the parent ROW is
    // missing. Both halves are pinned, on the two handles that can each
    // exhibit exactly one. The throw actually surfaces at prepare(), before a
    // value is bound; prepare and run stay inside one block so the pin does
    // not depend on which phase raises.
    const parentlessDb: DatabaseType = openDatabaseMigratedThroughVersionFour();
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
    // Negative control for the fixture-row pattern: proves FK enforcement is
    // live on this handle, so every accept in this block passes because the
    // parent ROW exists — not because enforcement is silently off — and proves
    // the REFERENCES clauses shipped un-stripped. This is the FK-constraint
    // half of the class distinction the parent-less test above opens: here the
    // parent table is Plan-009's real one and only the row is missing.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => {
      insertWorktreeRow({ id: "worktree-dangling", repoMountId: "missing-mount" });
    }).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => {
      insertWorktreeRow({ id: "worktree-with-parent" });
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

// ---------------------------------------------------------------------------
// Plan-006 T2.7 — `daemon_signing_keys` (migration version 5).
// ---------------------------------------------------------------------------
//
// The version-5 table was previously covered only by the table-name census in
// `ALL_EXPECTED_TABLES`, which pins that it EXISTS and nothing about its shape:
// a dropped NOT NULL, a widened PK, or a renamed column all pass that census.
// This block closes that gap the way the 0002 / 0003 / 0004 blocks do for their
// versions.
//
// Every value asserted below was read out of SQLite's own introspection
// (`PRAGMA table_info` / `PRAGMA index_list`) against the pinned toolchain
// (better-sqlite3 12.9.0 / SQLite 3.53.0) rather than reasoned from the DDL —
// column ORDER especially, which no reading of the CREATE TABLE can certify.
//
// What this block does NOT re-assert, deliberately: the table-name census, the
// `schema_version` version-walk anchor, and applyMigrations idempotency are all
// pinned by the 0001 block above and would be duplicate coverage here — the
// same division the 0004 block observes.
//
// SHAPE-CHECKABLE CITES:
//   * `Spec-022 §Daemon Master Key` — the private half is SEALED at rest via
//     the OS-keystore master key; the column is BLOB NOT NULL and never holds
//     cleartext key material. The sealing itself is `signing-key-source.ts`'s
//     injected boundary, covered by that module's own suite.
//   * `ADR-004 §Decision` — daemon-private key material is per-machine and
//     lives in local SQLite, never in shared Postgres. That this table exists
//     in THIS database is the assertion.
//   * I-006-2-02's custody half — `session_id` is the PRIMARY KEY, so a second
//     `create()` for one session is a constraint error rather than a silent
//     re-key that would strand every already-signed row behind a public key no
//     longer derivable from the stored private half.
describe("0005-daemon-signing-keys migration shape", () => {
  let db: DatabaseType;

  const FIXTURE_TIMESTAMP: string = "2026-07-08T00:00:00.000Z";
  const FIXTURE_PUBLIC_KEY: Buffer = Buffer.alloc(32, 0x01);
  const FIXTURE_SEALED_PRIVATE_KEY: Buffer = Buffer.alloc(48, 0x02);

  beforeEach(() => {
    // Canonical factory (Plan-001): applyPragmas → applyMigrations in the
    // pinned order, which now reaches version 5.
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function insertSigningKeyRow(overrides: { sessionId: string; createdAt?: string }): void {
    db.prepare(
      `INSERT INTO daemon_signing_keys
         (session_id, public_key, sealed_private_key, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      overrides.sessionId,
      FIXTURE_PUBLIC_KEY,
      FIXTURE_SEALED_PRIVATE_KEY,
      overrides.createdAt ?? FIXTURE_TIMESTAMP,
    );
  }

  it("pins the column shape, single-column PK, and NOT NULL discipline of `daemon_signing_keys`", () => {
    const columns = db
      .prepare("PRAGMA table_info(daemon_signing_keys)")
      .all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL.
    expect(columns.map((c) => c.name)).toEqual([
      "session_id",
      "public_key",
      "sealed_private_key",
      "created_at",
      "rotated_at",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // Declared types. The two key columns are BLOB and that is load-bearing
    // rather than cosmetic: `signing-key-source.ts` reads `sealed_private_key`
    // back expecting bytes, and SQLite's BLOB affinity does NOT coerce a
    // stored TEXT value (pinned by its own test below).
    expect(byName.get("session_id")?.type).toBe("TEXT");
    expect(byName.get("public_key")?.type).toBe("BLOB");
    expect(byName.get("sealed_private_key")?.type).toBe("BLOB");
    expect(byName.get("created_at")?.type).toBe("TEXT");
    expect(byName.get("rotated_at")?.type).toBe("TEXT");

    // Single-column PK on `session_id`; all others pk === 0. This is the
    // exactly-once custody guard, asserted as shape here and as behaviour
    // below.
    expect(byName.get("session_id")?.pk).toBe(1);
    for (const other of ["public_key", "sealed_private_key", "created_at", "rotated_at"]) {
      expect(byName.get(other)?.pk).toBe(0);
    }

    // NOT NULL columns per the DDL. `session_id` is EXCLUDED: the canonical
    // block declares it `session_id TEXT PRIMARY KEY` with no explicit
    // `NOT NULL`, and SQLite does not imply NOT NULL on a non-INTEGER PRIMARY
    // KEY column — the same documented quirk called out on the 0003 and 0004
    // blocks above.
    expect(byName.get("session_id")?.notnull).toBe(0);
    for (const required of ["public_key", "sealed_private_key", "created_at"]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    // `rotated_at` is reserved for a rotation ceremony V1 does not specify:
    // nullable, and NULL for every V1 row because no code path writes it (the
    // migration header's "ships unwritten" note).
    expect(byName.get("rotated_at")?.notnull).toBe(0);

    // No column carries a DEFAULT — every value is supplied by the writer.
    for (const column of columns) {
      expect(column.dflt_value).toBeNull();
    }
  });

  it("creates no explicit index beyond the implicit PRIMARY KEY autoindex", () => {
    const indexes = db.prepare("PRAGMA index_list(daemon_signing_keys)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      origin: string;
      partial: 0 | 1;
    }>;

    // One entry, and it is SQLite's own PK autoindex (origin "pk") rather than
    // a CREATE INDEX the migration issued. Lookups are by `session_id` only, so
    // the PK index is the whole access path.
    expect(indexes.map((index) => index.name)).toEqual(["sqlite_autoindex_daemon_signing_keys_1"]);
    expect(indexes[0]?.unique).toBe(1);
    expect(indexes[0]?.origin).toBe("pk");
    expect(indexes[0]?.partial).toBe(0);

    const indexColumns = db
      .prepare("PRAGMA index_info(sqlite_autoindex_daemon_signing_keys_1)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(indexColumns.map((c) => c.name)).toEqual(["session_id"]);
  });

  it("anchors the version-5 schema_version row with its Plan-006 description", () => {
    const anchorRows = db
      .prepare("SELECT description FROM schema_version WHERE version = 5")
      .all() as ReadonlyArray<{ description: string }>;
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0]?.description).toBe("Daemon signing keys (daemon_signing_keys)");
  });

  it("rejects a second signing key for the same session (the exactly-once guard)", () => {
    insertSigningKeyRow({ sessionId: "session-1" });

    let observedError: unknown;
    try {
      db.prepare(
        `INSERT INTO daemon_signing_keys
           (session_id, public_key, sealed_private_key, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        "session-1",
        Buffer.alloc(32, 0xaa),
        Buffer.alloc(48, 0xbb),
        "2026-07-09T00:00:00.000Z",
      );
    } catch (error) {
      observedError = error;
    }

    // `code` is better-sqlite3's SqliteError discriminator — the crisp half of
    // the pin; the message text is the brittle half. SQLite reports a
    // single-column PK collision as SQLITE_CONSTRAINT_PRIMARYKEY with a
    // "UNIQUE constraint failed" message, which is worth pinning precisely
    // because the two halves disagree in vocabulary.
    expect(observedError).toBeInstanceOf(Error);
    expect((observedError as { code?: string }).code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect((observedError as Error).message).toMatch(
      /UNIQUE constraint failed: daemon_signing_keys\.session_id/i,
    );

    // The rejection leaves the ORIGINAL key in place. This is the half that
    // matters: a silent re-key would strand every row already signed with the
    // first private key behind a public key no verifier can resolve.
    const rows = db
      .prepare("SELECT public_key, created_at FROM daemon_signing_keys")
      .all() as ReadonlyArray<{ public_key: Uint8Array; created_at: string }>;
    expect(rows).toHaveLength(1);
    expect(Uint8Array.from(rows[0]?.public_key ?? [])).toEqual(Uint8Array.from(FIXTURE_PUBLIC_KEY));
    expect(rows[0]?.created_at).toBe(FIXTURE_TIMESTAMP);
  });

  it("admits a second signing key for a DIFFERENT session", () => {
    // Negative control for the PK test above: the collision is scoped to one
    // session, so the table is genuinely per-session rather than per-daemon.
    insertSigningKeyRow({ sessionId: "session-1" });
    expect(() => {
      insertSigningKeyRow({ sessionId: "session-2" });
    }).not.toThrow();
  });

  it("rejects a row omitting public_key / sealed_private_key / created_at", () => {
    for (const [omittedColumn, columnList, values] of [
      [
        "public_key",
        "(session_id, sealed_private_key, created_at)",
        ["session-no-public", FIXTURE_SEALED_PRIVATE_KEY, FIXTURE_TIMESTAMP],
      ],
      [
        "sealed_private_key",
        "(session_id, public_key, created_at)",
        ["session-no-sealed", FIXTURE_PUBLIC_KEY, FIXTURE_TIMESTAMP],
      ],
      [
        "created_at",
        "(session_id, public_key, sealed_private_key)",
        ["session-no-created", FIXTURE_PUBLIC_KEY, FIXTURE_SEALED_PRIVATE_KEY],
      ],
    ] as ReadonlyArray<[string, string, ReadonlyArray<string | Buffer>]>) {
      // No DEFAULT on any column, so an omitted column resolves to NULL and
      // the NOT NULL constraint is what rejects.
      expect(() => {
        db.prepare(
          `INSERT INTO daemon_signing_keys ${columnList} VALUES (${values.map(() => "?").join(", ")})`,
        ).run(...values);
      }).toThrow(
        new RegExp(`NOT NULL constraint failed: daemon_signing_keys\\.${omittedColumn}`, "i"),
      );
    }
  });

  it("accepts a row with rotated_at NULL — the column ships unwritten in V1", () => {
    insertSigningKeyRow({ sessionId: "session-unrotated" });
    const row = db
      .prepare("SELECT rotated_at FROM daemon_signing_keys WHERE session_id = ?")
      .get("session-unrotated") as { rotated_at: string | null };
    expect(row.rotated_at).toBeNull();
  });

  it("does NOT coerce a TEXT value stored in the BLOB key columns", () => {
    // The reason `signing-key-source.ts` guards its read: SQLite's BLOB
    // declared type gives BLOB AFFINITY with NO coercion, so a TEXT value
    // written into `sealed_private_key` comes back as a JS `string` past a
    // `Uint8Array`-typed read. Nothing in the DDL prevents that write — the
    // module-level guard is the only thing that catches it, so the DDL's
    // permissiveness is pinned here rather than assumed away.
    db.prepare(
      `INSERT INTO daemon_signing_keys
         (session_id, public_key, sealed_private_key, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run("session-text-blob", FIXTURE_PUBLIC_KEY, "not-actually-bytes", FIXTURE_TIMESTAMP);

    const row = db
      .prepare(
        `SELECT typeof(sealed_private_key) AS storage_class, sealed_private_key
           FROM daemon_signing_keys WHERE session_id = ?`,
      )
      .get("session-text-blob") as { storage_class: string; sealed_private_key: unknown };
    expect(row.storage_class).toBe("text");
    expect(typeof row.sealed_private_key).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Plan-006 T3.1 — run-lifecycle terminal backstop (migration version 6).
// ---------------------------------------------------------------------------
//
// Version 6 adds no TABLE, so `ALL_EXPECTED_TABLES` pins nothing about it: the
// index and all three triggers could vanish and every other block in this file
// would stay green. This block is the shape floor the suite's own convention
// requires — the index exists with the right predicate and key expressions, and
// each of the three triggers exists on the right event — plus ONE behavioral arm
// on the promote leg, which is the leg no shape assertion can certify.
//
// The deeper behavioral matrix (insert-leg NULL + storage-class drift, the
// update leg's value-rewrite and de-scope arms, and the index's own
// duplicate-terminal rejection) is T3.5's per the plan; this block deliberately
// does not duplicate it.
describe("0006-run-lifecycle-terminal-backstop-index migration shape", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates the partial UNIQUE terminal-backstop index scoped to the three terminal run_lifecycle types", () => {
    // `sqlite_master.sql` is the authority for a PARTIAL index: `PRAGMA
    // index_list` reports `partial: 1` but never the predicate, so an index
    // whose WHERE clause silently widened to every `run_lifecycle` row — which
    // would reject legitimate non-terminal duplicates — passes index_list
    // unchanged. The DDL text is the only surface that discriminates it.
    const indexDdl = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get("idx_session_events_run_terminal_once") as { sql: string } | undefined;
    expect(indexDdl).toBeDefined();
    if (indexDdl === undefined) return;

    expect(indexDdl.sql).toContain("UNIQUE");
    // Keyed on the JSON-extracted run identity, not on stored columns — run
    // identity lives inside `payload`.
    expect(indexDdl.sql).toContain("json_extract(payload, '$.runId')");
    expect(indexDdl.sql).toContain("json_extract(payload, '$.runVersion')");
    // The partial predicate: the three terminal types and nothing else.
    expect(indexDdl.sql).toContain("WHERE category = 'run_lifecycle'");
    expect(indexDdl.sql).toContain("'run.completed'");
    expect(indexDdl.sql).toContain("'run.failed'");
    expect(indexDdl.sql).toContain("'run.interrupted'");

    // And it is registered against the right table.
    const indexes = db.prepare("PRAGMA index_list(session_events)").all() as ReadonlyArray<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const backstop = indexes.find((index) => index.name === "idx_session_events_run_terminal_once");
    expect(backstop).toBeDefined();
    expect(backstop?.unique).toBe(1);
    expect(backstop?.partial).toBe(1);
  });

  it("creates the terminal-key CHECK trigger trio SQLite cannot express as an ALTER TABLE ADD CHECK", () => {
    const triggers = db
      .prepare(
        `SELECT name, tbl_name FROM sqlite_master
          WHERE type = 'trigger' AND name LIKE 'trg_run_terminal_key_%'
          ORDER BY name`,
      )
      .all() as ReadonlyArray<{ name: string; tbl_name: string }>;

    // All three legs, and no fourth: the insert leg, the OLD-keyed update leg,
    // and the promote leg. A trio reduced to two is the failure this pins.
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      "trg_run_terminal_key_insert",
      "trg_run_terminal_key_promote",
      "trg_run_terminal_key_update",
    ]);
    for (const trigger of triggers) {
      expect(trigger.tbl_name).toBe("session_events");
    }
  });

  it("aborts on the promote leg when an UPDATE re-types a non-terminal row INTO the terminal set with NULL keys", () => {
    // THE HOLE THIS CLOSES, and why it needs a behavioral arm rather than a
    // shape one. The UNIQUE index treats NULLs as DISTINCT, so a terminal row
    // with a NULL `runId`/`runVersion` never occupies an index slot and any
    // number of them coexist. The INSERT leg catches that on the way in. But an
    // UPDATE that re-types an ALREADY-STORED non-terminal row into the terminal
    // set is keyed on OLD in the update leg — OLD was not terminal, so that leg
    // does not fire — and would otherwise slip past both. The promote leg
    // refuses it outright: terminal rows are INSERT-only.
    db.prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, monotonic_ns, category, type,
          actor, payload, correlation_id, causation_id, version,
          prev_hash, row_hash, daemon_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "evt-promote-probe",
      "session-promote",
      0,
      "2026-06-02T12:00:00.000Z",
      1_000_000_000,
      "run_lifecycle",
      // NON-terminal, and with NO runId/runVersion in the payload — the exact
      // row the promote leg exists to stop from being re-typed.
      "run.started",
      null,
      JSON.stringify({ note: "no run identity here" }),
      null,
      null,
      "1.0",
      Buffer.alloc(32),
      Buffer.alloc(32, 0x01),
      Buffer.alloc(64, 0x02),
    );

    expect(() =>
      db
        .prepare(`UPDATE session_events SET category = ?, type = ? WHERE id = ?`)
        .run("run_lifecycle", "run.completed", "evt-promote-probe"),
    ).toThrow(/terminal run_lifecycle by UPDATE|INSERT-only/i);

    // And the row is untouched — RAISE(ABORT) rolls back the statement.
    const row = db
      .prepare(`SELECT type FROM session_events WHERE id = ?`)
      .get("evt-promote-probe") as { type: string };
    expect(row.type).toBe("run.started");
  });
});

// ---------------------------------------------------------------------------
// Plan-006 T3.3 — `pending_anchor_uploads` (migration version 8).
// ---------------------------------------------------------------------------
//
// The durable Merkle-anchor upload queue. `ALL_EXPECTED_TABLES` pins that the
// table EXISTS and nothing about its shape, so this block is the shape floor
// the suite's convention requires — the same division the 0005 block states.
//
// Every value asserted below was read out of SQLite's own introspection
// (`PRAGMA table_info` / `index_list` / `index_info`) against the pinned
// toolchain (better-sqlite3 12.9.0 / SQLite 3.53.0) rather than reasoned from
// the DDL — column ORDER and the two autoindex NAMES especially, which no
// reading of the CREATE TABLE can certify.
//
// Spec coverage: `Spec-006 §Post-Compaction Integrity` — the covering-anchor
// precondition is a COVERAGE test, not an exact-start match, which is exactly
// why `end_sequence` sits in the UNIQUE key. The final arm below is that
// property asserted behaviorally: two anchors sharing a `start_sequence`
// coexist, and only an identical range is deduped.
//
// The service-level behavior on top of this shape (cadence firing, force-fire
// re-entry returning the queued row without re-signing) is Plan-006 T3.5's
// file set; this block covers the storage contract only.
describe("0008-pending-anchor-uploads migration shape", () => {
  let db: DatabaseType;

  const FIXTURE_MERKLE_ROOT: Buffer = Buffer.alloc(32, 0x11);
  const FIXTURE_ROOT_SIGNATURE: Buffer = Buffer.alloc(64, 0x22);

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function enqueueAnchor(anchor: {
    id: string;
    sessionId?: string;
    nodeId?: string;
    startSequence: number;
    endSequence: number;
  }): void {
    db.prepare(
      `INSERT INTO pending_anchor_uploads
         (id, session_id, node_id, start_sequence, end_sequence,
          merkle_root, root_signature, anchored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      anchor.id,
      anchor.sessionId ?? "session-anchor",
      anchor.nodeId ?? "node-alpha",
      anchor.startSequence,
      anchor.endSequence,
      FIXTURE_MERKLE_ROOT,
      FIXTURE_ROOT_SIGNATURE,
      "2026-08-04T00:00:00.000Z",
    );
  }

  it("pins the column shape, NOT NULL discipline, and the one DEFAULT of `pending_anchor_uploads`", () => {
    const columns = db
      .prepare("PRAGMA table_info(pending_anchor_uploads)")
      .all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL.
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "session_id",
      "node_id",
      "start_sequence",
      "end_sequence",
      "merkle_root",
      "root_signature",
      "anchored_at",
      "uploaded_at",
      "attempt_count",
      "last_attempt_at",
      "last_error",
    ]);

    const byName = new Map(columns.map((c) => [c.name, c]));

    // Declared types. The two commitment columns are BLOB and that is
    // load-bearing rather than cosmetic: they hold a 32-byte Merkle root and a
    // 64-byte Ed25519 signature, and SQLite's BLOB affinity does not coerce a
    // stored TEXT value — a base64 string written here would read back as text
    // and fail signature verification at audit time.
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("session_id")?.type).toBe("TEXT");
    expect(byName.get("node_id")?.type).toBe("TEXT");
    expect(byName.get("start_sequence")?.type).toBe("INTEGER");
    expect(byName.get("end_sequence")?.type).toBe("INTEGER");
    expect(byName.get("merkle_root")?.type).toBe("BLOB");
    expect(byName.get("root_signature")?.type).toBe("BLOB");
    expect(byName.get("anchored_at")?.type).toBe("TEXT");
    expect(byName.get("uploaded_at")?.type).toBe("TEXT");
    expect(byName.get("attempt_count")?.type).toBe("INTEGER");
    expect(byName.get("last_attempt_at")?.type).toBe("TEXT");
    expect(byName.get("last_error")?.type).toBe("TEXT");

    // Single-column PK on `id`; every other column pk === 0.
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of columns.filter((c) => c.name !== "id")) {
      expect(other.pk).toBe(0);
    }

    // NOT NULL columns per the DDL. `id` is EXCLUDED: the canonical block
    // declares it `id TEXT PRIMARY KEY` with no explicit `NOT NULL`, and SQLite
    // does not imply NOT NULL on a non-INTEGER PRIMARY KEY column — the same
    // documented quirk the 0003 / 0004 / 0005 blocks above call out.
    expect(byName.get("id")?.notnull).toBe(0);
    for (const required of [
      "session_id",
      "node_id",
      "start_sequence",
      "end_sequence",
      "merkle_root",
      "root_signature",
      "anchored_at",
      "attempt_count",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    // The four nullable columns are the LIFECYCLE ones: a freshly-enqueued
    // anchor has not been uploaded and has not been attempted.
    for (const nullable of ["uploaded_at", "last_attempt_at", "last_error"]) {
      expect(byName.get(nullable)?.notnull).toBe(0);
    }

    // `attempt_count` is the table's ONLY default — the enqueue path writes
    // eight columns and lets the retry counter start itself. SQLite reports the
    // default as the literal DDL text, hence the string "0".
    expect(byName.get("attempt_count")?.dflt_value).toBe("0");
    for (const column of columns.filter((c) => c.name !== "attempt_count")) {
      expect(column.dflt_value).toBeNull();
    }
  });

  it("creates the four-column UNIQUE key plus the partial pending-scan index", () => {
    const indexes = db.prepare("PRAGMA index_list(pending_anchor_uploads)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      origin: string;
      partial: 0 | 1;
    }>;
    const byName = new Map(indexes.map((index) => [index.name, index]));

    // Three indexes: the PK autoindex, the UNIQUE-constraint autoindex, and the
    // one explicit CREATE INDEX. `origin` discriminates them — "pk" / "u" /
    // "c" — which is what distinguishes a constraint SQLite derived from an
    // index the migration issued.
    expect([...byName.keys()].sort()).toEqual([
      "idx_pending_anchor_uploads_pending",
      "sqlite_autoindex_pending_anchor_uploads_1",
      "sqlite_autoindex_pending_anchor_uploads_2",
    ]);
    expect(byName.get("sqlite_autoindex_pending_anchor_uploads_1")?.origin).toBe("pk");
    expect(byName.get("sqlite_autoindex_pending_anchor_uploads_2")?.origin).toBe("u");
    expect(byName.get("idx_pending_anchor_uploads_pending")?.origin).toBe("c");

    // THE KEY. All four columns, in order. A key that lost `end_sequence`
    // would collapse a cadence anchor and a wider compaction-covering anchor
    // that share a `start_sequence` — the failure the last arm below drives.
    const uniqueKeyColumns = db
      .prepare("PRAGMA index_info(sqlite_autoindex_pending_anchor_uploads_2)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(uniqueKeyColumns.map((c) => c.name)).toEqual([
      "session_id",
      "node_id",
      "start_sequence",
      "end_sequence",
    ]);
    expect(byName.get("sqlite_autoindex_pending_anchor_uploads_2")?.unique).toBe(1);

    // The pending-scan index: non-unique, PARTIAL, over (session_id,
    // anchored_at). `sqlite_master.sql` is the authority for the predicate —
    // `index_list` reports `partial: 1` but never the WHERE clause, so an index
    // whose predicate silently widened to every row (turning the upload
    // worker's scan into a full-table scan of the flushed history) passes
    // `index_list` unchanged.
    expect(byName.get("idx_pending_anchor_uploads_pending")?.unique).toBe(0);
    expect(byName.get("idx_pending_anchor_uploads_pending")?.partial).toBe(1);
    const pendingIndexColumns = db
      .prepare("PRAGMA index_info(idx_pending_anchor_uploads_pending)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(pendingIndexColumns.map((c) => c.name)).toEqual(["session_id", "anchored_at"]);

    const indexDdl = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get("idx_pending_anchor_uploads_pending") as { sql: string } | undefined;
    expect(indexDdl?.sql).toContain("WHERE uploaded_at IS NULL");
  });

  it("anchors the version-8 schema_version row with its Plan-006 description", () => {
    const anchorRows = db
      .prepare("SELECT description FROM schema_version WHERE version = 8")
      .all() as ReadonlyArray<{ description: string }>;
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0]?.description).toBe(
      "Durable Merkle-anchor upload queue (pending_anchor_uploads)",
    );
  });

  it("has NO foreign key into session_events — a crypto-shred must not erase the witness", () => {
    // Deliberate absence, asserted so a later migration cannot add one
    // casually. The premise is ROW LIFETIME, not the shred mechanism: Spec-022
    // Path 1 destroys the per-participant key and deletes no row at all (the
    // hard DELETE is Path 2, and Postgres-only). What does remove local rows is
    // compaction, which rewrites them into `audit_stub` form, and any later
    // retention pass. An FK would either block those or cascade into the
    // anchors, destroying the very commitment that proves the range once
    // existed. Anchors OUTLIVE the rows they witness.
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(pending_anchor_uploads)").all();
    expect(foreignKeys).toEqual([]);
  });

  it("dedups an identical range but lets a wider covering anchor sharing start_sequence coexist", () => {
    // The Spec-006 §Post-Compaction Integrity property, asserted at the storage
    // layer. Three inserts, three distinct outcomes:

    // 1. The routine cadence anchor over [1, 1000].
    enqueueAnchor({ id: "anchor-cadence", startSequence: 1, endSequence: 1000 });

    // 2. A wider compaction-covering anchor over [1, 5000]. SAME start_sequence
    //    — and it MUST land, because a compactor about to discard [1, 5000]
    //    needs a covering witness and the [1, 1000] anchor does not cover it.
    //    A three-column key would reject this insert, silently leaving the
    //    compaction range unwitnessed.
    expect(() =>
      enqueueAnchor({ id: "anchor-covering", startSequence: 1, endSequence: 5000 }),
    ).not.toThrow();

    // 3. A genuine re-fire of the IDENTICAL range under a different row id.
    //    This is the one the key exists to dedup — a retried force-fire must
    //    not enqueue a second copy of a commitment already queued.
    expect(() =>
      enqueueAnchor({ id: "anchor-refire", startSequence: 1, endSequence: 1000 }),
    ).toThrow(/UNIQUE constraint failed/);

    const stored = db
      .prepare(
        `SELECT id, start_sequence, end_sequence FROM pending_anchor_uploads ORDER BY end_sequence`,
      )
      .all() as ReadonlyArray<{ id: string; start_sequence: number; end_sequence: number }>;
    expect(stored).toEqual([
      { id: "anchor-cadence", start_sequence: 1, end_sequence: 1000 },
      { id: "anchor-covering", start_sequence: 1, end_sequence: 5000 },
    ]);

    // And the key is per-(session, node): the same range on a different node's
    // chain is a different commitment, not a duplicate.
    expect(() =>
      enqueueAnchor({
        id: "anchor-other-node",
        nodeId: "node-beta",
        startSequence: 1,
        endSequence: 1000,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plan-006 T3.2 — compaction retention discriminator (migration version 9).
// ---------------------------------------------------------------------------
//
// Version 9 adds no TABLE, so `ALL_EXPECTED_TABLES` pins nothing about it: the
// CHECK, both columns, and the partial index could all vanish and every other
// block in this file would stay green. Same gap the 0006 block opens with, same
// remedy — this is the shape floor the suite's convention requires.
//
// TWO things here are load-bearing beyond ordinary column shape:
//
//   * The CHECK is the ONLY guard that keeps `retention_class` a two-valued
//     discriminator. Every compaction-facing statement in `compactor.ts` selects
//     on `retention_class IS NULL`, so a third value stored by any writer would
//     produce rows that are neither live nor stubbed — invisible to the
//     compactor, invisible to the verifier's `audit_stub` sweep, and carrying
//     destroyed payloads either way. A shape assertion cannot certify a CHECK;
//     only a REJECTION arm can, and it is paired with acceptance arms below so a
//     throw for some unrelated reason cannot pass for the constraint working.
//   * The index's PARTIALITY is the point of the index. `WHERE retention_class
//     IS NULL` is what keeps it sized to the LIVE prefix rather than to the whole
//     retained history, and `sqlite_master.sql` is the only authority for that
//     predicate — the 0006 block above explains why `index_list` cannot
//     discriminate it.
describe("0009-retention-class-and-stub-signature migration shape", () => {
  let db: DatabaseType;
  // Every probe row lands on one session, so sequences must not collide with
  // `UNIQUE(session_id, sequence)` — including on the arms that expect a throw,
  // where a duplicate sequence would raise the WRONG constraint.
  let nextSequence: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    nextSequence = 0;
  });

  afterEach(() => {
    db.close();
  });

  /**
   * A minimal `session_events` row. NON-terminal `session_lifecycle`, so the
   * version-6 terminal-key trigger trio stays out of these arms — a row those
   * triggers reject would look exactly like a CHECK rejection.
   */
  function insertEvent(id: string, retentionClass: string | null): void {
    db.prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, monotonic_ns, category, type,
          actor, payload, correlation_id, causation_id, version,
          prev_hash, row_hash, daemon_signature, retention_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "session-retention",
      nextSequence++,
      "2026-08-04T12:00:00.000Z",
      1_000_000_000,
      "session_lifecycle",
      "session.updated",
      null,
      JSON.stringify({ note: "retention-class probe" }),
      null,
      null,
      "1.0",
      Buffer.alloc(32),
      Buffer.alloc(32, 0x01),
      Buffer.alloc(64, 0x02),
      retentionClass,
    );
  }

  it("adds retention_class and stub_signature as nullable, default-less columns", () => {
    const columns = db
      .prepare("PRAGMA table_info(session_events)")
      .all() as ReadonlyArray<PragmaColumn>;
    const byName = new Map(columns.map((column) => [column.name, column]));

    // TEXT and BLOB, and the BLOB is load-bearing rather than cosmetic — the
    // same argument the 0008 block makes for its two commitment columns. A
    // `stub_signature` stored as base64 TEXT would read back as text and fail
    // verification against the bytes the compactor actually signed.
    expect(byName.get("retention_class")?.type).toBe("TEXT");
    expect(byName.get("stub_signature")?.type).toBe("BLOB");

    // NULLABLE with no default, both of them, and that is the schema's way of
    // saying LIVE. Every row written before compaction and every row written by
    // the append path leaves them unset, which is what makes `retention_class IS
    // NULL` a complete description of the live set. A NOT NULL column or a
    // DEFAULT would have required backfilling the whole table at migration time.
    expect(byName.get("retention_class")?.notnull).toBe(0);
    expect(byName.get("stub_signature")?.notnull).toBe(0);
    expect(byName.get("retention_class")?.dflt_value).toBeNull();
    expect(byName.get("stub_signature")?.dflt_value).toBeNull();

    // Appended by ALTER TABLE, so they are the LAST two columns in CID order.
    expect(columns.slice(-2).map((column) => column.name)).toEqual([
      "retention_class",
      "stub_signature",
    ]);
  });

  it("accepts NULL and 'audit_stub' for retention_class but REJECTS any third value", () => {
    // The two ACCEPTANCE baselines first. Without them the rejection below is
    // unfalsifiable: an insert that throws because a NOT NULL column was missed,
    // or because a version-6 trigger fired, is indistinguishable from the CHECK
    // doing its job.
    expect(() => {
      insertEvent("evt-retention-live", null);
    }).not.toThrow();
    expect(() => {
      insertEvent("evt-retention-stub", "audit_stub");
    }).not.toThrow();

    // THE REJECTION ARM. `retention_class` is a two-valued discriminator, and
    // the CHECK is the only thing that keeps it one.
    expect(() => {
      insertEvent("evt-retention-bogus", "archived");
    }).toThrow(/CHECK constraint failed/);

    // Casing counts too: the compactor writes the literal `'audit_stub'`, and a
    // near-miss would be a live row the compactor never revisits.
    expect(() => {
      insertEvent("evt-retention-case", "AUDIT_STUB");
    }).toThrow(/CHECK constraint failed/);

    // And an UPDATE cannot smuggle a third value past a row that entered clean.
    expect(() =>
      db
        .prepare("UPDATE session_events SET retention_class = ? WHERE id = ?")
        .run("archived", "evt-retention-live"),
    ).toThrow(/CHECK constraint failed/);

    const stored = db
      .prepare("SELECT id, retention_class FROM session_events ORDER BY id")
      .all() as ReadonlyArray<{ id: string; retention_class: string | null }>;
    expect(stored).toEqual([
      { id: "evt-retention-live", retention_class: null },
      { id: "evt-retention-stub", retention_class: "audit_stub" },
    ]);
  });

  it("creates idx_session_events_live PARTIAL on the live rows, keyed (session_id, sequence)", () => {
    const indexes = db.prepare("PRAGMA index_list(session_events)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      origin: string;
      partial: 0 | 1;
    }>;
    const live = indexes.find((index) => index.name === "idx_session_events_live");
    expect(live).toBeDefined();
    expect(live?.unique).toBe(0);
    expect(live?.partial).toBe(1);
    expect(live?.origin).toBe("c");

    // The key mirrors the compactor's own scan order: partition, then sequence.
    const keyColumns = db
      .prepare("PRAGMA index_info(idx_session_events_live)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(keyColumns.map((column) => column.name)).toEqual(["session_id", "sequence"]);

    // THE PREDICATE, off `sqlite_master.sql` because nothing else reports it. An
    // index whose WHERE clause silently widened to every row would still report
    // `partial: 1` here while indexing the entire retained history — the exact
    // cost this index exists to avoid.
    const indexDdl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_session_events_live") as { sql: string } | undefined;
    expect(indexDdl?.sql).toContain("WHERE retention_class IS NULL");
  });

  it("anchors the version-9 schema_version row with its Plan-006 description", () => {
    const versionRows = db
      .prepare("SELECT description FROM schema_version WHERE version = 9")
      .all() as ReadonlyArray<{ description: string }>;
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.description).toBe(
      "Compaction retention discriminator + post-compaction stub commitment " +
        "(session_events.retention_class, session_events.stub_signature, idx_session_events_live)",
    );
  });
});

// Plan-005 T1.7 — version-11 migration-shape coverage.
//
// Pins the four legs of `migrations/0011-driver-capability-currency.ts`: the
// fourteen-value `driver_capabilities.capability_flag` CHECK (reached by a
// twelve-step table rebuild, since SQLite cannot alter a column CHECK in
// place), the thirteen-flag `supported = 0` backfill this ordinal writes, the
// `cli_version_raw` / `cli_version_semver` pair on `runtime_bindings` +
// `driver_contract_meta`, and `runtime_bindings.spawn_config`. Schema
// source-of-truth is `docs/architecture/schemas/local-sqlite-schema.md`
// §"Driver and Runtime Binding Tables (Plan-005)".
//
// The physical column shape of the three tables is pinned by the
// `0003-runtime-bindings migration shape` block above (those pins run on a
// fully-migrated handle, so they already describe the post-version-11 shape,
// version-11 columns included). What this block adds is everything the shape
// pins cannot see: CHECK BEHAVIOUR on the new columns, the rebuild's effect on
// rows that already existed, and the backfill's cardinality.
//
// Two arms therefore run on an ISOLATED handle carrying versions 1 through 10
// and nothing later — the only state in which "before the migration" is a
// state that exists. `applyMigrations` offers no version ceiling, so the
// SHIPPED migration constants are exec'd in chain order, the same construction
// (and for the same anti-drift reason) as the 0004 block's
// `openDatabaseMigratedThroughVersionFour`.
//
// Shape-checkable spec/invariant cites:
//   * I-005-2 — an undeclared capability is UNSUPPORTED: the backfill writes
//     `supported = 0`, never 1, and never overwrites a declared row.
//   * `Spec-005 §Required Behavior` — the `cliVersion` report is persisted as a
//     both-or-neither pair (verbatim + parsed), and a NULL pair on
//     `driver_contract_meta` is the cache MISS that forces a refresh rather
//     than a fabricated version.
describe("0011-driver-capability-currency migration shape", () => {
  let db: DatabaseType;

  const FIXTURE_TIMESTAMP: string = "2026-08-20T00:00:00.000Z";

  // The fourteen values the widened CHECK ADMITS. Hardcoded rather than derived
  // from `DRIVER_CAPABILITY_FLAGS` for the ordinary anti-tautology reason: a
  // list derived from the const would agree with it by construction and could
  // never catch a value silently added or removed. The CHECK admitted
  // `transcript_replay` one ordinal AHEAD of the union declaring it — a CHECK is
  // a whitelist, so admitting a value before any row uses it costs nothing —
  // which is why THIS ordinal's backfill covers only thirteen of them.
  const FOURTEEN_ADMITTED_CAPABILITY_FLAGS: ReadonlyArray<string> = [
    "resume",
    "steer",
    "interactive_requests",
    "mcp",
    "tool_calls",
    "reasoning_stream",
    "model_mutation",
    "structured_output",
    "rollback",
    "session_goals",
    "callback_tools",
    "subagents",
    "cost_cap",
    "transcript_replay",
  ];

  // The thirteen THIS ORDINAL's backfill covers — the fourteen minus
  // `transcript_replay`, whose row set is written by the next ordinal.
  const THIRTEEN_BACKFILLED_CAPABILITY_FLAGS: ReadonlyArray<string> =
    FOURTEEN_ADMITTED_CAPABILITY_FLAGS.filter((flag) => flag !== "transcript_replay");

  /**
   * A handle carrying versions 1 through 10 and NOTHING later — the
   * pre-migration state the rebuild-preservation and backfill arms need, and
   * the state in which `driver_capabilities` still enforces the frozen
   * seven-value version-3 CHECK.
   *
   * Order is load-bearing: each script carries its own
   * `INSERT INTO schema_version`, and version 1 is what creates the table those
   * inserts target. A subsequent `applyMigrations` on this handle therefore
   * short-circuits versions 1 through 10 on their guards and runs ONLY
   * version 11 — which is exactly the upgrade path being asserted.
   */
  function openDatabaseMigratedThroughVersionTen(): DatabaseType {
    const isolatedDb: DatabaseType = new Database(":memory:");
    applyPragmas(isolatedDb);
    isolatedDb.exec(INITIAL_MIGRATION_SQL);
    isolatedDb.exec(RUNTIME_NODE_MIGRATION_SQL);
    isolatedDb.exec(RUNTIME_BINDINGS_MIGRATION_SQL);
    isolatedDb.exec(WORKTREE_LIFECYCLE_MIGRATION_SQL);
    isolatedDb.exec(DAEMON_SIGNING_KEYS_MIGRATION_SQL);
    isolatedDb.exec(RUN_LIFECYCLE_TERMINAL_BACKSTOP_MIGRATION_SQL);
    isolatedDb.exec(PII_PARTICIPANT_ID_MIGRATION_SQL);
    isolatedDb.exec(PENDING_ANCHOR_UPLOADS_MIGRATION_SQL);
    isolatedDb.exec(RETENTION_CLASS_AND_STUB_SIGNATURE_MIGRATION_SQL);
    isolatedDb.exec(REPO_WORKSPACES_MIGRATION_SQL);
    return isolatedDb;
  }

  /** One `driver_capabilities` cache row, on whichever handle is passed. */
  function insertCapabilityRow(
    target: DatabaseType,
    driverName: string,
    capabilityFlag: string,
    supported: 0 | 1,
    refreshedAt: string,
  ): void {
    target
      .prepare(
        `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(driverName, capabilityFlag, supported, refreshedAt);
  }

  /**
   * One `runtime_bindings` row with an explicit CLI-version pair. Every arm
   * that expects a throw must still supply a UNIQUE `id`: a PK collision would
   * raise the wrong constraint and make the CHECK assertion unfalsifiable.
   */
  function insertBindingWithCliVersion(
    id: string,
    cliVersionRaw: string | null,
    cliVersionSemver: string | null,
  ): void {
    db.prepare(
      `INSERT INTO runtime_bindings
         (id, run_id, driver_name, contract_version, created_at, updated_at,
          cli_version_raw, cli_version_semver)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "run-cli-version",
      "claude",
      "1.0.0",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
      cliVersionRaw,
      cliVersionSemver,
    );
  }

  /** The `driver_contract_meta` mirror of the helper above (PK is driver_name). */
  function insertContractMetaWithCliVersion(
    driverName: string,
    cliVersionRaw: string | null,
    cliVersionSemver: string | null,
  ): void {
    db.prepare(
      `INSERT INTO driver_contract_meta
         (driver_name, contract_version, refreshed_at, cli_version_raw, cli_version_semver)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(driverName, "1.0.0", FIXTURE_TIMESTAMP, cliVersionRaw, cliVersionSemver);
  }

  beforeEach(() => {
    // Canonical factory — applyPragmas → applyMigrations, now reaching
    // version 11.
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("admits all fourteen canonical capability flags and still rejects anything else", () => {
    // THE ACCEPTANCE SWEEP, one row per flag (the composite PK is
    // (driver_name, capability_flag), so a single driver can carry all
    // fourteen). Without it the rejection arms below are unfalsifiable.
    for (const capabilityFlag of FOURTEEN_ADMITTED_CAPABILITY_FLAGS) {
      expect(() => {
        insertCapabilityRow(db, "claude", capabilityFlag, 1, FIXTURE_TIMESTAMP);
      }).not.toThrow();
    }
    expect(db.prepare("SELECT COUNT(*) AS total FROM driver_capabilities").get()).toEqual({
      total: 14,
    });

    // `pause` is the canonical EXCLUDED flag per `Spec-005 §Required Behavior`
    // + ADR-011 — widening the CHECK must not have widened it to everything.
    expect(() => {
      insertCapabilityRow(db, "claude", "pause", 1, FIXTURE_TIMESTAMP);
    }).toThrow(/CHECK constraint failed/i);

    // Casing and near-misses count: the writer emits the exact literals, and a
    // near-miss row would be a capability nothing ever reads.
    expect(() => {
      insertCapabilityRow(db, "claude", "COST_CAP", 1, FIXTURE_TIMESTAMP);
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertCapabilityRow(db, "claude", "transcript_replays", 1, FIXTURE_TIMESTAMP);
    }).toThrow(/CHECK constraint failed/i);

    // And an UPDATE cannot smuggle an undeclared flag past a row that entered
    // clean — the CHECK travels with the column, not with the INSERT path.
    expect(() =>
      db
        .prepare("UPDATE driver_capabilities SET capability_flag = ? WHERE capability_flag = ?")
        .run("pause", "resume"),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("re-creates the composite PRIMARY KEY and its implicit autoindex through the rebuild", () => {
    // Step 3/8 of the twelve-step rebuild is "remember, then re-create, the
    // table's indexes". `driver_capabilities` has exactly one — the implicit PK
    // autoindex — and it comes back only because the successor table re-declares
    // the same `PRIMARY KEY (driver_name, capability_flag)`. Losing it would
    // turn the cache's uniqueness guarantee off silently, and the backfill's
    // `ON CONFLICT` target would stop resolving.
    const indexes = db.prepare("PRAGMA index_list(driver_capabilities)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      origin: string;
    }>;
    const primaryKeyIndex = indexes.find((index) => index.origin === "pk");
    expect(primaryKeyIndex).toBeDefined();
    expect(primaryKeyIndex?.unique).toBe(1);

    const keyColumns = db
      .prepare(`PRAGMA index_info(${primaryKeyIndex?.name ?? ""})`)
      .all() as ReadonlyArray<{ name: string }>;
    expect(keyColumns.map((column) => column.name)).toEqual(["driver_name", "capability_flag"]);

    // Behavioral half: a duplicate (driver_name, capability_flag) is refused.
    insertCapabilityRow(db, "claude", "resume", 1, FIXTURE_TIMESTAMP);
    expect(() => {
      insertCapabilityRow(db, "claude", "resume", 0, FIXTURE_TIMESTAMP);
    }).toThrow(/UNIQUE constraint failed/i);
  });

  it("leaves no transient rebuild table behind", () => {
    // The rebuild's successor is named `driver_capabilities_new` until the
    // rename consumes it. A torn or mis-ordered script would strand it here,
    // and a `_new` table that outlived the migration is a schema that lies
    // about which table the writers are talking to.
    const strandedTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_new' ESCAPE '\\'",
      )
      .all() as ReadonlyArray<{ name: string }>;
    expect(strandedTables).toEqual([]);
  });

  it("enforces the both-or-neither cli-version pair CHECK on `runtime_bindings`", () => {
    // Both ACCEPTANCE arms first: the pair is the only two states the write
    // path may produce.
    expect(() => {
      insertBindingWithCliVersion("binding-cli-absent", null, null);
    }).not.toThrow();
    expect(() => {
      insertBindingWithCliVersion("binding-cli-present", "2.1.245 (Claude Code)", "2.1.245");
    }).not.toThrow();

    // A parsed form without its verbatim source, and a verbatim source without
    // its parsed form, are BOTH refused — the half-written pair is the state
    // the floor gate could never re-derive after the fact.
    expect(() => {
      insertBindingWithCliVersion("binding-cli-raw-only", "2.1.245", null);
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertBindingWithCliVersion("binding-cli-semver-only", null, "2.1.245");
    }).toThrow(/CHECK constraint failed/i);

    // And an UPDATE cannot tear the pair apart afterwards. SQLite evaluates
    // every CHECK on every write to the row, not only on writes that name the
    // constrained column — which is what makes a single column-level CHECK
    // able to police both halves.
    expect(() =>
      db
        .prepare("UPDATE runtime_bindings SET cli_version_raw = NULL WHERE id = ?")
        .run("binding-cli-present"),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("bounds the `runtime_bindings` cli-version pair at 128 / 64 chars and rejects NUL", () => {
    // Empty strings: the pair is "absent or meaningful", never "present and
    // blank".
    expect(() => {
      insertBindingWithCliVersion("binding-cli-empty", "", "");
    }).toThrow(/CHECK constraint failed/i);

    // ACCEPT edges, pinning both ceilings so a `<= N` → `< N` off-by-one is
    // caught (the resume_handle 4096-accept precedent in the 0003 block).
    expect(() => {
      insertBindingWithCliVersion("binding-cli-raw-128", "9".repeat(128), "1.0.0");
    }).not.toThrow();
    expect(() => {
      insertBindingWithCliVersion("binding-cli-semver-64", "1.0.0", "9".repeat(64));
    }).not.toThrow();

    // REJECT edges, one char past each ceiling.
    expect(() => {
      insertBindingWithCliVersion("binding-cli-raw-129", "9".repeat(129), "1.0.0");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertBindingWithCliVersion("binding-cli-semver-65", "1.0.0", "9".repeat(65));
    }).toThrow(/CHECK constraint failed/i);

    // Embedded NUL, on each half independently — the provider-string
    // defense-in-depth bound the other Plan-005 text columns already carry.
    expect(() => {
      insertBindingWithCliVersion(
        "binding-cli-raw-nul",
        `2.1.245${String.fromCharCode(0)}x`,
        "1.0.0",
      );
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertBindingWithCliVersion(
        "binding-cli-semver-nul",
        "2.1.245",
        `1.0.0${String.fromCharCode(0)}x`,
      );
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the same pair CHECK and bounds on `driver_contract_meta`", () => {
    // The two tables carry the SAME pair with the SAME bounds by design (the
    // cache row and the binding row describe one provider CLI), so the mirror
    // is asserted rather than assumed.
    expect(() => {
      insertContractMetaWithCliVersion("claude", null, null);
    }).not.toThrow();
    expect(() => {
      insertContractMetaWithCliVersion("codex", "0.149.1", "0.149.1");
    }).not.toThrow();

    expect(() => {
      insertContractMetaWithCliVersion("gemini", "0.149.1", null);
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertContractMetaWithCliVersion("gemini", null, "0.149.1");
    }).toThrow(/CHECK constraint failed/i);

    // Empty strings: the pair is "absent or meaningful", never "present and
    // blank".
    expect(() => {
      insertContractMetaWithCliVersion("gemini", "", "");
    }).toThrow(/CHECK constraint failed/i);

    // ACCEPT edges, pinning both ceilings so a `<= N` → `< N` off-by-one is
    // caught. Without these arms the reject edges below pass against a CHECK
    // that is one char too tight, and the mirror claim would go unfalsified on
    // exactly the bound it exists to assert. Fresh `driver_name` values per arm:
    // the PK is `driver_name`, and a collision would raise UNIQUE rather than
    // the CHECK the sibling reject arms below are asserting.
    expect(() => {
      insertContractMetaWithCliVersion("meta-cli-raw-128", "9".repeat(128), "1.0.0");
    }).not.toThrow();
    expect(() => {
      insertContractMetaWithCliVersion("meta-cli-semver-64", "1.0.0", "9".repeat(64));
    }).not.toThrow();

    // REJECT edges, one char past each ceiling.
    expect(() => {
      insertContractMetaWithCliVersion("gemini", "9".repeat(129), "1.0.0");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertContractMetaWithCliVersion("gemini", "1.0.0", "9".repeat(65));
    }).toThrow(/CHECK constraint failed/i);

    // Embedded NUL, on each half independently — the provider-string
    // defense-in-depth bound the other Plan-005 text columns already carry.
    expect(() => {
      insertContractMetaWithCliVersion("gemini", `0.149.1${String.fromCharCode(0)}x`, "1.0.0");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      insertContractMetaWithCliVersion("gemini", "0.149.1", `1.0.0${String.fromCharCode(0)}x`);
    }).toThrow(/CHECK constraint failed/i);
  });

  it("carries version-10 rows through the rebuild and backfills exactly thirteen flags per driver", () => {
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      // A pre-migration cache: two drivers, DISTINCT refreshed_at instants, and
      // `supported = 1` on every declared row so a backfill that blanket-wrote
      // zeros would be visible rather than indistinguishable.
      insertCapabilityRow(isolatedDb, "claude", "resume", 1, "2026-08-01T00:00:00.000Z");
      insertCapabilityRow(isolatedDb, "claude", "steer", 1, "2026-08-02T00:00:00.000Z");
      insertCapabilityRow(isolatedDb, "codex", "mcp", 1, "2026-07-01T00:00:00.000Z");

      // Version 11's SQL DIRECTLY, not `applyMigrations`: this arm's claim is
      // about what THIS ordinal writes, and running the chain would fold the
      // next ordinal's `transcript_replay` backfill into the same row set and
      // make the thirteen-flag assertion a claim about neither migration.
      isolatedDb.exec(DRIVER_CAPABILITY_CURRENCY_MIGRATION_SQL);

      // CARDINALITY. Thirteen per driver, no more and no fewer — this is the
      // number `provider/driver-capabilities-writer.ts` compares against
      // `DRIVER_CAPABILITY_FLAGS.length` on every cold-start hydration, and
      // `provider/provider-output-validation.ts` against every refresh.
      const flagsFor = (driverName: string): ReadonlyArray<string> =>
        (
          isolatedDb
            .prepare(
              "SELECT capability_flag FROM driver_capabilities WHERE driver_name = ? ORDER BY capability_flag",
            )
            .all(driverName) as ReadonlyArray<{ capability_flag: string }>
        ).map((row) => row.capability_flag);
      expect(flagsFor("claude")).toEqual([...THIRTEEN_BACKFILLED_CAPABILITY_FLAGS].sort());
      expect(flagsFor("codex")).toEqual([...THIRTEEN_BACKFILLED_CAPABILITY_FLAGS].sort());

      // `transcript_replay` is ADMITTED by the CHECK but gets NO row from THIS
      // ordinal: the CHECK ran one migration ahead of the union, so the row set
      // catches up in the next one.
      expect(
        isolatedDb
          .prepare(
            "SELECT COUNT(*) AS total FROM driver_capabilities WHERE capability_flag = 'transcript_replay'",
          )
          .get(),
      ).toEqual({ total: 0 });

      // PRESERVATION. The three pre-migration rows survive the DROP/RENAME with
      // their `supported` and `refreshed_at` values untouched — the backfill's
      // `ON CONFLICT ... DO NOTHING` must not have overwritten them.
      expect(
        isolatedDb
          .prepare(
            "SELECT supported, refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = ?",
          )
          .get("claude", "resume"),
      ).toEqual({ supported: 1, refreshed_at: "2026-08-01T00:00:00.000Z" });
      expect(
        isolatedDb
          .prepare(
            "SELECT supported, refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = ?",
          )
          .get("codex", "mcp"),
      ).toEqual({ supported: 1, refreshed_at: "2026-07-01T00:00:00.000Z" });

      // I-005-2: every BACKFILLED row is `supported = 0`. An undeclared
      // capability is unsupported, and nothing in a migration may declare one.
      const backfilledSupportedValues = isolatedDb
        .prepare(
          "SELECT DISTINCT supported FROM driver_capabilities WHERE capability_flag NOT IN ('resume', 'steer', 'mcp')",
        )
        .all() as ReadonlyArray<{ supported: number }>;
      expect(backfilledSupportedValues).toEqual([{ supported: 0 }]);

      // PER-DRIVER refreshed_at, never a global MAX and never the migration's
      // wall clock: claude's backfilled rows carry claude's newest instant
      // (2026-08-02) and codex's carry codex's (2026-07-01). A global aggregate
      // would have stamped BOTH with 2026-08-02, making codex's cache read as
      // five weeks fresher than the last answer codex ever gave.
      expect(
        isolatedDb
          .prepare(
            "SELECT DISTINCT refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = ?",
          )
          .get("claude", "rollback"),
      ).toEqual({ refreshed_at: "2026-08-02T00:00:00.000Z" });
      expect(
        isolatedDb
          .prepare(
            "SELECT DISTINCT refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = ?",
          )
          .get("codex", "rollback"),
      ).toEqual({ refreshed_at: "2026-07-01T00:00:00.000Z" });
    } finally {
      isolatedDb.close();
    }
  });

  it("gives pre-migration rows the spawn_config default and a NULL cli-version pair", () => {
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      // A binding and a contract-meta row written under the version-3 shape,
      // which has no notion of either new column.
      isolatedDb
        .prepare(
          `INSERT INTO runtime_bindings
             (id, run_id, driver_name, contract_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "binding-legacy",
          "run-legacy",
          "claude",
          "1.0.0",
          FIXTURE_TIMESTAMP,
          FIXTURE_TIMESTAMP,
        );
      isolatedDb
        .prepare(
          `INSERT INTO driver_contract_meta (driver_name, contract_version, refreshed_at)
           VALUES (?, ?, ?)`,
        )
        .run("claude", "1.0.0", FIXTURE_TIMESTAMP);

      applyMigrations(isolatedDb);

      // `spawn_config` is NOT NULL, so the existing row could only survive the
      // ALTER by taking the DEFAULT — which is exactly why the column ships
      // with one rather than through a table rebuild.
      expect(
        isolatedDb
          .prepare(
            "SELECT spawn_config, cli_version_raw, cli_version_semver FROM runtime_bindings WHERE id = ?",
          )
          .get("binding-legacy"),
      ).toEqual({ spawn_config: "{}", cli_version_raw: null, cli_version_semver: null });

      // The NULL pair on the cache row is the MISS signal, not an empty
      // reading: hydration refreshes from the driver rather than reporting a
      // version nobody asked the CLI for.
      expect(
        isolatedDb
          .prepare(
            "SELECT cli_version_raw, cli_version_semver FROM driver_contract_meta WHERE driver_name = ?",
          )
          .get("claude"),
      ).toEqual({ cli_version_raw: null, cli_version_semver: null });
    } finally {
      isolatedDb.close();
    }
  });

  it("anchors the version-11 schema_version row with its Plan-005 description", () => {
    const versionRows = db
      .prepare("SELECT description FROM schema_version WHERE version = 11")
      .all() as ReadonlyArray<{ description: string }>;
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.description).toBe(
      "Driver capability currency (fourteen-value driver_capabilities.capability_flag CHECK " +
        "+ thirteen-flag backfill, runtime_bindings/driver_contract_meta cli_version_raw " +
        "+ cli_version_semver, runtime_bindings.spawn_config)",
    );
  });

  it("keeps the backfilled row set in exact lockstep with DRIVER_CAPABILITY_FLAGS", () => {
    // THE UNION-PARITY TRIPWIRE. The migration hardcodes its flag literals on
    // purpose (a migration is a frozen point-in-time copy of the schema — the
    // 0003 precedent), so nothing structural ties the backfill to the contract
    // const. This test is that tie, asserted behaviorally through live rows:
    // it is the Plan-005 analogue of the I-010-2 DDL-conformance tripwire, and
    // it fails the moment either side moves without the other.
    //
    // Compared as SORTED sets, deliberately. Row order without an ORDER BY is
    // undefined, and the two canonical corpus listings of these fourteen values
    // (`api-payload-contracts.md` §Shared Enums and the local-SQLite schema doc)
    // already disagree on the order of the last two — vocabulary is the claim,
    // ordering is not.
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      insertCapabilityRow(isolatedDb, "claude", "resume", 1, FIXTURE_TIMESTAMP);
      applyMigrations(isolatedDb);

      const backfilledFlags = (
        isolatedDb
          .prepare(
            "SELECT capability_flag FROM driver_capabilities WHERE driver_name = ? ORDER BY capability_flag",
          )
          .all("claude") as ReadonlyArray<{ capability_flag: string }>
      ).map((row) => row.capability_flag);

      expect(
        backfilledFlags,
        "the backfilled row set must equal DRIVER_CAPABILITY_FLAGS exactly — " +
          "`provider/driver-capabilities-writer.ts` proves exactly this key set on every " +
          "cold-start hydration (naming both the missing and the unexpected keys), and a " +
          "mismatch throws before any refresh can heal it. The const and the backfilled row " +
          "set move in LOCKSTEP: Plan-005 T3.19 lands the fourteenth union member and the " +
          "fourteenth `transcript_replay` row in the SAME migration ordinal (the CHECK having " +
          "widened one ordinal earlier, which costs nothing). A red arm here means the two " +
          "diverged — widen whichever half lags, never this assertion.",
      ).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());
    } finally {
      isolatedDb.close();
    }
  });
});

// Plan-005 T3.19 — version-12 migration-shape coverage.
//
// Version 12 is a PURE ROW BACKFILL. Its two legs settle in different ordinals
// and conflating them is the trap: the `capability_flag` CHECK was already
// widened to fourteen values by version 11 (a CHECK is a whitelist, so admitting
// a value before any row uses it costs nothing), so nothing here rebuilds a
// table. What DOES have to land in the same ordinal as the union's fourteenth
// member is the ROW — `provider/driver-capabilities-writer.ts` proves an exact
// key set on every cold-start hydration and throws on a mismatch, so a cache
// left at thirteen rows fails the next hydrate BEFORE any refresh could heal it.
//
// Shape-checkable spec/invariant cites:
//   * I-005-2 — an undeclared capability is UNSUPPORTED: the backfill writes
//     `supported = 0`, never 1, and never overwrites a declared row.
//   * `Spec-005 §Recovery Consequences` — the cache is the cold-start source of
//     truth, so its currency stamp must describe the driver's own last answer
//     rather than the migration's wall clock.
describe("0012-transcript-capability-backfill migration shape", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * A handle carrying versions 1 through 10 and nothing later. Seeding a cache
   * HERE and then running the chain is the real upgrade path: version 11 fans
   * the seed out to thirteen flags and version 12 adds the fourteenth, which is
   * the only construction in which "the row set caught up" is observable.
   */
  function openDatabaseMigratedThroughVersionTen(): DatabaseType {
    const isolatedDb: DatabaseType = new Database(":memory:");
    applyPragmas(isolatedDb);
    isolatedDb.exec(INITIAL_MIGRATION_SQL);
    isolatedDb.exec(RUNTIME_NODE_MIGRATION_SQL);
    isolatedDb.exec(RUNTIME_BINDINGS_MIGRATION_SQL);
    isolatedDb.exec(WORKTREE_LIFECYCLE_MIGRATION_SQL);
    isolatedDb.exec(DAEMON_SIGNING_KEYS_MIGRATION_SQL);
    isolatedDb.exec(RUN_LIFECYCLE_TERMINAL_BACKSTOP_MIGRATION_SQL);
    isolatedDb.exec(PII_PARTICIPANT_ID_MIGRATION_SQL);
    isolatedDb.exec(PENDING_ANCHOR_UPLOADS_MIGRATION_SQL);
    isolatedDb.exec(RETENTION_CLASS_AND_STUB_SIGNATURE_MIGRATION_SQL);
    isolatedDb.exec(REPO_WORKSPACES_MIGRATION_SQL);
    return isolatedDb;
  }

  /**
   * The same handle carried one ordinal further, to the state in which
   * `transcript_replay` is already ADMISSIBLE. The version-10 CHECK still
   * enforces the frozen seven-value list, so a case that needs to seed the
   * fourteenth flag itself has to start from here.
   */
  function openDatabaseMigratedThroughVersionEleven(): DatabaseType {
    const isolatedDb: DatabaseType = openDatabaseMigratedThroughVersionTen();
    isolatedDb.exec(DRIVER_CAPABILITY_CURRENCY_MIGRATION_SQL);
    return isolatedDb;
  }

  function seedCapabilityRow(
    target: DatabaseType,
    driverName: string,
    capabilityFlag: string,
    supported: 0 | 1,
    refreshedAt: string,
  ): void {
    target
      .prepare(
        `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(driverName, capabilityFlag, supported, refreshedAt);
  }

  function capabilityFlagsFor(target: DatabaseType, driverName: string): ReadonlyArray<string> {
    return (
      target
        .prepare(
          "SELECT capability_flag FROM driver_capabilities WHERE driver_name = ? ORDER BY capability_flag",
        )
        .all(driverName) as ReadonlyArray<{ capability_flag: string }>
    ).map((row) => row.capability_flag);
  }

  it("brings every cached driver up to the full canonical flag set, the new row unsupported", () => {
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      // `supported = 1` on the seeded row so a backfill that blanket-wrote zeros
      // would be visible rather than indistinguishable.
      seedCapabilityRow(isolatedDb, "claude", "resume", 1, "2026-08-01T00:00:00.000Z");
      seedCapabilityRow(isolatedDb, "codex", "mcp", 1, "2026-07-01T00:00:00.000Z");

      applyMigrations(isolatedDb);

      expect(capabilityFlagsFor(isolatedDb, "claude")).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());
      expect(capabilityFlagsFor(isolatedDb, "codex")).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());

      // I-005-2 — undeclared is unsupported, so the migration writes 0 and never 1.
      expect(
        isolatedDb
          .prepare(
            "SELECT DISTINCT supported FROM driver_capabilities WHERE capability_flag = 'transcript_replay'",
          )
          .all(),
      ).toEqual([{ supported: 0 }]);

      // The seeded rows survive with their own values — the backfill adds, never
      // overwrites.
      expect(
        isolatedDb
          .prepare(
            "SELECT supported, refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = ?",
          )
          .get("claude", "resume"),
      ).toEqual({ supported: 1, refreshed_at: "2026-08-01T00:00:00.000Z" });
    } finally {
      isolatedDb.close();
    }
  });

  it("stamps the new row with the DRIVER's own newest currency instant, never a global one", () => {
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      // Two drivers, five weeks apart. A global MAX would stamp both with the
      // newer instant and make the older driver's cache read as fresher than the
      // last answer it ever gave.
      seedCapabilityRow(isolatedDb, "claude", "resume", 1, "2026-08-02T00:00:00.000Z");
      seedCapabilityRow(isolatedDb, "codex", "mcp", 1, "2026-07-01T00:00:00.000Z");

      applyMigrations(isolatedDb);

      expect(
        isolatedDb
          .prepare(
            "SELECT refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = 'transcript_replay'",
          )
          .get("claude"),
      ).toEqual({ refreshed_at: "2026-08-02T00:00:00.000Z" });
      expect(
        isolatedDb
          .prepare(
            "SELECT refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = 'transcript_replay'",
          )
          .get("codex"),
      ).toEqual({ refreshed_at: "2026-07-01T00:00:00.000Z" });
    } finally {
      isolatedDb.close();
    }
  });

  it("invents no row for a driver that has no cache at all", () => {
    // The asymmetry is deliberate: a driver with NO cached rows must stay
    // uncached, because a lone `transcript_replay` row would be a partial cache
    // that fails the hydrator's key-set proof instead of reporting a clean MISS
    // and forcing a refresh.
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      applyMigrations(isolatedDb);
      expect(isolatedDb.prepare("SELECT COUNT(*) AS total FROM driver_capabilities").get()).toEqual(
        {
          total: 0,
        },
      );
    } finally {
      isolatedDb.close();
    }
  });

  it("leaves an already-declared transcript_replay row untouched", () => {
    // `ON CONFLICT ... DO NOTHING`, driven rather than restated: a node that
    // refreshed its cache after the CHECK widened already holds the row, and a
    // migration may never overwrite a driver's own answer with a fail-closed one.
    const isolatedDb = openDatabaseMigratedThroughVersionEleven();
    try {
      seedCapabilityRow(isolatedDb, "claude", "transcript_replay", 1, "2026-08-20T00:00:00.000Z");

      applyMigrations(isolatedDb);

      expect(
        isolatedDb
          .prepare(
            "SELECT supported, refreshed_at FROM driver_capabilities WHERE driver_name = ? AND capability_flag = 'transcript_replay'",
          )
          .get("claude"),
      ).toEqual({ supported: 1, refreshed_at: "2026-08-20T00:00:00.000Z" });
    } finally {
      isolatedDb.close();
    }
  });

  it("is idempotent across a second migration pass", () => {
    const isolatedDb = openDatabaseMigratedThroughVersionTen();
    try {
      seedCapabilityRow(isolatedDb, "claude", "resume", 1, "2026-08-01T00:00:00.000Z");

      applyMigrations(isolatedDb);
      applyMigrations(isolatedDb);

      expect(capabilityFlagsFor(isolatedDb, "claude")).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());
      expect(
        isolatedDb.prepare("SELECT COUNT(*) AS total FROM schema_version WHERE version = 12").get(),
      ).toEqual({ total: 1 });
    } finally {
      isolatedDb.close();
    }
  });

  it("anchors the version-12 schema_version row with its transcript-backfill description", () => {
    const versionRows = db
      .prepare("SELECT description FROM schema_version WHERE version = 12")
      .all() as ReadonlyArray<{ description: string }>;
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.description).toBe(
      "Transcript capability backfill (transcript_replay supported = 0 row per cached driver_name)",
    );
  });
});
