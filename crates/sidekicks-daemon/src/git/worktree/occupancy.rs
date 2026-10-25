//! Which sessions stand in which folder of a repository mount, and which of them has an agent
//! running there. A session stands where its live workspace's checkout is; an agent runs where a
//! run's execution context is still unreleased. Nothing here holds a folder: it only reads, and
//! every folder is keyed by [`canonical_folder_path`].

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::stored_column::{optional_text_column, text_column};
use crate::git::worktree::rows::live_worktree_state_predicate;
use crate::workspace::folder::canonical_path::canonical_folder_path;
use crate::workspace::row_guards::CHECKOUT_ROOT_METADATA_PATH;

/// The statements the occupancy read prepares on a pooled connection.
#[expect(dead_code, reason = "the daemon's start sizes its read pool with it")]
pub(crate) const MOUNT_OCCUPANCY_STATEMENT_CAPACITY: usize = 2;

// A workspace's checkout is its working tree's top level, which the execution-root service records
// in the workspace's metadata; a workspace without that key works at its root.
static STANDING_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    let archived = <&'static str>::from(WorkspaceState::Archived);
    let live_worktree = live_worktree_state_predicate("wt");
    format!(
        "SELECT standing.session_id, standing.folder, s.branch,
       (SELECT wt.id FROM worktrees AS wt
         WHERE wt.repo_mount_id = standing.repo_mount_id
           AND wt.fs_root = standing.folder
           AND {live_worktree}
         LIMIT 1)
  FROM (SELECT w.session_id, w.repo_mount_id, w.created_at,
               COALESCE(json_extract(w.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
                        w.fs_root) AS folder
          FROM workspaces AS w
         WHERE w.repo_mount_id = :repo_mount_id
           AND w.state <> '{archived}'
           AND w.fs_root IS NOT NULL) AS standing
  JOIN sessions AS s ON s.id = standing.session_id
 ORDER BY standing.created_at, standing.session_id"
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

/// Why a mount's occupancy could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OccupancyReadError {
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

/// Reads who stands in, and who runs in, each folder of a repository mount.
#[derive(Clone)]
pub(crate) struct MountOccupancyReader {
    reads: Arc<DatabaseReadPool>,
}

// The rows as stored, before their folders are keyed.
struct OccupancyRows {
    standing: Vec<(PathBuf, StandingSession)>,
    running: Vec<(PathBuf, SessionId)>,
}

impl MountOccupancyReader {
    /// A reader on the daemon's read pool.
    pub(crate) fn new(reads: Arc<DatabaseReadPool>) -> Self {
        Self { reads }
    }

    /// The occupancy of every folder of the mount `repo_mount_id`, from one read of both row
    /// sets. Fails with [`OccupancyReadError`]: the pool's or SQLite's failure, or a folder's
    /// resolve failing for another reason than a part that names nothing.
    pub(crate) async fn read(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<MountOccupancy, OccupancyReadError> {
        let mount = repo_mount_id.to_string();
        let rows = self
            .reads
            .read(ReadLength::Short, move |connection| {
                let parameters = named_params! { ":repo_mount_id": mount };
                let standing = connection
                    .prepare_cached(STANDING_SESSIONS_SQL.as_str())?
                    .query_map(parameters, |row| {
                        Ok((
                            PathBuf::from(row.get::<_, String>(1)?),
                            StandingSession {
                                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                                recorded_branch: optional_text_column(row, 2, GitRefName::new)?,
                                worktree_id: optional_text_column(row, 3, |text| {
                                    WorktreeId::new(&text)
                                })?,
                            },
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
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
        for (folder, session) in rows.standing {
            let folder = keys.key_of(folder).await?;
            occupancy
                .standing_by_folder
                .entry(folder)
                .or_default()
                .push(session);
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
