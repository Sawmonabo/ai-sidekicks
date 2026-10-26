//! `session.workingFolder.subscribe`: a mark each time the folder a session works in changes, so
//! the changes pane reads it again. The stream follows the session when it moves to another
//! folder, and a slow reader is sent only the newest mark.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::repo::git_reads::{
    SessionWorkingFolderSubscribeRequest, WorkingTreeChange,
};
use sidekicks_contracts::repo::methods::SessionWorkingFolderSubscribe;

use crate::git::worktree::watch::WorkingFolderWatcher;
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use crate::ipc::stream::feed::Feed;
use crate::ipc::stream::latest_value::LatestValueFeed;

/// Registers `session.workingFolder.subscribe` on `watcher`; a session this daemon holds no row
/// for is refused with `session.notFound`, leaving nothing open. Fails the start when the method
/// is already registered.
pub(crate) fn register_working_folder(
    registry: &mut MethodRegistryBuilder,
    watcher: Arc<WorkingFolderWatcher>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<SessionWorkingFolderSubscribe, _>(
        move |request: SessionWorkingFolderSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let watcher = Arc::clone(&watcher);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    let subscription = watcher
                        .subscribe(
                            &request.session_id,
                            Arc::new(move |change: WorkingTreeChange| outlet.send(change)),
                        )
                        .await?;
                    Ok(move || drop(subscription))
                })
                .await?;
                let feed: Box<dyn Feed<Emission = WorkingTreeChange>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
