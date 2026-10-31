//! The workspace verbs: `workspace.bind`, which binds a session to an attached mount,
//! `workspace.list`, a session's workspaces read through their health, and
//! `workspace.executionRoot.prepare`, a workspace's root made ready, a new worktree when it names
//! a branch.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::repo::methods::{
    WorkspaceBind, WorkspaceExecutionRootPrepare, WorkspaceList,
};
use sidekicks_contracts::repo::workspace::{
    WorkspaceBindRequest, WorkspaceListRequest, WorkspaceListResponse,
};
use sidekicks_contracts::worktree::lifecycle::WorkspaceExecutionRootPrepareRequest;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_workspace::execution_root::ExecutionRootService;
use sidekicks_workspace::service::WorkspaceService;

/// Registers the three workspace verbs over `workspaces` and `execution_roots`; a prepare waits
/// for the workspace's preparation hold, so it never runs beside another preparation of it. Each
/// refuses as its service refuses. Fails the start when a method is already registered.
pub(crate) fn register_workspaces(
    registry: &mut MethodRegistryBuilder,
    workspaces: Arc<WorkspaceService>,
    execution_roots: Arc<ExecutionRootService>,
) -> Result<(), RegistrationError> {
    let binding = Arc::clone(&workspaces);
    registry.register::<WorkspaceBind, _>(
        move |request: WorkspaceBindRequest, _context: HandlerContext| {
            let workspaces = Arc::clone(&binding);
            async move { Ok(workspaces.bind(&request).await?) }.boxed()
        },
    )?;
    registry.register::<WorkspaceList, _>(
        move |request: WorkspaceListRequest, _context: HandlerContext| {
            let workspaces = Arc::clone(&workspaces);
            async move {
                Ok(WorkspaceListResponse {
                    workspaces: workspaces.list(&request).await?,
                })
            }
            .boxed()
        },
    )?;
    registry.register::<WorkspaceExecutionRootPrepare, _>(
        move |request: WorkspaceExecutionRootPrepareRequest, _context: HandlerContext| {
            let execution_roots = Arc::clone(&execution_roots);
            async move {
                let hold = execution_roots.hold_preparation(request.workspace_id).await;
                Ok(execution_roots.prepare_held(&hold, &request).await?)
            }
            .boxed()
        },
    )
}
