//! `project.branch.list`: a project's branches for both base pickers, in the daemon's one order,
//! with how far each is ahead of and behind its upstream and the tree that has it checked out.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::repo::git_reads::ProjectBranchListRequest;
use sidekicks_contracts::repo::methods::ProjectBranchList;

use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_workspace::git::worktree::branch_list::BranchListReader;

/// Registers `project.branch.list` on `branches`; a mount that is not attached is refused with
/// `repoMount.notFound`. Fails the start when the method is already registered.
pub(crate) fn register_repo_branches(
    registry: &mut MethodRegistryBuilder,
    branches: Arc<BranchListReader>,
) -> Result<(), RegistrationError> {
    registry.register::<ProjectBranchList, _>(
        move |request: ProjectBranchListRequest, _context: HandlerContext| {
            let branches = Arc::clone(&branches);
            async move { Ok(branches.read(&request.repo_mount_id).await?) }.boxed()
        },
    )
}
