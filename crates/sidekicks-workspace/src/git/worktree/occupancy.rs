//! Who stands in which folder, and which session has an agent running there. A live workspace
//! stands where its checkout is, else at its root, and one with neither stands nowhere; an agent
//! runs where a run's execution context is still unreleased. Every folder is keyed by
//! [`canonical_folder_path`].
//!
//! - One read says who stands where, in three scopes: one mount's sessions, which every list and
//!   count reads; every mount of one repository, which the sweep out of a removed tree reads; and
//!   every live workspace of every mount, a session's and a workflow run's alike, which the
//!   retired-tree cleanup reads before it deletes a folder.
//! - The cleanup's read and its delete are held together: the cleanup holds the folder closing
//!   before it reads, and every write that puts a workspace in a folder holds that folder landing
//!   before it checks the closings, so a workspace either is read or is refused.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::folders::RepoMountOutsideTrustEnvelopeReason;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{optional_text_column, text_column};

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::worktree::path_holds::{PathHold, PathHolds};
use crate::git::worktree::rows::live_worktree_state_predicate;
use crate::repo::errors::RepoRefusal;
use crate::row_guards::{CHECKOUT_ROOT_METADATA_PATH, COMMON_DIR_METADATA_PATH};
use crate::service::WorkspaceServiceError;
use crate::trust_envelope::is_contained_within;

/// The statements the occupancy reader prepares on a pooled connection: one mount's standing
/// sessions and running sessions, and every mount's standing workspaces.
pub const MOUNT_OCCUPANCY_STATEMENT_CAPACITY: usize = 3;

/// The statements [`read_standing_in_repository`] and [`read_standing_folder_of`] prepare on a
/// pooled connection, which the occupancy reader never prepares.
pub const REPOSITORY_STANDING_STATEMENT_CAPACITY: usize = 2;

// Where a run-owned workspace's run stands is its context; the workspace itself stands for no
// session, so only the cleanup counts it.
static STANDING_ON_MOUNT_SQL: LazyLock<String> =
    LazyLock::new(|| standing_workspaces_sql("w.repo_mount_id = :repo_mount_id"));

static STANDING_IN_REPOSITORY_SQL: LazyLock<String> = LazyLock::new(|| {
    standing_workspaces_sql(&format!(
        "w.repo_mount_id IN ({})",
        repository_mounts_of(":repo_mount_id")
    ))
});

static STANDING_EVERYWHERE_SQL: LazyLock<String> = LazyLock::new(|| standing_workspaces_sql("1"));

static STANDING_FOLDER_OF_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM workspaces AS w WHERE w.id = :workspace_id AND w.state <> '{}'",
        standing_folder("w"),
        <&'static str>::from(WorkspaceState::Archived)
    )
});

// The oldest unreleased run in each folder is the one a removal names.
const RUNNING_SESSIONS_SQL: &str = "SELECT r.session_id, r.checkout_root
  FROM run_execution_contexts AS r
  JOIN workspaces AS w ON w.id = r.workspace_id
 WHERE w.repo_mount_id = :repo_mount_id
   AND r.released_at IS NULL
   AND r.checkout_root IS NOT NULL
 ORDER BY r.created_at, r.run_id";

/// The SQL value of the folder the `workspaces` row read as `table` stands in: the checkout, its
/// working tree's top level that the execution-root service records in its metadata, else its
/// root; `NULL` for a workspace that has neither.
pub fn standing_folder(table: &str) -> String {
    format!(
        "COALESCE(json_extract({table}.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
                 {table}.fs_root)"
    )
}

/// The SQL query of the ids of every mount of the repository the mount `mount` (a column or a
/// parameter) holds: that mount, and each other mount whose attach recorded the same common
/// folder.
pub fn repository_mounts_of(mount: &str) -> String {
    format!(
        "SELECT other.id FROM repo_mounts AS other, repo_mounts AS named
  WHERE named.id = {mount}
    AND (other.id = named.id
         OR json_extract(other.metadata, '{COMMON_DIR_METADATA_PATH}')
            = json_extract(named.metadata, '{COMMON_DIR_METADATA_PATH}'))"
    )
}

