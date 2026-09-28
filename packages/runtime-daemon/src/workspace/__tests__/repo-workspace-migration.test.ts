// repo-workspace-migration.test.ts — the repo_mounts and workspaces schema shape.
//
// Pins the column set, NOT NULL flags, primary-key shape, DEFAULT clauses,
// index shape (including the partial-unique `idx_repo_mounts_active_root`), and
// the behavioral CHECK / UNIQUE / FK enforcement of the two Local SQLite tables
// (`repo_mounts`, `workspaces`). Schema source of truth is
// `session/daemon-schema.ts`.
//
// Asserted via PRAGMA table_info / index_list / index_info (explicit
// field-by-field) plus behavioral rejection inserts.
//
// Shape-checkable cites:
//   * repo mount records persist canonical root, owner node, and lifecycle
//     state (the `node_id` / `canonical_root` NOT NULL pair and the `state`
//     CHECK below); workspace records persist execution root, repo
//     association, and health (`fs_root`, the `repo_mount_id` FK, and the
//     `state` CHECK).
//   * Every `repo_mounts` row stores the user-entered attach path
//     (`local_path`, provenance) ALONGSIDE the resolver-produced
//     `canonical_root`, plus the owning `node_id` and a lifecycle state from
//     the closed set. The DDL half is that both path columns are NOT NULL and
//     distinct, and that `idx_repo_mounts_active_root` keys deduplication off
//     `canonical_root` rather than `local_path`. That the WRITER puts the
//     resolver's output in `canonical_root` is the assertion, not this
//     file's.
//
// Every value asserted below was read out of SQLite's own introspection rather
// than reasoned from the DDL — column ORDER and the autoindex NAMES especially,
// which no reading of the CREATE TABLE can certify.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExecutionMode,
  RepoMountState,
  VcsType,
  WorkspaceState,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";

// PRAGMA table_info column shape (better-sqlite3 returns these field names).
interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  // 1-based ordinal within the primary key; 0 if the column is not part of the
  // PK. Composite PKs therefore yield pk values 2, 3, ... — hence `number`,
  // not a binary union.
  pk: number;
}

const FIXTURE_TIMESTAMP: string = "2026-08-04T00:00:00.000Z";
const FIXTURE_CANONICAL_ROOT: string = "/repos/acme-payments";

// Vocabulary sources for the CHECK loops below, bound EXHAUSTIVE-BY-TYPE to the
// canonical contracts unions rather than spelled as bare string literals. The
// DDL enum and the wire union are two encodings of ONE vocabulary and only the
// wire half is type-checked, so an addition to `RepoMountState` /
// `WorkspaceState` / `VcsType` / `ExecutionMode` that omitted the paired CHECK
// edit in `session/daemon-schema.ts` would leave a literal-driven loop
// green here and surface only at persist time, as a runtime CHECK failure on a
// value the wire had already accepted. `Record<T, true>` moves that to
// typecheck: a new union member is a missing property here, a renamed one an
// excess property. Keys are read back with `Object.keys`, so declaring the
// member is also what adds its accept arm — and if the CHECK was not widened
// with it, that arm fails loudly.
const REPO_MOUNT_STATES: Record<RepoMountState, true> = {
  attached: true,
  detached: true,
  archived: true,
};
const WORKSPACE_STATES: Record<WorkspaceState, true> = {
  provisioning: true,
  ready: true,
  busy: true,
  stale: true,
  archived: true,
};
const VCS_TYPES: Record<VcsType, true> = { git: true };
const EXECUTION_MODES: Record<ExecutionMode, true> = {
  "bound-root": true,
  "provisioned-worktree": true,
};

