// Plan-010 PR #253 — worktree-lifecycle + execution-mode schema (inlined SQL).
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file — the same rationale as `0001-initial.ts` /
// `0002-runtime-node.ts` / `0003-runtime-bindings.ts`:
//
//   1. The build pipeline (`tsc -b`) does NOT copy non-TS assets into
//      `dist/`. Any FS-relative load path (`new URL(..., import.meta.url)`)
//      would resolve correctly under `vitest` (running against `src/`) but
//      throw `ENOENT` at first dist-from-import use.
//   2. `package.json` `"files": ["dist"]` would exclude `src/migrations/`
//      from the published tarball anyway, so a published consumer would
//      never see the SQL file even if a build-time copy step ran.
//   3. Bundlers (esbuild / webpack / Bun) handle `import.meta.url`
//      inconsistently; inline strings survive every transform stage.
//
// The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Workspace and Git Tables (Plan-009, Plan-010, Plan-011)" — the four
// Plan-010 CREATE TABLE blocks below are copied verbatim from that section
// (including the `-- Owner:` headers, the per-column comments, and the two
// partial-unique indexes) so the inline constant stays in lockstep with the
// canonical doc (D-010-5: the audited DDL there IS the migration content).
//
// ----------------------------------------------------------------------------
// Plan-010 scope (this migration — version 4)
// ----------------------------------------------------------------------------
//
// Plan-010 owns the physical CREATE for four Local SQLite tables:
//
//   * worktrees              — per-mount live checkouts with creating-session
//                              / creating-run provenance (I-010-3); the
//                              partial-unique `idx_worktrees_active_branch`
//                              (WHERE state NOT IN 'retired', 'failed') is
//                              the at-most-one-live-checkout-per-(mount,
//                              branch) race arbiter (I-010-4).
//   * ephemeral_clones       — TTL'd clone roots with cleanup bookkeeping;
//                              `idx_ephemeral_clones_sweep` (state,
//                              expires_at) serves the cleanup-tick scan.
//   * branch_contexts        — polymorphic root carrier: worktree-mode rows
//                              reference the worktree, ephemeral-clone rows
//                              the clone, branch-mode rows neither; the
//                              at-most-one-root CHECK holds (I-010-5).
//   * run_execution_contexts — per-run execution binding (run → workspace,
//                              mode, execution root, git_common_dir); the
//                              mode-conditional CHECK names exactly which
//                              root id each mode carries.
//
// Forward FK references (deliberate — ratified B23 campaign order):
//   `REFERENCES repo_mounts(id)` / `REFERENCES workspaces(id)` target
//   Plan-009 Phase 2 tables that no migration creates yet. SQLite resolves
//   FK targets lazily at DML time, so these CREATE TABLE statements apply
//   cleanly on a fresh database; under `foreign_keys = ON` any INSERT into
//   the referencing columns fails until the parent tables exist. That
//   failure is a statement-compile error — `SQLITE_ERROR: no such table:
//   main.repo_mounts` — NOT a `FOREIGN KEY constraint failed`
//   (SQLITE_CONSTRAINT_FOREIGNKEY) violation: with the parent TABLE absent,
//   SQLite never reaches constraint evaluation. Anything discriminating FK
//   failures by error class must account for both. (Observed against the
//   pinned toolchain and pinned by the "ships write-inert on a parent-less
//   db" case in `session/__tests__/migration-shape.test.ts`.) No production
//   insert path exists until Plan-010 Phase 2+, which chains after Plan-009
//   Phase 2's migration. Do NOT strip or weaken the REFERENCES clauses.
//
// Contract↔DDL lockstep (I-010-2, DDL half): the T1.4 conformance test
// string-extracts the CHECK clauses from this exported constant and compares
// the parsed sets against the `worktree.ts` contract enums — keep the
// constant exported and the CHECK clauses byte-verbatim.
//
// The `schema_version` anchor table itself is owned by Plan-001
// (`0001-initial.ts`); this migration only INSERTs its version-4 row.

