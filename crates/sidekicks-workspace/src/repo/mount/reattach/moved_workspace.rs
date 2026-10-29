//! A moved workspace admitted again on its new mount: the root it kept, its bound folder after a
//! lost root, or the bound folder of its first preparation, each checked as a bind checks its pick.

use std::path::{Path, PathBuf};

use notify::Watcher;
use serde_json::Value;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_store::database::stored_column::parse_stored_json_object;
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::RepoMountReattachService;
use crate::errors::{WorkspaceServiceInvariantError, WorkspaceServiceInvariantKind};
use crate::event_emitter::EmitWorkspaceEventInput;
use crate::execution_root::{ExecutionRootError, WorkspacePreparationHold, last_error_detail};
use crate::row_guards::BOUND_ROOT_METADATA_PATH;
use crate::service::preparation::CompletedRootPreparation;
use crate::service::{WorkspaceRow, WorkspaceServiceError};

// What a log line names the failed recording beside a failed admission as.
const ADMISSION_OPERATION: &str = "a moved workspace's admission";

// The member name under the path's `$.`, so the key and its path are one fact.
const BOUND_ROOT_METADATA_KEY: &str = BOUND_ROOT_METADATA_PATH.split_at(2).1;

/// Whether an admitted root finishes the workspace's preparation, or leaves its first preparation
/// to run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Admission {
    /// The root becomes the workspace's root, `ready`.
    Completing,
    /// The bound folder is only checked; the first preparation makes the root later.
    FirstPreparation,
}

impl<W: Watcher + Send + 'static> RepoMountReattachService<W> {
    /// Admits the held workspace again on the mount a re-attach moved it to: one left `preparing`
    /// with its root kept turns `ready` there, or `rootLost` with why when the new repository does
    /// not hold that root; a `rootLost` `boundRoot` one with only its bound folder is prepared from
    /// that folder; one still in its first preparation has its bound folder checked, turning
    /// `rootLost` when it is refused. Any other workspace, or none, is left as it is. A refused
    /// folder is recorded and answers `Ok`; any other failure once the root was dropped is
    /// recorded too and answers [`ExecutionRootError::Preparation`].
    pub(crate) async fn prepare_moved_workspace_held(
        &self,
        hold: &WorkspacePreparationHold<'_>,
    ) -> Result<(), ExecutionRootError> {
        let Some(workspace) = self
            .workspaces
            .find_workspace_row(hold.workspace_id())
            .await?
        else {
            return Ok(());
        };
        let bound_root = read_bound_root(&workspace)?;
        match (workspace.state, workspace.fs_root.clone(), bound_root) {
            (WorkspaceState::Preparing, Some(root), _) => {
                // The mount write moved the row to `preparing`; an event could not share it.
                self.events
                    .emit_workspace_preparing(
                        EmitWorkspaceEventInput {
                            session_id: workspace.session_id,
                            workspace_id: workspace.id,
                            repo_mount_id: Some(workspace.repo_mount_id),
                            actor: None,
                        },
                        SessionEventLinkage::default(),
                    )
                    .await
                    .map_err(WorkspaceServiceError::Append)?;
                self.admit_root(&workspace, &root, Admission::Completing)
                    .await
            }
            (WorkspaceState::RootLost, None, Some(bound_root))
                if workspace.execution_mode == ExecutionMode::BoundRoot =>
            {
                self.workspaces
                    .begin_root_preparation(workspace.id, ExecutionMode::BoundRoot)
                    .await?;
                self.admit_root(&workspace, &bound_root, Admission::Completing)
                    .await
            }
            (WorkspaceState::Preparing, None, Some(bound_root)) => {
                self.admit_root(&workspace, &bound_root, Admission::FirstPreparation)
                    .await
            }
            (
                WorkspaceState::Preparing
                | WorkspaceState::Ready
                | WorkspaceState::RootLost
                | WorkspaceState::Archived,
                _,
                _,
            ) => Ok(()),
        }
    }

    // Admits `root` on the workspace's mount, completing the preparation there for `Completing`. A
    // refused folder ends the preparation `rootLost` with why; any other failure does too once the
    // root was dropped, and is answered. A first preparation that met a failure other than a
    // refusal is left to run again.
    async fn admit_root(
        &self,
        workspace: &WorkspaceRow,
        root: &Path,
        admission: Admission,
    ) -> Result<(), ExecutionRootError> {
        let admitted = async {
            let admitted = self.workspaces.admit_folder(workspace.id, root).await?;
            if admission == Admission::Completing {
                let completed = CompletedRootPreparation {
                    execution_root: admitted.execution_root,
                    checkout_root: admitted.checkout_root,
                    execution_mode: None,
                    bound_root: None,
                };
                self.workspaces
                    .complete_root_preparation(workspace.id, &completed)
                    .await?;
            }
            Ok::<(), WorkspaceServiceError>(())
        }
        .await;
        let Err(failure) = admitted else {
            return Ok(());
        };
        let is_refused_folder = matches!(failure, WorkspaceServiceError::Refused(_));
        if admission == Admission::FirstPreparation && !is_refused_folder {
            return Err(failure.into());
        }
        // A workspace left `preparing` with a root it may not keep would refuse every run.
        let failure = ExecutionRootError::from(failure);
        let recorded = self
            .workspaces
            .fail_root_preparation(workspace.id, &last_error_detail(&failure))
            .await;
        let failure = match recorded {
            Ok(()) if is_refused_folder => return Ok(()),
            Ok(()) => failure,
            Err(recording) => ExecutionRootError::Undone(Box::new(CleanupFailures::new(
                failure,
                vec![Box::new(recording)],
                ADMISSION_OPERATION,
            ))),
        };
        Err(ExecutionRootError::Preparation {
            workspace_id: workspace.id,
            failure: Box::new(failure),
        })
    }
}

// The folder the workspace's bind admitted, `None` when its metadata records none.
fn read_bound_root(workspace: &WorkspaceRow) -> Result<Option<PathBuf>, ExecutionRootError> {
    let members = parse_stored_json_object(&workspace.metadata).map_err(|fault| {
        ExecutionRootError::from(WorkspaceServiceInvariantError {
            message: format!(
                "workspace {} holds metadata that is no JSON object",
                workspace.id
            ),
            kind: WorkspaceServiceInvariantKind::WorkspaceRowUnprojectable,
            workspace_id: Some(workspace.id),
            source: Some(Box::new(fault)),
        })
    })?;
    Ok(members
        .get(BOUND_ROOT_METADATA_KEY)
        .and_then(Value::as_str)
        .map(PathBuf::from))
}
