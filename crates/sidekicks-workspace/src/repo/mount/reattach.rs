//! The re-attach: the recovery for a mount whose folder holds another repository than the one
//! attached there. The old row turns `detached` and a new `attached` row takes its root under the
//! same project, anchored on the repository git finds there now; no detach cascade runs, so the
//! project, its sessions and the folder are untouched.
//!
//! - The refusals are decided before the write and tested again inside it, so a refusal writes
//!   nothing.
//! - Each workspace moves to the new mount keeping its id, mode and root. One with a root turns
//!   `preparing` in the same write, its root kept, so no run binds it before it is admitted again;
//!   events cannot share the mount write, so after the commit each is admitted again in place under
//!   its preparation hold, by this service or by a run's gate, whichever comes first. One whose
//!   root git does not list for the new repository turns `rootLost` with why, and one still in its
//!   first preparation has its bound folder admitted the same way.
//! - Each tree the daemon made moves to the new mount in the same write when the new repository
//!   lists its folder; any other is retired and stamped cleaned there, so its folder stays on disk
//!   as it is and no sweep removes it. Its `worktree.retired` follows the commit. A tree's kept
//!   copies stay on the old mount.

mod moved_workspace;
#[cfg(test)]
mod tests;
mod write;

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use notify::{RecommendedWatcher, Watcher};
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::folders::{
    RepoMountReattachResponse, RepoMountRequest, RepoMountRootResolutionReason,
};
use sidekicks_contracts::repo::mount::{RepoMountHealth, RepoMountId, WorkspaceId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::appender::{SessionEventEmitError, SessionEventLinkage};

use self::write::{
    DETACH_OLD_MOUNT_STATEMENT, IDENTITY_HOLDER_STATEMENT, RUNNING_RUN_STATEMENT, ReattachBindings,
    ReattachWritten, SELECT_IDENTITY_HOLDER_SQL, read_written, reattach_statements,
};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::execution_root::{ExecutionRootError, ExecutionRootService};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::worktree::event_emitter::{EmitWorktreeEventInput, WorktreeEventEmitter};
use crate::git::worktree::rows::LIVE_WORKTREE_STATE_PREDICATE;
use crate::projector::{HealthProjectionError, RepoMountHealthRow};
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::health::{
    MountHealthProbeError, MountHealthReadError, probe_repo_mount_health, read_sessions_on_mount,
};
use crate::repo::mount::service::detach::read_running_run;
use crate::repo::mount::service::new_repo_mount_id;
use crate::repo::root_resolver::RepoRootResolver;
use crate::service::{AttachedMount, WorkspaceService, WorkspaceServiceError, root_mismatch};

/// The statements the re-attach's reads keep prepared on each read connection: the running run,
/// the holder of the repository, the mount's live trees and the sessions on the new mount.
pub const REPO_MOUNT_REATTACH_SERVICE_STATEMENT_CAPACITY: usize = 4;

// What a log line names a failed follow-up's group as.
const FOLLOW_UP_OPERATION: &str = "a re-attach's follow-ups";

// The daemon's live trees on the old mount, whose folders the new repository's list is read for.
static SELECT_LIVE_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, fs_root FROM worktrees
  WHERE repo_mount_id = @repo_mount_id AND {}",
        *LIVE_WORKTREE_STATE_PREDICATE
    )
});

/// Why the agent of a running run could not be read; the implementation's own failure is the
/// cause.
#[derive(Debug, thiserror::Error)]
#[error("the agent of a run in the project could not be read")]
pub struct RunAgentLookupError(#[source] pub Box<dyn Error + Send + Sync>);

/// Where the re-attach reads the agent a running run is for, so its conflict can name who holds
/// the folder.
pub trait RunAgentLookup: Send + Sync {
    /// The agent `run_id` in `session_id` is for. Fails when the read fails or the session's log
    /// names none.
    fn read_run_agent<'a>(
        &'a self,
        session_id: &'a SessionId,
        run_id: &'a RunId,
    ) -> BoxFuture<'a, Result<AgentId, RunAgentLookupError>>;
}