// Every live workspace with a folder among those `scope` keeps, oldest first, with its session's
// recorded branch, the live tree the daemon made at its folder and its mount's root.
fn standing_workspaces_sql(scope: &str) -> String {
    format!(
        "SELECT standing.id, standing.session_id, standing.folder, s.branch,
       (SELECT wt.id FROM worktrees AS wt
         WHERE wt.repo_mount_id = standing.repo_mount_id
           AND wt.fs_root = standing.folder
           AND {live_worktree}
         LIMIT 1),
       standing.is_run_owned, mount.canonical_root
  FROM (SELECT w.id, w.session_id, w.repo_mount_id, w.created_at,
               w.workflow_run_id IS NOT NULL AS is_run_owned, {folder} AS folder
          FROM workspaces AS w
         WHERE {scope} AND w.state <> '{archived}') AS standing
  JOIN repo_mounts AS mount ON mount.id = standing.repo_mount_id
  LEFT JOIN sessions AS s ON s.id = standing.session_id
 WHERE standing.folder IS NOT NULL
 ORDER BY standing.created_at, standing.id",
        live_worktree = live_worktree_state_predicate("wt"),
        folder = standing_folder("w"),
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
}

/// One live workspace standing in a folder, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StandingWorkspace {
    /// The workspace.
    pub workspace_id: WorkspaceId,
    /// Its session.
    pub session_id: SessionId,
    /// The folder it stands in, as stored.
    pub folder: PathBuf,
    /// Whether a workflow run owns it rather than its session.
    pub is_run_owned: bool,
    /// The root of its mount, the repository's own checkout.
    pub repository_root: PathBuf,
    /// The branch its session's record holds, `None` until one is written.
    pub(crate) recorded_branch: Option<GitRefName>,
    /// The live tree this daemon made at its folder, `None` for one it did not make.
    pub(crate) worktree_id: Option<WorktreeId>,
}

/// One session standing in a folder of the repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StandingSession {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The branch the session's record holds, `None` until one is written.
    pub(crate) recorded_branch: Option<GitRefName>,
    /// The live tree this daemon made at that folder, `None` for one it did not make.
    pub(crate) worktree_id: Option<WorktreeId>,
}

/// Who stands in, and who runs in, each folder of one repository mount, keyed by
/// [`canonical_folder_path`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct MountOccupancy {
    /// The sessions standing in each folder, oldest workspace first.
    pub(crate) standing_by_folder: HashMap<PathBuf, Vec<StandingSession>>,
    /// The session whose agent runs in each folder, for the folders where one does.
    pub(crate) running_by_folder: HashMap<PathBuf, SessionId>,
}

