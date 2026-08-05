// Plan-009 T2.1 — version-10 migration: the repo-mount and workspace tables.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Workspace and Git Tables (Plan-009, Plan-010, Plan-011)" — the two Plan-009
// CREATE TABLE blocks below are copied VERBATIM from that section (including the
// `-- Owner: Plan-009` headers, the per-column comments, and the four-line
// rationale above the partial-unique index), the same convention and the same
// direction of authority `0002-runtime-node.ts` / `0004-worktree-lifecycle.ts`
// state: the schema doc defines the shape, this file applies it. Change the doc
// first, then mirror it here.
//
// ----------------------------------------------------------------------------
// Plan-009 scope (this migration — version 10)
// ----------------------------------------------------------------------------
//
// Plan-009 owns the physical CREATE for exactly two Local SQLite tables:
//
//   * repo_mounts — the durable attach record. It carries BOTH path values
//                   because both are meaningful (I-009-5): `local_path` is the
//                   user-entered path (provenance) and `canonical_root` is the
//                   resolver's absolute, symlink-resolved output. Every
//                   trust-envelope check and every node-ownership routing
//                   decision keys off `canonical_root`, never `local_path`.
//   * workspaces  — the execution binding: which mount, which execution mode,
//                   which resolved root (`fs_root`, nullable while a writable
//                   mode is provisioning), and the lifecycle state the health
//                   projection reads.
//
// NOT created here: `worktrees` / `ephemeral_clones` / `branch_contexts` /
// `run_execution_contexts` are Plan-010's, shipped at version 4. Their
// `REFERENCES repo_mounts(id)` / `REFERENCES workspaces(id)` clauses are the
// forward references the ratified B23 order left resolvable-but-unresolved:
// SQLite resolves FK targets lazily at DML time, so version 4 applied cleanly
// against absent parents and every INSERT into those referencing columns failed
// as `SQLITE_ERROR: no such table` until THIS version. Applying version 10
// after version 4 is therefore the intended order, not a repair — and it is
// what turns those columns' failure class into the ordinary
// `FOREIGN KEY constraint failed`.
//
// The active-mount partial unique index (D-009-7) is the deduplication key, and
// its three columns are each load-bearing: `canonical_root` rather than
// `local_path` so two entered aliases of one repository are recognized as one
// mount; `node_id` so the same absolute path on two runtime nodes stays two
// distinct node-local filesystems; `WHERE state = 'attached'` so a detached row
// is history rather than a permanent block on re-attach.
//
// Idempotency + concurrency are the migration runner's job (the guarded
// `hasMigrationApplied(db, 10)` block with its in-transaction re-check and
// `.immediate()` dispatch); this constant is a plain DDL script. The transcribed
// DDL carries no `IF NOT EXISTS`, so a second exec throws "table already
// exists" — the runner guard is what makes re-application a no-op, and the
// version-10 anchor row committing in the SAME transaction as the CREATEs is
// what keeps the guard and the physical schema from ever disagreeing. Atomicity
// is load-bearing here for the reason it is at versions 6, 8, and 9: a torn
// apply that landed `repo_mounts` without `idx_repo_mounts_active_root` would
// leave the attach path admitting duplicate active mounts of one canonical root,
// silently.
//
// The `schema_version` anchor table itself is owned by Plan-001
// (`0001-initial.ts`); this migration only INSERTs its version-10 row.
//
// Spec coverage: `Spec-009 §State And Data Implications` — repo mount records
// persist canonical root, owner node, and lifecycle state; workspace records
// persist execution root, repo association, and health. Refs: Plan-009 T2.1,
// invariant I-009-5, D-009-7.

export const REPO_WORKSPACES_MIGRATION_SQL: string = `
-- Owner: Plan-009
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  node_id         TEXT NOT NULL,              -- owning runtime node (the node that can access the path)
  local_path      TEXT NOT NULL,              -- user-entered attach path (provenance)
  canonical_root  TEXT NOT NULL,              -- resolver output: absolute, symlink-resolved (envelope/dedupe key)
  vcs_type        TEXT NOT NULL DEFAULT 'git'
                  CHECK(vcs_type IN ('git', 'none')),
  state           TEXT NOT NULL DEFAULT 'attached'
                  CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}' -- JSON
);

CREATE INDEX idx_repo_mounts_session ON repo_mounts(session_id);
-- Active-mount uniqueness binds the CANONICAL root per owning node (Plan-009 D-009-7): two
-- entered aliases resolving to one root on one node are one mount; the same absolute path on two
-- different nodes is two distinct node-local filesystems (Spec-009 §State And Data Implications) and both attach;
-- detached rows stay re-attachable as new rows.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(session_id, node_id, canonical_root) WHERE state = 'attached';

-- Owner: Plan-009
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL DEFAULT 'read-only' -- read-only until a writable mode is explicitly selected (Spec-009; 'worktree' is the default WRITABLE run mode per ADR-006, not the row default)
                  CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'ready', 'busy', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-009)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);

INSERT INTO schema_version (version, applied_at, description)
VALUES (10, datetime('now'), 'Repo mount and workspace tables (repo_mounts, workspaces)');
`;
