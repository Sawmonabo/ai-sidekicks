//! The clone verbs: where a clone goes, the start, the live clone card, the answer to git's
//! question, the cancel and the large-files pull. While the clone service is not running each
//! answers `project.clone.unavailable`, with the text of its failed start, or none where it was
//! never started.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::repo::clone::{
    ProjectCloneAnswerRequest, ProjectCloneRequest, ProjectCloneStartRequest, ProjectCloneStatus,
};
use sidekicks_contracts::repo::methods::{
    ProjectCloneAnswer, ProjectCloneCancel, ProjectCloneFolderRead, ProjectCloneStart,
    ProjectCloneSubscribe, ProjectLargeFilePull,
};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_workspace::clone::service::{CloneService, CloneServiceError};

// The clone service once started, or the text every verb is refused with.
type CloneServiceStart = Arc<Result<Arc<CloneService>, String>>;

/// Registers the six clone verbs on `clones`, the started service or the text of its failed start
/// (empty where it was never started). An unknown project refuses the card's subscribe with
/// nothing left open. Fails the start when a method is already registered.
pub(crate) fn register_project_clone_methods(
    registry: &mut MethodRegistryBuilder,
    clones: Result<Arc<CloneService>, String>,
) -> Result<(), RegistrationError> {
    let clones: CloneServiceStart = Arc::new(clones);
    let reading = Arc::clone(&clones);
    registry.register::<ProjectCloneFolderRead, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let clones = Arc::clone(&reading);
            async move { Ok(running(&clones)?.read_clone_folder().await?) }.boxed()
        },
    )?;
    let starting = Arc::clone(&clones);
    registry.register::<ProjectCloneStart, _>(
        move |request: ProjectCloneStartRequest, _context: HandlerContext| {
            let clones = Arc::clone(&starting);
            async move { Ok(running(&clones)?.start_clone(request).await?) }.boxed()
        },
    )?;
    let following = Arc::clone(&clones);
    registry.register_subscription::<ProjectCloneSubscribe, _>(
        move |request: ProjectCloneRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let clones = Arc::clone(&following);
            async move {
                let clones = running(&clones)?;
                let feed = LatestValueFeed::open(move |outlet| async move {
                    Ok(clones.follow_card(request.project_id, outlet).await?)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = ProjectCloneStatus>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let answering = Arc::clone(&clones);
    registry.register::<ProjectCloneAnswer, _>(
        move |request: ProjectCloneAnswerRequest, _context: HandlerContext| {
            let clones = Arc::clone(&answering);
            async move {
                running(&clones)?
                    .answer(request.project_id, request.question_id, request.answer)
                    .await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    let canceling = Arc::clone(&clones);
    registry.register::<ProjectCloneCancel, _>(
        move |request: ProjectCloneRequest, _context: HandlerContext| {
            let clones = Arc::clone(&canceling);
            async move {
                running(&clones)?.cancel(request.project_id).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    registry.register::<ProjectLargeFilePull, _>(
        move |request: ProjectCloneRequest, _context: HandlerContext| {
            let clones = Arc::clone(&clones);
            async move {
                running(&clones)?
                    .pull_large_files(request.project_id)
                    .await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}

// The running service, or `project.clone.unavailable` with its start's text.
fn running(clones: &CloneServiceStart) -> Result<Arc<CloneService>, HandlerError> {
    match clones.as_ref() {
        Ok(service) => Ok(Arc::clone(service)),
        Err(message) => Err(CloneServiceError::unavailable(message.clone()).into()),
    }
}
