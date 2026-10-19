//! The `repo_mounts` table's attach, read and detach, and a chat's managed mount rows. An attached
//! mount belongs to the machine and serves one project: attach stamps the daemon's machine id and
//! the root's place, writes no workspace and appends no event. A managed mount is one chat's own
//! workspace folder, written at that chat's create and deleted with it.
//!
//! - A repository is attached once per machine and place: its identity is its git common folder,
//!   kept on the mount as `metadata.commonDir` and compared inside the insert, with the active-root
//!   index as the backstop for one root; the read before it only refuses early.
//! - Attach resolves first and inserts second, so the project writer can write the project row and
//!   its mount in one write.
//! - Detach checks for running agents in the project, archives and flips the mount in one write,
//!   then appends `workspace.archived` events, so a crash leaves the rows durable and the events
//!   missing. A managed mount is never detached.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::folders::{RepoMountAttachRequest, RepoMountAttachResponse};
use sidekicks_contracts::repo::mount::{RepoMountHealth, RepoMountId, RepoMountState, VcsType};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, place_value, text_binding};
use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::database::writer::{DatabaseWriter, WriteError, sqlite_error_code};
use crate::events::session::appender::SessionEventEmitError;
#[cfg(test)]
use crate::pause_point::PausePoint;
use crate::settle_all::SettleFailures;
use crate::uuid_v7::mint_uuid_v7;
use crate::workspace::event_emitter::WorkspaceEventEmitter;
use crate::workspace::projector::{HealthProjectionError, RepoMountHealthRow};
use crate::workspace::repo::errors::RepoRefusal;
use crate::workspace::repo::mount::health::{MountHealthProbeError, probe_repo_mount_health};
use crate::workspace::repo::root_resolver::RepoRootResolver;
use crate::workspace::row_guards::COMMON_DIR_METADATA_PATH;
use crate::workspace::schema::MountOrigin;

/// The statements the service's reads keep prepared on each read connection.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start, sizing its read connections")
)]
pub(crate) const REPO_MOUNT_SERVICE_STATEMENT_CAPACITY: usize = 4;

// An attached mount of a repository the machine has no active mount of in that place, compared by
// identity anchor inside the write; zero rows refuses it.
static INSERT_ATTACHED_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    let attached = <&'static str>::from(RepoMountState::Attached);
    let origin = <&'static str>::from(MountOrigin::Attached);
    format!(
        "INSERT INTO repo_mounts (
    id, machine_id, local_path, canonical_root, place, vcs_type, origin, project_id, state,
    attached_at, updated_at, metadata
  )
  SELECT @id, @machine_id, @local_path, @canonical_root, @place, @vcs_type, '{origin}',
         @project_id, '{attached}', @now, @now,
         json_set('{{}}', '{COMMON_DIR_METADATA_PATH}', @common_dir)
   WHERE NOT EXISTS (
     SELECT 1 FROM repo_mounts
      WHERE machine_id = @machine_id
        AND coalesce(place, '') = coalesce(@place, '')
        AND state = '{attached}'
        AND json_extract(metadata, '{COMMON_DIR_METADATA_PATH}') = @common_dir)"
    )
});

// A chat's managed mount; the daemon chose its folder, so it carries no identity anchor.
static INSERT_MANAGED_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO repo_mounts (
    id, machine_id, local_path, canonical_root, place, vcs_type, origin, managed_session_id,
    state, attached_at, updated_at
  ) VALUES (
    @id, @machine_id, @canonical_root, @canonical_root, @place, '{}', '{}', @managed_session_id,
    '{}', @now, @now
  )",
        <&'static str>::from(VcsType::Git),
        <&'static str>::from(MountOrigin::Managed),
        <&'static str>::from(RepoMountState::Attached),
    )
});

// The workspaces on the chat's managed mount.
const MANAGED_WORKSPACE_IDS_SQL: &str = "SELECT workspace.id
     FROM workspaces AS workspace
     JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
    WHERE mount.managed_session_id = @session_id";

