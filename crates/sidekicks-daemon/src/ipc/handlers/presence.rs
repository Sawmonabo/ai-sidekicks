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
    // Filed while the call is dispatched, so a connection's heartbeats land in the order they
    // arrived and before its close drops them.
    let recording = Arc::clone(&presence);
    registry.register_ordered::<PresenceHeartbeatSend, _, _, _>(
        move |context: &HandlerContext, request: &PresenceHeartbeatSendRequest| {
            let device_id = context.calling_device(PresenceHeartbeatSend::DESCRIPTOR.method)?;
            recording.record_heartbeat(context.transport_id, device_id, request.clone());
            Ok(())
        },
        |()| futures::future::ready(Ok(EmptyPayload {})).boxed(),
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::presence::PresenceRegister;
    use sidekicks_ipc::registry::{Dispatch as _, MethodRegistryBuilder, TransportId};

    use super::register_presence_methods;

    #[test]
    fn a_heartbeat_is_filed_by_its_dispatch_so_the_close_after_it_drops_the_device() {
        let presence = Arc::new(PresenceRegister::default());
        let mut builder = MethodRegistryBuilder::new();
        register_presence_methods(&mut builder, Arc::clone(&presence))
            .expect("the presence methods register");
        let registry = builder.freeze();

        // The call is never polled, as a call canceled by its connection's close never is.
        drop(registry.dispatch(
            request(
                "presence.heartbeat.send",
                Some(&json!({ "deviceType": "desktop", "appVisible": true })),
            ),
            context(7),
        ));
        assert_eq!(
            presence.read().devices.len(),
            1,
            "the dispatch filed the heartbeat"
        );

        presence.cleanup_transport(TransportId(7));
        assert!(
            presence.read().devices.is_empty(),
            "the close dropped the device"
        );
    }
}
