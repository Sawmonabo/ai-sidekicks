//! The workspace service: the one owner of the `workspaces` table's lifecycle. A bind lands a
//! session's workspace on an attached mount; the list reads each workspace's health, moving a
//! ready one whose root is gone to `rootLost`; the write gate refuses a run a workspace cannot
//! take; and the preparation bracket's rows move a workspace through `preparing` to `ready` or
//! `rootLost`.
//!
//! - Every transition writes its row in its event's prelude, so the row and the event commit
//!   together; each is a compare-and-swap expecting one row, so a row that moved refuses the write,
//!   event and all.
//! - `fs_root` is an approval's scope: a bind and a preparation's begin write `NULL`, and only a
//!   completed preparation writes a path.
//! - A bind records the folder it admitted (`boundRoot`, never cleared, rewritten by a move into
//!   another tree) and that folder's checkout (`checkoutRoot`, rewritten by every completed
//!   preparation).
//! - No workspace is held for a run: two sessions' runs may work in one folder at once.
//!
//! The writes that share another row's write are not here: a detach's archive and a managed
//! mount's deletion, a re-attach's move to the new mount, and a session purge's delete.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::folders::RepoMountRootResolutionReason;
use sidekicks_contracts::repo::mount::{
    ExecutionMode, RepoMountHealth, RepoMountId, RepoMountState, WorkspaceId, WorkspaceState,
};
use sidekicks_contracts::repo::workspace::{WorkspaceBindRequest, WorkspaceBindResponse};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::schema::session_directory::read_session_state_through;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::session::appender::{SessionEventEmitError, SessionEventLinkage};

use crate::errors::{WorkspaceRefusal, WorkspaceServiceInvariantError};
use crate::event_emitter::{EmitWorkspaceEventInput, WorkspaceEventEmitter};
use crate::git::worktree::rows::LIVE_WORKTREE_STATE_PREDICATE;
use crate::projector::{HealthProjectionError, RepoMountHealthRow};
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::health::{MountHealthProbeError, probe_repo_mount_health};
use crate::repo::root_resolver::RepoRootResolver;
use crate::row_guards::{
    BOUND_ROOT_METADATA_PATH, CHECKOUT_ROOT_METADATA_PATH, COMMON_DIR_METADATA_PATH,
    assert_mode_offered, expect_single_row_changed,
};
use crate::trust_envelope::{
    AdmittedExecutionRoot, WorkspaceExecutionRootCandidate, validate_execution_root,
};

mod list;
pub(crate) mod preparation;
#[cfg(test)]
mod tests;

/// The statements the service's reads keep prepared on each read connection, the session state
/// read included.
pub const WORKSPACE_SERVICE_STATEMENT_CAPACITY: usize = 7;

// A session's live workspace on one mount; `idx_workspaces_live_session_mount` holds it to one row,
// and an archived workspace is history that does not count.
static LIVE_WORKSPACE_OF_SESSION_ON_MOUNT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "session_id = @session_id AND repo_mount_id = @repo_mount_id AND state <> '{}'",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

static SELECT_LIVE_WORKSPACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, execution_mode, state FROM workspaces WHERE {}",
        *LIVE_WORKSPACE_OF_SESSION_ON_MOUNT
    )
});

// `SELECT … FROM repo_mounts` rather than `VALUES` re-tests inside the write that the mount is
// still attached, that the session still exists and that no other bind gave it a live workspace on
// the mount since the reads: zero rows refuses the write and takes `workspace.preparing` with it.
static BIND_WORKSPACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO workspaces (
    id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, created_at,
    updated_at
  )
  SELECT @id, @session_id, @repo_mount_id, @execution_mode, NULL, '{preparing}',
         json_set('{{}}', '{BOUND_ROOT_METADATA_PATH}', @bound_root,
                          '{CHECKOUT_ROOT_METADATA_PATH}', @checkout_root),
         @now, @now
    FROM repo_mounts
   WHERE id = @repo_mount_id AND state = '{attached}'
     AND EXISTS (SELECT 1 FROM sessions WHERE id = @session_id)
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE {live})",
        preparing = <&'static str>::from(WorkspaceState::Preparing),
        attached = <&'static str>::from(RepoMountState::Attached),
        live = *LIVE_WORKSPACE_OF_SESSION_ON_MOUNT,
    )
});