/// One thing a committed re-attach owed after its write that did not happen.
#[derive(Debug, thiserror::Error)]
pub enum RepoMountReattachFollowUpFailure {
    /// A workspace or tree the write moved could not be read into its typed facts.
    #[error("a row the re-attach moved could not be read")]
    Rows(#[source] rusqlite::Error),
    /// A retired tree's `worktree.retired`, or a session's `repoMount.health.changed`, was not
    /// appended.
    #[error("an event the re-attach owed was not appended")]
    Announcement(#[source] SessionEventEmitError),
    /// A moved workspace could not be admitted again.
    #[error("workspace {workspace_id} could not be admitted again on the new mount")]
    MovedWorkspace {
        /// The workspace.
        workspace_id: WorkspaceId,
        /// Why.
        #[source]
        source: ExecutionRootError,
    },
    /// The new mount's health, or the sessions on it, could not be read.
    #[error("the new mount's health could not be read")]
    Health(#[source] Box<dyn Error + Send + Sync>),
}

/// Why a re-attach failed: a refusal the wire carries, a failure inside the daemon before the
/// write committed, or follow-ups a committed re-attach did not finish.
#[derive(Debug, thiserror::Error)]
pub enum RepoMountReattachError {
    /// The call was refused with its code; nothing was written.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The workspace service failed inside the daemon.
    #[error(transparent)]
    Workspace(WorkspaceServiceError),
    /// The mount's rows did not reach the database.
    #[error("the repo mount's rows did not reach the database")]
    Read(#[from] DatabaseReadError),
    /// A stored row could not be read into its typed facts.
    #[error("a repo mount, worktree or run row could not be read")]
    Row(#[from] rusqlite::Error),
    /// The re-attach's write was not kept.
    #[error("the re-attach's write was not kept")]
    Write(#[from] WriteError),
    /// The mount's health probe and its row did not belong together.
    #[error(transparent)]
    HealthProjection(#[from] HealthProjectionError),
    /// A tree's folder could not be resolved to compare it with the ones git lists.
    #[error("a worktree's folder could not be resolved to compare it with git's list")]
    Folder(#[source] io::Error),
    /// The agent of the run that holds the folder could not be read.
    #[error(transparent)]
    Agent(#[from] RunAgentLookupError),
    /// The re-attach committed, but something it owed after the write did not happen; the rows
    /// are the truth and a moved workspace is admitted again at its next run.
    #[error(
        "repo mount {replaced_repo_mount_id} was re-attached as {repo_mount_id}, but a follow-up \
         failed: a retired tree announced, a workspace admitted again or a session told the new \
         health"
    )]
    FollowUpIncomplete {
        /// The new mount.
        repo_mount_id: RepoMountId,
        /// The mount it replaced.
        replaced_repo_mount_id: RepoMountId,
        /// Every follow-up that failed, boxed to keep the error small.
        #[source]
        source: Box<SettleFailures<RepoMountReattachFollowUpFailure>>,
    },
}

impl From<RepoRefusal> for RepoMountReattachError {
    fn from(refusal: RepoRefusal) -> Self {
        Self::Refused(refusal.into())
    }
}

impl From<WorkspaceServiceError> for RepoMountReattachError {
    fn from(error: WorkspaceServiceError) -> Self {
        match error {
            WorkspaceServiceError::Refused(refusal) => Self::Refused(refusal),
            fault @ (WorkspaceServiceError::Invariant(_)
            | WorkspaceServiceError::Read(_)
            | WorkspaceServiceError::Row(_)
            | WorkspaceServiceError::HealthProjection(_)
            | WorkspaceServiceError::Append(_)) => Self::Workspace(fault),
        }
    }
}

impl From<RepoMountReattachError> for HandlerError {
    /// A refusal is answered with its code; every other failure, follow-ups a committed re-attach
    /// did not finish among them, is a fault, since no wire code names those.
    fn from(error: RepoMountReattachError) -> Self {
        match error {
            RepoMountReattachError::Refused(refusal) => Self::Refused(refusal),
            fault @ (RepoMountReattachError::Workspace(_)
            | RepoMountReattachError::Read(_)
            | RepoMountReattachError::Row(_)
            | RepoMountReattachError::Write(_)
            | RepoMountReattachError::HealthProjection(_)
            | RepoMountReattachError::Folder(_)
            | RepoMountReattachError::Agent(_)
            | RepoMountReattachError::FollowUpIncomplete { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}

/// What the re-attach runs with; `W` is the worktree setup card's file watch.
pub struct RepoMountReattachServiceDeps<W = RecommendedWatcher> {
    /// The writer the re-attach's one write goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool, sized with [`REPO_MOUNT_REATTACH_SERVICE_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The workspace lifecycle, through which a moved workspace is admitted again.
    pub workspaces: Arc<WorkspaceService>,
    /// The owner of every workspace's preparation hold.
    pub execution_roots: Arc<ExecutionRootService<W>>,
    /// Where a moved workspace's `workspace.preparing` and the new mount's health go.
    pub events: Arc<WorkspaceEventEmitter>,
    /// Where each tree the re-attach retired is announced, as a removal announces it.
    pub worktree_events: Arc<WorktreeEventEmitter>,
    /// Resolves the folder again exactly as attach resolves a path.
    pub resolver: RepoRootResolver,
    /// Reads the agent a running run is for.
    pub agents: Arc<dyn RunAgentLookup>,
}

/// Re-attaches a mount whose folder holds another repository now, keeping the project's sessions
/// and every workspace id. See the module doc.
pub struct RepoMountReattachService<W = RecommendedWatcher> {
    writer: Arc<DatabaseWriter>,
    reads: Arc<DatabaseReadPool>,
    workspaces: Arc<WorkspaceService>,
    execution_roots: Arc<ExecutionRootService<W>>,
    events: Arc<WorkspaceEventEmitter>,
    worktree_events: Arc<WorktreeEventEmitter>,
    resolver: RepoRootResolver,
    agents: Arc<dyn RunAgentLookup>,
    /// Where a test holds a re-attach between its checks and its write.
    #[cfg(test)]
    pub(crate) write_pause: PausePoint,
}

impl<W: Watcher + Send + 'static> RepoMountReattachService<W> {
    /// The service over `deps`.
    pub fn new(deps: RepoMountReattachServiceDeps<W>) -> Self {
        Self {
            writer: deps.writer,
            reads: deps.reads,
            workspaces: deps.workspaces,
            execution_roots: deps.execution_roots,
            events: deps.events,
            worktree_events: deps.worktree_events,
            resolver: deps.resolver,
            agents: deps.agents,
            #[cfg(test)]
            write_pause: PausePoint::default(),
        }
    }

    /// Re-attaches the mount at its root under the same project, answering the new mount.
    /// Refuses, writing nothing: `repoMount.notFound` for a mount that is not attached,
    /// `repoMount.managed` for a chat's managed workspace, `repoMount.reattachRefused` when the
    /// mount does not read `identityMismatch`, `repoMount.rootResolutionFailed` when the folder is
    /// no repository (`notARepository`), resolves to another root (`rootMismatch`) or git cannot
    /// answer for it, `repoMount.reattachConflict` naming the session and agent while an agent runs
    /// anywhere in the project, and `repoMount.alreadyAttached` when another attached mount holds
    /// the folder's repository. Fails with [`RepoMountReattachError::FollowUpIncomplete`] when it
    /// committed but an event or a moved workspace's admission did not follow.
    pub async fn reattach(
        &self,
        request: &RepoMountRequest,
    ) -> Result<RepoMountReattachResponse, RepoMountReattachError> {
        let repo_mount_id = request.repo_mount_id;
        let mount = self
            .workspaces
            .require_attached_mount(repo_mount_id)
            .await?;
        if mount.managed_session_id.is_some() {
            return Err(RepoRefusal::MountManaged { repo_mount_id }.into());
        }
        // A mount with no anchor has no identity to mismatch.
        let Some(old_anchor) = mount.common_folder_anchor.clone() else {
            return Err(RepoRefusal::ReattachRefused { repo_mount_id }.into());
        };
        match self.probe_health(&mount, &old_anchor).await? {
            RepoMountHealth::IdentityMismatch {
                is_repository: true,
                ..
            } => {}
            RepoMountHealth::IdentityMismatch {
                is_repository: false,
                ..
            } => {
                return Err(RepoRefusal::RootResolutionFailed {
                    reason: RepoMountRootResolutionReason::NotARepository,
                    detail: None,
                }
                .into());
            }
            RepoMountHealth::Healthy { .. } | RepoMountHealth::Unreachable { .. } => {
                return Err(RepoRefusal::ReattachRefused { repo_mount_id }.into());
            }
        }
        // Resolved exactly as attach resolves a path; the new row takes the old one's root.
        let resolution = self
            .resolver
            .resolve_canonical_root(&mount.canonical_root)
            .await?;
        if resolution.canonical_root != mount.canonical_root {
            return Err(root_mismatch().into());
        }

        let bindings = ReattachBindings {
            repo_mount_id,
            new_repo_mount_id: new_repo_mount_id(),
            old_common_dir: old_anchor.to_string_lossy().into_owned(),
            common_dir: resolution.common_folder.to_string_lossy().into_owned(),
            listed_worktree_ids: self.read_listed_worktree_ids(&mount).await?,
            now: WireInstant::now(),
        };
        self.refuse_running_run(repo_mount_id).await?;
        self.refuse_identity_holder(&bindings).await?;
        #[cfg(test)]
        self.write_pause.pass().await;

        let results = match self.writer.write(reattach_statements(&bindings)).await {
            Ok(results) => results,
            Err(error) => return Err(self.refusal_of_write(error, &bindings).await),
        };
        let new_repo_mount_id = bindings.new_repo_mount_id;
        let mut failures = Vec::new();
        let written = match read_written(&results) {
            Ok(written) => written,
            Err(unread) => {
                failures.push(RepoMountReattachFollowUpFailure::Rows(unread));
                ReattachWritten {
                    moved_workspaces: Vec::new(),
                    retired_worktrees: Vec::new(),
                    project_id: None,
                }
            }
        };
        tracing::info!(
            project_id = ?written.project_id,
            %new_repo_mount_id,
            replaced_repo_mount_id = %repo_mount_id,
            "repo.attached"
        );

        // The re-attach is committed: every follow-up is tried, and the failures answered together.
        for (worktree_id, session_id) in written.retired_worktrees {
            let retired = self
                .worktree_events
                .emit_worktree_retired(
                    // The tree's own session, as a removal's event names it.
                    EmitWorktreeEventInput {
                        session_id,
                        worktree_id,
                        repo_mount_id: Some(repo_mount_id),
                        workspace_id: None,
                        actor: None,
                    },
                    None,
                    SessionEventLinkage::default(),
                )
                .await;
            if let Err(failure) = retired {
                failures.push(RepoMountReattachFollowUpFailure::Announcement(failure));
            }
        }
        for workspace_id in written.moved_workspaces {
            let hold = self.execution_roots.hold_preparation(workspace_id).await;
            if let Err(source) = self.prepare_moved_workspace_held(&hold).await {
                failures.push(RepoMountReattachFollowUpFailure::MovedWorkspace {
                    workspace_id,
                    source,
                });
            }
        }
        let new_mount = AttachedMount {
            id: new_repo_mount_id,
            common_folder_anchor: Some(resolution.common_folder.clone()),
            ..mount
        };
        failures.extend(
            self.announce_health(&new_mount, &resolution.common_folder)
                .await,
        );

        let outcomes: Vec<Result<(), RepoMountReattachFollowUpFailure>> =
            failures.into_iter().map(Err).collect();
        settle_all(outcomes, FOLLOW_UP_OPERATION).map_err(|source| {
            RepoMountReattachError::FollowUpIncomplete {
                repo_mount_id: new_repo_mount_id,
                replaced_repo_mount_id: repo_mount_id,
                source: Box::new(source),
            }
        })?;
        Ok(RepoMountReattachResponse {
            repo_mount_id: new_repo_mount_id,
        })
    }

    // The mount's health now, read against `anchor`; git that cannot answer refuses as the
    // resolver refused.
    async fn probe_health(
        &self,
        mount: &AttachedMount,
        anchor: &Path,
    ) -> Result<RepoMountHealth, RepoMountReattachError> {
        let health_row = RepoMountHealthRow {
            canonical_root: &mount.canonical_root,
            place: mount.place.as_ref(),
            common_dir_anchor: Some(anchor),
        };
        match probe_repo_mount_health(&self.resolver, &health_row).await {
            Ok(health) => Ok(health),
            Err(MountHealthProbeError::GitUnanswered(refusal)) => Err(refusal.into()),
            Err(MountHealthProbeError::Projection(error)) => Err(error.into()),
        }
    }

    // The ids of the daemon's live trees on the mount whose folders git lists for the repository
    // there now, as the JSON array the move binds.
    async fn read_listed_worktree_ids(
        &self,
        mount: &AttachedMount,
    ) -> Result<String, RepoMountReattachError> {
        let mut listed = HashSet::new();
        for root in self
            .resolver
            .list_working_trees(&mount.canonical_root)
            .await?
        {
            listed.insert(
                canonical_folder_path(&root)
                    .await
                    .map_err(RepoMountReattachError::Folder)?,
            );
        }
        let repo_mount_id = mount.id;
        let live = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_live_worktrees(connection, repo_mount_id)
            })
            .await?;
        let mut listed_ids = Vec::new();
        for (worktree_id, fs_root) in live {
            let folder = canonical_folder_path(&fs_root)
                .await
                .map_err(RepoMountReattachError::Folder)?;
            if listed.contains(&folder) {
                listed_ids.push(worktree_id.text().as_str().to_owned());
            }
        }
        Ok(serde_json::Value::from(listed_ids).to_string())
    }

    // Refuses `reattachConflict` naming the session and agent of the oldest run in the project.
    async fn refuse_running_run(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<(), RepoMountReattachError> {
        let running = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_running_run(connection, repo_mount_id).map_err(RepoMountReattachError::from)
            })
            .await?;
        let Some(running) = running else {
            return Ok(());
        };
        let running_agent_id = self
            .agents
            .read_run_agent(&running.session_id, &running.run_id)
            .await?;
        Err(RepoRefusal::ReattachConflict {
            running_session_id: running.session_id,
            running_agent_id,
        }
        .into())
    }

    // Refuses `alreadyAttached` naming another attached mount of the folder's repository.
    async fn refuse_identity_holder(
        &self,
        bindings: &ReattachBindings,
    ) -> Result<(), RepoMountReattachError> {
        let repo_mount_id = bindings.repo_mount_id;
        let common_dir = bindings.common_dir.clone();
        let holder = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_identity_holder(connection, repo_mount_id, &common_dir)
            })
            .await?;
        match holder {
            Some((conflicting_repo_mount_id, conflicting_project_id)) => {
                Err(RepoRefusal::AlreadyAttached {
                    conflicting_repo_mount_id,
                    conflicting_project_id,
                }
                .into())
            }
            None => Ok(()),
        }
    }

    // A refused write as the refusal its test stands for, read again now; the write kept nothing.
    // A refusal whose cause is gone by the read, or any other failure, is the write's own.
    async fn refusal_of_write(
        &self,
        error: WriteError,
        bindings: &ReattachBindings,
    ) -> RepoMountReattachError {
        let refusal = match error.refused_statement_index() {
            Some(RUNNING_RUN_STATEMENT) => self.refuse_running_run(bindings.repo_mount_id).await,
            Some(IDENTITY_HOLDER_STATEMENT) => self.refuse_identity_holder(bindings).await,
            // A detach or re-attach moved the mount since it was read.
            Some(DETACH_OLD_MOUNT_STATEMENT) => self
                .workspaces
                .require_attached_mount(bindings.repo_mount_id)
                .await
                .map(drop)
                .map_err(RepoMountReattachError::from),
            Some(_) | None => Ok(()),
        };
        match refusal {
            Err(refusal) => refusal,
            Ok(()) => error.into(),
        }
    }

    // Sends the new mount's verdict to every session on it, which takes the mismatch banner away;
    // answers each failure.
    async fn announce_health(
        &self,
        mount: &AttachedMount,
        anchor: &Path,
    ) -> Vec<RepoMountReattachFollowUpFailure> {
        let health = match self.probe_health(mount, anchor).await {
            Ok(health) => health,
            Err(failure) => {
                return vec![RepoMountReattachFollowUpFailure::Health(Box::new(failure))];
            }
        };
        let repo_mount_id = mount.id;
        let sessions: Result<_, MountHealthReadError> = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_sessions_on_mount(connection, repo_mount_id)
            })
            .await;
        let sessions = match sessions {
            Ok(sessions) => sessions,
            Err(failure) => {
                return vec![RepoMountReattachFollowUpFailure::Health(Box::new(failure))];
            }
        };
        let mut failures = Vec::new();
        for session_id in sessions {
            if let Err(failure) = self
                .events
                .emit_mount_health_changed(
                    session_id,
                    repo_mount_id,
                    health.clone(),
                    SessionEventLinkage::default(),
                )
                .await
            {
                failures.push(RepoMountReattachFollowUpFailure::Announcement(failure));
            }
        }
        failures
    }
}

fn read_live_worktrees(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Vec<(WorktreeId, PathBuf)>, RepoMountReattachError> {
    Ok(connection
        .prepare_cached(&SELECT_LIVE_WORKTREES_SQL)?
        .query_map(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| {
                Ok((
                    text_column(row, 0, |text| WorktreeId::new(&text))?,
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}

fn read_identity_holder(
    connection: &Connection,
    repo_mount_id: RepoMountId,
    common_dir: &str,
) -> Result<Option<(RepoMountId, Option<ProjectId>)>, RepoMountReattachError> {
    Ok(connection
        .prepare_cached(&SELECT_IDENTITY_HOLDER_SQL)?
        .query_row(
            named_params! {
                "@repo_mount_id": repo_mount_id.text().as_str(),
                "@common_dir": common_dir,
            },
            |row| {
                Ok((
                    text_column(row, 0, |text| RepoMountId::new(&text))?,
                    sidekicks_store::database::stored_column::optional_text_column(
                        row,
                        1,
                        |text| ProjectId::new(&text),
                    )?,
                ))
            },
        )
        .optional()?)
}
