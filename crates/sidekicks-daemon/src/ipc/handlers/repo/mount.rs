//! The folder verbs: `repoMount.attach` (a folder attached as a project, or the project already
//! holding its repository), `repoMount.read` (one mount with a freshly probed health and what uses
//! it), `repoMount.list` (every folder the service can reach), `repoMount.detach` (a project's
//! `Delete`), `repoMount.reattach` (the lost folder's `Re-attach`) and `repoMount.move` (the lost
//! folder's `Open folder…` on a folder holding the same repository).

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::folders::{
    RepoMountAttachRequest, RepoMountListResponse, RepoMountMoveRequest, RepoMountOrigin,
    RepoMountRequest,
};
use sidekicks_contracts::repo::methods::{
    RepoMountAttach, RepoMountDetach, RepoMountList, RepoMountMove, RepoMountRead,
    RepoMountReattach,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_workspace::folder::usage::{RepoFolderUsage, RepoFolderUsageError};

use crate::daemon::process::workspace_services::RepoMountMethods;

/// Registers the six folder verbs over `methods`. A detach, whatever it answers, then asks for
/// the worktree cleanup and lets go the held carry of a mount no longer attached that no move
/// takes forward, since a detach can fail after its write committed; a re-attach or a move,
/// whatever it answers, forgets the setup cards of the trees it retired and reads its project into
/// the projects list again. Each refuses as its service refuses. Fails the start when a method is
/// already registered.
pub(crate) fn register_repo_mounts(
    registry: &mut MethodRegistryBuilder,
    methods: RepoMountMethods,
) -> Result<(), RegistrationError> {
    let RepoMountMethods {
        projects,
        mounts,
        packing,
        usage,
        reattach,
        setup,
        list_feed,
        cleanup,
    } = methods;
    let attaching = Arc::clone(&projects);
    registry.register::<RepoMountAttach, _>(
        move |request: RepoMountAttachRequest, _context: HandlerContext| {
            let projects = Arc::clone(&attaching);
            async move { Ok(projects.attach_or_find(&request).await?.mount) }.boxed()
        },
    )?;
    let reading = Arc::clone(&usage);
    registry.register::<RepoMountRead, _>(
        move |request: RepoMountRequest, _context: HandlerContext| {
            let usage = Arc::clone(&reading);
            let mounts = Arc::clone(&mounts);
            let packing = Arc::clone(&packing);
            async move {
                Ok(usage
                    .read_mount(&mounts, &packing, &request.repo_mount_id)
                    .await?)
            }
            .boxed()
        },
    )?;
    let listing = Arc::clone(&usage);
    registry.register::<RepoMountList, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let usage = Arc::clone(&listing);
            async move {
                Ok(RepoMountListResponse {
                    mounts: usage.list().await?,
                })
            }
            .boxed()
        },
    )?;
    let detaching = Arc::clone(&reattach);
    registry.register::<RepoMountDetach, _>(
        move |request: RepoMountRequest, _context: HandlerContext| {
            let projects = Arc::clone(&projects);
            let reattach = Arc::clone(&detaching);
            let cleanup = cleanup.clone();
            async move {
                let repo_mount_id = request.repo_mount_id;
                // The request names no actor and no correlation, so the detach records none.
                let detached = projects.detach(repo_mount_id, None, None).await;
                cleanup.request();
                if let Err(error) = reattach.let_go_detached_carry(repo_mount_id).await {
                    tracing::warn!(
                        %repo_mount_id,
                        error = &error as &(dyn Error + 'static),
                        "a detached project's held captures could not be let go; a folder \
                         attached again at its old place may be refused them until the next start"
                    );
                }
                Ok(detached?)
            }
            .boxed()
        },
    )?;
    {
        let usage = Arc::clone(&usage);
        let reattach = Arc::clone(&reattach);
        let setup = Arc::clone(&setup);
        let list_feed = Arc::clone(&list_feed);
        registry.register::<RepoMountReattach, _>(
            move |request: RepoMountRequest, _context: HandlerContext| {
                let usage = Arc::clone(&usage);
                let reattach = Arc::clone(&reattach);
                let setup = Arc::clone(&setup);
                let list_feed = Arc::clone(&list_feed);
                async move {
                    // Read first: the re-attach moves the project onto a new mount without an
                    // event.
                    let project_id = read_project_of(&usage, &request.repo_mount_id).await?;
                    let reattached = reattach.reattach(&request).await;
                    setup.forget_retired().await;
                    if let Some(project_id) = project_id {
                        list_feed.refresh(&[project_id]);
                    }
                    Ok(reattached?)
                }
                .boxed()
            },
        )?;
    }
    registry.register::<RepoMountMove, _>(
        move |request: RepoMountMoveRequest, _context: HandlerContext| {
            let usage = Arc::clone(&usage);
            let reattach = Arc::clone(&reattach);
            let setup = Arc::clone(&setup);
            let list_feed = Arc::clone(&list_feed);
            async move {
                // Read first: the move puts the project on a new mount and folder without an event.
                let project_id = read_project_of(&usage, &request.repo_mount_id).await?;
                let moved = reattach.move_to_folder(&request).await;
                setup.forget_retired().await;
                if let Some(project_id) = project_id {
                    list_feed.refresh(&[project_id]);
                }
                Ok(moved?)
            }
            .boxed()
        },
    )
}

// The project a mount serves, `None` for a chat's own workspace or a worktree's folder.
async fn read_project_of(
    usage: &RepoFolderUsage,
    repo_mount_id: &RepoMountId,
) -> Result<Option<ProjectId>, RepoFolderUsageError> {
    Ok(match usage.read_origin(repo_mount_id).await? {
        RepoMountOrigin::Attached { project_id, .. } => Some(project_id),
        RepoMountOrigin::Managed { .. } | RepoMountOrigin::Worktree { .. } => None,
    })
}