export const WORKTREE_LIFECYCLE_MIGRATION_SQL: string = `
-- Owner: Plan-010 (Tier-6 audit: provenance columns, active-branch uniqueness, cleanup stamp — D-010-5)
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,              -- creating-session provenance (Spec-010 §State And Data Implications; session ids are event-sourced — no FK, matching session_id columns elsewhere)
  created_by_run_id     TEXT,                       -- creating-run provenance; NULL = pre-run explicit prepare (run ids are event-sourced, not FK-constrained)
  branch_name           TEXT NOT NULL,
  fs_root               TEXT NOT NULL,              -- filesystem path to worktree (under the daemon execution-roots dir, D-010-6)
  state                 TEXT NOT NULL DEFAULT 'creating'
                        CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  cleaned_at            TEXT                        -- async disk-cleanup stamp (retire records state; the sweep stamps cleanup)
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- At most one live checkout per (mount, branch): mirrors git's own constraint — a checkout existing
-- on disk (any non-retired, non-failed state, including 'merged') still holds the branch. Race arbiter
-- for the provenance-split collision policy (Spec-010 §Resolved Questions).
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- Owner: Plan-010 (Tier-6 audit: TTL + cleanup bookkeeping — D-010-5)
CREATE TABLE ephemeral_clones (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  clone_root      TEXT NOT NULL,              -- filesystem path (under the daemon execution-roots dir, D-010-6)
  branch_name     TEXT NOT NULL,              -- head branch inside the clone (caller-supplied or slug-derived at prepare; the status read exposes it — Spec-010 §Interfaces)
  cleanup_policy  TEXT NOT NULL DEFAULT 'on_run_complete'
                  CHECK(cleanup_policy IN ('on_run_complete', 'manual')),
  state           TEXT NOT NULL DEFAULT 'creating'
                  CHECK(state IN ('creating', 'ready', 'retired', 'failed')),
  expires_at      TEXT NOT NULL,              -- TTL deadline (daemon config, default 24h; Spec-009 §Ephemeral Clone Lifecycle)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  cleaned_at      TEXT                        -- async disk-cleanup stamp
);

CREATE INDEX idx_ephemeral_clones_workspace ON ephemeral_clones(workspace_id);
CREATE INDEX idx_ephemeral_clones_sweep ON ephemeral_clones(state, expires_at);  -- cleanup-tick scan

-- Owner: Plan-010 | Extended by: Plan-011
-- Polymorphic root carrier (Tier-6 audit, D-010-5): worktree-mode rows reference the worktree,
-- ephemeral-clone rows the clone, branch-mode rows neither (the main checkout carries no Plan-010 root row).
CREATE TABLE branch_contexts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id        TEXT REFERENCES worktrees(id),
  ephemeral_clone_id TEXT REFERENCES ephemeral_clones(id),
  base_branch        TEXT NOT NULL,
  head_branch        TEXT NOT NULL,
  upstream_ref       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (worktree_id IS NULL OR ephemeral_clone_id IS NULL)
);

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;  -- one binding row per (workspace, worktree) — D-010-15 upsert; the worktree-keyed BranchContextRead resolves on the pair

-- Owner: Plan-010 (Tier-6 audit, D-010-16)
-- Per-run execution binding (Spec-010 §State And Data Implications: execution mode as run setup data):
-- which workspace/mode/root a repo-bound run executes against. run_id is event-sourced (runs live in
-- the event log, not a table) — PRIMARY KEY without FK. released_at stamps run-terminal release; a terminal-source rollback clears it atomically with the run's re-open, and a rollback composite ending without a confirmed rewind restores it (campaign B2 — Spec-004 §Required Behavior; the campaign's Plan-010 bundle owns the implementing task).
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,                  -- event-sourced session id (no FK, matching session_id columns elsewhere)
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  execution_root     TEXT NOT NULL,
  git_common_dir     TEXT NOT NULL,                  -- \`git rev-parse --git-common-dir\` (absolute) captured at context creation: the surviving canonical git dir for snapshot-ref ops, so Plan-010 T5.3 ref pruning outlives a worktree retirement of execution_root (worktree mode → main repo git dir; branch/read-only → <root>/.git; ephemeral clone → the clone's own git dir, refs sharing the clone's disposal lifecycle)
  worktree_id        TEXT REFERENCES worktrees(id),
  ephemeral_clone_id TEXT REFERENCES ephemeral_clones(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- Mode-conditional identity (Tier-6 audit): the mode names exactly which root id is
  -- present, and every writable mode carries its branch context (Spec-010 §State And
  -- Data Implications); read-only carries none of the three.
  CHECK (
    (execution_mode = 'read-only' AND worktree_id IS NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NULL)
    OR (execution_mode = 'branch' AND worktree_id IS NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'worktree' AND worktree_id IS NOT NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'ephemeral clone' AND ephemeral_clone_id IS NOT NULL AND worktree_id IS NULL AND branch_context_id IS NOT NULL)
  )
);

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);

INSERT INTO schema_version (version, applied_at, description)
VALUES (4, datetime('now'), 'Worktree lifecycle tables (worktrees, ephemeral_clones, branch_contexts, run_execution_contexts)');
`;
