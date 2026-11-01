//! The worktree verbs: `worktree.retire`, `worktree.status.read` (a project's checkout and trees
//! as the switcher draws them), a new tree's setup card (`worktree.setup.subscribe`,
//! `worktree.setup.retry`), the copies across volumes a removal or a put-back makes
//! (`worktree.copy.subscribe`) and the kept worktrees (`worktree.removed.list`,
//! `worktree.restore`, `worktree.removed.delete`).

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::methods::{
    WorktreeCopySubscribe, WorktreeRemovedDelete, WorktreeRemovedList, WorktreeRestore,
    WorktreeRetire, WorktreeSetupRetry, WorktreeSetupSubscribe, WorktreeStatusRead,
};
use sidekicks_contracts::worktree::copy_progress::{
    WorktreeCopyProgress, WorktreeCopySubscribeRequest,
};
use sidekicks_contracts::worktree::lifecycle::{WorktreeRetireRequest, WorktreeStatusReadRequest};
use sidekicks_contracts::worktree::removed::{RemovedWorktreeRequest, WorktreeRemovedListRequest};
use sidekicks_contracts::worktree::setup::{WorktreeSetupRequest, WorktreeSetupStatus};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::repo::errors::RepoRefusal;

use crate::daemon::process::workspace_services::WorktreeMethods;

/// Registers the eight worktree verbs over `methods`. A retire, whatever it answers, then forgets
/// the setup cards of retired trees and asks for the worktree cleanup, since a retire can fail
/// after its retirement committed. The card and the copies under way are each sent whole on
/// subscribe and on each change, a slow reader only the newest; a tree with no row refuses the
/// card's subscribe and an unknown project the copies' subscribe and the kept list, with nothing
/// left open. Each refuses as its service refuses. Fails the start when a method is already
/// registered.
pub(crate) fn register_worktrees(
    registry: &mut MethodRegistryBuilder,
    methods: WorktreeMethods,
) -> Result<(), RegistrationError> {
    let WorktreeMethods {
        removal,
        removed,
        status,
        setup,
        copies,
        records,
        cleanup,
    } = methods;
    let retiring = Arc::clone(&setup);
    registry.register::<WorktreeRetire, _>(
        move |request: WorktreeRetireRequest, _context: HandlerContext| {
            let removal = Arc::clone(&removal);
            let setup = Arc::clone(&retiring);
            let cleanup = cleanup.clone();
            async move {
                let retired = removal.retire(&request).await;
                setup.forget_retired().await;
                cleanup.request();
                Ok(retired?)
            }
            .boxed()
        },
    )?;
    registry.register::<WorktreeStatusRead, _>(
        move |request: WorktreeStatusReadRequest, _context: HandlerContext| {
            let status = Arc::clone(&status);
            async move { Ok(status.read(&request).await?) }.boxed()
        },
    )?;
    let following = Arc::clone(&setup);
    registry.register_subscription::<WorktreeSetupSubscribe, _>(
        move |request: WorktreeSetupRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let setup = Arc::clone(&following);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    // The runner hands the listener the card as it stands before answering.
                    let subscription = setup
                        .subscribe(
                            request.worktree_id,
                            Arc::new(move |card: WorktreeSetupStatus| outlet.send(card)),
                        )
                        .await?;
                    Ok(move || drop(subscription))
                })
                .await?;
                let feed: Box<dyn Feed<Emission = WorktreeSetupStatus>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    registry.register::<WorktreeSetupRetry, _>(
        move |request: WorktreeSetupRequest, _context: HandlerContext| {
            let setup = Arc::clone(&setup);
            async move {
                // Answered once the steps it ran again have ended; the card carries their progress.
                setup.retry(request.worktree_id).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    let checking = Arc::clone(&records);
    registry.register_subscription::<WorktreeCopySubscribe, _>(
        move |request: WorktreeCopySubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let records = Arc::clone(&checking);
            let copies = copies.clone();
            async move {
                require_project(&records, request.project_id).await?;
                let feed = LatestValueFeed::open(|outlet| async move {
                    let mut follower = copies.follow(request.project_id);
                    // The follower's first read answers the copies under way at once.
                    let following = tokio::spawn(async move {
                        while let Some(progress) = follower.next().await {
                            outlet.send(progress);
                        }
                    });
                    Ok::<_, HandlerError>(move || following.abort())
                })
                .await?;
                let feed: Box<dyn Feed<Emission = WorktreeCopyProgress>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let listing = Arc::clone(&removed);
    registry.register::<WorktreeRemovedList, _>(
        move |request: WorktreeRemovedListRequest, _context: HandlerContext| {
            let records = Arc::clone(&records);
            let removed = Arc::clone(&listing);
            async move {
                require_project(&records, request.project_id).await?;
                Ok(removed.list(&request).await?)
            }
            .boxed()
        },
    )?;
    let restoring = Arc::clone(&removed);
    registry.register::<WorktreeRestore, _>(
        move |request: RemovedWorktreeRequest, _context: HandlerContext| {
            let removed = Arc::clone(&restoring);
            async move { Ok(removed.restore(request.removed_worktree_id).await?) }.boxed()
        },
    )?;
    registry.register::<WorktreeRemovedDelete, _>(
        move |request: RemovedWorktreeRequest, _context: HandlerContext| {
            let removed = Arc::clone(&removed);
            async move {
                removed.delete(request.removed_worktree_id).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}

// Refuses `project.notFound` for a named project that does not exist; no project names every one.
async fn require_project(
    records: &ProjectRecords,
    project_id: Option<ProjectId>,
) -> Result<(), HandlerError> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    match records.read_entry(project_id).await? {
        Some(_) => Ok(()),
        None => Err(HandlerError::Refused(
            RepoRefusal::ProjectNotFound { project_id }.into(),
        )),
    }
}
