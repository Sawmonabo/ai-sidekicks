//! A session's held review notes: `session.reviewNote.add`, `session.reviewNote.update` and
//! `session.reviewNote.delete` change them, and `session.reviewNote.subscribe` follows them, the
//! whole set at once and again on each change, each note's stranded mark read fresh; a slow reader
//! is sent only the newest set.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::review_note::{
    ReviewNoteSet, SessionReviewNoteAdd, SessionReviewNoteAddRequest, SessionReviewNoteDelete,
    SessionReviewNoteDeleteRequest, SessionReviewNoteSubscribe, SessionReviewNoteSubscribeRequest,
    SessionReviewNoteUpdate, SessionReviewNoteUpdateRequest,
};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_session::review_note::store::SessionReviewNoteStore;

/// Registers the four review note methods, each refusing by the codes its method lists, a refused
/// change keeping nothing and a refused subscription leaving nothing open. Fails the start when a
/// method is already registered.
pub(crate) fn register_session_review_notes(
    registry: &mut MethodRegistryBuilder,
    notes: Arc<SessionReviewNoteStore>,
) -> Result<(), RegistrationError> {
    let adding = Arc::clone(&notes);
    registry.register::<SessionReviewNoteAdd, _>(
        move |request: SessionReviewNoteAddRequest, _context: HandlerContext| {
            let notes = Arc::clone(&adding);
            async move { Ok(notes.add(request).await?) }.boxed()
        },
    )?;
    let updating = Arc::clone(&notes);
    registry.register::<SessionReviewNoteUpdate, _>(
        move |request: SessionReviewNoteUpdateRequest, _context: HandlerContext| {
            let notes = Arc::clone(&updating);
            async move { Ok(notes.update(request).await?) }.boxed()
        },
    )?;
    let deleting = Arc::clone(&notes);
    registry.register::<SessionReviewNoteDelete, _>(
        move |request: SessionReviewNoteDeleteRequest, _context: HandlerContext| {
            let notes = Arc::clone(&deleting);
            async move { Ok(notes.delete(request).await?) }.boxed()
        },
    )?;
    registry.register_subscription::<SessionReviewNoteSubscribe, _>(
        move |request: SessionReviewNoteSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let notes = Arc::clone(&notes);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    notes
                        .follow(request.session_id, outlet)
                        .await
                        .map_err(HandlerError::from)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = ReviewNoteSet>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
