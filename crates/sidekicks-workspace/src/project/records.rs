//! The reads of the project records. A session's project is the project of the attached mount its
//! latest workspace binds, or, before its workspace is bound (its project still cloning), the
//! project its create named; a chat's managed mount is no project, and a forgotten project is none.
//!
//! - Every read is on the read pool, so a project writer reads what it committed.
//! - A list read takes its sessions' activity from the session directory through
//!   [`ProjectSessionActivity`], on the same connection, so an entry's count, tally and running
//!   session are read together.
//! - A read of some projects starts from those projects, so a change to one project reads only
//!   that project's sessions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use serde::de::DeserializeOwned;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::{BranchNamePattern, EnvironmentRow};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::{
    ProjectId, ProjectListEntry, ProjectName, ProjectSessionTally, ProjectSetup, ProjectState,
};
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState};
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_platforms::EntryIdentity;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{
    StoredJsonFault, closed_word, optional_text_column, text_column,
};
use strum::VariantArray;

use crate::git::branch_name_pattern::BranchPatternProject;
use crate::git::worktree::naming::WorktreeProjectNaming;
use crate::schema::{CloneOutcome, MountOrigin};

/// The distinct statements the records keep prepared on each read connection; the session
/// activity port counts its own.
pub const PROJECT_RECORDS_STATEMENT_CAPACITY: usize = 13;

/// The subquery answering the project id of the session whose id `session_id_sql` reads (a bound
/// parameter such as `@sessionId`, or a column such as `s.id`), or NULL for a chat, a session whose
/// project was forgotten, or one not bound to a project yet.
pub fn session_project_sql(session_id_sql: &str) -> String {
    let attached = <&'static str>::from(MountOrigin::Attached);
    format!(
        "(SELECT project.id FROM projects AS project
    WHERE project.id = COALESCE(
      (SELECT mount.project_id
         FROM workspaces AS workspace
         JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
        WHERE workspace.session_id = {session_id_sql} AND mount.origin = '{attached}'
        ORDER BY workspace.created_at DESC, workspace.id DESC
        LIMIT 1),
      (SELECT request.project_id
         FROM session_create_requests AS request
        WHERE request.session_id = {session_id_sql})))"
    )
}

/// The session directory's reading of each project session's activity, which the project list
/// counts and tallies.
pub trait ProjectSessionActivity: Send + Sync {
    /// Reads on `reader` the activity of every project session (shape `project`, state not
    /// `purge_requested`) of `project_ids`, or of every project when `None`.
    fn read_session_facts(
        &self,
        reader: &Connection,
        project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>>;
}

/// One project session's facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectSessionFacts {
    /// The project the session sits in.
    pub project_id: ProjectId,
    /// The session.
    pub session_id: SessionId,
    /// What the session is doing, as the sessions list reads it.
    pub activity: SessionActivity,
}

/// An attached project's folder: its mount, its repository's root and where that root is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachedProjectRoot {
    /// The project.
    pub project_id: ProjectId,
    /// Its attached mount.
    pub repo_mount_id: RepoMountId,
    /// The mount's resolved root, as stored.
    pub canonical_root: PathBuf,
    /// Where the root is; `None` on macOS and Linux.
    pub place: Option<Place>,
}

/// The setup steps and environment rows of the project a worktree belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeProjectSetup {
    /// What runs after a worktree is made.
    pub setup: ProjectSetup,
    /// The project's own environment rows, which its setup commands run with.
    pub environment_rows: Vec<EnvironmentRow>,
}

