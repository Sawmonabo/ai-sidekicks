//! `session.context.subscribe`: a session's context reading, the one that feeds the ring and the
//! inspector's `Context` section alike. A subscriber reads the held reading at once and then only
//! the newest after each change; its stream finishes once the session closes.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::session::controls::methods::SessionAddressedRequest;
use sidekicks_contracts::session::inspector::{SessionContextReading, SessionContextSubscribe};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_session::readings::context::ContextReadings;

/// Registers `session.context.subscribe` over `readings`; a session this daemon holds no row for
/// is refused `session.notFound`, leaving nothing open. Fails the start when the method is already
/// registered.
pub(crate) fn register_context_subscribe(
    registry: &mut MethodRegistryBuilder,
    readings: Arc<ContextReadings>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<SessionContextSubscribe, _>(
        move |request: SessionAddressedRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let readings = Arc::clone(&readings);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    Ok(readings.follow(request.session_id, outlet).await?)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = SessionContextReading>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
