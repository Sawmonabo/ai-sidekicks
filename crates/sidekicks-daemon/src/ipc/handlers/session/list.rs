//! `session.subscribe`: the live sessions list. The acknowledgment carries the chats count and as
//! many entries as fit one message; the rest of the list follows as `page` changes, each fitting
//! one message, the last marked complete, and every other change after them, the newest per
//! session, as the subscription's gate lets each through.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::directory::{
    SessionListChange, SessionSubscribe, SessionSubscribeResponse,
};

use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_session::directory::list_feed::SessionListFeed;

/// Registers `session.subscribe` on `registry`. A list that cannot be read fails the call with
/// nothing left open; one that later stops being current ends the subscription with a fault.
/// Fails the start when the method is already registered.
pub(crate) fn register_session_list(
    registry: &mut MethodRegistryBuilder,
    list_feed: Arc<SessionListFeed>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<SessionSubscribe, _>(
        move |_request: EmptyPayload, _context: HandlerContext, subscription_id: SubscriptionId| {
            let list_feed = Arc::clone(&list_feed);
            async move {
                let opening = list_feed.open().await?;
                let feed: Box<dyn Feed<Emission = SessionListChange>> =
                    Box::new(opening.subscriber);
                Ok((
                    SessionSubscribeResponse {
                        subscription_id,
                        sessions: opening.sessions,
                        chat_count: opening.chat_count,
                        is_complete: opening.is_complete,
                    },
                    feed,
                ))
            }
            .boxed()
        },
    )
}
