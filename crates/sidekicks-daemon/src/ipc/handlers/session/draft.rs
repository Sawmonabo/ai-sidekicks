//! The session's unsent composer draft, held in the daemon so every device opens the same
//! half-written message. `session.draft.update` saves it: the draft, its words and extras, replaces
//! the one held when the save was typed over its current revision, and an empty draft clears it,
//! which is how Send clears it. `session.draft.subscribe` follows it, the draft held now and again
//! after each change with its revision; a slow reader is sent only the newest draft.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::session::draft::{
    HeldSessionDraft, SessionDraftSubscribe, SessionDraftSubscribeRequest, SessionDraftUpdate,
    SessionDraftUpdateRequest,
};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_session::draft_store::SessionDraftStore;

/// Registers `session.draft.update`, refusing a session the daemon does not hold
/// `session.notFound` and a save over a newer draft `session.draft.revisionStale`, keeping nothing,
/// and `session.draft.subscribe`, refusing an unknown session `session.notFound` and leaving
/// nothing open. Fails the start when a method is already registered.
pub(crate) fn register_session_draft(
    registry: &mut MethodRegistryBuilder,
    drafts: Arc<SessionDraftStore>,
) -> Result<(), RegistrationError> {
    let saving = Arc::clone(&drafts);
    registry.register::<SessionDraftUpdate, _>(
        move |request: SessionDraftUpdateRequest, _context: HandlerContext| {
            let drafts = Arc::clone(&saving);
            async move {
                Ok(drafts
                    .write(request.session_id, request.draft, request.expected_revision)
                    .await?)
            }
            .boxed()
        },
    )?;
    registry.register_subscription::<SessionDraftSubscribe, _>(
        move |request: SessionDraftSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let drafts = Arc::clone(&drafts);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    drafts
                        .follow(request.session_id, outlet)
                        .await
                        .map_err(HandlerError::from)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = HeldSessionDraft>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
