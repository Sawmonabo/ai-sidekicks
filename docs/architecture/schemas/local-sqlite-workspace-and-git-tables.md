# Workspace and Git Tables (Plan-006, Plan-007, Plan-008)

The workspace and git tables of the daemon's one SQLite schema: the attached and managed folders, the workspaces bound to them, the worktrees, the removed worktrees kept for `Put back`, the branch contexts and each run's execution binding. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

```sql
-- Owner: Plan-006
CREATE TABLE repo_mounts (
  id                  TEXT PRIMARY KEY,
  node_id             TEXT NOT NULL,          -- this machine's own node id, stamped by the daemon and never taken from the caller; a mount belongs to the machine, not to a session
  local_path          TEXT NOT NULL,          -- user-entered attach path (provenance)
  canonical_root      TEXT NOT NULL,          -- resolver output: absolute, symlink-resolved (envelope/dedupe key)
  origin              TEXT NOT NULL DEFAULT 'attached'
                      CHECK(origin IN ('attached', 'managed')),
                                              -- 'attached' = a project's folder the person attached or cloned; 'managed' = a chat's
                                              -- git-initialized workspace the daemon owns (Spec-001 §Required Behavior; ADR-030)
  managed_session_id  TEXT,                   -- the one chat a managed mount belongs to (event-sourced session id, no FK, matching session_id columns elsewhere)
  state               TEXT NOT NULL DEFAULT 'attached'
                      CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  metadata            TEXT NOT NULL DEFAULT '{}', -- JSON; commonDir: attach-persisted canonicalized git common directory — the repo-identity anchor bind/run re-derivation must match (Spec-007 §Repo Identity And Common-Directory Keying (V1 Definition)); reads never write it
  CHECK ((origin = 'managed') = (managed_session_id IS NOT NULL))
);

-- Active-mount uniqueness binds the CANONICAL root per owning node (Plan-006 D-006-7): two
-- entered aliases resolving to one root are one mount, whichever session asked, and a folder
-- is listed once per machine with what uses it; detached rows stay re-attachable as new rows.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(node_id, canonical_root) WHERE state = 'attached';
CREATE UNIQUE INDEX idx_repo_mounts_managed_session
  ON repo_mounts(managed_session_id) WHERE managed_session_id IS NOT NULL;

-- Owner: Plan-006
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL               -- where the session works, chosen at bind (session.create or repo.workspaceBind): 'bound-root' = the project's own checkout; 'provisioned-worktree' = a worktree of its own. A chat's managed workspace is always 'bound-root'
                  CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'preparing'
                  CHECK(state IN ('preparing', 'ready', 'busy', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-007); boundRoot: admitted bind origin — the bound-root execution-root carrier, never cleared by a new preparation (Spec-007/Spec-008)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);
-- A session has one live workspace on a mount, so binding it again answers that one; an archived
-- row is history and does not count.
CREATE UNIQUE INDEX idx_workspaces_live_session_mount
  ON workspaces(session_id, repo_mount_id) WHERE state <> 'archived';

-- Owner: Plan-007 (provenance columns, active-branch uniqueness, cleanup stamp — D-007-5)
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,              -- creating-session provenance (Spec-008 §State And Data Implications; session ids are event-sourced — no FK, matching session_id columns elsewhere)
  created_by_run_id     TEXT,                       -- creating-run provenance; NULL = pre-run explicit prepare (run ids are event-sourced, not FK-constrained)
  branch_name           TEXT NOT NULL,
  fs_root               TEXT NOT NULL,              -- filesystem path to worktree (under the daemon execution-roots dir, D-007-6)
  state                 TEXT NOT NULL DEFAULT 'creating'
                        CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  cleaned_at            TEXT                        -- async disk-cleanup stamp (retire records state; the sweep stamps cleanup)
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- At most one live checkout per (mount, branch): mirrors git's own constraint — a checkout existing
-- on disk (any non-retired, non-failed state, including 'merged') still holds the branch. Race arbiter
-- for the provenance-split collision policy (Spec-008 §Branch, Base And Preparation Rules).
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- Owner: Plan-007
-- A worktree removed with `Discard and remove`, kept whole until the person presses `Delete now`; nothing
-- deletes it automatically. The folder is moved intact to
-- ~/.ai-sidekicks/worktrees/<project>/.removed/<name>-<removed id>/, holding the tree, a copy of git's
-- per-worktree record and a pack of the staged objects, and every commit the kept record names is pinned
-- in the person's repository under refs/sidekicks/removed/<removed id>/. `Put back` moves the tree back and
-- removes the pins; `Delete now` deletes the kept folder and the pins (Spec-008 §State And Data Implications).
CREATE TABLE removed_worktrees (
  id              TEXT PRIMARY KEY,
  mount_id        TEXT NOT NULL REFERENCES repo_mounts(id),
  project_id      TEXT NOT NULL,              -- the project record the worktree belonged to
  worktree_name   TEXT NOT NULL,
  original_path   TEXT NOT NULL,              -- where the worktree lived, for `Put back`
  branch          TEXT NOT NULL,
  head_commit     TEXT NOT NULL,
  removed_at      TEXT NOT NULL,
  size_bytes      INTEGER,                    -- read once after the discard, off its path; NULL until read
  size_read_at    TEXT
);

CREATE INDEX idx_removed_worktrees_project ON removed_worktrees(project_id);

-- Owner: Plan-007 | Extended by: Plan-008
-- Root carrier (D-007-5): provisioned-worktree rows reference the worktree; bound-root rows reference
-- none (the project's own checkout carries no Plan-007 root row).
CREATE TABLE branch_contexts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id        TEXT REFERENCES worktrees(id),
  base_branch        TEXT NOT NULL,
  head_branch        TEXT NOT NULL,
  upstream_ref       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;  -- one binding row per (workspace, worktree) — D-007-15 upsert; the worktree-keyed BranchContextRead resolves on the pair

-- Owner: Plan-007 (D-007-16) | Extended by: Plan-014
-- Per-run execution binding (Spec-008 §State And Data Implications: execution mode as run setup data):
-- which workspace, mode and root a run that works in a repository executes against. One row per run, written
-- at the run's start: an agent run keyed by its run id, a workflow run keyed by its workflow run id (both
-- event-sourced UUIDs, so the PRIMARY KEY carries no FK). A run in a chat's own folder, and a `None` run, writes no row. A workflow
-- run's row lives as long as the run's record, and a session that moves while the run is paused leaves its
-- steps on the recorded root (Spec-015 §Interfaces And Contracts).
-- released_at stamps run-terminal release; an undo leaves it as it is (Spec-003 §Required Behavior; the Plan-007 bundle owns the implementing task).
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,                  -- event-sourced session id (no FK, matching session_id columns elsewhere)
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  execution_root     TEXT NOT NULL,
  git_common_dir     TEXT NOT NULL,                  -- `git rev-parse --git-common-dir` (absolute) captured at context creation: the surviving canonical git dir for the base pins under `refs/sidekicks/base/<owner id>/` and the alternate a capture is read through, so pin removal outlives a worktree retirement of execution_root (provisioned-worktree → the main repository's git dir; bound-root → <root>/.git)
  worktree_id        TEXT REFERENCES worktrees(id),
  branch_context_id  TEXT NOT NULL REFERENCES branch_contexts(id),
  point_capture_error TEXT,                          -- workflow runs: why a snapshot point after the start failed to capture; NULL while every point captured. A fault at the start fails the run before its first step instead
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- Mode-conditional identity: a provisioned-worktree row names its worktree, a bound-root row names none,
  -- and both carry their branch context (Spec-008 §State And Data Implications).
  CHECK ((execution_mode = 'provisioned-worktree') = (worktree_id IS NOT NULL))
);

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);
```

**Project record.** An attached repository is a project, and each project keeps a durable record beside its mount: its display name, the setup steps its worktrees run after preparation, its own environment rows, whether it is archived, and a cloning mark while `repo.clone` fetches it. One origin holds one project record, so attaching a folder that is already a project finds that project. Renaming a project edits the display name alone. Deleting a project forgets the record and detaches its mount; its sessions and the folder on disk stay ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)). The removed-worktree records, the agent definitions and the workflow secrets key a project by this record's id.
