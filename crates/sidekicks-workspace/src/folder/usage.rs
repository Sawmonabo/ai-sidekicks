//! The folders the service can reach and who uses each: every attached mount, a project's folder or
//! a chat's own workspace, and each standing worktree the daemon made, listed after its project's
//! folder; and, for one mount, where it came from, its project's name and the sessions bound to it,
//! which the mount read adds to the mount's own row. A chat's folder comes from its earliest live
//! holder: of the chats holding it and not marked for purge, the one bound to it first.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::{ProjectId, ProjectName};
use sidekicks_contracts::repo::folders::{
    RepoMountListEntry, RepoMountOrigin, RepoMountReadResponse, RepoMountUser,
};
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::worktree::occupancy::{MountOccupancyReader, OccupancyReadError, StandingSession};
use crate::git::worktree::rows::LIVE_WORKTREE_STATE_PREDICATE;
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::service::{RepoMountRecord, RepoMountService, RepoMountServiceError};
use crate::schema::MountOrigin;

/// The distinct statements the folder reads keep prepared on each read connection.
pub const REPO_FOLDER_USAGE_STATEMENT_CAPACITY: usize = 4;

/// The subquery answering the earliest live holder of the chat folder whose mount id the SQL
/// expression `mount_id` names, leaving out the chat `excluded_session_id` names where given:
/// holders marked for purge or not yet born after the rest, then the earliest bound, as the bound
/// sessions read orders them, a holder not yet bound last, then the first by id.
pub fn earliest_live_holder_sql(mount_id: &str, excluded_session_id: Option<&str>) -> String {
    let excluded = excluded_session_id
        .map(|session_id| format!(" AND hold.session_id <> {session_id}"))
        .unwrap_or_default();
    format!(
        "(SELECT hold.session_id
          FROM managed_folder_holds AS hold
          LEFT JOIN sessions AS holder ON holder.id = hold.session_id
          LEFT JOIN workspaces AS workspace
            ON workspace.repo_mount_id = hold.repo_mount_id
           AND workspace.session_id = hold.session_id AND workspace.state <> '{archived}'
         WHERE hold.repo_mount_id = {mount_id}{excluded}
         GROUP BY hold.session_id
         ORDER BY MAX(coalesce(holder.state = '{purge_requested}', 1)) ASC,
                  MIN(workspace.created_at) IS NULL ASC, MIN(workspace.created_at) ASC,
                  hold.session_id ASC
         LIMIT 1)",
        archived = <&'static str>::from(WorkspaceState::Archived),
        purge_requested = <&'static str>::from(SessionState::PurgeRequested),
    )
}

// A mount's row with its origin's facts; for a chat's folder, its earliest live holder.
static MOUNT_ORIGIN_COLUMNS: LazyLock<String> = LazyLock::new(|| {
    format!(
        "mount.id, mount.canonical_root, mount.origin, mount.project_id, {},
       project.name, mount.place
  FROM repo_mounts AS mount
  LEFT JOIN projects AS project ON project.id = mount.project_id",
        earliest_live_holder_sql("mount.id", None)
    )
});

static ATTACHED_MOUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}
 WHERE mount.state = '{}'
 ORDER BY mount.attached_at ASC, mount.id ASC",
        *MOUNT_ORIGIN_COLUMNS,
        <&'static str>::from(RepoMountState::Attached)
    )
});

// Unscoped by state, as the mount read answers for a detached mount too.
static MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} WHERE mount.id = @repo_mount_id",
        *MOUNT_ORIGIN_COLUMNS
    )
});

static STANDING_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT worktrees.id, worktrees.fs_root
  FROM worktrees
 WHERE worktrees.repo_mount_id = @repo_mount_id AND {}
 ORDER BY worktrees.created_at ASC, worktrees.id ASC",
        LIVE_WORKTREE_STATE_PREDICATE.as_str()
    )
});

// Every session with a live workspace on the mount, the earliest bound first.
static BOUND_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT session_id
  FROM workspaces
 WHERE repo_mount_id = @repo_mount_id AND state <> '{}'
 GROUP BY session_id
 ORDER BY MIN(created_at) ASC, session_id ASC",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

/// What the mount read adds to a mount's own row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoMountUsage {
    /// Where the mount came from.
    pub origin: RepoMountOrigin,
    /// Its project's name; `None` on a chat's own workspace.
    pub display_name: Option<ProjectName>,
    /// The sessions bound to it, the earliest first.
    pub used_by: Vec<RepoMountUser>,
}

