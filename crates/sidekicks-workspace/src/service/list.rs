//! A workspace's health as the list and the write gate read it: a ready workspace's root is probed
//! on each read, and one found gone moves to `rootLost` there, so both agree on its state.

use sidekicks_contracts::repo::mount::{RepoMountHealth, WorkspaceId, WorkspaceState};
use sidekicks_contracts::repo::workspace::{
    WORKSPACE_LAST_ERROR_MAX_LEN, WorkspaceListEntry, WorkspaceListRequest,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::{WorkspaceRow, WorkspaceService, WorkspaceServiceError, root_mismatch, wire_path};
use crate::errors::{
    WorkspaceRefusal, WorkspaceServiceInvariantError, WorkspaceServiceInvariantKind,
};
use crate::projector::{WorkspaceHealthRow, compute_workspace_health, is_probe_bearing};
use crate::row_guards::{probe_filesystem_path, read_last_error};

// A session's workspaces with their mounts' places, narrowed to one mount when one is named;
// `created_at, id`, since two binds can share an instant.
const LIST_WORKSPACES_SQL: &str = "SELECT workspace.id, workspace.session_id,
        workspace.repo_mount_id, workspace.execution_mode, workspace.fs_root, workspace.state,
        workspace.metadata, mount.place
   FROM workspaces AS workspace
   JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
  WHERE workspace.session_id = @session_id
    AND (@repo_mount_id IS NULL OR workspace.repo_mount_id = @repo_mount_id)
  ORDER BY workspace.created_at, workspace.id";

/// The `lastError` a probe that found a ready workspace's root gone records; it names no path.
const ROOT_UNREACHABLE_DETAIL: &str = "the workspace's working folder can no longer be reached";

impl WorkspaceService {
    /// A session's workspaces, narrowed to one mount when `request` names it, each read through
    /// its health: a ready one whose root is gone moves to `rootLost` and reads so. Refuses
    /// `session.notFound` for a session the directory does not hold. One row that cannot be read
    /// fails the whole list, since a shortened list would mislead what to detach; fails as the
    /// read, the probe's projection or the `rootLost` move fails.
    pub async fn list(
        &self,
        request: &WorkspaceListRequest,
    ) -> Result<Vec<WorkspaceListEntry>, WorkspaceServiceError> {
        let session_id = request.session_id;
        // An empty list would read as a session with no workspaces.
        if !self.session_exists(session_id).await? {
            return Err(session_not_found(&session_id).into());
        }
        let repo_mount_id = request
            .repo_mount_id
            .map(|repo_mount_id| repo_mount_id.text().as_str().to_owned());
        let rows = self
            .reads
            .read(ReadLength::Long, move |connection| {
                let mut statement = connection.prepare_cached(LIST_WORKSPACES_SQL)?;
                let rows = statement
                    .query_map(
                        rusqlite::named_params! {
                            "@session_id": session_id.text().as_str(),
                            "@repo_mount_id": repo_mount_id,
                        },
                        super::workspace_row,
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, WorkspaceServiceError>(rows)
            })
            .await?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            entries.push(self.list_entry(row).await?);
        }
        Ok(entries)
    }

    /// The write gate before a run: the workspace's root is probed first, a gone one moving it to
    /// `rootLost`. A `ready` workspace whose mount folder now holds another repository moves to
    /// `rootLost` with that recorded; one whose mount folder is out of reach is refused without a
    /// write. Refuses `workspace.notFound`, `workspace.rootUnavailable`, `repoMount.notFound` and
    /// `repoMount.rootResolutionFailed` when git cannot answer; fails with an illegal-transition
    /// invariant for a `preparing` or archived workspace. Holds nothing.
    pub(crate) async fn assert_writable(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<(), WorkspaceServiceError> {
        let row = self.require_workspace_row(workspace_id).await?;
        match self.observe_state(&row).await? {
            WorkspaceState::Ready => self.assert_mount_identity(&row).await,
            WorkspaceState::RootLost => Err(WorkspaceRefusal::RootUnavailable {
                workspace_id: Some(workspace_id),
            }
            .into()),
            state @ (WorkspaceState::Preparing | WorkspaceState::Archived) => {
                Err(WorkspaceServiceInvariantError {
                    message: format!(
                        "workspace \"{workspace_id}\" cannot take writes in state \"{}\"",
                        <&'static str>::from(state)
                    ),
                    kind: WorkspaceServiceInvariantKind::IllegalStateTransition,
                    workspace_id: Some(workspace_id),
                    source: None,
                }
                .into())
            }
        }
    }

    // The row as the wire lists it, read through its health.
    async fn list_entry(
        &self,
        row: WorkspaceRow,
    ) -> Result<WorkspaceListEntry, WorkspaceServiceError> {
        let state = self.observe_state(&row).await?;
        let unprojectable = |source: Box<dyn std::error::Error + Send + Sync>| {
            unprojectable_row(row.id, "its stored root or last error", source)
        };
        let fs_root = row
            .fs_root
            .as_deref()
            .map(wire_path)
            .transpose()
            .map_err(|error| unprojectable(Box::new(error)))?;
        // A `rootLost` move this read made is in the row now; read it back for its `lastError`.
        let metadata = if state == row.state {
            row.metadata.clone()
        } else {
            self.find_workspace_row(row.id)
                .await?
                .map_or_else(|| row.metadata.clone(), |current| current.metadata)
        };
        let last_error = read_last_error(&metadata)
            .map_err(|error| unprojectable(Box::new(error)))?
            .map(FreeFormText::<WORKSPACE_LAST_ERROR_MAX_LEN>::new)
            .transpose()
            .map_err(|error| unprojectable(Box::new(error)))?;
        Ok(WorkspaceListEntry {
            id: row.id,
            repo_mount_id: row.repo_mount_id,
            execution_mode: row.execution_mode,
            state,
            fs_root,
            last_error,
        })
    }

    // Probes a row whose state owes a probe, makes a derived `rootLost` move durable, and answers
    // the state to report: the one place the read floor is, so the list and the gate agree.
    async fn observe_state(
        &self,
        row: &WorkspaceRow,
    ) -> Result<WorkspaceState, WorkspaceServiceError> {
        // A missing root under a state that owes a probe reaches the projector with no probe,
        // which names that defect.
        let probe = match row.fs_root.as_deref() {
            Some(fs_root) if is_probe_bearing(row.state) => {
                Some(probe_filesystem_path(fs_root, row.place.as_ref()).await)
            }
            Some(_) | None => None,
        };
        let health_row = WorkspaceHealthRow {
            state: row.state,
            fs_root: row.fs_root.as_deref(),
            place: row.place.as_ref(),
        };
        let projection = compute_workspace_health(&health_row, probe.as_ref())
            .map_err(|error| unprojectable_row(row.id, "its health", Box::new(error)))?;
        if projection.is_root_lost_transition_required {
            self.mark_root_lost(row.id, ROOT_UNREACHABLE_DETAIL)
                .await
                .map_err(|error| root_lost_not_kept(row.id, error))?;
        }
        Ok(projection.observed_state)
    }

    // Refuses a run on a mount whose folder is out of reach (no move: it may come back) or holds
    // another repository than the one attached (moved to `rootLost`: only a re-attach repairs it).
    async fn assert_mount_identity(&self, row: &WorkspaceRow) -> Result<(), WorkspaceServiceError> {
        let mount = self.require_attached_mount(row.repo_mount_id).await?;
        match self.probe_mount_health(&mount).await? {
            RepoMountHealth::Healthy { .. } => Ok(()),
            RepoMountHealth::Unreachable { .. } => Err(WorkspaceRefusal::RootUnavailable {
                workspace_id: Some(row.id),
            }
            .into()),
            RepoMountHealth::IdentityMismatch { .. } => {
                self.mark_root_lost(row.id, &root_mismatch().to_string())
                    .await
                    .map_err(|error| root_lost_not_kept(row.id, error))?;
                Err(WorkspaceRefusal::RootUnavailable {
                    workspace_id: Some(row.id),
                }
                .into())
            }
        }
    }
}

// A row the wire shape cannot carry, naming what failed.
fn unprojectable_row(
    workspace_id: WorkspaceId,
    subject: &str,
    source: Box<dyn std::error::Error + Send + Sync>,
) -> WorkspaceServiceError {
    WorkspaceServiceInvariantError {
        message: format!(
            "workspace \"{workspace_id}\" could not be listed: {subject} is unreadable"
        ),
        kind: WorkspaceServiceInvariantKind::WorkspaceRowUnprojectable,
        workspace_id: Some(workspace_id),
        source: Some(source),
    }
    .into()
}

// A `rootLost` move the read derived and could not keep: the row is fine, the write is the defect,
// so a person is not sent to a healthy row.
fn root_lost_not_kept(
    workspace_id: WorkspaceId,
    error: WorkspaceServiceError,
) -> WorkspaceServiceError {
    WorkspaceServiceInvariantError {
        message: format!(
            "workspace \"{workspace_id}\" lost its root, but the move to rootLost was not kept"
        ),
        kind: WorkspaceServiceInvariantKind::RootLostTransitionDurabilityFailure,
        workspace_id: Some(workspace_id),
        source: Some(Box::new(error)),
    }
    .into()
}
