// The projects, repository mounts and workspaces tables, which the daemon's schema script runs
// with the rest.

/**
 * Where a project's clone stands while the project is marked `cloning`: git running, failed with
 * git's words, canceled by the person, or interrupted by the service's restart or shutdown.
 */
export const CloneOutcome = {
  Running: "running",
  Failed: "failed",
  Canceled: "canceled",
  Interrupted: "interrupted",
} as const;

/** One of {@link CloneOutcome}'s values, as the `projects.clone_outcome` column holds it. */
export type CloneOutcome = (typeof CloneOutcome)[keyof typeof CloneOutcome];

const CLONE_OUTCOME_VALUES_SQL = Object.values(CloneOutcome)
  .map((outcome) => `'${outcome}'`)
  .join(", ");

/**
 * The workspace part of the daemon's schema: projects, then the repository mounts that name them,
 * then the workspaces bound to those mounts, in foreign-key order.
 */
export const WORKSPACE_SCHEMA_SQL: string = `
-- ---------------------------------------------------------------------------
-- Projects, repository mounts and workspaces.
-- ---------------------------------------------------------------------------
-- A project: the record beside a repository's mount that the person names. It exists from the
-- first press of Clone, before any mount does. name is the display name, the folder's own name
-- until the person renames it. slug is fixed at attach and names the project's worktrees folder,
-- ~/.ai-sidekicks/worktrees/<slug>/, so a rename moves no worktree. folder_path is the
-- repository's root, or the clone's destination while cloning. The repository's identity is its
-- mount's anchor (repo_mounts.metadata.commonDir); attach keeps one project per repository. While
-- cloning, clone_url keeps the address the person typed with any user and password taken out,
-- clone_outcome where the clone stands, clone_failure git's last error line after a failed clone,
-- and clone_staging_folder the folder the daemon made beside the destination for git to clone
-- into, with clone_staging_identity its <device>:<inode>: the one folder a failure or a restart
-- removes, and only while that path still holds that folder.
CREATE TABLE projects (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  folder_path            TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN ('cloning', 'active', 'archived')),
  clone_url              TEXT,
  clone_outcome          TEXT CHECK(clone_outcome IN (${CLONE_OUTCOME_VALUES_SQL})),
  clone_failure          TEXT,
  clone_staging_folder   TEXT,
  clone_staging_identity TEXT,
  setup                  TEXT NOT NULL,              -- JSON: the setup steps
  environment_rows       TEXT NOT NULL DEFAULT '[]', -- JSON: the project's own environment rows
  branch_pattern         TEXT,                       -- NULL follows the machine's pattern
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK ((state = 'cloning') = (clone_url IS NOT NULL)),
  CHECK ((state = 'cloning') = (clone_outcome IS NOT NULL)),
  CHECK ((clone_staging_folder IS NULL) = (clone_staging_identity IS NULL)),
  CHECK (state = 'cloning' OR clone_staging_folder IS NULL),
  CHECK ((clone_outcome IS '${CloneOutcome.Failed}') = (clone_failure IS NOT NULL))
) STRICT;

-- A mount belongs to the machine, not to a session. local_path is what the
-- user entered; canonical_root is the resolver's absolute, symlink-resolved
-- path, and every trust check keys on it.
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL,                -- the daemon's own node, stamped at attach
  local_path      TEXT NOT NULL,
  canonical_root  TEXT NOT NULL,
  vcs_type        TEXT NOT NULL DEFAULT 'git'
                  CHECK(vcs_type IN ('git')),
  -- 'attached' is a project's folder the person attached or cloned; 'managed'
  -- is a chat's git-initialized workspace the daemon owns.
  origin          TEXT NOT NULL DEFAULT 'attached'
                  CHECK(origin IN ('attached', 'managed')),
  -- The one chat a managed mount belongs to; event-sourced, so no foreign key.
  managed_session_id TEXT,
  -- The project an attached mount serves; NULL on a chat's managed mount, and
  -- on a detached mount once its project is forgotten.
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'attached'
                  CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',   -- JSON
  -- The background fetch's last success, and its last failure while none has succeeded since; the
  -- ahead and behind figures read as of fetched_at (attached_at before any) while one is set.
  fetched_at      TEXT,
  fetch_failed_at TEXT,
  CHECK ((origin = 'managed') = (managed_session_id IS NOT NULL)),
  CHECK (origin = 'attached' OR project_id IS NULL),
  CHECK (origin = 'managed' OR state <> 'attached' OR project_id IS NOT NULL)
) STRICT;

-- Two aliases of one root on one machine are one mount; the same path on two
-- machines is two filesystems; a detached row does not block a re-attach.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(node_id, canonical_root) WHERE state = 'attached';
CREATE UNIQUE INDEX idx_repo_mounts_managed_session
  ON repo_mounts(managed_session_id) WHERE managed_session_id IS NOT NULL;
-- A project has one attached mount, which every session of the project binds to.
CREATE UNIQUE INDEX idx_repo_mounts_active_project
  ON repo_mounts(project_id) WHERE state = 'attached';

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL
                  CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  fs_root         TEXT,                         -- NULL while a root is being made; a moved
                                                -- workspace keeps its root while it is admitted again
  state           TEXT NOT NULL DEFAULT 'preparing'
                  CHECK(state IN ('preparing', 'ready', 'stale', 'archived')),
  -- JSON: lastError, why a stale workspace's last preparation failed; boundRoot, the folder the
  -- bind admitted, where a bound-root run works, never cleared; checkoutRoot, the top level of the
  -- working tree the workspace works in now, the bound checkout's or its worktree's.
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);
-- A session has one live workspace on a mount, so binding it again answers that one; an archived
-- row is history and does not count.
CREATE UNIQUE INDEX idx_workspaces_live_session_mount
  ON workspaces(session_id, repo_mount_id) WHERE state <> 'archived';
`;