// Each row that names a workspace on the mount goes before it, and each workspace before the mount,
// because every foreign key holds on DELETE too.
static DELETE_MANAGED_MOUNT_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    [
        format!(
            "DELETE FROM run_execution_contexts WHERE workspace_id IN ({MANAGED_WORKSPACE_IDS_SQL})"
        ),
        format!("DELETE FROM branch_contexts WHERE workspace_id IN ({MANAGED_WORKSPACE_IDS_SQL})"),
        "DELETE FROM workspaces
    WHERE repo_mount_id IN (SELECT id FROM repo_mounts WHERE managed_session_id = @session_id)"
            .to_owned(),
        "DELETE FROM repo_mounts WHERE managed_session_id = @session_id".to_owned(),
    ]
});

// Unscoped by state: a read must answer for a `detached` mount.
static SELECT_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, machine_id, local_path, canonical_root, place, vcs_type, origin, state,
          attached_at, json_extract(metadata, '{COMMON_DIR_METADATA_PATH}')
     FROM repo_mounts
    WHERE id = @repo_mount_id"
    )
});

// The machine's attached mount in the place at the root (the active-root index's predicate) or
// with the identity anchor, a mount at the root first.
static SELECT_ACTIVE_MOUNT_OF_REPOSITORY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, origin, project_id
     FROM repo_mounts
    WHERE machine_id = @machine_id
      AND coalesce(place, '') = coalesce(@place, '')
      AND state = '{}'
      AND (canonical_root = @canonical_root
           OR json_extract(metadata, '{COMMON_DIR_METADATA_PATH}') = @common_dir)
    ORDER BY canonical_root = @canonical_root DESC, id ASC
    LIMIT 1",
        <&'static str>::from(RepoMountState::Attached)
    )
});

const SELECT_MANAGED_ROOT_SQL: &str =
    "SELECT canonical_root FROM repo_mounts WHERE managed_session_id = @session_id";

/// Why a mount call failed: a refusal the wire carries, or a failure of the store or of the
/// events a committed detach owed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepoMountServiceError {
    /// The call was refused; nothing was written.
    #[error(transparent)]
    Refused(#[from] RepoRefusal),
    /// The mount table could not be read.
    #[error("the repo mount table could not be read")]
    Read(#[from] DatabaseReadError),
    /// A stored mount row could not be read into its typed facts: a corrupt row or an id the
    /// contracts refuse.
    #[error("a repo mount row could not be read")]
    Row(#[from] rusqlite::Error),
    /// The write was not kept.
    #[error("the repo mount write was not kept")]
    Write(#[from] WriteError),
    /// The health probe and the mount row did not belong together.
    #[error(transparent)]
    HealthProjection(#[from] HealthProjectionError),
    /// The detach committed, but appending a `workspace.archived` failed, so the log under-reports
    /// the archived rows; the rows are the truth and a rerun is a no-op.
    #[error(
        "repo mount {repo_mount_id} detached and archived its workspaces, but announcing them \
         failed; the rows are committed"
    )]
    DetachNotificationIncomplete {
        /// The detached mount.
        repo_mount_id: RepoMountId,
        /// Every append that failed.
        #[source]
        source: SettleFailures<SessionEventEmitError>,
    },
    /// The detach committed, but a workspace it archived could not be read into its typed facts,
    /// so none was announced; the rows are the truth and a rerun is a no-op.
    #[error(
        "repo mount {repo_mount_id} detached and archived its workspaces, but they could not be \
         read to announce them; the rows are committed"
    )]
    DetachArchivalsUnread {
        /// The detached mount.
        repo_mount_id: RepoMountId,
        /// Why a workspace row did not read.
        #[source]
        source: rusqlite::Error,
    },
}

/// A path resolved for attach and found unattached, which
/// [`RepoMountService::insert_attached_mount`] keeps; the repository may be attached between the
/// two calls, which the insert refuses then.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoAttachTarget {
    /// The path as entered, kept as provenance.
    pub(crate) local_path: FilesystemPath,
    /// The resolved root, as the wire carries it and the row keeps it.
    pub(crate) canonical_root: FilesystemPath,
    /// The repository's resolved git common folder, the mount's identity anchor.
    pub(crate) common_folder: PathBuf,
    /// Where the root is; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
}

/// A folder resolved the way attach resolves it, attaching nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedFolder {
    /// The resolved root.
    pub(crate) canonical_root: PathBuf,
    /// The attached project mount of its repository, `None` when none holds it.
    pub(crate) repo_mount_id: Option<RepoMountId>,
}

