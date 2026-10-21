//! `project.branch.list`: a project's branches for both base pickers, in the daemon's one order,
//! with how far each is ahead of and behind its upstream and the tree that has it checked out.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::repo::git_reads::ProjectBranchListRequest;
use sidekicks_contracts::repo::methods::ProjectBranchList;

use crate::git::worktree::branch_list::BranchListReader;
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

/// Registers `project.branch.list` on `branches`; a mount that is not attached is refused with
/// `repoMount.notFound`. Fails the start when the method is already registered.
#[expect(dead_code, reason = "the daemon's start")]
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
