//! A session's working folder: `session.workingFolder.update`, which moves the session into
//! another tree of its repository, at once when none of its runs is live, else when the live run
//! ends; and `session.workingFolder.subscribe`, a mark each time the folder the session works in
//! changes, so the changes pane reads it again. The stream follows the session when it moves to
//! another folder, and a slow reader is sent only the newest mark.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::repo::git_reads::{
    SessionWorkingFolderSubscribeRequest, WorkingTreeChange,
};
use sidekicks_contracts::repo::methods::SessionWorkingFolderSubscribe;
use sidekicks_contracts::session::directory::{
    SessionWorkingFolderUpdate, SessionWorkingFolderUpdateRequest,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_session::working_folder::SessionWorkingFolders;
use sidekicks_workspace::git::worktree::watch::WorkingFolderWatcher;

/// Registers `session.workingFolder.update` over `working_folders`, which refuses as its doc
/// names, and `session.workingFolder.subscribe` on `watcher`; a session this daemon holds no row
/// for is refused `session.notFound`, leaving nothing open. Fails the start when a method is
/// already registered.
pub(crate) fn register_session_working_folder(
    registry: &mut MethodRegistryBuilder,
    working_folders: Arc<SessionWorkingFolders>,
    watcher: Arc<WorkingFolderWatcher>,
) -> Result<(), RegistrationError> {
    registry.register::<SessionWorkingFolderUpdate, _>(
        move |request: SessionWorkingFolderUpdateRequest, _context: HandlerContext| {
            let working_folders = Arc::clone(&working_folders);
            async move { Ok(working_folders.set(&request).await?) }.boxed()
        },
    )?;
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
