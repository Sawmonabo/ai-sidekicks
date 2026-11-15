//! Who stands in which folder, and which session has an agent running there. A live workspace
//! stands where its checkout is, else at its root, and one with neither stands nowhere; an agent
//! runs where a run's execution context is still unreleased. Every folder is keyed by
//! [`canonical_folder_path`].
//!
//! - One read says who stands where, in three scopes: one mount's sessions, which every list and
//!   count reads; every mount of one repository, which the sweep out of a removed tree reads; and
//!   every live workspace of every mount, a session's and a workflow run's alike, with every
//!   attached mount's root, which the retired-tree cleanup reads before it deletes a folder.
//! - The cleanup's read and its delete are held together: the cleanup holds the folder as one it
//!   deletes before it reads, and every write that puts a workspace or a mount in a folder holds
//!   that folder as one written into before it reads the deletions, then waits for any deletion of
//!   it to end, so a workspace either is read or is written once the folder is gone, decided by
//!   its own admission.

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::git::shared::GitRefName;
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
use crate::row_guards::{CHECKOUT_ROOT_METADATA_PATH, COMMON_DIR_METADATA_PATH};
use crate::service::{SELECT_ATTACHED_MOUNT_ROOTS_SQL, read_paths};
use crate::trust_envelope::is_contained_within;

