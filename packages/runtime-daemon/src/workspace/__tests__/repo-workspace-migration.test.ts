// Schema shape of `repo_mounts` and `workspaces` (source: `session/daemon-schema.ts`).
//
// Pins columns, NOT NULL flags, primary keys, defaults and indexes (including the partial-unique
// `idx_repo_mounts_active_root`), plus the CHECK, UNIQUE and FK behavior of the two tables. Shape
// is read from SQLite's own introspection (`PRAGMA table_info`, `index_list`, `index_info`)
// rather than reasoned from the DDL, because column order and autoindex names cannot be
// certified by reading the CREATE TABLE.
//
// `local_path` (the entered path) and `canonical_root` (the resolver's output) are both NOT NULL
// and independent, and the unique index keys on `canonical_root`. That the writer stores the
// resolver's output in `canonical_root` is asserted elsewhere, not here.

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

// A `PRAGMA table_info` row, with the field names better-sqlite3 returns.
interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  // 1-based ordinal within the primary key, 0 if the column is not part of it.
  pk: number;
}

const FIXTURE_TIMESTAMP: string = "2026-08-04T00:00:00.000Z";
const FIXTURE_CANONICAL_ROOT: string = "/repos/acme-payments";

// Values for the CHECK loops below, typed exhaustively against the contracts unions. The DDL
// CHECK and the wire union encode one vocabulary and only the union is type-checked, so a new
// member added without the paired CHECK edit would otherwise surface only at persist time.
// `Record<T, true>` makes a new member a typecheck error here, and its accept arm fails if the
// CHECK was not widened.
const REPO_MOUNT_STATES: Record<RepoMountState, true> = {
  attached: true,
  detached: true,
  archived: true,
};
const WORKSPACE_STATES: Record<WorkspaceState, true> = {
  preparing: true,
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
    // `openDatabase` accepts ":memory:", so the pragma and migration order is not re-derived.
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // Helpers insert fully populated valid rows; tests override one constraint-relevant field at a
  // time. Parent rows are created first, so a rejection is never a dangling FK.

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
      // The entered path is a subdirectory of the canonical root, so the columns differ.
      `${overrides.canonicalRoot ?? FIXTURE_CANONICAL_ROOT}/src/services`,
      overrides.canonicalRoot ?? FIXTURE_CANONICAL_ROOT,
      overrides.vcsType ?? "git",
      overrides.state ?? "attached",
      FIXTURE_TIMESTAMP,
      FIXTURE_TIMESTAMP,
    );
  }

  // A state change moves a row across the `idx_repo_mounts_active_root` predicate, removing or
  // re-inserting its index entry.
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

    // Columns in creation order.
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

    // Every column is TEXT; `metadata` holds serialized JSON, which SQLite has no class for.
    for (const column of columns) {
      expect(column.type).toBe("TEXT");
    }

    // Single-column PK on `id`; the sweep fails if the key is widened to a composite.
    expect(byName.get("id")?.pk).toBe(1);
    for (const other of columns.filter((column) => column.name !== "id")) {
      expect(other.pk).toBe(0);
    }

    // Both path columns are mandatory: a nullable `canonical_root` would let an unresolved mount
    // persist, a nullable `local_path` would lose the entered path, and a mount with no
    // `node_id` is unroutable.
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
    // `id` is NOT NULL too, because a STRICT table's primary key column is.
    expect(byName.get("id")?.notnull).toBe(1);

    // SQLite reports a default as its literal DDL text, hence the quoted strings.
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

    // `fs_root` is the only nullable column: a workspace still provisioning has no execution
    // root, and NOT NULL would force the bind path to invent a placeholder.
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
    expect(byName.get("state")?.dflt_value).toBe("'preparing'");
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

    // Exactly two indexes: the PK autoindex (`origin` "pk") and the schema's own ("c").
    expect([...byIndexName.keys()].sort()).toEqual([
      "idx_repo_mounts_active_root",
      "sqlite_autoindex_repo_mounts_1",
    ]);
    expect(byIndexName.get("sqlite_autoindex_repo_mounts_1")?.origin).toBe("pk");

    // The dedupe key is unique and partial over (node_id, canonical_root). Keying on
    // `local_path` would let two aliases of one repository both attach, and dropping `node_id`
    // would let one absolute path attach on only one node.
    expect(byIndexName.get("idx_repo_mounts_active_root")?.unique).toBe(1);
    expect(byIndexName.get("idx_repo_mounts_active_root")?.partial).toBe(1);
    const activeRootColumns = db
      .prepare("PRAGMA index_info(idx_repo_mounts_active_root)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(activeRootColumns.map((column) => column.name)).toEqual(["node_id", "canonical_root"]);

    // The predicate is read from `sqlite_master.sql`: `index_list` reports `partial: 1` but not
    // the WHERE clause, and a predicate widened to every row would block re-attach of a detached
    // mount for good.
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

    // Both must be non-unique: a session holds several workspaces and a mount several bindings.
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
    for (const state of Object.keys(REPO_MOUNT_STATES)) {
      expect(() => {
        insertRepoMountRow({
          id: `mount-state-${state}`,
          canonicalRoot: `/repos/state-${state}`,
          state,
        });
      }).not.toThrow();
    }
    // 'ready' is valid for `workspaces` and must still be rejected here: the two tables' state
    // vocabularies are disjoint.
    expect(() => {
      insertRepoMountRow({
        id: "mount-state-ready",
        canonicalRoot: "/repos/state-ready",
        state: "ready",
      });
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces the vcs_type CHECK on `repo_mounts`", () => {
    // Each row gets its own canonical root: every row is `attached`, so a shared root would make
    // the `hg` reject fail on UNIQUE instead of on the CHECK under test.
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
    // 'attached' is a valid repo-mount state that must not leak into the workspace vocabulary.
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
        state: "preparing",
      });
    }).not.toThrow();
  });

  it("enforces the workspaces.repo_mount_id foreign key against `repo_mounts`", () => {
    // Negative control first: with enforcement live, the accept below passes because the parent
    // exists, not because enforcement is off.
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
    // The message names the key columns, which shows the partial index fired and not the PK on
    // `id`.
    expect(() => {
      insertRepoMountRow({ id: "mount-duplicate" });
    }).toThrow(/UNIQUE constraint failed: repo_mounts\.node_id, repo_mounts\.canonical_root/i);
  });

  it("admits an active mount that differs in exactly one key column", () => {
    // Each accept varies one member of the index key and holds the other fixed: a different
    // node is a different filesystem, a different canonical root a different repository.
    insertRepoMountRow({ id: "mount-baseline" });
    expect(() => {
      insertRepoMountRow({ id: "mount-other-node", nodeId: "node-beta" });
    }).not.toThrow();
    expect(() => {
      insertRepoMountRow({ id: "mount-other-root", canonicalRoot: "/repos/other-repository" });
    }).not.toThrow();
  });

  it("admits an attach alongside an already-detached row on the same key", () => {
    // The index covers only `attached` rows, so a detached row never blocks re-attach. This arm
    // puts no entry in the index; the UPDATE arm below covers entry removal.
    insertRepoMountRow({ id: "mount-detached", state: "detached" });
    expect(() => {
      insertRepoMountRow({ id: "mount-reattached" });
    }).not.toThrow();
  });

  it("readmits an attach after the holder is UPDATEd to detached", () => {
    // The detach-then-re-attach lifecycle: the first row occupies the partial index until the
    // UPDATE evicts it.
    insertRepoMountRow({ id: "mount-holder" });
    updateRepoMountState("mount-holder", "detached");
    expect(() => {
      insertRepoMountRow({ id: "mount-successor" });
    }).not.toThrow();
  });

  it("rejects an UPDATE that re-attaches a detached mount whose key is already held", () => {
    // The uniqueness check must also fire on the index entry an UPDATE inserts, or a re-attach
    // would put two active mounts on one canonical root.
    insertRepoMountRow({ id: "mount-active" });
    insertRepoMountRow({ id: "mount-detached", state: "detached" });
    expect(() => {
      updateRepoMountState("mount-detached", "attached");
    }).toThrow(/UNIQUE constraint failed: repo_mounts\.node_id, repo_mounts\.canonical_root/i);
  });

  it("stores the entered path and the canonical root as independent values", () => {
    // The two columns hold different strings on one row, so a schema that collapsed them shows.
    insertRepoMountRow({ id: "mount-1" });
    const row = db
      .prepare("SELECT local_path, canonical_root, metadata FROM repo_mounts WHERE id = ?")
      .get("mount-1") as { local_path: string; canonical_root: string; metadata: string };
    expect(row.canonical_root).toBe(FIXTURE_CANONICAL_ROOT);
    expect(row.local_path).toBe(`${FIXTURE_CANONICAL_ROOT}/src/services`);
    expect(row.local_path).not.toBe(row.canonical_root);
    // An omitted `metadata` resolves to its DDL default, not NULL, so readers can always parse it.
    expect(row.metadata).toBe("{}");
  });
});

// Row shapes for the reopen probes below; members use the SQL column names.
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
    // A real file: reopening an in-memory database yields a new empty one.
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

    // The reopen runs `applyMigrations` on a database that already has the schema. The DDL has no
    // `IF NOT EXISTS`, so a broken guard throws "table already exists" here.
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
