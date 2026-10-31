//! The folders the service can reach and who uses each: every attached mount, a project's folder or
//! a chat's own workspace, and each standing worktree the daemon made, listed after its project's
//! folder; and, for one mount, where it came from, its project's name and the sessions bound to it,
//! which the mount read adds to the mount's own row.

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

const MOUNT_ORIGIN_COLUMNS: &str = "mount.id, mount.canonical_root, mount.origin,
       mount.project_id, mount.managed_session_id, project.name, mount.place
  FROM repo_mounts AS mount
  LEFT JOIN projects AS project ON project.id = mount.project_id";

static ATTACHED_MOUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {MOUNT_ORIGIN_COLUMNS}
 WHERE mount.state = '{}'
 ORDER BY mount.attached_at ASC, mount.id ASC",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// Unscoped by state, as the mount read answers for a detached mount too.
static MOUNT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {MOUNT_ORIGIN_COLUMNS} WHERE mount.id = @repo_mount_id"));

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
    managed_session_id: Option<SessionId>,
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
                let mount = connection
                    .prepare_cached(&MOUNT_SQL)?
                    .query_row(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        mount_origin_row,
                    )
                    .optional()?
                    .filter(|mount| {
                        mount.project_id.is_some() || mount.managed_session_id.is_some()
                    })
                    .ok_or(RepoRefusal::MountNotFound { repo_mount_id })?;
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
}

fn mount_origin_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MountOriginRow> {
    Ok(MountOriginRow {
        id: text_column(row, 0, |text| RepoMountId::new(&text))?,
        canonical_root: text_column(row, 1, FilesystemPath::new)?,
        origin: text_column(row, 2, closed_word)?,
        project_id: optional_text_column(row, 3, |text| ProjectId::new(&text))?,
        managed_session_id: optional_text_column(row, 4, |text| SessionId::new(&text))?,
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

// A managed mount names its chat; any other names the project it serves. The rows' checks tie a
// managed mount to its chat and a project's mount, while it can be read, to its project.
fn origin_of(mount: &MountOriginRow) -> RepoMountOrigin {
    match mount.origin {
        MountOrigin::Managed => RepoMountOrigin::Managed {
            repo_mount_id: mount.id,
            session_id: mount
                .managed_session_id
                .expect("a managed mount's row names its chat"),
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