/// Why who stands or runs where could not be read.
#[derive(Debug, thiserror::Error)]
pub enum OccupancyReadError {
    /// The read did not reach a connection.
    #[error("the occupancy read did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The read failed, or a stored id does not parse.
    #[error("the occupancy of a repository mount could not be read")]
    Database(#[from] rusqlite::Error),
    /// A folder's key could not be resolved (a permission refusal).
    #[error("a folder a session stands or runs in could not be resolved")]
    Folder(#[source] io::Error),
}

/// Reads who stands in, and who runs in, each folder, and holds the cleanup's read and delete of
/// a folder together against the writes that put a workspace in one. Its clones share the holds.
#[derive(Clone)]
pub struct MountOccupancyReader {
    reads: Arc<DatabaseReadPool>,
    // The folders the cleanup is deleting.
    closing_folders: Arc<PathHolds>,
    // The folders workspaces are being written into.
    landing_folders: Arc<PathHolds>,
}

// The rows as stored, before their folders are keyed.
struct OccupancyRows {
    standing: Vec<StandingWorkspace>,
    running: Vec<(PathBuf, SessionId)>,
}

impl MountOccupancyReader {
    /// A reader on the daemon's read pool, holding no folder.
    pub fn new(reads: Arc<DatabaseReadPool>) -> Self {
        Self {
            reads,
            closing_folders: Arc::default(),
            landing_folders: Arc::default(),
        }
    }

    /// The occupancy of every folder of the mount `repo_mount_id` by the sessions' own
    /// workspaces, from one read of both row sets. Fails with [`OccupancyReadError`]: the pool's
    /// or SQLite's failure, or a folder's resolve failing for another reason than a part that names
    /// nothing.
    pub(crate) async fn read(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<MountOccupancy, OccupancyReadError> {
        let mount = repo_mount_id.to_string();
        let rows = self
            .reads
            .read(ReadLength::Short, move |connection| {
                let parameters = named_params! { ":repo_mount_id": mount };
                let standing =
                    read_standing(connection, STANDING_ON_MOUNT_SQL.as_str(), parameters)?;
                let running = connection
                    .prepare_cached(RUNNING_SESSIONS_SQL)?
                    .query_map(parameters, |row| {
                        Ok((
                            PathBuf::from(row.get::<_, String>(1)?),
                            text_column(row, 0, |text| SessionId::new(&text))?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, OccupancyReadError>(OccupancyRows { standing, running })
            })
            .await?;
        let mut keys = FolderKeys::default();
        let mut occupancy = MountOccupancy::default();
        for standing in rows.standing {
            if standing.is_run_owned {
                continue;
            }
            let folder = keys.key_of(standing.folder).await?;
            occupancy
                .standing_by_folder
                .entry(folder)
                .or_default()
                .push(StandingSession {
                    session_id: standing.session_id,
                    recorded_branch: standing.recorded_branch,
                    worktree_id: standing.worktree_id,
                });
        }
        for (folder, session_id) in rows.running {
            let folder = keys.key_of(folder).await?;
            occupancy
                .running_by_folder
                .entry(folder)
                .or_insert(session_id);
        }
        Ok(occupancy)
    }

    /// Whether any live workspace of any mount, a session's or a workflow run's, stands at or
    /// inside the folder whose key is `folder_key`. Fails as [`MountOccupancyReader::read`] does.
    pub(crate) async fn is_stood_in(&self, folder_key: &Path) -> Result<bool, OccupancyReadError> {
        let standing = self
            .reads
            .read(ReadLength::Short, |connection| {
                Ok::<_, OccupancyReadError>(read_standing(
                    connection,
                    STANDING_EVERYWHERE_SQL.as_str(),
                    [],
                )?)
            })
            .await?;
        let mut keys = FolderKeys::default();
        for workspace in standing {
            if is_contained_within(&keys.key_of(workspace.folder).await?, folder_key) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Holds the folder whose key is `folder_key` closing until the answer drops, so no workspace
    /// is written into it or inside it meanwhile; `None`, holding nothing, while one is being
    /// written there. Taken before the read of who stands there, and dropped once the folder is
    /// deleted or kept aside.
    pub(crate) fn hold_closing(&self, folder_key: &Path) -> Option<PathHold> {
        let closing = self.closing_folders.hold(folder_key);
        // Held before the landings are read, as a landing is held before it reads the closings,
        // so of a closing and a landing that cross, at least one sees the other.
        (!self.landing_folders.is_held_across(folder_key)).then_some(closing)
    }

    /// Holds `folder` landing until the answer drops, which the caller keeps until its write of a
    /// workspace standing there or below it commits. Refuses `repoMount.outsideTrustEnvelope`
    /// (`worktreeRemoved`) while the cleanup deletes a folder that holds `folder` or lies inside
    /// it, and fails with `Folder` when `folder` cannot be resolved.
    pub(crate) async fn hold_landing(
        &self,
        folder: &Path,
    ) -> Result<PathHold, WorkspaceServiceError> {
        let folder_key = canonical_folder_path(folder)
            .await
            .map_err(WorkspaceServiceError::Folder)?;
        let landing = self.landing_folders.hold(&folder_key);
        if self.closing_folders.is_held_across(&folder_key) {
            return Err(RepoRefusal::OutsideTrustEnvelope {
                reason: RepoMountOutsideTrustEnvelopeReason::WorktreeRemoved,
            }
            .into());
        }
        Ok(landing)
    }
}

/// Every live workspace with a folder on a mount of the repository the mount `repo_mount_id`
/// holds, a session's and a workflow run's alike, oldest first. Fails when the rows cannot be read.
pub fn read_standing_in_repository(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> rusqlite::Result<Vec<StandingWorkspace>> {
    read_standing(
        connection,
        STANDING_IN_REPOSITORY_SQL.as_str(),
        named_params! { ":repo_mount_id": repo_mount_id.text().as_str() },
    )
}

/// The folder the live workspace `workspace_id` stands in now, as stored; `None` for one archived
/// or gone, or with no folder. Fails when the row cannot be read.
pub fn read_standing_folder_of(
    connection: &Connection,
    workspace_id: WorkspaceId,
) -> rusqlite::Result<Option<PathBuf>> {
    Ok(connection
        .prepare_cached(&STANDING_FOLDER_OF_SQL)?
        .query_row(
            named_params! { ":workspace_id": workspace_id.text().as_str() },
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .map(PathBuf::from))
}

fn read_standing(
    connection: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> rusqlite::Result<Vec<StandingWorkspace>> {
    connection
        .prepare_cached(sql)?
        .query_map(parameters, |row| {
            Ok(StandingWorkspace {
                workspace_id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                folder: PathBuf::from(row.get::<_, String>(2)?),
                recorded_branch: optional_text_column(row, 3, GitRefName::new)?,
                worktree_id: optional_text_column(row, 4, |text| WorktreeId::new(&text))?,
                is_run_owned: row.get(5)?,
                repository_root: PathBuf::from(row.get::<_, String>(6)?),
            })
        })?
        .collect()
}

// Each stored folder's key, resolved once however many rows name it.
#[derive(Default)]
struct FolderKeys {
    by_stored: HashMap<PathBuf, PathBuf>,
}

impl FolderKeys {
    async fn key_of(&mut self, stored: PathBuf) -> Result<PathBuf, OccupancyReadError> {
        if let Some(key) = self.by_stored.get(&stored) {
            return Ok(key.clone());
        }
        let key = canonical_folder_path(&stored)
            .await
            .map_err(OccupancyReadError::Folder)?;
        self.by_stored.insert(stored, key.clone());
        Ok(key)
    }
}