/// One mount's stored facts, in any state; the `repoMount.read` reply adds a fresh health
/// verdict, the folder's origin, its project's name and the sessions using it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoMountRow {
    /// The mount.
    pub(crate) id: RepoMountId,
    /// The machine whose daemon attached it.
    pub(crate) machine_id: MachineId,
    /// The path as entered.
    pub(crate) local_path: FilesystemPath,
    /// The resolved root, as stored; the health probe compares it byte for byte.
    pub(crate) canonical_root: PathBuf,
    /// Where the root is; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// Its version-control system.
    pub(crate) vcs_type: VcsType,
    /// Where it came from.
    pub(crate) origin: MountOrigin,
    /// Its state.
    pub(crate) state: RepoMountState,
    /// When it was attached.
    pub(crate) attached_at: WireInstant,
    /// The git common folder recorded at attach; `None` on a managed mount.
    pub(crate) common_folder_anchor: Option<PathBuf>,
}

/// One mount's stored facts with a freshly probed health verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoMountRecord {
    /// The stored facts.
    pub(crate) row: RepoMountRow,
    /// Its health, probed for this read.
    pub(crate) health: RepoMountHealth,
}

// The machine's attached mount holding a repository.
struct ActiveMount {
    id: RepoMountId,
    origin: MountOrigin,
    project_id: Option<ProjectId>,
}

/// Owns the `repo_mounts` table's attach, read and detach. The detach also archives the mount's
/// `workspaces` rows and a managed mount's deletion deletes them, because each must share one
/// write with the mount row it follows.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the repository mount methods' handlers")
)]
pub(crate) struct RepoMountService {
    writer: Arc<DatabaseWriter>,
    reads: Arc<DatabaseReadPool>,
    events: Arc<WorkspaceEventEmitter>,
    resolver: RepoRootResolver,
    machine_id: MachineId,
    /// Where a test holds a detach between its row read and its write.
    #[cfg(test)]
    pub(crate) detach_pause: PausePoint,
    /// Where a test holds a detach the running check refused, before it reads the running session.
    #[cfg(test)]
    pub(crate) running_read_pause: PausePoint,
}

#[expect(dead_code, reason = "the repository mount methods' handlers")]
impl RepoMountService {
    /// The mounts of `machine_id`'s daemon, written through `writer`, read through `reads`, roots
    /// resolved by `resolver` and a detach's archivals appended through `events`.
    pub(crate) fn new(
        writer: Arc<DatabaseWriter>,
        reads: Arc<DatabaseReadPool>,
        events: Arc<WorkspaceEventEmitter>,
        resolver: RepoRootResolver,
        machine_id: MachineId,
    ) -> Self {
        Self {
            writer,
            reads,
            events,
            resolver,
            machine_id,
            #[cfg(test)]
            detach_pause: PausePoint::default(),
            #[cfg(test)]
            running_read_pause: PausePoint::default(),
        }
    }