/// Why a project read failed.
#[derive(Debug, thiserror::Error)]
pub enum ProjectReadError {
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("the project rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// One project as the list holds it: its entry and when it was made, which orders the list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ListedProject {
    /// When the project was made, as stored.
    pub(crate) created_at: String,
    /// The project as the list draws it.
    pub(crate) entry: ProjectListEntry,
}

/// Projects as the list draws them, oldest first, with the sessions counted in them.
#[derive(Clone, Debug, Default)]
pub(crate) struct ListedProjects {
    /// The projects read.
    pub(crate) projects: Vec<ListedProject>,
    /// Every session counted in those projects.
    pub(crate) sessions: Vec<ProjectSessionFacts>,
}

/// One read of the projects some changes touched: the projects named and those the changed
/// sessions sit in now.
#[derive(Clone, Debug, Default)]
pub(crate) struct ProjectChanges {
    /// Every project read again, those whose rows are gone among them.
    pub(crate) read_project_ids: Vec<ProjectId>,
    /// The read projects whose rows exist, with their sessions.
    pub(crate) listed: ListedProjects,
}

/// Where a project's clone stands, while the project is cloning.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloneRecord {
    /// Where the clone stands.
    pub(crate) outcome: CloneOutcome,
    /// Git's last error line, held only while the outcome is `failed`.
    pub(crate) failure: Option<String>,
}

/// One project's own row, as the project writer and a clone's card read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectRow {
    /// Its life.
    pub(crate) state: ProjectState,
    /// Its repository's root, or the clone's destination while cloning, as stored.
    pub(crate) folder_path: PathBuf,
    /// Where the folder is; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// Its own branch pattern; `None` follows the machine's.
    pub(crate) branch_pattern: Option<BranchNamePattern>,
    /// Its clone, while it is cloning.
    pub(crate) clone: Option<CloneRecord>,
}

/// The project a mount serves and the sessions a detach of it archives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DetachSubjects {
    /// The project.
    pub(crate) project_id: ProjectId,
    /// Its active sessions and those still provisioning, oldest first.
    pub(crate) archivable_session_ids: Vec<SessionId>,
}

/// A clone the last stop cut short, as the clone service's start-time recovery reads it: one
/// recorded running, or one whose staged folder a recovery left unremoved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CutShortClone {
    /// The cloning project.
    pub(crate) project_id: ProjectId,
    /// Whether it is still recorded running.
    pub(crate) is_running: bool,
    /// The folder the finished clone is renamed to.
    pub(crate) folder_path: PathBuf,
    /// The folder the daemon named for the clone's git, with its identity once it made it;
    /// `None` before it named one.
    pub(crate) staged: Option<(PathBuf, Option<EntryIdentity>)>,
}

// Each project with its attached mount; `@project_ids` NULL reads every project.
static PROJECT_ROWS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT project.id, project.name, project.folder_path, project.state, project.setup,
       project.environment_rows, project.branch_pattern, project.place, project.created_at,
       (SELECT mount.id FROM repo_mounts AS mount
         WHERE mount.project_id = project.id AND mount.state = '{}') AS repo_mount_id
  FROM projects AS project
 WHERE @project_ids IS NULL OR project.id IN (SELECT value FROM json_each(@project_ids))
 ORDER BY project.created_at ASC, project.id ASC",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// Each run whose execution root is unreleased, with the project of its workspace's mount, oldest
// first; `run_id` breaks ties between runs started in the same tick.
const RUNNING_SESSIONS_SQL: &str = "SELECT mount.project_id, run_context.session_id
  FROM run_execution_contexts AS run_context
  JOIN workspaces AS workspace ON workspace.id = run_context.workspace_id
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE run_context.released_at IS NULL
   AND mount.project_id IS NOT NULL
   AND (@project_ids IS NULL
        OR mount.project_id IN (SELECT value FROM json_each(@project_ids)))
 ORDER BY run_context.created_at ASC, run_context.run_id ASC";

// The project each named session sits in now.
static SESSION_PROJECTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM json_each(@session_ids) AS given",
        session_project_sql("given.value")
    )
});

// One project's row.
const PROJECT_ROW_SQL: &str =
    "SELECT state, folder_path, place, branch_pattern, clone_outcome, clone_failure
  FROM projects
 WHERE id = @project_id";

// Every project as a check of the machine's branch pattern reads it, oldest first.
const PATTERN_PROJECTS_SQL: &str =
    "SELECT id, folder_path, place, state, branch_pattern IS NOT NULL
  FROM projects
 ORDER BY created_at ASC, id ASC";

const NAMING_OF_MOUNT_SQL: &str = "SELECT project.slug, project.branch_pattern
  FROM repo_mounts AS mount JOIN projects AS project ON project.id = mount.project_id
 WHERE mount.id = @repo_mount_id";

