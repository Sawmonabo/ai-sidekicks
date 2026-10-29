//! The presence methods: `presence.heartbeat.send`, filed under the calling device and the
//! connection that carried it, `presence.read`, the devices connected now, and
//! `presence.subscribe`, the devices sent whole on subscribe and on each change.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::presence::{
    MachinePresence, PresenceHeartbeatSend, PresenceHeartbeatSendRequest, PresenceRead,
    PresenceSubscribe,
};
use sidekicks_ipc::presence::PresenceRegister;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;

/// Registers the three presence methods over `presence`. A heartbeat with no calling device is a
/// fault in the daemon, answered as an internal error. Fails the start when a method is already
/// registered.
pub(crate) fn register_presence_methods(
    registry: &mut MethodRegistryBuilder,
    presence: Arc<PresenceRegister>,
) -> Result<(), RegistrationError> {
    let reading = Arc::clone(&presence);
    registry.register::<PresenceRead, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let presence = Arc::clone(&reading);
            async move { Ok(presence.read()) }.boxed()
        },
    )?;
    let recording = Arc::clone(&presence);
    registry.register::<PresenceHeartbeatSend, _>(
        move |request: PresenceHeartbeatSendRequest, context: HandlerContext| {
            let presence = Arc::clone(&recording);
            async move {
                let device_id = context.calling_device(PresenceHeartbeatSend::DESCRIPTOR.method)?;
                presence.record_heartbeat(context.transport_id, device_id, request);
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    registry.register_subscription::<PresenceSubscribe, _>(
        move |_request: EmptyPayload, _context: HandlerContext, subscription_id: SubscriptionId| {
            let presence = Arc::clone(&presence);
            async move {
                let feed = LatestValueFeed::open(move |outlet| {
                    let id = presence.follow(outlet);
                    std::future::ready(Ok(move || presence.detach(id)))
                })
                .await?;
                let feed: Box<dyn Feed<Emission = MachinePresence>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