    /// The mounts of a daemon over the test `database`, roots resolved by `resolver`.
    #[cfg(test)]
    pub(crate) async fn for_test(
        database: &crate::database::writer::test_file::TestDatabase,
        resolver: RepoRootResolver,
    ) -> Arc<Self> {
        use crate::database::writer::DatabaseWriterOptions;
        use crate::events::log_service::{
            EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
        };
        use crate::events::session::followers::SessionEventFollowers;

        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens the test database"),
        );
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY,
        ));
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::clone(&reads),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: None,
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        Arc::new(Self::new(
            writer,
            reads,
            Arc::new(WorkspaceEventEmitter::new(event_log)),
            resolver,
            MachineId::new("machine".to_owned()).expect("the id is short"),
        ))
    }

    /// Resolves `request`'s path for attach and checks the machine has no active mount of its
    /// repository, writing nothing. Refuses a path the resolver refuses, a WSL place
    /// (`repoMount.distributionNotFound`, no distribution being reachable here), a root that
    /// resolves past the wire's path cap (`request.paramsInvalid`, as the request's own path would
    /// be), and `repoMount.alreadyAttached` naming the mount that holds the repository.
    pub(crate) async fn resolve_attach_target(
        &self,
        request: &RepoMountAttachRequest,
    ) -> Result<RepoAttachTarget, RepoMountServiceError> {
        refuse_distribution(request)?;
        let resolution = self
            .resolver
            .resolve_canonical_root(Path::new(request.local_path.as_str()))
            .await?;
        // A link or junction can resolve to a longer path than the one entered; a resolved path
        // holds no NUL, so passing the cap is the one way it is refused.
        let root_text = stored_path(&resolution.canonical_root);
        let code_points = root_text.chars().count();
        let canonical_root = FilesystemPath::new(root_text)
            .map_err(|_over_cap| RepoRefusal::ResolvedRootTooLong { code_points })?;
        let place = None;
        if let Some(holder) = self
            .find_active_mount_of_repository(
                &resolution.canonical_root,
                Some(&resolution.common_folder),
                place.clone(),
            )
            .await?
        {
            return Err(already_attached(&holder).into());
        }
        Ok(RepoAttachTarget {
            local_path: request.local_path.clone(),
            canonical_root,
            common_folder: resolution.common_folder,
            place,
        })
    }

    /// Keeps a resolved target as the mount of `project_id`, in one write after
    /// `project_statements` (the project row a new project needs, written with its mount or not
    /// at all). Refuses `repoMount.alreadyAttached` when the repository was attached since it was
    /// resolved; fails with the write's failure otherwise.
    pub(crate) async fn insert_attached_mount(
        &self,
        target: &RepoAttachTarget,
        project_id: ProjectId,
        project_statements: Vec<WriteStatement>,
    ) -> Result<RepoMountAttachResponse, RepoMountServiceError> {
        let repo_mount_id = new_repo_mount_id();
        let insert_index = project_statements.len();
        let mut statements = project_statements;
        statements.push(WriteStatement {
            sql: Cow::Borrowed(INSERT_ATTACHED_MOUNT_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", repo_mount_id.text().as_str()),
                text_binding("@machine_id", self.machine_id.as_str()),
                text_binding("@local_path", target.local_path.as_str()),
                text_binding("@canonical_root", target.canonical_root.as_str()),
                (Cow::Borrowed("@place"), place_value(target.place.as_ref())),
                text_binding("@vcs_type", <&'static str>::from(VcsType::Git)),
                text_binding("@project_id", project_id.text().as_str()),
                text_binding("@common_dir", &stored_path(&target.common_folder)),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        });
        if let Err(error) = self.writer.write(statements).await {
            return Err(self
                .refusal_of_insert(
                    error,
                    Path::new(target.canonical_root.as_str()),
                    Some(&target.common_folder),
                    target.place.as_ref(),
                    insert_index,
                )
                .await);
        }
        Ok(RepoMountAttachResponse {
            repo_mount_id,
            state: RepoMountState::Attached,
            vcs_type: VcsType::Git,
            canonical_root: target.canonical_root.clone(),
            place: target.place.clone(),
        })
    }

    /// The folder at `request`'s path resolved the way attach resolves it, attaching nothing: its
    /// canonical root and the attached project mount of its repository. A chat's managed
    /// workspace is never a project, so its mount is never answered. Refuses as
    /// [`RepoMountService::resolve_attach_target`] does, `alreadyAttached` aside.
    pub(crate) async fn resolve_folder(
        &self,
        request: &RepoMountAttachRequest,
    ) -> Result<ResolvedFolder, RepoMountServiceError> {
        refuse_distribution(request)?;
        let resolution = self
            .resolver
            .resolve_canonical_root(Path::new(request.local_path.as_str()))
            .await?;
        let mount = self
            .find_active_mount_of_repository(
                &resolution.canonical_root,
                Some(&resolution.common_folder),
                None,
            )
            .await?;
        Ok(ResolvedFolder {
            canonical_root: resolution.canonical_root,
            repo_mount_id: mount
                .filter(|mount| mount.origin == MountOrigin::Attached)
                .map(|mount| mount.id),
        })
    }

    /// The folder of the chat's managed workspace, or `None` when the session has none. Fails as
    /// the read fails.
    pub(crate) async fn read_managed_root(
        &self,
        session_id: SessionId,
    ) -> Result<Option<PathBuf>, RepoMountServiceError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_MANAGED_ROOT_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .map(PathBuf::from))
            })
            .await
    }

    /// Registers a chat's workspace folder `canonical_root` in `place` as its managed mount,
    /// before the folder exists: the daemon chose the root, so nothing is resolved. Refuses
    /// `repoMount.alreadyAttached` when the root, which the session id names, is already
    /// attached; fails with the write's failure otherwise.
    pub(crate) async fn attach_managed(
        &self,
        session_id: SessionId,
        canonical_root: &Path,
        place: Option<&Place>,
    ) -> Result<RepoMountId, RepoMountServiceError> {
        let repo_mount_id = new_repo_mount_id();
        let statement = WriteStatement {
            sql: Cow::Borrowed(INSERT_MANAGED_MOUNT_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", repo_mount_id.text().as_str()),
                text_binding("@machine_id", self.machine_id.as_str()),
                text_binding("@canonical_root", &stored_path(canonical_root)),
                (Cow::Borrowed("@place"), place_value(place)),
                text_binding("@managed_session_id", session_id.text().as_str()),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: None,
        };
        if let Err(error) = self.writer.write(vec![statement]).await {
            return Err(self
                .refusal_of_insert(error, canonical_root, None, place, 0)
                .await);
        }
        Ok(repo_mount_id)
    }

    /// Deletes a chat's managed mount row and every row on it, in one write. A session with no
    /// managed mount writes nothing, so a repeat is safe. Fails with the write's failure.
    pub(crate) async fn delete_managed(
        &self,
        session_id: SessionId,
    ) -> Result<(), RepoMountServiceError> {
        self.writer
            .write(managed_mount_deletion_statements(session_id))
            .await?;
        Ok(())
    }

    /// One mount's stored facts, in any state. Refuses `repoMount.notFound`; fails as the read
    /// fails, and with [`RepoMountServiceError::Row`] for a row the contracts refuse.
    pub(crate) async fn read_row(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<RepoMountRow, RepoMountServiceError> {
        let row = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_mount_row(connection, repo_mount_id)
            })
            .await?;
        row.ok_or_else(|| RepoRefusal::MountNotFound { repo_mount_id }.into())
    }

    /// One mount's facts, in any state, with a freshly probed health verdict, `unreachable` when the
    /// root or git gives no answer in time. Refuses `repoMount.notFound`, and
    /// `repoMount.rootResolutionFailed` (`vcsError`) when git cannot answer for the root otherwise;
    /// fails as [`RepoMountService::read_row`] does.
    pub(crate) async fn read(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<RepoMountRecord, RepoMountServiceError> {
        let row = self.read_row(repo_mount_id).await?;
        let health_row = RepoMountHealthRow {
            canonical_root: &row.canonical_root,
            place: row.place.as_ref(),
            common_dir_anchor: row.common_folder_anchor.as_deref(),
        };
        let health = match probe_repo_mount_health(&self.resolver, &health_row).await {
            Ok(health) => health,
            Err(MountHealthProbeError::GitUnanswered(refusal)) => return Err(refusal.into()),
            Err(MountHealthProbeError::Projection(error)) => return Err(error.into()),
        };
        Ok(RepoMountRecord { row, health })
    }

    // The machine's attached mount in `place` at `canonical_root` or with the anchor
    // `common_folder`, the root's first.
    async fn find_active_mount_of_repository(
        &self,
        canonical_root: &Path,
        common_folder: Option<&Path>,
        place: Option<Place>,
    ) -> Result<Option<ActiveMount>, RepoMountServiceError> {
        let machine_id = self.machine_id.clone();
        let canonical_root = stored_path(canonical_root);
        let common_dir = common_folder.map(stored_path);
        self.reads
            .read(ReadLength::Short, move |connection| {
                read_active_mount(
                    connection,
                    &machine_id,
                    place.as_ref(),
                    &canonical_root,
                    common_dir.as_deref(),
                )
            })
            .await
    }

    // A refused or constraint-failed mount insert as `repoMount.alreadyAttached` when an active
    // mount of the repository explains it; anything else is the write's own failure, since the
    // caller must not be sent to detach a mount that does not exist. The failed write is undone
    // whole, so the read sees the rows as they were.
    async fn refusal_of_insert(
        &self,
        error: WriteError,
        canonical_root: &Path,
        common_folder: Option<&Path>,
        place: Option<&Place>,
        insert_index: usize,
    ) -> RepoMountServiceError {
        let is_insert_refusal = error.refused_statement_index() == Some(insert_index)
            || sqlite_error_code(&error) == Some(rusqlite::ErrorCode::ConstraintViolation);
        if !is_insert_refusal {
            return error.into();
        }
        match self
            .find_active_mount_of_repository(canonical_root, common_folder, place.cloned())
            .await
        {
            Ok(Some(holder)) => already_attached(&holder).into(),
            Ok(None) => error.into(),
            Err(lookup_failure) => {
                tracing::warn!(
                    error = &lookup_failure as &(dyn std::error::Error + 'static),
                    "the holder of a refused mount insert could not be read"
                );
                error.into()
            }
        }
    }
}

/// The statements that delete a chat's managed mount row with every workspace on it and the run
/// and branch rows naming those workspaces, in foreign-key order; a session with none matches
/// nothing. They go in one write, alone or inside the purge's.
#[cfg_attr(not(test), expect(dead_code, reason = "the session purge"))]
pub(crate) fn managed_mount_deletion_statements(session_id: SessionId) -> Vec<WriteStatement> {
    DELETE_MANAGED_MOUNT_SQL
        .iter()
        .map(|sql| WriteStatement {
            sql: Cow::Owned(sql.clone()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@session_id",
                session_id.text().as_str(),
            )]),
            expected_row_count: None,
        })
        .collect()
}