/// The statements the occupancy reader prepares on a pooled connection: one mount's standing
/// sessions and running sessions, every mount's standing workspaces and every attached mount's
/// root.
pub const MOUNT_OCCUPANCY_STATEMENT_CAPACITY: usize = 4;

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
// recorded branch, the live tree the daemon made at its folder, its mount's root and its mount.
fn standing_workspaces_sql(scope: &str) -> String {
    format!(
        "SELECT standing.id, standing.session_id, standing.folder, s.branch,
       (SELECT wt.id FROM worktrees AS wt
         WHERE wt.repo_mount_id = standing.repo_mount_id
           AND wt.fs_root = standing.folder
           AND {live_worktree}
         LIMIT 1),
       standing.is_run_owned, mount.canonical_root, standing.repo_mount_id
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
    /// Its mount.
    pub repo_mount_id: RepoMountId,
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
/// a folder together against the writes that put a workspace or a mount in one. Its clones share
/// the holds, so the daemon builds one and hands clones of it to every owner.
#[derive(Clone)]
pub struct MountOccupancyReader {
    reads: Arc<DatabaseReadPool>,
    folders_being_deleted: Arc<PathHolds>,
    folders_being_written_into: Arc<PathHolds>,
}

/// A write's hold on the folder it puts a workspace or a mount in, kept until the write commits.
pub(crate) struct FolderWriteHold {
    _hold: PathHold,
    /// Whether the write waited for the cleanup to delete a folder at or around its own, so what
    /// it admitted before is admitted again.
    pub(crate) has_waited: bool,
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
            folders_being_deleted: Arc::default(),
            folders_being_written_into: Arc::default(),
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
    /// inside the retired tree stored at `tree_folder` and keyed `tree_key`, or any attached
    /// mount's root lies there. `keys` holds the folders the pass has resolved so far; a folder
    /// that cannot be resolved is compared as [`FolderKeys::is_within_tree`] says. Fails with the
    /// pool's or SQLite's failure.
    pub(crate) async fn is_stood_in(
        &self,
        tree_folder: &Path,
        tree_key: &Path,
        keys: &mut FolderKeys,
    ) -> Result<bool, OccupancyReadError> {
        let (standing, mount_roots) = self
            .reads
            .read(ReadLength::Short, |connection| {
                Ok::<_, OccupancyReadError>((
                    read_standing(connection, STANDING_EVERYWHERE_SQL.as_str(), [])?,
                    read_paths(connection, &SELECT_ATTACHED_MOUNT_ROOTS_SQL, &[])?,
                ))
            })
            .await?;
        let folders = standing
            .into_iter()
            .map(|workspace| workspace.folder)
            .chain(mount_roots);
        for folder in folders {
            if keys.is_within_tree(folder, tree_folder, tree_key).await {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Holds the folder whose key is `folder_key` as one the cleanup deletes until the answer
    /// drops, so a write into it or inside it waits meanwhile; `None`, holding nothing, while a
    /// workspace or a mount is being written at, around or inside it. Taken before the read of who
    /// stands there, and handed to the delete or the keep-aside, so it lasts as long as they do.
    pub(crate) fn hold_for_deletion(&self, folder_key: &Path) -> Option<PathHold> {
        let deletion = self.folders_being_deleted.hold(folder_key);
        // Held before the writes are read, as a write is held before it reads the deletions, so
        // of a deletion and a write that cross, at least one sees the other.
        (!self.folders_being_written_into.is_held_across(folder_key)).then_some(deletion)
    }

    /// Holds `folder` as one a workspace or a mount is written into until the answer drops, which
    /// the caller keeps until its write commits; while the cleanup deletes a folder at or around
    /// it, waits for that deletion to end, the hold standing. Fails when `folder` cannot be
    /// resolved.
    pub(crate) async fn hold_folder_for_write(&self, folder: &Path) -> io::Result<FolderWriteHold> {
        self.hold_for_write(folder, PathHolds::is_held_within).await
    }

    /// [`Self::hold_folder_for_write`] for a root that stands for every folder its write moves a
    /// workspace into inside it, so it also waits out a deletion of a folder inside it.
    pub(crate) async fn hold_root_for_write(&self, root: &Path) -> io::Result<FolderWriteHold> {
        self.hold_for_write(root, PathHolds::is_held_across).await
    }

    async fn hold_for_write(
        &self,
        folder: &Path,
        is_deleted: fn(&PathHolds, &Path) -> bool,
    ) -> io::Result<FolderWriteHold> {
        let folder_key = canonical_folder_path(folder).await?;
        // Kept through the wait, so a later cleanup of the folder defers rather than deleting it
        // between the wait's end and the write.
        let hold = self.folders_being_written_into.hold(&folder_key);
        let has_waited = self
            .folders_being_deleted
            .wait_until_free(|deleted| is_deleted(deleted, &folder_key))
            .await;
        Ok(FolderWriteHold {
            _hold: hold,
            has_waited,
        })
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
                repo_mount_id: text_column(row, 7, |text| RepoMountId::new(&text))?,
                folder: PathBuf::from(row.get::<_, String>(2)?),
                recorded_branch: optional_text_column(row, 3, GitRefName::new)?,
                worktree_id: optional_text_column(row, 4, |text| WorktreeId::new(&text))?,
                is_run_owned: row.get(5)?,
                repository_root: PathBuf::from(row.get::<_, String>(6)?),
            })
        })?
        .collect()
}

/// Each stored folder's key, resolved once however many rows name it; the cleanup keeps one set
/// for a whole pass, so each folder is resolved once across the pass's trees.
#[derive(Default)]
pub(crate) struct FolderKeys {
    by_stored: HashMap<PathBuf, FolderKey>,
}

// A stored folder's key, or for one whose resolve failed, the deepest folder of its path that
// resolves joined with the rest of the path as stored.
#[derive(Clone)]
enum FolderKey {
    Resolved(PathBuf),
    Unresolved(PathBuf),
}

impl FolderKeys {
    // `stored`'s key; fails when it cannot be resolved.
    async fn key_of(&mut self, stored: PathBuf) -> Result<PathBuf, OccupancyReadError> {
        if let Some(FolderKey::Resolved(key)) = self.by_stored.get(&stored) {
            return Ok(key.clone());
        }
        let key = canonical_folder_path(&stored)
            .await
            .map_err(OccupancyReadError::Folder)?;
        self.by_stored
            .insert(stored, FolderKey::Resolved(key.clone()));
        Ok(key)
    }

    /// Whether the folder stored as `stored` lies at or inside the tree stored at `tree_folder`
    /// and keyed `tree_key`. One whose resolve fails (a parent the daemon may no longer enter) is
    /// compared by its stored path and by its nearest key against both, and warned of once.
    pub(crate) async fn is_within_tree(
        &mut self,
        stored: PathBuf,
        tree_folder: &Path,
        tree_key: &Path,
    ) -> bool {
        let key = if let Some(key) = self.by_stored.get(&stored) {
            key.clone()
        } else {
            let key = lenient_key_of(&stored).await;
            self.by_stored.insert(stored.clone(), key.clone());
            key
        };
        match key {
            FolderKey::Resolved(key) => is_contained_within(&key, tree_key),
            FolderKey::Unresolved(nearest) => {
                [stored.as_path(), nearest.as_path()].iter().any(|folder| {
                    is_contained_within(folder, tree_folder)
                        || is_contained_within(folder, tree_key)
                })
            }
        }
    }
}

// `stored`'s key, or where its resolve fails, the key of the deepest folder of its path that
// resolves joined with the rest, `stored` itself when none does.
async fn lenient_key_of(stored: &Path) -> FolderKey {
    let failure = match canonical_folder_path(stored).await {
        Ok(key) => return FolderKey::Resolved(key),
        Err(failure) => failure,
    };
    tracing::warn!(
        error = &failure as &(dyn Error + 'static),
        folder = %stored.display(),
        "a folder a live workspace or an attached mount stands in could not be resolved; the \
         cleanup compares it by its path"
    );
    for parent in stored.ancestors().skip(1) {
        // A parent that fails too is passed over for the next one up.
        if let Ok(key) = canonical_folder_path(parent).await {
            let rest = stored
                .strip_prefix(parent)
                .expect("a path's ancestor is a prefix of it");
            return FolderKey::Unresolved(key.join(rest));
        }
    }
    FolderKey::Unresolved(stored.to_path_buf())
}
