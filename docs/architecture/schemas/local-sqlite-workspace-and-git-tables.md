# Workspace and Git Tables (Plan-006, Plan-007, Plan-008)

The project, repository mount, workspace and worktree tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

```sql
-- Owner: Plan-006
-- The project record (**Project record** below). It exists from the first press of `Clone`, before any mount does.
CREATE TABLE projects (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,              -- the display name; the folder's own name until the person renames it
  slug                 TEXT NOT NULL UNIQUE,       -- fixed at attach; names the project's worktrees folder, ~/.ai-sidekicks/worktrees/<slug>/, so a rename moves no worktree
  folder_path          TEXT NOT NULL,              -- the repository's root; the clone's destination while cloning
  state                TEXT NOT NULL CHECK(state IN ('cloning', 'active', 'archived')),  -- ProjectState
  clone_url            TEXT,                       -- while cloning: the address the person typed, any user and password taken out
  clone_outcome        TEXT CHECK(clone_outcome IN ('running', 'failed', 'canceled', 'interrupted')),
                                                   -- while cloning: git running, failed with git's words, canceled by the person, or
                                                   -- interrupted by the service's restart or shutdown
  clone_failure        TEXT,                       -- git's last error line after a failed clone
  clone_staging_folder   TEXT,                     -- while cloning: the folder the daemon made beside the destination for git to clone into, renamed into place once the clone finishes
  clone_staging_identity TEXT,                     -- that folder's <device>:<inode>; a failure or a restart removes the folder only while its path still holds that same folder, so a folder the person made is never deleted
  setup                TEXT NOT NULL,              -- JSON ProjectSetup: files to copy, commands in order, the step time limit (absent: no limit)
  environment_rows     TEXT NOT NULL DEFAULT '[]', -- JSON EnvironmentRow[]: the project's own rows, each winning over the machine's row of the same name
  branch_pattern       TEXT,                       -- NULL follows the machine's pattern
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK ((state = 'cloning') = (clone_url IS NOT NULL)),
  CHECK ((state = 'cloning') = (clone_outcome IS NOT NULL)),
  CHECK ((clone_staging_folder IS NULL) = (clone_staging_identity IS NULL)),
  CHECK (state = 'cloning' OR clone_staging_folder IS NULL),
  CHECK ((clone_outcome IS 'failed') = (clone_failure IS NOT NULL))
);

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
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
                                              -- the project an attached mount serves; NULL on a chat's managed mount, and on a
                                              -- detached mount once the detach forgot its project. A re-attach writes its new row
                                              -- under the same project
  state               TEXT NOT NULL DEFAULT 'attached'
                      CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  metadata            TEXT NOT NULL DEFAULT '{}', -- JSON; commonDir: attach-persisted canonicalized git common directory — the repo-identity anchor bind/run re-derivation must match (Spec-007 §Repo Identity And Common-Directory Keying (V1 Definition)); reads never write it
  fetched_at          TEXT,                   -- the background fetch's last success; ahead and behind read as of it (attached_at before any)
  fetch_failed_at     TEXT,                   -- the background fetch's last failure while none has succeeded since
  CHECK ((origin = 'managed') = (managed_session_id IS NOT NULL)),
  CHECK (origin = 'attached' OR project_id IS NULL),
  CHECK (origin = 'managed' OR state <> 'attached' OR project_id IS NOT NULL)
);

-- Active-mount uniqueness binds the CANONICAL root per owning node (Plan-006 D-006-7): two
-- entered aliases resolving to one root are one mount, whichever session asked, and a folder
-- is listed once per machine with what uses it; detached rows stay re-attachable as new rows.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(node_id, canonical_root) WHERE state = 'attached';
CREATE UNIQUE INDEX idx_repo_mounts_managed_session
  ON repo_mounts(managed_session_id) WHERE managed_session_id IS NOT NULL;
-- A project has one attached mount, which every session of the project binds to.
CREATE UNIQUE INDEX idx_repo_mounts_active_project
  ON repo_mounts(project_id) WHERE state = 'attached';

-- Owner: Plan-006
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL               -- where the session works, chosen at bind (session.create or repo.workspaceBind): 'bound-root' = the project's own checkout; 'provisioned-worktree' = a worktree of its own. A chat's managed workspace is always 'bound-root'
                  CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'preparing'
                  CHECK(state IN ('preparing', 'ready', 'stale', 'archived')),  -- no run holds a workspace: an agent runs where its run's execution context is unreleased
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-007); boundRoot: admitted bind origin — the bound-root execution-root carrier, never cleared by a new preparation (Spec-007/Spec-008); checkoutRoot: the top level of the working tree boundRoot sits in, rewritten by every completed preparation, which a run's checkout_root and a worktree's occupancy read
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
  base_ref              TEXT NOT NULL,              -- the base the branch was cut from, as given
  fs_root               TEXT NOT NULL,              -- filesystem path to worktree (under the daemon execution-roots dir, D-007-6)
  state                 TEXT NOT NULL DEFAULT 'creating'
                        CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  retired_risk_digest   TEXT,                       -- digest of what the risk read showed when the daemon retired a tree it made and could not hand over; NULL for any other retirement, whose removal showed nothing to lose. The sweep deletes the folder only while a read shows nothing to lose or this same digest, and keeps any other tree aside as a kept copy
  cleanup_started_at    TEXT,                       -- set once the sweep has decided to delete the folder, before git's record of it goes, so a pass after a crash finishes the removal without reading a tree git no longer knows
  cleaned_at            TEXT                        -- async disk-cleanup stamp (retire records state; the sweep stamps the folder gone, kept aside or left on disk)
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- At most one live checkout per (mount, branch): mirrors git's own constraint — a checkout existing
-- on disk (any non-retired, non-failed state, including 'merged') still holds the branch. Race arbiter
-- for the provenance-split collision policy (Spec-008 §Branch, Base And Preparation Rules).
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- Owner: Plan-007
-- A worktree removed with `Discard and remove`, or a removed one the cleanup sweep found holding something
-- its removal did not show, kept whole until the person presses `Delete now`; nothing deletes it
-- automatically. The folder is moved intact to
-- ~/.ai-sidekicks/worktrees/<project>/.removed/<name>-<removed id>/, holding the tree, a copy of git's
-- per-worktree record and a pack of the staged objects, and every commit the kept record names is pinned
-- in the person's repository under refs/sidekicks/removed/<removed id>/. `Put back` moves the tree back, and
-- its leftover pins, kept folder and row are removed after the answer; `Delete now` deletes the kept folder
-- and the pins (Spec-008 §State And Data Implications).
CREATE TABLE removed_worktrees (
  id              TEXT PRIMARY KEY,
  mount_id        TEXT NOT NULL REFERENCES repo_mounts(id),
  project_id      TEXT NOT NULL,              -- the project record the worktree belonged to
  created_by_session_id TEXT NOT NULL,        -- the session that made the worktree, carried to the tree a put-back makes
  worktree_name   TEXT NOT NULL,
  original_path   TEXT NOT NULL,              -- where the worktree lived, for `Put back`
  kept_path       TEXT NOT NULL,              -- the kept folder under the project's .removed/
  branch          TEXT NOT NULL,
  is_on_branch    INTEGER NOT NULL DEFAULT 0 CHECK (is_on_branch IN (0, 1)), -- 1 when branch is the one the kept HEAD names (in a rebase, the one being rebased); 0 for a detached HEAD, whose row keeps the worktree's own branch; set with head_commit
  base_ref        TEXT NOT NULL,              -- the worktree's base, carried to its put-back
  head_commit     TEXT,                       -- set just before the tree moves, from what the copy records; NULL while nothing has moved
  record_folder   TEXT,                       -- git's record of the tree as git named it from inside the live tree, set with head_commit; the stale-record check and the repair of an interrupted discard read it, so a moved tree's relative link is never resolved
  removed_at      TEXT,                       -- set in the write that lists the copy; NULL while the tree is being moved aside: no list shows the row, and the daemon's start finishes or undoes it
  size_bytes      INTEGER,                    -- read once after the discard, off its path; NULL until read
  size_read_at    TEXT,
  restored_worktree_id TEXT,                  -- set in the put-back's write; what is left here is removed once the tree put back stands sound or has gone through its own removal, a failure tried again at the next cleanup, and a second put-back refuses; no foreign key, since a session purge may delete that tree's row, which counts as its own removal
  -- What a put-back is doing, written before its tree moves and cleared in its record write or once it is
  -- undone. A row still marked names a put-back a crash cut short: the daemon moves the tree back into the
  -- kept folder (after a copy across volumes, which left the kept tree whole, it deletes the copy), removes
  -- the record and deletes the branch it made, by its ref at its commit while no tree has it checked out,
  -- then clears the mark.
  restoring_to    TEXT,                       -- the folder the tree is being put back at
  restoring_record TEXT,                      -- git's record the put-back made for it
  restoring_branch TEXT,                      -- a branch the put-back makes; NULL keeps the tree's own
  restoring_branch_commit TEXT,               -- the commit that branch is made at
  CHECK (removed_at IS NULL OR head_commit IS NOT NULL),
  CHECK ((head_commit IS NULL) = (record_folder IS NULL)),
  CHECK ((restoring_to IS NULL) = (restoring_record IS NULL)),
  CHECK ((restoring_branch IS NULL) = (restoring_branch_commit IS NULL)),
  CHECK (restoring_to IS NOT NULL OR restoring_branch IS NULL)
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
  checkout_root      TEXT NOT NULL,                  -- the top level of the working tree the run works in, from workspaces.metadata.checkoutRoot, written while the tree exists: the caller-supplied checkoutRoot a turn snapshot captures from, so a nested execution_root still captures the whole tree
  git_common_dir     TEXT NOT NULL,                  -- `git rev-parse --git-common-dir` (absolute) captured at context creation: the surviving canonical git dir for the base pins under `refs/sidekicks/base/<owner id>/` and the alternate a capture is read through, so pin removal outlives a worktree retirement of execution_root (provisioned-worktree → the main repository's git dir; bound-root → <root>/.git)
  worktree_id        TEXT REFERENCES worktrees(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  point_capture_error TEXT,                          -- workflow runs: why a snapshot point after the start failed to capture; NULL while every point captured. A fault at the start fails the run before its first step instead
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- Mode-conditional identity: a provisioned-worktree row names its worktree, a bound-root row names none,
  -- and both carry their branch context (Spec-008 §State And Data Implications).
  CHECK (
    (execution_mode = 'bound-root' AND worktree_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'provisioned-worktree'
        AND worktree_id IS NOT NULL AND branch_context_id IS NOT NULL)
  )
);

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);
```

**Project record.** An attached repository is a project, and each project keeps a durable record beside its mount, the `projects` row: its display name, the folder slug fixed at attach, the setup steps its worktrees run after preparation, its own environment rows, its own branch-name pattern when one is set, whether it is archived, and a cloning mark (`state = 'cloning'`, with the address and the failure line) while `repo.clone` fetches it. The repository's identity is its mount's anchor, `repo_mounts.metadata.commonDir`, and attach keeps one project record per repository, so attaching a folder that is already a project finds that project. A project's attached mount names it in `repo_mounts.project_id`, and a re-attach writes its new mount row under the same record. Renaming a project edits the display name alone. Deleting a project forgets the record and detaches its mount; its sessions and the folder on disk stay ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)). The removed-worktree records, the agent definitions and the workflow secrets key a project by this record's id.