// A WSL place cannot be reached from this computer's resolver; the place's own distribution names
// the refusal.
fn refuse_distribution(request: &RepoMountAttachRequest) -> Result<(), RepoRefusal> {
    match &request.place {
        Some(place) => Err(RepoRefusal::DistributionNotFound {
            distro: place.distro.clone(),
        }),
        None => Ok(()),
    }
}

fn already_attached(holder: &ActiveMount) -> RepoRefusal {
    RepoRefusal::AlreadyAttached {
        conflicting_repo_mount_id: holder.id,
        conflicting_project_id: holder.project_id,
    }
}

fn new_repo_mount_id() -> RepoMountId {
    RepoMountId::try_from(mint_uuid_v7()).expect("a minted UUID is a repo mount id")
}

// A path as its TEXT column holds it, the form every other path column keeps.
fn stored_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn read_mount_row(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Option<RepoMountRow>, RepoMountServiceError> {
    Ok(connection
        .prepare_cached(&SELECT_MOUNT_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| {
                Ok(RepoMountRow {
                    id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                    machine_id: text_column(row, 1, |text| {
                        MachineId::new(text).ok_or(StoredMachineIdInvalid)
                    })?,
                    local_path: text_column(row, 2, FilesystemPath::new)?,
                    canonical_root: PathBuf::from(row.get::<_, String>(3)?),
                    place: optional_text_column(row, 4, |text| {
                        serde_json::from_str::<Place>(&text)
                    })?,
                    vcs_type: text_column(row, 5, closed_word)?,
                    origin: text_column(row, 6, closed_word)?,
                    state: text_column(row, 7, closed_word)?,
                    attached_at: text_column(row, 8, WireInstant::try_from)?,
                    common_folder_anchor: row.get::<_, Option<String>>(9)?.map(PathBuf::from),
                })
            },
        )
        .optional()?)
}

fn read_active_mount(
    connection: &Connection,
    machine_id: &MachineId,
    place: Option<&Place>,
    canonical_root: &str,
    common_dir: Option<&str>,
) -> Result<Option<ActiveMount>, RepoMountServiceError> {
    Ok(connection
        .prepare_cached(&SELECT_ACTIVE_MOUNT_OF_REPOSITORY_SQL)?
        .query_row(
            named_params! {
                "@machine_id": machine_id.as_str(),
                "@place": place_value(place),
                "@canonical_root": canonical_root,
                "@common_dir": common_dir,
            },
            |row| {
                Ok(ActiveMount {
                    id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                    origin: text_column(row, 1, closed_word)?,
                    project_id: optional_text_column(row, 2, |text| ProjectId::new(&text))?,
                })
            },
        )
        .optional()?)
}

/// A stored machine id outside the id's length bounds.
#[derive(Debug, thiserror::Error)]
#[error("the stored machine id is outside its length bounds")]
pub(crate) struct StoredMachineIdInvalid;

pub(crate) mod detach;
#[cfg(test)]
mod tests;