// The setup steps and environment rows of the project a worktree belongs to.
const PROJECT_OF_WORKTREE_SQL: &str = "SELECT project.setup, project.environment_rows
  FROM worktrees AS worktree
  JOIN repo_mounts AS mount ON mount.id = worktree.repo_mount_id
  JOIN projects AS project ON project.id = mount.project_id
 WHERE worktree.id = @worktree_id";

static ENVIRONMENT_ROWS_OF_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT environment_rows FROM projects WHERE id = {}",
        session_project_sql("@session_id")
    )
});

const PROJECT_OF_MOUNT_SQL: &str = "SELECT project_id FROM repo_mounts WHERE id = @repo_mount_id";

// The project's sessions a detach archives: the active ones, and those still provisioning, whose
// bind can never come once the project is forgotten.
static ARCHIVABLE_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT s.id FROM sessions s
 WHERE s.shape = '{}' AND s.state IN ('{}', '{}')
   AND {} = @project_id
 ORDER BY s.created_at ASC, s.id ASC",
        <&'static str>::from(SessionShape::Project),
        <&'static str>::from(SessionState::Active),
        <&'static str>::from(SessionState::Provisioning),
        session_project_sql("s.id")
    )
});

const SLUG_TAKEN_SQL: &str = "SELECT 1 FROM projects WHERE slug = @slug";

// The attached projects' folders, the most recently attached first; `@project_id` NULL reads every
// one.
static ATTACHED_ROOTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT mount.project_id, mount.id, mount.canonical_root, mount.place
  FROM repo_mounts AS mount
 WHERE mount.state = '{}' AND mount.origin = '{}'
   AND (@project_id IS NULL OR mount.project_id = @project_id)
 ORDER BY mount.attached_at DESC, mount.id DESC",
        <&'static str>::from(RepoMountState::Attached),
        <&'static str>::from(MountOrigin::Attached)
    )
});

// A clone recorded running, or holding a staged folder: at the clone service's start no git runs,
// so the last stop cut it short.
static CUT_SHORT_CLONES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, clone_outcome = '{running}', folder_path, clone_staging_folder,
       clone_staging_identity
  FROM projects
 WHERE state = '{}' AND (clone_outcome = '{running}' OR clone_staging_folder IS NOT NULL)",
        <&'static str>::from(ProjectState::Cloning),
        running = <&'static str>::from(CloneOutcome::Running)
    )
});

/// The project reads, on the daemon's read pool.
pub struct ProjectRecords {
    reads: Arc<DatabaseReadPool>,
    activity: Arc<dyn ProjectSessionActivity>,
}

impl ProjectRecords {
    /// The reads on `reads`, each project session's activity read through `activity`.
    pub fn new(reads: Arc<DatabaseReadPool>, activity: Arc<dyn ProjectSessionActivity>) -> Self {
        Self { reads, activity }
    }

    /// Every project as the list draws it, oldest first. Fails as the read fails.
    pub async fn read_entries(&self) -> Result<Vec<ProjectListEntry>, ProjectReadError> {
        Ok(self
            .read_list()
            .await?
            .projects
            .into_iter()
            .map(|listed| listed.entry)
            .collect())
    }

