//! The project verbs: `project.subscribe`, the live list of every project, sent whole on subscribe
//! and on each change, and the edits on one project's own row, each answering the project as the
//! list now draws it.

pub(crate) mod clone;

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::project::{
    ProjectBranchPatternUpdateRequest, ProjectEnvironmentUpdateRequest, ProjectList,
    ProjectRenameRequest, ProjectSetupUpdateRequest, ProjectStateChangeRequest,
};
use sidekicks_contracts::repo::methods::{
    ProjectArchive, ProjectBranchPatternUpdate, ProjectEnvironmentUpdate, ProjectReactivate,
    ProjectRename, ProjectSetupUpdate, ProjectSubscribe,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::service::ProjectService;

/// Registers the live projects list and the six project edits. A list that cannot be read fails
/// the subscribe with nothing left open; an edit of an unknown project is refused
/// `project.notFound`, a refused environment row `project.environment.nameRefused` and a refused
/// pattern `project.branchPattern.refused`, nothing written. Fails the start when a method is
/// already registered.
pub(crate) fn register_project_methods(
    registry: &mut MethodRegistryBuilder,
    projects: Arc<ProjectService>,
    list_feed: Arc<ProjectListFeed>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<ProjectSubscribe, _>(
        move |_request: EmptyPayload, _context: HandlerContext, subscription_id: SubscriptionId| {
            let list_feed = Arc::clone(&list_feed);
            async move {
                let feed =
                    LatestValueFeed::open(
                        move |outlet| async move { list_feed.open(outlet).await },
                    )
                    .await?;
                let feed: Box<dyn Feed<Emission = ProjectList>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let renaming = Arc::clone(&projects);
    registry.register::<ProjectRename, _>(
        move |request: ProjectRenameRequest, _context: HandlerContext| {
            let projects = Arc::clone(&renaming);
            async move { Ok(projects.rename(request.project_id, &request.name).await?) }.boxed()
        },
    )?;
    let archiving = Arc::clone(&projects);
    registry.register::<ProjectArchive, _>(
        move |request: ProjectStateChangeRequest, _context: HandlerContext| {
            let projects = Arc::clone(&archiving);
            async move { Ok(projects.archive(request.project_id).await?) }.boxed()
        },
    )?;
    let reactivating = Arc::clone(&projects);
    registry.register::<ProjectReactivate, _>(
        move |request: ProjectStateChangeRequest, _context: HandlerContext| {
            let projects = Arc::clone(&reactivating);
            async move { Ok(projects.reactivate(request.project_id).await?) }.boxed()
        },
    )?;
    let setting_up = Arc::clone(&projects);
    registry.register::<ProjectSetupUpdate, _>(
        move |request: ProjectSetupUpdateRequest, _context: HandlerContext| {
            let projects = Arc::clone(&setting_up);
            async move {
                Ok(projects
                    .update_setup(request.project_id, &request.setup)
                    .await?)
            }
            .boxed()
        },
    )?;
    let environment = Arc::clone(&projects);
    registry.register::<ProjectEnvironmentUpdate, _>(
        move |request: ProjectEnvironmentUpdateRequest, _context: HandlerContext| {
            let projects = Arc::clone(&environment);
            async move {
                Ok(projects
                    .update_environment(request.project_id, &request.environment_rows)
                    .await?)
            }
            .boxed()
        },
    )?;
    registry.register::<ProjectBranchPatternUpdate, _>(
        move |request: ProjectBranchPatternUpdateRequest, _context: HandlerContext| {
            let projects = Arc::clone(&projects);
            async move {
                Ok(projects
                    .update_branch_pattern(request.project_id, request.pattern)
                    .await?)
            }
            .boxed()
        },
    )
}