/// Why a folder read failed.
#[derive(Debug, thiserror::Error)]
pub enum RepoFolderUsageError {
    /// The mount is unknown, or detached with its project forgotten (`repoMount.notFound`).
    #[error(transparent)]
    Refused(#[from] RepoRefusal),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("the folder rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// A folder could not be keyed for another reason than a part that names nothing.
    #[error("a folder could not be resolved to its key")]
    Folder(#[source] io::Error),
    /// The mount's own row or its health could not be read, or was refused.
    #[error(transparent)]
    Mount(#[from] RepoMountServiceError),
    /// A mount's stored root does not read as a wire path.
    #[error("a mount's root is not a path the reply can carry")]
    MountRoot(#[from] TextError),
}

impl From<RepoFolderUsageError> for HandlerError {
    /// A refusal is answered with its code; every other failure is a fault.
    fn from(error: RepoFolderUsageError) -> Self {
        match error {
            RepoFolderUsageError::Refused(refusal)
            | RepoFolderUsageError::Mount(RepoMountServiceError::Refused(refusal)) => {
                Self::Refused(refusal.into())
            }
            fault @ (RepoFolderUsageError::Pool(_)
            | RepoFolderUsageError::Database(_)
            | RepoFolderUsageError::Folder(_)
            | RepoFolderUsageError::Mount(_)
            | RepoFolderUsageError::MountRoot(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<OccupancyReadError> for RepoFolderUsageError {
    fn from(error: OccupancyReadError) -> Self {
        match error {
            OccupancyReadError::Pool(error) => Self::Pool(error),
            OccupancyReadError::Database(error) => Self::Database(error),
            OccupancyReadError::Folder(error) => Self::Folder(error),
        }
    }
}

// One mount's row with its origin's facts.
struct MountOriginRow {
    id: RepoMountId,
    canonical_root: FilesystemPath,
    origin: MountOrigin,
    project_id: Option<ProjectId>,
    earliest_holder: Option<SessionId>,
    project_name: Option<ProjectName>,
    place: Option<Place>,
}

// An attached mount and, for a project's, its standing worktrees.
struct ListedMount {
    mount: MountOriginRow,
    worktrees: Vec<(WorktreeId, FilesystemPath)>,
}

/// Reads the folders the service can reach and the sessions using each.
pub struct RepoFolderUsage {
    reads: Arc<DatabaseReadPool>,
    occupancy: MountOccupancyReader,
}

impl RepoFolderUsage {
    /// Reads through `reads`, each folder's sessions through `occupancy`.
    pub fn new(reads: Arc<DatabaseReadPool>, occupancy: MountOccupancyReader) -> Self {
        Self { reads, occupancy }
    }

    /// Every attached mount, each project's standing worktrees right after its folder, with how
    /// many sessions stand in each folder. Fails as a read or a folder's key fails.
    pub async fn list(&self) -> Result<Vec<RepoMountListEntry>, RepoFolderUsageError> {
        let listed = self
            .reads
            .read(ReadLength::Short, |connection| {
                let mut listed = Vec::new();
                for mount in connection
                    .prepare_cached(&ATTACHED_MOUNTS_SQL)?
                    .query_map([], mount_origin_row)?
                {
                    let mount = mount?;
                    let worktrees = match mount.origin {
                        MountOrigin::Attached => read_standing_worktrees(connection, mount.id)?,
                        MountOrigin::Managed => Vec::new(),
                    };
                    listed.push(ListedMount { mount, worktrees });
                }
                Ok::<_, RepoFolderUsageError>(listed)
            })
            .await?;
        let mut entries = Vec::new();
        for ListedMount { mount, worktrees } in listed {
            let standing_by_folder = self.occupancy.read(&mount.id).await?.standing_by_folder;
            let project_id = mount.project_id;
            entries.push(RepoMountListEntry {
                using_session_count: using_session_count(
                    &standing_by_folder,
                    &mount.canonical_root,
                )
                .await?,
                origin: origin_of(&mount),
                place: mount.place.clone(),
                path: mount.canonical_root,
            });
            for (worktree_id, path) in worktrees {
                entries.push(RepoMountListEntry {
                    using_session_count: using_session_count(&standing_by_folder, &path).await?,
                    origin: RepoMountOrigin::Worktree {
                        worktree_id,
                        project_id: project_id
                            .expect("an attached project's mount names its project"),
                    },
                    place: mount.place.clone(),
                    path,
                });
            }
        }
        Ok(entries)
    }

    /// `repoMount.read`: the mount's stored facts with a freshly probed health, read through
    /// `mounts`, and where it came from, its project's name and every session bound to it. Refuses
    /// `repoMount.notFound` for an unknown mount and for a detached one whose project was
    /// forgotten, `repoMount.rootResolutionFailed` when git cannot answer for its root, and fails
    /// as a read fails.
    pub async fn read_mount(
        &self,
        mounts: &RepoMountService,
        repo_mount_id: &RepoMountId,
    ) -> Result<RepoMountReadResponse, RepoFolderUsageError> {
        let usage = self.read_usage(repo_mount_id).await?;
        let RepoMountRecord { row, health } = mounts.read(*repo_mount_id).await?;
        Ok(RepoMountReadResponse {
            id: row.id,
            machine_id: row.machine_id,
            local_path: row.local_path,
            canonical_root: FilesystemPath::new(row.canonical_root.to_string_lossy().into_owned())?,
            place: row.place,
            vcs_type: row.vcs_type,
            state: row.state,
            health,
            attached_at: row.attached_at,
            origin: usage.origin,
            display_name: usage.display_name,
            used_by: usage.used_by,
        })
    }

    /// Where the mount came from, its project's name, and every session bound to it. Refuses
    /// `repoMount.notFound` for an unknown mount, and for a detached one whose project was
    /// forgotten, which no session can reach again. Fails as the read fails.
    pub async fn read_usage(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<RepoMountUsage, RepoFolderUsageError> {
        let repo_mount_id = *repo_mount_id;
        self.reads
            .read(ReadLength::Short, move |connection| {
                let mount = read_reachable_mount(connection, repo_mount_id)?;
                let used_by = connection
                    .prepare_cached(&BOUND_SESSIONS_SQL)?
                    .query_map(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| {
                            Ok(RepoMountUser {
                                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(RepoMountUsage {
                    origin: origin_of(&mount),
                    display_name: mount.project_name,
                    used_by,
                })
            })
            .await
    }

    /// Where the mount came from, alone, for a caller that needs none of its users. Refuses
    /// `repoMount.notFound` as [`Self::read_usage`] does, and fails as the read fails.
    pub async fn read_origin(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<RepoMountOrigin, RepoFolderUsageError> {
        let repo_mount_id = *repo_mount_id;
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(origin_of(&read_reachable_mount(connection, repo_mount_id)?))
            })
            .await
    }
}

// The mount's row, unless it is unknown or detached with its project forgotten
// (`repoMount.notFound`).
fn read_reachable_mount(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<MountOriginRow, RepoFolderUsageError> {
    Ok(connection
        .prepare_cached(&MOUNT_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            mount_origin_row,
        )
        .optional()?
        .filter(|mount| mount.project_id.is_some() || mount.origin == MountOrigin::Managed)
        .ok_or(RepoRefusal::MountNotFound { repo_mount_id })?)
}

fn mount_origin_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MountOriginRow> {
    Ok(MountOriginRow {
        id: text_column(row, 0, |text| RepoMountId::new(&text))?,
        canonical_root: text_column(row, 1, FilesystemPath::new)?,
        origin: text_column(row, 2, closed_word)?,
        project_id: optional_text_column(row, 3, |text| ProjectId::new(&text))?,
        earliest_holder: optional_text_column(row, 4, |text| SessionId::new(&text))?,
        project_name: optional_text_column(row, 5, ProjectName::new)?,
        place: optional_text_column(row, 6, |text| serde_json::from_str::<Place>(&text))?,
    })
}

fn read_standing_worktrees(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> rusqlite::Result<Vec<(WorktreeId, FilesystemPath)>> {
    connection
        .prepare_cached(&STANDING_WORKTREES_SQL)?
        .query_map(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| {
                Ok((
                    text_column(row, 0, |text| WorktreeId::new(&text))?,
                    text_column(row, 1, FilesystemPath::new)?,
                ))
            },
        )?
        .collect()
}

// A managed mount names its earliest live holder; any other names the project it serves. A managed
// mount is written with its founding chat's hold and deleted with its last, and the rows' checks
// tie a project's mount, while it can be read, to its project.
fn origin_of(mount: &MountOriginRow) -> RepoMountOrigin {
    match mount.origin {
        MountOrigin::Managed => RepoMountOrigin::Managed {
            repo_mount_id: mount.id,
            session_id: mount
                .earliest_holder
                .expect("a managed mount is held until it is deleted"),
        },
        MountOrigin::Attached => RepoMountOrigin::Attached {
            repo_mount_id: mount.id,
            project_id: mount
                .project_id
                .expect("a project's mount read here names its project"),
        },
    }
}

// The sessions standing in `folder`, keyed as the occupancy keys its folders.
async fn using_session_count(
    standing_by_folder: &HashMap<PathBuf, Vec<StandingSession>>,
    folder: &FilesystemPath,
) -> Result<SafeInt<0>, RepoFolderUsageError> {
    let key = canonical_folder_path(Path::new(folder.as_str()))
        .await
        .map_err(RepoFolderUsageError::Folder)?;
    let count = standing_by_folder.get(&key).map_or(0, Vec::len);
    Ok(u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a count of sessions read is a safe integer"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::repo::folders::RepoMountOrigin;
    use sidekicks_contracts::repo::mount::RepoMountId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionState;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use super::{REPO_FOLDER_USAGE_STATEMENT_CAPACITY, RepoFolderUsage};
    use crate::git::worktree::occupancy::MountOccupancyReader;
    use crate::git::worktree::schema::schema_parts;
    use crate::test_rows::PARENT_ROWS_AT;

    const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
    // The fresh chat's id sorts before the planning chat's, so only the bound order puts the
    // planning chat first.
    const FRESH_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
    const PLANNING_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";

    async fn origin_session(usage: &RepoFolderUsage) -> SessionId {
        let repo_mount_id = RepoMountId::new(MOUNT_ID).expect("the id is a UUID");
        match usage
            .read_origin(&repo_mount_id)
            .await
            .expect("the chat's folder reads")
        {
            RepoMountOrigin::Managed { session_id, .. } => session_id,
            other @ (RepoMountOrigin::Attached { .. } | RepoMountOrigin::Worktree { .. }) => {
                panic!("a chat's folder, not {other:?}")
            }
        }
    }

    // Catches the origin read from the chat the folder is made for, and a purged holder named:
    // the planning chat, bound first, is the origin until it is marked for purge and once its
    // purge has taken its hold, when the fresh chat holding the folder is.
    #[tokio::test]
    async fn a_chat_folders_origin_names_its_earliest_live_holder() {
        let database = TestDatabase::new(schema_parts());
        let rows = database.opener()().expect("the database is made with its schema");
        insert_session_row(&rows, PLANNING_SESSION_ID, None, None);
        insert_session_row(&rows, FRESH_SESSION_ID, None, None);
        rows.execute_batch(&format!(
            "INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, origin, \
             managed_session_id, attached_at, updated_at) VALUES ('{MOUNT_ID}', 'machine', \
             '/chats/planning', '/chats/planning', 'managed', '{PLANNING_SESSION_ID}', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
             INSERT INTO managed_folder_holds (repo_mount_id, session_id) VALUES \
             ('{MOUNT_ID}', '{PLANNING_SESSION_ID}'), ('{MOUNT_ID}', '{FRESH_SESSION_ID}');
             INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at, \
             updated_at) VALUES \
             ('planning', '{PLANNING_SESSION_ID}', '{MOUNT_ID}', 'boundRoot', \
             '2026-10-14T09:30:00.000Z', '2026-10-14T09:30:00.000Z'), \
             ('fresh', '{FRESH_SESSION_ID}', '{MOUNT_ID}', 'boundRoot', \
             '2026-10-14T09:31:00.000Z', '2026-10-14T09:31:00.000Z')"
        ))
        .expect("the planning chat's folder, its holds and workspaces are admitted");
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            REPO_FOLDER_USAGE_STATEMENT_CAPACITY,
        ));
        let usage = RepoFolderUsage::new(Arc::clone(&reads), MountOccupancyReader::new(reads));
        let planning = SessionId::new(PLANNING_SESSION_ID).expect("a session id");
        let fresh = SessionId::new(FRESH_SESSION_ID).expect("a session id");

        assert_eq!(origin_session(&usage).await, planning);
        rows.execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            [
                <&'static str>::from(SessionState::PurgeRequested),
                PLANNING_SESSION_ID,
            ],
        )
        .expect("the planning chat is marked for purge");
        assert_eq!(origin_session(&usage).await, fresh);
        rows.execute_batch(&format!(
            "DELETE FROM workspaces WHERE session_id = '{PLANNING_SESSION_ID}';
             DELETE FROM managed_folder_holds WHERE session_id = '{PLANNING_SESSION_ID}';
             DELETE FROM sessions WHERE id = '{PLANNING_SESSION_ID}'"
        ))
        .expect("the planning chat's purge takes its rows");
        assert_eq!(origin_session(&usage).await, fresh);
    }
}