    /// One project as the list draws it, or `None` when it does not exist. Fails as the read
    /// fails.
    pub async fn read_entry(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<ProjectListEntry>, ProjectReadError> {
        let activity = Arc::clone(&self.activity);
        let listed = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ProjectReadError>(read_listed(
                    connection,
                    activity.as_ref(),
                    Some(&[project_id]),
                )?)
            })
            .await?;
        Ok(listed
            .projects
            .into_iter()
            .next()
            .map(|listed| listed.entry))
    }

    /// Every project as the list draws it, oldest first, with the sessions counted in each. Fails
    /// as the read fails.
    pub(crate) async fn read_list(&self) -> Result<ListedProjects, ProjectReadError> {
        let activity = Arc::clone(&self.activity);
        self.reads
            .read(ReadLength::Long, move |connection| {
                Ok(read_listed(connection, activity.as_ref(), None)?)
            })
            .await
    }

    /// The project each of `session_ids` sits in now, and every one of `project_ids` and of those
    /// projects read again, in one read. Fails as the read fails.
    pub(crate) async fn read_project_changes(
        &self,
        session_ids: Vec<SessionId>,
        project_ids: Vec<ProjectId>,
    ) -> Result<ProjectChanges, ProjectReadError> {
        let activity = Arc::clone(&self.activity);
        self.reads
            .read(ReadLength::Short, move |connection| {
                let mut read_project_ids = project_ids;
                for project_id in read_session_projects(connection, &session_ids)? {
                    if !read_project_ids.contains(&project_id) {
                        read_project_ids.push(project_id);
                    }
                }
                let listed = if read_project_ids.is_empty() {
                    ListedProjects::default()
                } else {
                    read_listed(connection, activity.as_ref(), Some(&read_project_ids))?
                };
                Ok(ProjectChanges {
                    read_project_ids,
                    listed,
                })
            })
            .await
    }

    /// One project's row, or `None` when it does not exist. Fails as the read fails.
    pub(crate) async fn read_row(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<ProjectRow>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(PROJECT_ROW_SQL)?
                    .query_row(
                        named_params! { "@project_id": project_id.text().as_str() },
                        project_row,
                    )
                    .optional()?)
            })
            .await
    }

    /// Every project as a check of the machine's branch pattern reads it, oldest first. Fails as
    /// the read fails.
    pub(crate) async fn read_pattern_projects(
        &self,
    ) -> Result<Vec<BranchPatternProject>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(PATTERN_PROJECTS_SQL)?
                    .query_map([], |row| {
                        Ok(BranchPatternProject {
                            id: text_column(row, 0, |text| ProjectId::new(&text))?,
                            folder: PathBuf::from(row.get::<_, String>(1)?),
                            place: optional_text_column(row, 2, stored_json)?,
                            state: text_column(row, 3, closed_word)?,
                            has_own_pattern: row.get(4)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    /// The naming facts of the project the mount `repo_mount_id` serves, or `None` when it serves
    /// none: a chat's managed mount, or a mount whose project was forgotten. Fails as the read
    /// fails.
    pub async fn read_naming(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<Option<WorktreeProjectNaming>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(NAMING_OF_MOUNT_SQL)?
                    .query_row(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| {
                            Ok(WorktreeProjectNaming {
                                slug: row.get(0)?,
                                branch_pattern: optional_text_column(row, 1, stored_json_text)?,
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    /// The setup steps and environment rows of the project `worktree_id` belongs to, or `None`
    /// when it belongs to none. Fails as the read fails.
    pub async fn read_worktree_project(
        &self,
        worktree_id: WorktreeId,
    ) -> Result<Option<WorktreeProjectSetup>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(PROJECT_OF_WORKTREE_SQL)?
                    .query_row(
                        named_params! { "@worktree_id": worktree_id.text().as_str() },
                        |row| {
                            Ok(WorktreeProjectSetup {
                                setup: text_column(row, 0, stored_json)?,
                                environment_rows: text_column(row, 1, stored_json)?,
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    /// The environment rows of the project `session_id` sits in, which its provider processes
    /// start with; none for a chat or a session whose project was forgotten. Fails as the read
    /// fails.
    pub async fn read_environment_rows_of_session(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<EnvironmentRow>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&ENVIRONMENT_ROWS_OF_SESSION_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| text_column(row, 0, stored_json),
                    )
                    .optional()?
                    .unwrap_or_default())
            })
            .await
    }

    /// The project the mount `repo_mount_id` serves with the sessions its detach archives, or
    /// `None` for a chat's mount or a forgotten project. Fails as the read fails.
    pub(crate) async fn read_detach_subjects(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<Option<DetachSubjects>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                let project_id = connection
                    .prepare_cached(PROJECT_OF_MOUNT_SQL)?
                    .query_row(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| optional_text_column(row, 0, |text| ProjectId::new(&text)),
                    )
                    .optional()?
                    .flatten();
                let Some(project_id) = project_id else {
                    return Ok(None);
                };
                let archivable_session_ids = connection
                    .prepare_cached(&ARCHIVABLE_SESSIONS_SQL)?
                    .query_map(
                        named_params! { "@project_id": project_id.text().as_str() },
                        |row| text_column(row, 0, |text| SessionId::new(&text)),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(Some(DetachSubjects {
                    project_id,
                    archivable_session_ids,
                }))
            })
            .await
    }

    /// Whether a project holds `slug`. Fails as the read fails.
    pub(crate) async fn is_slug_taken(&self, slug: String) -> Result<bool, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SLUG_TAKEN_SQL)?
                    .exists(named_params! { "@slug": slug })?)
            })
            .await
    }

    /// Every attached project's folder, the most recently attached first. Fails as the read
    /// fails.
    pub async fn read_attached_roots(&self) -> Result<Vec<AttachedProjectRoot>, ProjectReadError> {
        self.read_roots(None).await
    }

    /// The folder of the project `project_id`, or `None` while it has no attached mount: unknown,
    /// forgotten or still cloning. Fails as the read fails.
    pub async fn read_project_root(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<AttachedProjectRoot>, ProjectReadError> {
        Ok(self.read_roots(Some(project_id)).await?.into_iter().next())
    }

    /// The clones the last stop cut short, which no git runs for at the clone service's start.
    /// Fails as the read fails.
    pub(crate) async fn read_cut_short_clones(
        &self,
    ) -> Result<Vec<CutShortClone>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, |connection| {
                Ok(connection
                    .prepare_cached(&CUT_SHORT_CLONES_SQL)?
                    .query_map([], |row| {
                        let staged_folder = row.get::<_, Option<String>>(3)?.map(PathBuf::from);
                        let staged_identity =
                            optional_text_column(row, 4, |text| text.parse::<EntryIdentity>())?;
                        Ok(CutShortClone {
                            project_id: text_column(row, 0, |text| ProjectId::new(&text))?,
                            is_running: row.get(1)?,
                            folder_path: PathBuf::from(row.get::<_, String>(2)?),
                            // The row's check sets an identity only beside its folder.
                            staged: staged_folder.map(|folder| (folder, staged_identity)),
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_roots(
        &self,
        project_id: Option<ProjectId>,
    ) -> Result<Vec<AttachedProjectRoot>, ProjectReadError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                let project_id = project_id.map(|project_id| project_id.text().as_str().to_owned());
                Ok(connection
                    .prepare_cached(&ATTACHED_ROOTS_SQL)?
                    .query_map(named_params! { "@project_id": project_id }, |row| {
                        Ok(AttachedProjectRoot {
                            project_id: text_column(row, 0, |text| ProjectId::new(&text))?,
                            repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
                            canonical_root: PathBuf::from(row.get::<_, String>(2)?),
                            place: optional_text_column(row, 3, stored_json)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }
}

// The projects of `project_ids`, or every project when `None`, with their sessions' activity and
// the session an agent runs in, oldest first.
fn read_listed(
    connection: &Connection,
    activity: &dyn ProjectSessionActivity,
    project_ids: Option<&[ProjectId]>,
) -> rusqlite::Result<ListedProjects> {
    let project_ids_json = project_ids.map(|project_ids| {
        serde_json::to_string(project_ids).expect("a list of ids serializes to JSON")
    });
    let sessions = activity.read_session_facts(connection, project_ids)?;
    let mut facts_by_project: HashMap<ProjectId, Vec<SessionActivity>> = HashMap::new();
    for facts in &sessions {
        facts_by_project
            .entry(facts.project_id)
            .or_default()
            .push(facts.activity);
    }
    // The oldest run comes first, so the first seen per project is the one named.
    let mut running_sessions: HashMap<ProjectId, SessionId> = HashMap::new();
    for running in connection.prepare_cached(RUNNING_SESSIONS_SQL)?.query_map(
        named_params! { "@project_ids": project_ids_json },
        |row| {
            Ok((
                text_column(row, 0, |text| ProjectId::new(&text))?,
                text_column(row, 1, |text| SessionId::new(&text))?,
            ))
        },
    )? {
        let (project_id, session_id) = running?;
        running_sessions.entry(project_id).or_insert(session_id);
    }
    let projects = connection
        .prepare_cached(&PROJECT_ROWS_SQL)?
        .query_map(named_params! { "@project_ids": project_ids_json }, |row| {
            let project_id = text_column(row, 0, |text| ProjectId::new(&text))?;
            let activities = facts_by_project
                .get(&project_id)
                .map_or(&[][..], Vec::as_slice);
            Ok(ListedProject {
                created_at: row.get(8)?,
                entry: ProjectListEntry {
                    project_id,
                    repo_mount_id: optional_text_column(row, 9, |text| RepoMountId::new(&text))?,
                    name: text_column(row, 1, ProjectName::new)?,
                    folder_path: text_column(row, 2, FilesystemPath::new)?,
                    state: text_column(row, 3, closed_word)?,
                    session_count: count_of(activities.len()),
                    running_session_id: running_sessions.get(&project_id).copied(),
                    session_tally: tally_of(activities),
                    setup: text_column(row, 4, stored_json)?,
                    environment_rows: text_column(row, 5, stored_json)?,
                    branch_pattern: optional_text_column(row, 6, stored_json_text)?,
                    place: optional_text_column(row, 7, stored_json)?,
                    // No distribution can be removed where no WSL place exists.
                    is_distribution_removed: None,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ListedProjects { projects, sessions })
}

// The projects `session_ids` sit in now; a session in none, or whose rows are gone, adds none.
fn read_session_projects(
    connection: &Connection,
    session_ids: &[SessionId],
) -> rusqlite::Result<Vec<ProjectId>> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let session_ids_json =
        serde_json::to_string(session_ids).expect("a list of ids serializes to JSON");
    connection
        .prepare_cached(&SESSION_PROJECTS_SQL)?
        .query_map(named_params! { "@session_ids": session_ids_json }, |row| {
            optional_text_column(row, 0, |text| ProjectId::new(&text))
        })?
        .filter_map(Result::transpose)
        .collect()
}

fn project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
    let outcome = optional_text_column(row, 4, stored_clone_outcome)?;
    let failure: Option<String> = row.get(5)?;
    Ok(ProjectRow {
        state: text_column(row, 0, closed_word)?,
        folder_path: PathBuf::from(row.get::<_, String>(1)?),
        place: optional_text_column(row, 2, stored_json)?,
        branch_pattern: optional_text_column(row, 3, stored_json_text)?,
        // The row's checks set the outcome exactly while it is cloning.
        clone: outcome.map(|outcome| CloneRecord { outcome, failure }),
    })
}

// How many of the sessions read running, waiting on the person and done.
fn tally_of(activities: &[SessionActivity]) -> ProjectSessionTally {
    let mut running = 0;
    let mut waiting = 0;
    let mut done = 0;
    for activity in activities {
        match activity {
            SessionActivity::Running => running += 1,
            SessionActivity::Waiting => waiting += 1,
            SessionActivity::Done => done += 1,
            SessionActivity::Failed | SessionActivity::Idle => {}
        }
    }
    ProjectSessionTally {
        running: count_of(running),
        waiting: count_of(waiting),
        done: count_of(done),
    }
}

fn count_of(count: usize) -> SafeInt<0> {
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a count of rows read is a safe integer")
}

// A stored JSON column, its fault kept without the stored text.
fn stored_json<Parsed: DeserializeOwned>(text: String) -> Result<Parsed, StoredJsonFault> {
    serde_json::from_str(&text).map_err(StoredJsonFault::from)
}

// A stored column holding a checked value's own text, read through that value's check.
fn stored_json_text<Parsed: DeserializeOwned>(text: String) -> Result<Parsed, StoredJsonFault> {
    serde_json::from_value(serde_json::Value::String(text)).map_err(StoredJsonFault::from)
}

fn stored_clone_outcome(text: String) -> Result<CloneOutcome, UnknownCloneOutcome> {
    CloneOutcome::VARIANTS
        .iter()
        .copied()
        .find(|outcome| <&'static str>::from(*outcome) == text)
        .ok_or(UnknownCloneOutcome)
}

/// A stored clone outcome that names no outcome.
#[derive(Debug, thiserror::Error)]
#[error("the stored clone outcome names no outcome")]
struct UnknownCloneOutcome;
