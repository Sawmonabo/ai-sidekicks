// The worktrees, removed worktrees, branch contexts and run execution roots tables, which the
// daemon's schema script runs with the rest, after the workspace tables they reference.

/**
 * The worktree part of the daemon's schema: worktrees, the kept copies of removed ones, branch
 * contexts and each run's execution root, in foreign-key order.
 */
export const WORKTREE_SCHEMA_SQL: string = `
-- ---------------------------------------------------------------------------
-- Worktrees, branch contexts and run execution roots.
-- ---------------------------------------------------------------------------
-- Session and run ids are event-sourced, so they carry no foreign key.
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,
  created_by_run_id     TEXT,                   -- NULL for a prepare before any run
  branch_name           TEXT NOT NULL,
  base_ref              TEXT NOT NULL,          -- the base the branch was cut from, as given
  fs_root               TEXT NOT NULL,          -- the tree's folder
  state                 TEXT NOT NULL DEFAULT 'creating'
    CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- What the risk read showed when the daemon retired a tree it made and could not hand over, as
  -- a digest; NULL for any other retirement, whose removal showed nothing to lose. The sweep
  -- deletes the folder only while a read shows nothing to lose or this same digest.
  retired_risk_digest   TEXT,
  -- Set once the sweep has decided to delete the folder, before git's record of it goes, so a pass
  -- after a crash finishes the removal without reading a tree git no longer knows.
  cleanup_started_at    TEXT,
  -- Stamped once the folder is gone, kept aside, or left on disk for good.
  cleaned_at            TEXT
) STRICT;

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- Git's own rule: a checkout on disk (any state but retired or failed, merged
-- included) holds its branch. This index arbitrates a creation race.
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- A worktree removed with Discard and remove, kept whole until the person deletes it; nothing
-- deletes it on its own. The folder sits in the project's worktrees folder under .removed/, and
-- the commits it names stay pinned in the repository until Put back or Delete now. Put back moves
-- it back into the tree, and what is left of it goes after the answer.
CREATE TABLE removed_worktrees (
  id              TEXT PRIMARY KEY,
  mount_id        TEXT NOT NULL REFERENCES repo_mounts(id),
  project_id      TEXT NOT NULL,                -- the project record the worktree belonged to
  -- The session that made the worktree, carried to the tree a put-back makes.
  created_by_session_id TEXT NOT NULL,
  worktree_name   TEXT NOT NULL,
  original_path   TEXT NOT NULL,                -- where the worktree lived, for Put back
  kept_path       TEXT NOT NULL,                -- the kept folder under the project's .removed/
  branch          TEXT NOT NULL,
  -- 1 when branch is the one the kept HEAD names, or in a rebase the one being rebased; 0 for a
  -- detached HEAD, whose row keeps the worktree's own branch. Set with head_commit.
  is_on_branch    INTEGER NOT NULL DEFAULT 0 CHECK (is_on_branch IN (0, 1)),
  base_ref        TEXT NOT NULL,                -- the worktree's base, carried to its put-back
  -- Set just before the tree moves, from what the copy records; NULL while nothing has moved.
  head_commit     TEXT,
  -- Git's record of the tree as git named it from inside the live tree; set with head_commit.
  record_folder   TEXT,
  -- Set in the tree's retirement write. NULL while the tree is being moved aside: no list shows
  -- the row, and the daemon's start finishes or undoes it.
  removed_at      TEXT,
  size_bytes      INTEGER,                      -- read once after the discard; NULL until read
  size_read_at    TEXT,
  -- Set in the put-back's write: the tree is back, and what is left here goes once it stands
  -- sound or has gone through its own removal, a failure retried at the next cleanup. No foreign
  -- key: a session purge may delete that tree's row, which counts as its own removal.
  restored_worktree_id TEXT,
  -- Written by a put-back before its tree moves and cleared in its record write or once it is
  -- undone; a row still marked names a put-back a crash cut short, which the daemon undoes.
  restoring_to    TEXT,                         -- the folder the tree is being put back at
  restoring_record TEXT,                        -- git's record the put-back made for it
  restoring_branch TEXT,                        -- a branch the put-back makes; NULL keeps its own
  restoring_branch_commit TEXT,                 -- the commit that branch is made at
  CHECK (removed_at IS NULL OR head_commit IS NOT NULL),
  CHECK ((head_commit IS NULL) = (record_folder IS NULL)),
  CHECK ((restoring_to IS NULL) = (restoring_record IS NULL)),
  CHECK ((restoring_branch IS NULL) = (restoring_branch_commit IS NULL)),
  CHECK (restoring_to IS NOT NULL OR restoring_branch IS NULL)
) STRICT;

CREATE INDEX idx_removed_worktrees_project ON removed_worktrees(project_id);

-- A provisioned-worktree row names its worktree; a bound-root row names none
-- (the mount's own checkout has no root row).
CREATE TABLE branch_contexts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id   TEXT REFERENCES worktrees(id),
  base_branch   TEXT NOT NULL,
  head_branch   TEXT NOT NULL,
  upstream_ref  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
-- One binding row per (worktree, workspace): the upsert key.
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace
  ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;

-- released_at stamps the run-terminal release of the root.
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  execution_root     TEXT NOT NULL,
  -- The top level of the working tree the run works in, written while the tree
  -- exists, so a snapshot captures the whole tree even from a nested root.
  checkout_root      TEXT NOT NULL,
  -- git rev-parse --git-common-dir (absolute) at creation: the git dir that
  -- outlives a retired worktree, so snapshot refs can still be pruned.
  git_common_dir     TEXT NOT NULL,
  worktree_id        TEXT REFERENCES worktrees(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- The mode names which root id is present; both modes carry their branch
  -- context.
  CHECK(
    (execution_mode = 'bound-root' AND worktree_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'provisioned-worktree'
        AND worktree_id IS NOT NULL AND branch_context_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);
`;