describe("repo_mounts and workspaces schema shape", () => {
  let db: DatabaseType;

  beforeEach(() => {
    // Canonical factory: ":memory:" is better-sqlite3's in-memory
    // database-path spelling, so `openDatabase` composes the pinned
    // applyPragmas → applyMigrations order here too — the pragma/migration
    // order is never re-derived in a test.
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // Helpers: fully-populated valid rows; tests override the identity /
  // constraint-relevant fields to exercise one constraint at a time. Every
  // referenced parent row is created before use (including in reject cases), so
  // a rejection is attributable to the constraint under test — never to a
  // dangling FK.

  function insertRepoMountRow(overrides: {
    id: string;
    nodeId?: string;
    canonicalRoot?: string;
    vcsType?: string;
    state?: string;
  }): void {
    db.prepare(
      `INSERT INTO repo_mounts
         (id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      overrides.nodeId ?? "node-alpha",
      // The ENTERED path is deliberately a subdirectory of the canonical root:
      // the two columns must be able to disagree, and a helper that wrote the
      // same value into both would hide a schema collapsing them.
      `${overrides.canonicalRoot ?? FIXTURE_CANONICAL_ROOT}/src/services`,
      overrides.canonicalRoot ?? FIXTURE_CANONICAL_ROOT,
      overrides.vcsType ?? "git",
      overrides.state ?? "attached",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  // State transitions (not just inserts) move rows across the
  // `idx_repo_mounts_active_root` predicate boundary, so the arbiter's
  // index-entry REMOVAL and re-INSERT paths need their own driver.
  function updateRepoMountState(repoMountId: string, state: string): void {
    db.prepare("UPDATE repo_mounts SET state = ?, updated_at = ? WHERE id = ?").run(
      state,
      FIXTURE_TIMESTAMP,
      repoMountId,
    );
  }

  function insertWorkspaceRow(overrides: {
    id: string;
    repoMountId?: string;
    executionMode?: string;
    fsRoot?: string | null;
    state?: string;
  }): void {
    db.prepare(
      `INSERT INTO workspaces
         (id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      overrides.id,
      "session-1",
      overrides.repoMountId ?? "mount-1",
      overrides.executionMode ?? "bound-root",
      overrides.fsRoot === undefined ? FIXTURE_CANONICAL_ROOT : overrides.fsRoot,
      overrides.state ?? "ready",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  it("pins the column shape, single-column PK, and both path columns of `repo_mounts`", () => {
    const columns = db
      .prepare("PRAGMA table_info(repo_mounts)")
      .all() as ReadonlyArray<PragmaColumn>;

    // Columns in CID (creation) order — fixed by the CREATE TABLE DDL.
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "node_id",
      "local_path",
      "canonical_root",
      "vcs_type",
      "state",
      "attached_at",
      "updated_at",
      "metadata",
    ]);

    const byName = new Map(columns.map((column) => [column.name, column]));

    // Every column is TEXT — `metadata` included, since SQLite has no JSON
    // storage class and the column holds a serialized document.
    for (const column of columns) {
      expect(column.type).toBe("TEXT");
    }

    // Single-column PK on `id`; all others pk === 0. The sweep is what makes
    // "single-column" an assertion rather than a comment — widening to a
    // composite PK would otherwise pass.
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of columns.filter((column) => column.name !== "id")) {
      expect(other.pk).toBe(0);
    }

    // BOTH path columns are mandatory. `local_path` is the user-entered
    // provenance value and `canonical_root` the resolver output; a nullable
    // `canonical_root` would let an unresolved mount persist, and a nullable
    // `local_path` would discard the provenance the invariant names. `node_id`
    // is mandatory for the same reason — a mount with no owning node is
    // unroutable.
    for (const required of [
      "node_id",
      "local_path",
      "canonical_root",
      "vcs_type",
      "state",
      "attached_at",
      "updated_at",
      "metadata",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    // `id` is NOT NULL too: a STRICT table's PRIMARY KEY column is.
    expect(byName.get("id")?.notnull).toBe(1);

    // DEFAULT clauses. SQLite reports the default as the literal DDL text,
    // hence the quoted strings.
    expect(byName.get("vcs_type")?.dflt_value).toBe("'git'");
    expect(byName.get("state")?.dflt_value).toBe("'attached'");
    expect(byName.get("metadata")?.dflt_value).toBe("'{}'");
    for (const column of columns.filter(
      (candidate) => !["vcs_type", "state", "metadata"].includes(candidate.name),
    )) {
      expect(column.dflt_value).toBeNull();
    }
  });

  it("pins the column shape, single-column PK, and nullable `fs_root` of `workspaces`", () => {
    const columns = db
      .prepare("PRAGMA table_info(workspaces)")
      .all() as ReadonlyArray<PragmaColumn>;

    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "session_id",
      "repo_mount_id",
      "execution_mode",
      "fs_root",
      "state",
      "metadata",
      "created_at",
      "updated_at",
    ]);

    const byName = new Map(columns.map((column) => [column.name, column]));

    for (const column of columns) {
      expect(column.type).toBe("TEXT");
    }

    expect(byName.get("id")?.pk).toBe(1);
    for (const other of columns.filter((column) => column.name !== "id")) {
      expect(other.pk).toBe(0);
    }

    // `fs_root` is the ONLY nullable column, and its nullability is
    // load-bearing rather than lax: a workspace still provisioning has no
    // resolved execution root yet, so a NOT NULL here would
    // force the bind path to invent a placeholder root.
    expect(byName.get("fs_root")?.notnull).toBe(0);
    for (const required of [
      "session_id",
      "repo_mount_id",
      "execution_mode",
      "state",
      "metadata",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(required)?.notnull).toBe(1);
    }
    expect(byName.get("id")?.notnull).toBe(1);

    // `execution_mode` has no default: a bind always names its mode.
    expect(byName.get("state")?.dflt_value).toBe("'provisioning'");
    expect(byName.get("metadata")?.dflt_value).toBe("'{}'");
    for (const column of columns.filter(
      (candidate) => !["state", "metadata"].includes(candidate.name),
    )) {
      expect(column.dflt_value).toBeNull();
    }
  });

  it("creates the partial-unique idx_repo_mounts_active_root", () => {
    const indexes = db.prepare("PRAGMA index_list(repo_mounts)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      origin: string;
      partial: 0 | 1;
    }>;
    const byIndexName = new Map(indexes.map((index) => [index.name, index]));

    // Two indexes and no third: the PK autoindex plus the one the schema
    // issues. `origin` discriminates them — "pk" for the constraint SQLite
    // derived, "c" for a CREATE INDEX.
    expect([...byIndexName.keys()].sort()).toEqual([
      "idx_repo_mounts_active_root",
      "sqlite_autoindex_repo_mounts_1",
    ]);
    expect(byIndexName.get("sqlite_autoindex_repo_mounts_1")?.origin).toBe("pk");

    // Dedupe key: UNIQUE + partial over (node_id, canonical_root). A mount
    // belongs to the machine, so no session is part of the key. Column ORDER
    // and MEMBERSHIP are both load-bearing — keying on
    // `local_path` instead of `canonical_root` would let two entered aliases
    // of one repository both attach, and dropping `node_id` would make one
    // absolute path attachable on only one runtime node.
    expect(byIndexName.get("idx_repo_mounts_active_root")?.unique).toBe(1);
    expect(byIndexName.get("idx_repo_mounts_active_root")?.partial).toBe(1);
    const activeRootColumns = db
      .prepare("PRAGMA index_info(idx_repo_mounts_active_root)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(activeRootColumns.map((column) => column.name)).toEqual(["node_id", "canonical_root"]);

    // THE PREDICATE, off `sqlite_master.sql` because nothing else reports it:
    // `index_list` reports `partial: 1` but never the WHERE clause, so an index
    // whose predicate silently widened to every row would pass `index_list`
    // unchanged while permanently blocking re-attach of a detached mount.
    const indexDdl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_repo_mounts_active_root") as { sql: string } | undefined;
    expect(indexDdl?.sql).toContain("WHERE state = 'attached'");
  });

  it("creates idx_workspaces_session and idx_workspaces_repo as non-unique lookup indexes", () => {
    const indexes = db.prepare("PRAGMA index_list(workspaces)").all() as ReadonlyArray<{
      name: string;
      unique: 0 | 1;
      origin: string;
    }>;
    const byIndexName = new Map(indexes.map((index) => [index.name, index]));

    expect([...byIndexName.keys()].sort()).toEqual([
      "idx_workspaces_repo",
      "idx_workspaces_session",
      "sqlite_autoindex_workspaces_1",
    ]);

    // `unique === 0` on both is load-bearing, not decoration: a session holds
    // several workspaces and a mount can carry more than one binding, so a
    // UNIQUE on either would cap the product at one workspace per session /
    // per mount — a functional break `index_info` alone cannot see.
    expect(byIndexName.get("idx_workspaces_session")?.unique).toBe(0);
    const sessionIndexColumns = db
      .prepare("PRAGMA index_info(idx_workspaces_session)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(sessionIndexColumns.map((column) => column.name)).toEqual(["session_id"]);

    expect(byIndexName.get("idx_workspaces_repo")?.unique).toBe(0);
    const repoIndexColumns = db
      .prepare("PRAGMA index_info(idx_workspaces_repo)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(repoIndexColumns.map((column) => column.name)).toEqual(["repo_mount_id"]);
  });

  it("enforces the state CHECK on `repo_mounts`", () => {
    // Behavioral proof that SQLite enforces the closed lifecycle set names.
    for (const state of Object.keys(REPO_MOUNT_STATES)) {
      expect(() => {
        insertRepoMountRow({
          id: `mount-state-${state}`,
          canonicalRoot: `/repos/state-${state}`,
          state,
        });
      }).not.toThrow();
    }
    // 'ready' is the sharpest out-of-enum probe: it is valid for `workspaces`
    // and must still be rejected here — the two tables' state vocabularies are
    // disjoint, not a shared enum.
    expect(() => {
      insertRepoMountRow({
        id: "mount-state-ready",
        canonicalRoot: "/repos/state-ready",
        state: "ready",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the vcs_type CHECK on `repo_mounts`", () => {
    // Each row gets its own canonical root: every row here takes the default
    // `state: 'attached'` and enters idx_repo_mounts_active_root, so a shared
    // root would make the `hg` reject throw on UNIQUE instead of on the CHECK
    // this test pins.
    for (const vcsType of Object.keys(VCS_TYPES)) {
      expect(() => {
        insertRepoMountRow({
          id: `mount-vcs-${vcsType}`,
          canonicalRoot: `/repos/vcs-${vcsType}`,
          vcsType,
        });
      }).not.toThrow();
    }
    expect(() => {
      insertRepoMountRow({ id: "mount-vcs-hg", canonicalRoot: "/repos/vcs-hg", vcsType: "hg" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the state CHECK on `workspaces`", () => {
    insertRepoMountRow({ id: "mount-1" });
    for (const state of Object.keys(WORKSPACE_STATES)) {
      expect(() => {
        insertWorkspaceRow({ id: `workspace-state-${state}`, state });
      }).not.toThrow();
    }
    // 'attached' is the mirror-image probe of the `repo_mounts` case above: a
    // valid repo-mount state that must not leak into the workspace vocabulary.
    expect(() => {
      insertWorkspaceRow({ id: "workspace-state-attached", state: "attached" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the execution_mode CHECK on `workspaces`", () => {
    insertRepoMountRow({ id: "mount-1" });
    for (const executionMode of Object.keys(EXECUTION_MODES)) {
      expect(() => {
        insertWorkspaceRow({ id: `workspace-mode-${executionMode}`, executionMode });
      }).not.toThrow();
    }
    expect(() => {
      insertWorkspaceRow({ id: "workspace-mode-not-a-member", executionMode: "not-a-member" });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("accepts a workspace with a NULL fs_root (the provisioning path)", () => {
    insertRepoMountRow({ id: "mount-1" });
    expect(() => {
      insertWorkspaceRow({
        id: "workspace-provisioning",
        executionMode: "provisioned-worktree",
        fsRoot: null,
        state: "provisioning",
      });
    }).not.toThrow();
  });

  it("enforces the workspaces.repo_mount_id foreign key against `repo_mounts`", () => {
    // Negative control first: FK enforcement is live on this handle, so the
    // accept below passes because the parent exists — not because enforcement
    // is silently off.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => {
      insertWorkspaceRow({ id: "workspace-dangling", repoMountId: "missing-mount" });
    }).toThrow(/FOREIGN KEY constraint failed/i);

    insertRepoMountRow({ id: "mount-1" });
    expect(() => {
      insertWorkspaceRow({ id: "workspace-bound" });
    }).not.toThrow();
  });

  it("rejects a second ACTIVE mount of one canonical root on the same node", () => {
    insertRepoMountRow({ id: "mount-first" });
    // Column-qualified rather than a loose /UNIQUE/ matcher: `repo_mounts` also
    // carries the PK autoindex on `id`, so naming the key is what proves the
    // PARTIAL index fired and not a duplicate id.
    expect(() => {
      insertRepoMountRow({ id: "mount-duplicate" });
    }).toThrow(/UNIQUE constraint failed: repo_mounts\.node_id, repo_mounts\.canonical_root/i);
  });

  it("admits an active mount that differs in exactly one key column", () => {
    // Each accept varies ONE member of the index key and holds the other
    // fixed, so the test cannot pass for the wrong reason: a different node is
    // a different node-local filesystem, and a different canonical root is a
    // different repository.
    insertRepoMountRow({ id: "mount-baseline" });
    expect(() => {
      insertRepoMountRow({ id: "mount-other-node", nodeId: "node-beta" });
    }).not.toThrow();
    expect(() => {
      insertRepoMountRow({ id: "mount-other-root", canonicalRoot: "/repos/other-repository" });
    }).not.toThrow();
  });

  it("admits an attach alongside an already-detached row on the same key", () => {
    // `WHERE state = 'attached'` scopes the index to LIVE mounts, so a detached
    // row is history and never blocks re-attach. This arm never places an entry
    // in the partial index at all — the UPDATE arm below is the one that
    // exercises index-entry removal.
    insertRepoMountRow({ id: "mount-detached", state: "detached" });
    expect(() => {
      insertRepoMountRow({ id: "mount-reattached" });
    }).not.toThrow();
  });

  it("readmits an attach after the holder is UPDATEd to detached", () => {
    // The production detach-then-re-attach lifecycle, and the only path that
    // exercises index-entry REMOVAL: the first row genuinely occupies the
    // partial index before the UPDATE evicts it.
    insertRepoMountRow({ id: "mount-holder" });
    updateRepoMountState("mount-holder", "detached");
    expect(() => {
      insertRepoMountRow({ id: "mount-successor" });
    }).not.toThrow();
  });

  it("rejects an UPDATE that re-attaches a detached mount whose key is already held", () => {
    // The reverse transition: the arbiter must fire on the index-entry INSERT
    // an UPDATE drives, not only on row INSERT. A resurrect-on-retry bug would
    // otherwise put two active mounts on one canonical root — exactly the
    // duplicate-attach state exists to prevent.
    insertRepoMountRow({ id: "mount-active" });
    insertRepoMountRow({ id: "mount-detached", state: "detached" });
    // Column-qualified to the key, the same bar the INSERT counterpart above
    // applies. The PK autoindex cannot fire on an UPDATE that leaves `id`
    // untouched, so a bare matcher would do — naming the key is
    // what keeps the pin attributable if a later edit touches the identity
    // columns, and this is the arm pinning the arbiter's index-entry INSERT
    // path.
    expect(() => {
      updateRepoMountState("mount-detached", "attached");
    }).toThrow(/UNIQUE constraint failed: repo_mounts\.node_id, repo_mounts\.canonical_root/i);
  });

  it("stores the entered path and the canonical root as independent values", () => {
    // The storage half: the two columns hold different strings on the same
    // row, so a schema that collapsed them (or a writer that could only ever
    // store one) is observable here.
    insertRepoMountRow({ id: "mount-1" });
    const row = db
      .prepare("SELECT local_path, canonical_root, metadata FROM repo_mounts WHERE id = ?")
      .get("mount-1") as { local_path: string; canonical_root: string; metadata: string };
    expect(row.canonical_root).toBe(FIXTURE_CANONICAL_ROOT);
    expect(row.local_path).toBe(`${FIXTURE_CANONICAL_ROOT}/src/services`);
    expect(row.local_path).not.toBe(row.canonical_root);
    // The omitted `metadata` column resolves to its DDL default rather than to
    // NULL, which is what lets every reader treat it as a parseable document.
    expect(row.metadata).toBe("{}");
  });
});

// Row shapes for the reopen probes below. Members carry the SQL column names,
// hence the snake_case spelling.
interface DurableRepoMountRow {
  canonical_root: string;
  state: string;
}

interface DurableWorkspaceRow {
  repo_mount_id: string;
  execution_mode: string;
  state: string;
}

describe("repo_mounts and workspaces durability across an openDatabase reopen", () => {
  let databaseDirectory: string;
  let databasePath: string;

  beforeEach(() => {
    // A real file rather than ":memory:" — a reopen of an in-memory database is
    // a NEW empty database, so the durability claim would be untestable there.
    databaseDirectory = mkdtempSync(join(tmpdir(), "ai-sidekicks-repo-workspaces-"));
    databasePath = join(databaseDirectory, "daemon.sqlite");
  });

  afterEach(() => {
    rmSync(databaseDirectory, { recursive: true, force: true });
  });

  it("re-runs as a no-op on reopen and leaves the persisted rows intact", () => {
    const firstHandle: DatabaseType = openDatabase(databasePath);
    try {
      firstHandle
        .prepare(
          `INSERT INTO repo_mounts
             (id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "mount-durable",
          "node-alpha",
          `${FIXTURE_CANONICAL_ROOT}/src/services`,
          FIXTURE_CANONICAL_ROOT,
          "git",
          "attached",
          FIXTURE_TIMESTAMP,
          FIXTURE_TIMESTAMP,
        );
      firstHandle
        .prepare(
          `INSERT INTO workspaces
             (id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "workspace-durable",
          "session-1",
          "mount-durable",
          "bound-root",
          FIXTURE_CANONICAL_ROOT,
          "ready",
          FIXTURE_TIMESTAMP,
          FIXTURE_TIMESTAMP,
        );
    } finally {
      firstHandle.close();
    }

    // The reopen runs `applyMigrations` again against a database that already
    // has the schema. The DDL has no `IF NOT EXISTS`, so a runner-guard
    // regression surfaces here as a hard "table already exists" throw rather
    // than as silent data loss.
    const reopened: DatabaseType = openDatabase(databasePath);
    try {
      const mountRow = reopened
        .prepare("SELECT canonical_root, state FROM repo_mounts WHERE id = ?")
        .get("mount-durable") as DurableRepoMountRow;
      expect(mountRow.canonical_root).toBe(FIXTURE_CANONICAL_ROOT);
      expect(mountRow.state).toBe("attached");

      const workspaceRow = reopened
        .prepare("SELECT repo_mount_id, execution_mode, state FROM workspaces WHERE id = ?")
        .get("workspace-durable") as DurableWorkspaceRow;
      expect(workspaceRow.repo_mount_id).toBe("mount-durable");
      expect(workspaceRow.execution_mode).toBe("bound-root");
      expect(workspaceRow.state).toBe("ready");
    } finally {
      reopened.close();
    }
  });
});