// Attached only: a detached mount is no bind target, and `repoMount.notFound` says so.
static SELECT_ATTACHED_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, local_path, canonical_root, place, managed_session_id,
        json_extract(metadata, '{COMMON_DIR_METADATA_PATH}')
   FROM repo_mounts
  WHERE id = @repo_mount_id AND state = '{}'",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// The trust envelope's attached roots: the canonical root of every attached mount.
static SELECT_ATTACHED_MOUNT_ROOTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT canonical_root FROM repo_mounts WHERE state = '{}' ORDER BY canonical_root",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// The trees the daemon made for a mount and keeps on disk, admitted by provenance.
static SELECT_LIVE_WORKTREE_ROOTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT fs_root FROM worktrees
  WHERE repo_mount_id = @repo_mount_id AND {}
  ORDER BY fs_root",
        *LIVE_WORKTREE_STATE_PREDICATE
    )
});

// A workspace with the place of its mount, where its root is.
const SELECT_WORKSPACE_SQL: &str = "SELECT workspace.id, workspace.session_id,
        workspace.repo_mount_id, workspace.execution_mode, workspace.fs_root, workspace.state,
        workspace.metadata, mount.place
   FROM workspaces AS workspace
   JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
  WHERE workspace.id = @workspace_id";

/// Why a workspace call failed: a refusal the wire carries, or a failure inside the daemon.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceServiceError {
    /// The call was refused with its code; nothing was written.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A row or a transition broke what the workspace lifecycle holds; no wire code names it.
    #[error(transparent)]
    Invariant(#[from] WorkspaceServiceInvariantError),
    /// The database could not be read.
    #[error("the workspace tables could not be read")]
    Read(#[from] DatabaseReadError),
    /// A stored row could not be read into its typed facts.
    #[error("a workspace or repo mount row could not be read")]
    Row(#[from] rusqlite::Error),
    /// A mount's health probe and its row did not belong together.
    #[error(transparent)]
    HealthProjection(#[from] HealthProjectionError),
    /// The event and the row it carries were not kept.
    #[error("a workspace event was not appended")]
    Append(#[source] SessionEventEmitError),
}

impl From<WorkspaceRefusal> for WorkspaceServiceError {
    fn from(refusal: WorkspaceRefusal) -> Self {
        Self::Refused(refusal.into())
    }
}

impl From<RepoRefusal> for WorkspaceServiceError {
    fn from(refusal: RepoRefusal) -> Self {
        Self::Refused(refusal.into())
    }
}

impl From<WorkspaceServiceError> for HandlerError {
    /// A refusal is answered with its code; every other failure is a fault.
    fn from(error: WorkspaceServiceError) -> Self {
        match error {
            WorkspaceServiceError::Refused(refusal) => Self::Refused(refusal),
            fault @ (WorkspaceServiceError::Invariant(_)
            | WorkspaceServiceError::Read(_)
            | WorkspaceServiceError::Row(_)
            | WorkspaceServiceError::HealthProjection(_)
            | WorkspaceServiceError::Append(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// What the workspace service is built from.
pub struct WorkspaceServiceDeps {
    /// The read pool, sized with [`WORKSPACE_SERVICE_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The one seam every workspace event is appended through, each write riding in its event's
    /// prelude.
    pub events: Arc<WorkspaceEventEmitter>,
    /// Asks git for a mount's identity and the working trees the trust envelope admits.
    pub resolver: RepoRootResolver,
}

/// Owns every workspace lifecycle transition and the `workspaces` writes that share no other row's
/// write; each transition's legal predecessor states sit in its `UPDATE`'s `WHERE`.
pub struct WorkspaceService {
    reads: Arc<DatabaseReadPool>,
    events: Arc<WorkspaceEventEmitter>,
    resolver: RepoRootResolver,
    /// Where a test holds a `rootLost` move between its row read and its write.
    #[cfg(test)]
    pub(crate) root_lost_pause: PausePoint,
}

/// A workspace row with the place of its mount.
#[derive(Clone, Debug)]
pub(crate) struct WorkspaceRow {
    /// The workspace.
    pub(crate) id: WorkspaceId,
    /// The session whose log takes its events.
    pub(crate) session_id: SessionId,
    /// Its mount.
    pub(crate) repo_mount_id: RepoMountId,
    /// Its mode.
    pub(crate) execution_mode: ExecutionMode,
    /// Its execution root, `None` while it is being made.
    pub(crate) fs_root: Option<PathBuf>,
    /// Its state as stored.
    pub(crate) state: WorkspaceState,
    /// Its `metadata` JSON object.
    pub(crate) metadata: String,
    /// Its mount's place; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
}

/// An attached mount's facts a bind and the write gate read.
#[derive(Clone, Debug)]
pub(crate) struct AttachedMount {
    /// The mount.
    pub(crate) id: RepoMountId,
    /// The path as entered at attach, where a bind naming no folder roots.
    pub(crate) local_path: PathBuf,
    /// The resolved root, as stored.
    pub(crate) canonical_root: PathBuf,
    /// Where the root is; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// The chat whose managed workspace the mount is, `None` for a project's mount.
    pub(crate) managed_session_id: Option<SessionId>,
    /// The git common folder recorded at attach; `None` on a managed mount.
    pub(crate) common_folder_anchor: Option<PathBuf>,
}

impl WorkspaceService {
    /// The service over `deps`.
    pub fn new(deps: WorkspaceServiceDeps) -> Self {
        Self {
            reads: deps.reads,
            events: deps.events,
            resolver: deps.resolver,
            #[cfg(test)]
            root_lost_pause: PausePoint::default(),
        }
    }

    /// Binds `request`'s session to an attached mount: the workspace lands `preparing` with no
    /// root, recording the folder admitted and its checkout. A session that already has a live
    /// workspace on the mount is answered that workspace as it stands, whatever mode and state,
    /// and nothing is probed or written. Refuses `session.notFound`, `repoMount.notFound` for a
    /// mount not attached, `repoMount.managed` for another chat's managed workspace,
    /// `workspace.modeUnsupported`, `workspace.rootUnavailable` when the mount's folder is out of
    /// reach, `repoMount.rootResolutionFailed` when it holds another repository or git cannot
    /// answer, and `repoMount.outsideTrustEnvelope` for a folder outside the mount's trees.
    pub async fn bind(
        &self,
        request: &WorkspaceBindRequest,
    ) -> Result<WorkspaceBindResponse, WorkspaceServiceError> {
        let session_id = request.session_id;
        let repo_mount_id = request.repo_mount_id;
        if !self.session_exists(session_id).await? {
            return Err(session_not_found(&session_id).into());
        }
        if let Some(bound) = self.read_live_workspace(session_id, repo_mount_id).await? {
            return Ok(bound);
        }
        let mount = self.require_attached_mount(repo_mount_id).await?;
        // A managed mount is its own chat's folder alone; its owner never changes, so the read
        // decides.
        if mount
            .managed_session_id
            .is_some_and(|owner| owner != session_id)
        {
            return Err(RepoRefusal::MountManaged { repo_mount_id }.into());
        }
        assert_mode_offered(request.execution_mode, mount.managed_session_id.is_some())?;

        // A bind that names no folder roots at the working tree the person attached, never at the
        // repository's main checkout.
        let named_folder = request
            .directory
            .as_ref()
            .map(|directory| Path::new(directory.as_str()))
            .filter(|directory| !directory.as_os_str().is_empty());
        let admitted = self
            .admit_on_healthy_mount(&mount, named_folder.unwrap_or(&mount.local_path), None)
            .await?;
        let bound_root = if named_folder.is_some() {
            &admitted.execution_root
        } else {
            &admitted.checkout_root
        };

        let workspace_id = new_workspace_id();
        let insert = WriteStatement {
            sql: Cow::Borrowed(BIND_WORKSPACE_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", workspace_id.text().as_str()),
                text_binding("@session_id", session_id.text().as_str()),
                text_binding("@repo_mount_id", repo_mount_id.text().as_str()),
                text_binding(
                    "@execution_mode",
                    <&'static str>::from(request.execution_mode),
                ),
                text_binding("@bound_root", &bound_root.to_string_lossy()),
                text_binding("@checkout_root", &admitted.checkout_root.to_string_lossy()),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        // The birth event names the mount, the one place a transcript reader learns which mount
        // the workspace is on.
        let appended = self
            .events
            .emit_workspace_preparing(
                EmitWorkspaceEventInput {
                    session_id,
                    workspace_id,
                    repo_mount_id: Some(repo_mount_id),
                    actor: None,
                },
                prelude(insert),
                None,
            )
            .await;
        if appended
            .as_ref()
            .is_err_and(|error| error.refused_statement_index().is_some())
        {
            // A bind of this session to this mount that committed since the reads is the answer;
            // a session purged since is refused; else the mount left `attached` and the move
            // refusal below stands.
            if let Some(bound) = self.read_live_workspace(session_id, repo_mount_id).await? {
                return Ok(bound);
            }
            if !self.session_exists(session_id).await? {
                return Err(session_not_found(&session_id).into());
            }
        }
        expect_single_row_changed(appended, workspace_id, "bind", "its repo mount")?;
        Ok(WorkspaceBindResponse {
            workspace_id,
            execution_mode: request.execution_mode,
            state: WorkspaceState::Preparing,
        })
    }

    /// Admits `folder` for a move of the workspace into another tree, as a bind admits its pick.
    /// Refuses `workspace.notFound`, `repoMount.notFound` for a mount no longer attached,
    /// `workspace.rootUnavailable` when the mount's folder is out of reach,
    /// `repoMount.rootResolutionFailed` when it holds another repository, and
    /// `repoMount.outsideTrustEnvelope` for a folder outside the mount's trees.
    pub(crate) async fn admit_folder(
        &self,
        workspace_id: WorkspaceId,
        folder: &Path,
    ) -> Result<AdmittedExecutionRoot, WorkspaceServiceError> {
        let row = self.require_workspace_row(workspace_id).await?;
        let mount = self.require_attached_mount(row.repo_mount_id).await?;
        self.admit_on_healthy_mount(&mount, folder, Some(workspace_id))
            .await
    }

    /// Refuses, writing nothing, a workspace whose mount is not attached (`repoMount.notFound`),
    /// whose mount folder is out of reach (`workspace.rootUnavailable`), or whose mount folder
    /// holds another repository than the one attached there (`repoMount.rootResolutionFailed`,
    /// `rootMismatch`); `workspace.notFound` for no such workspace.
    pub(crate) async fn assert_mount_healthy(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<(), WorkspaceServiceError> {
        let row = self.require_workspace_row(workspace_id).await?;
        let mount = self.require_attached_mount(row.repo_mount_id).await?;
        self.refuse_unhealthy_mount(&mount, Some(workspace_id))
            .await
    }

    // The picked folder admitted on a mount that is reachable and still holds its repository.
    // Reachability comes first: the envelope resolves its candidate, which fails on a vanished
    // root and would refuse `outsideTrustEnvelope` where `rootUnavailable` is the truth.
    async fn admit_on_healthy_mount(
        &self,
        mount: &AttachedMount,
        folder: &Path,
        workspace_id: Option<WorkspaceId>,
    ) -> Result<AdmittedExecutionRoot, WorkspaceServiceError> {
        self.refuse_unhealthy_mount(mount, workspace_id).await?;
        let (attached_mount_roots, provenance_roots) = self.read_envelope_roots(mount).await?;
        Ok(validate_execution_root(
            &self.resolver,
            WorkspaceExecutionRootCandidate {
                mount_canonical_root: &mount.canonical_root,
                directory: Some(folder),
                attached_mount_roots: &attached_mount_roots,
                provenance_roots: &provenance_roots,
            },
        )
        .await?)
    }

    // Refuses a mount whose folder is out of reach (`rootUnavailable`, naming the workspace when
    // there is one) or holds another repository (`rootMismatch`).
    async fn refuse_unhealthy_mount(
        &self,
        mount: &AttachedMount,
        workspace_id: Option<WorkspaceId>,
    ) -> Result<(), WorkspaceServiceError> {
        match self.probe_mount_health(mount).await? {
            RepoMountHealth::Healthy { .. } => Ok(()),
            RepoMountHealth::Unreachable { .. } => {
                Err(WorkspaceRefusal::RootUnavailable { workspace_id }.into())
            }
            RepoMountHealth::IdentityMismatch { .. } => Err(root_mismatch().into()),
        }
    }

    // The mount's health now; git that cannot answer refuses as the resolver refused.
    async fn probe_mount_health(
        &self,
        mount: &AttachedMount,
    ) -> Result<RepoMountHealth, WorkspaceServiceError> {
        let health_row = RepoMountHealthRow {
            canonical_root: &mount.canonical_root,
            place: mount.place.as_ref(),
            common_dir_anchor: mount.common_folder_anchor.as_deref(),
        };
        match probe_repo_mount_health(&self.resolver, &health_row).await {
            Ok(health) => Ok(health),
            Err(MountHealthProbeError::GitUnanswered(refusal)) => Err(refusal.into()),
            Err(MountHealthProbeError::Projection(error)) => Err(error.into()),
        }
    }

    // Every attached mount's root, and the roots the mount itself admits by provenance: a managed
    // mount's folder is the daemon's own, a project's the trees the daemon made for it.
    async fn read_envelope_roots(
        &self,
        mount: &AttachedMount,
    ) -> Result<(Vec<PathBuf>, Vec<PathBuf>), WorkspaceServiceError> {
        let managed_root = mount
            .managed_session_id
            .map(|_| mount.canonical_root.clone());
        let repo_mount_id = mount.id;
        self.reads
            .read(ReadLength::Short, move |connection| {
                let attached = read_paths(connection, &SELECT_ATTACHED_MOUNT_ROOTS_SQL, &[])?;
                let provenance = match managed_root {
                    Some(managed_root) => vec![managed_root],
                    None => read_paths(
                        connection,
                        &SELECT_LIVE_WORKTREE_ROOTS_SQL,
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                    )?,
                };
                Ok((attached, provenance))
            })
            .await
    }

    // Whether the directory holds the session.
    async fn session_exists(&self, session_id: SessionId) -> Result<bool, WorkspaceServiceError> {
        Ok(
            read_session_state_through::<WorkspaceServiceError>(&self.reads, session_id)
                .await?
                .is_some(),
        )
    }

    // The session's live workspace on the mount as stored, `None` when it has none.
    async fn read_live_workspace(
        &self,
        session_id: SessionId,
        repo_mount_id: RepoMountId,
    ) -> Result<Option<WorkspaceBindResponse>, WorkspaceServiceError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_LIVE_WORKSPACE_SQL)?
                    .query_row(
                        named_params! {
                            "@session_id": session_id.text().as_str(),
                            "@repo_mount_id": repo_mount_id.text().as_str(),
                        },
                        |row| {
                            Ok(WorkspaceBindResponse {
                                workspace_id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                                execution_mode: text_column(row, 1, closed_word)?,
                                state: text_column(row, 2, closed_word)?,
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    /// The attached mount `repo_mount_id`. Refuses `repoMount.notFound` for a mount that does not
    /// exist or is not attached; fails as the read fails.
    pub(crate) async fn require_attached_mount(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<AttachedMount, WorkspaceServiceError> {
        let mount = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_attached_mount(connection, repo_mount_id)
            })
            .await?;
        mount.ok_or_else(|| RepoRefusal::MountNotFound { repo_mount_id }.into())
    }

    /// The workspace `workspace_id` with its mount's place, `None` when it does not exist. Fails as
    /// the read fails.
    pub(crate) async fn find_workspace_row(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Option<WorkspaceRow>, WorkspaceServiceError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_WORKSPACE_SQL)?
                    .query_row(
                        named_params! { "@workspace_id": workspace_id.text().as_str() },
                        workspace_row,
                    )
                    .optional()?)
            })
            .await
    }

    /// [`WorkspaceService::find_workspace_row`], refusing `workspace.notFound` for none.
    pub(crate) async fn require_workspace_row(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceRow, WorkspaceServiceError> {
        self.find_workspace_row(workspace_id)
            .await?
            .ok_or_else(|| WorkspaceRefusal::NotFound { workspace_id }.into())
    }
}

/// The linkage of an event whose one prelude statement writes its row.
pub(crate) fn prelude(statement: WriteStatement) -> SessionEventLinkage {
    SessionEventLinkage {
        transactional_prelude: vec![statement],
        ..SessionEventLinkage::default()
    }
}

/// The refusal of a mount whose folder holds another repository than the one attached there.
pub(crate) fn root_mismatch() -> RepoRefusal {
    RepoRefusal::RootResolutionFailed {
        reason: RepoMountRootResolutionReason::RootMismatch,
        detail: None,
    }
}

/// One workspace row, read by the columns [`SELECT_WORKSPACE_SQL`] selects, in its order.
pub(crate) fn workspace_row(row: &Row<'_>) -> rusqlite::Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        repo_mount_id: text_column(row, 2, |text| RepoMountId::new(&text))?,
        execution_mode: text_column(row, 3, closed_word)?,
        fs_root: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
        state: text_column(row, 5, closed_word)?,
        metadata: row.get(6)?,
        // The column holds the place's wire JSON.
        place: optional_text_column(row, 7, |text| serde_json::from_str::<Place>(&text))?,
    })
}

fn new_workspace_id() -> WorkspaceId {
    WorkspaceId::try_from(mint_uuid_v7()).expect("a minted UUID is a workspace id")
}

fn read_attached_mount(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Option<AttachedMount>, WorkspaceServiceError> {
    Ok(connection
        .prepare_cached(&SELECT_ATTACHED_MOUNT_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| {
                Ok(AttachedMount {
                    id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                    local_path: PathBuf::from(row.get::<_, String>(1)?),
                    canonical_root: PathBuf::from(row.get::<_, String>(2)?),
                    place: optional_text_column(row, 3, |text| {
                        serde_json::from_str::<Place>(&text)
                    })?,
                    managed_session_id: optional_text_column(row, 4, |text| SessionId::new(&text))?,
                    common_folder_anchor: row.get::<_, Option<String>>(5)?.map(PathBuf::from),
                })
            },
        )
        .optional()?)
}

// The one path column a read selects, row by row.
fn read_paths(
    connection: &Connection,
    sql: &str,
    params: &[(&str, &dyn rusqlite::ToSql)],
) -> rusqlite::Result<Vec<PathBuf>> {
    connection
        .prepare_cached(sql)?
        .query_map(params, |row| row.get::<_, String>(0).map(PathBuf::from))?
        .collect()
}

/// A stored root as the wire carries it; a root past the wire's cap fails with [`TextError`].
pub(crate) fn wire_path(path: &Path) -> Result<FilesystemPath, TextError> {
    FilesystemPath::new(path.to_string_lossy().into_owned())
}
