//! The projects, repository mounts and workspaces tables, which the daemon's schema runs with the
//! rest. Every closed set a column holds is written from its enum.

use std::sync::LazyLock;

use sidekicks_contracts::project::ProjectState;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountState, VcsType, WorkspaceState};
use strum::{IntoStaticStr, VariantArray};

use crate::database::sql_list::sql_list_of;

/// Where a project's clone stands while the project is `cloning`: git running, failed with git's
/// words, canceled by the person, or interrupted by the service's restart or stop. Converts to the
/// word the `projects.clone_outcome` column holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, VariantArray, IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum CloneOutcome {
    /// Git is running.
    Running,
    /// Git failed; `clone_failure` holds its last line.
    Failed,
    /// The person canceled it.
    Canceled,
    /// The service's restart or stop cut it short.
    Interrupted,
}

/// Where a repository mount came from, as the `repo_mounts.origin` column holds it: a project's
/// folder the person attached or cloned, or a chat's git-initialized workspace the daemon owns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, VariantArray, IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum MountOrigin {
    /// A project's folder.
    Attached,
    /// A chat's managed workspace.
    Managed,
}

/// The workspace part of the daemon's schema: projects, then the repository mounts that name them,
/// then the workspaces bound to those mounts, in foreign-key order.
pub(crate) static WORKSPACE_SCHEMA_SQL: LazyLock<String> = LazyLock::new(workspace_schema_sql);

fn workspace_schema_sql() -> String {
    let project_states = sql_list_of(
        ProjectState::VARIANTS
            .iter()
            .copied()
            .map(<&'static str>::from),
    );
    let clone_outcomes = sql_list_of(
        CloneOutcome::VARIANTS
            .iter()
            .copied()
            .map(<&'static str>::from),
    );
    let vcs_types = sql_list_of(VcsType::VARIANTS.iter().copied().map(<&'static str>::from));
    let mount_origins = sql_list_of(
        MountOrigin::VARIANTS
            .iter()
            .copied()
            .map(<&'static str>::from),
    );
    let mount_states = sql_list_of(
        RepoMountState::VARIANTS
            .iter()
            .copied()
            .map(<&'static str>::from),
    );
    let execution_modes = sql_list_of(
        ExecutionMode::VARIANTS
            .iter()
            .copied()
            .map(<&'static str>::from),
    );
    let workspace_states = sql_list_of(
        WorkspaceState::VARIANTS
            .iter()
            .copied()
            .map(<&'static str>::from),
    );
    let cloning = <&'static str>::from(ProjectState::Cloning);
    let failed = <&'static str>::from(CloneOutcome::Failed);
    let git = <&'static str>::from(VcsType::Git);
    let attached_origin = <&'static str>::from(MountOrigin::Attached);
    let managed_origin = <&'static str>::from(MountOrigin::Managed);
    let attached_state = <&'static str>::from(RepoMountState::Attached);
    let preparing = <&'static str>::from(WorkspaceState::Preparing);
    let archived_workspace = <&'static str>::from(WorkspaceState::Archived);
    format!(
        "
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
  state                  TEXT NOT NULL CHECK(state IN ({project_states})),
  clone_url              TEXT,
  clone_outcome          TEXT CHECK(clone_outcome IN ({clone_outcomes})),
  clone_failure          TEXT,
  clone_staging_folder   TEXT,
  clone_staging_identity TEXT,
  setup                  TEXT NOT NULL,              -- JSON: the setup steps
  environment_rows       TEXT NOT NULL DEFAULT '[]', -- JSON: the project's own environment rows
  branch_pattern         TEXT,                       -- NULL follows the machine's pattern
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK ((state = '{cloning}') = (clone_url IS NOT NULL)),
  CHECK ((state = '{cloning}') = (clone_outcome IS NOT NULL)),
  CHECK ((clone_staging_folder IS NULL) = (clone_staging_identity IS NULL)),
  CHECK (state = '{cloning}' OR clone_staging_folder IS NULL),
  CHECK ((clone_outcome IS '{failed}') = (clone_failure IS NOT NULL))
) STRICT;

-- A mount belongs to the machine, not to a session. local_path is what the
-- user entered; canonical_root is the resolver's absolute, symlink-resolved
-- path, and every trust check keys on it.
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL,                -- the daemon's own node, stamped at attach
  local_path      TEXT NOT NULL,
  canonical_root  TEXT NOT NULL,
  vcs_type        TEXT NOT NULL DEFAULT '{git}'
                  CHECK(vcs_type IN ({vcs_types})),
  -- '{attached_origin}' is a project's folder the person attached or cloned; '{managed_origin}'
  -- is a chat's git-initialized workspace the daemon owns.
  origin          TEXT NOT NULL DEFAULT '{attached_origin}'
                  CHECK(origin IN ({mount_origins})),
  -- The one chat a managed mount belongs to; event-sourced, so no foreign key.
  managed_session_id TEXT,
  -- The project an attached mount serves; NULL on a chat's managed mount, and
  -- on a detached mount once its project is forgotten.
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT '{attached_state}'
                  CHECK(state IN ({mount_states})),
  attached_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{{}}',   -- JSON
  -- The background fetch's last success, and its last failure while none has succeeded since; the
  -- ahead and behind figures read as of fetched_at (attached_at before any) while one is set.
  fetched_at      TEXT,
  fetch_failed_at TEXT,
  CHECK ((origin = '{managed_origin}') = (managed_session_id IS NOT NULL)),
  CHECK (origin = '{attached_origin}' OR project_id IS NULL),
  CHECK (origin = '{managed_origin}' OR state <> '{attached_state}' OR project_id IS NOT NULL)
) STRICT;

-- Two aliases of one root on one machine are one mount; the same path on two
-- machines is two filesystems; a detached row does not block a re-attach.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(node_id, canonical_root) WHERE state = '{attached_state}';
CREATE UNIQUE INDEX idx_repo_mounts_managed_session
  ON repo_mounts(managed_session_id) WHERE managed_session_id IS NOT NULL;
-- A project has one attached mount, which every session of the project binds to.
CREATE UNIQUE INDEX idx_repo_mounts_active_project
  ON repo_mounts(project_id) WHERE state = '{attached_state}';
-- A project's sessions, which its rules reach, found through every mount it attached.
CREATE INDEX idx_repo_mounts_project ON repo_mounts(project_id);

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL
                  CHECK(execution_mode IN ({execution_modes})),
  -- NULL while a root is being made; a moved workspace keeps its root while it is admitted again.
  fs_root         TEXT,
  state           TEXT NOT NULL DEFAULT '{preparing}'
                  CHECK(state IN ({workspace_states})),
  -- JSON: lastError, why a stale workspace's last preparation failed; boundRoot, the folder the
  -- bind admitted, where a bound-root run works, never cleared; checkoutRoot, the top level of the
  -- working tree the workspace works in now, the bound checkout's or its worktree's.
  metadata        TEXT NOT NULL DEFAULT '{{}}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);
-- A session has one live workspace on a mount, so binding it again answers that one; an archived
-- row is history and does not count.
CREATE UNIQUE INDEX idx_workspaces_live_session_mount
  ON workspaces(session_id, repo_mount_id) WHERE state <> '{archived_workspace}';
"
    )
}
