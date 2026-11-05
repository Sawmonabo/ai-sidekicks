//! The notifications of `provider.account.subscribe`: one broadcast the account plane publishes
//! on, and the subscription each client opens on it, which reads the notifications published from
//! its call on.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::provider::account::methods::ProviderAccountSubscribe;
use sidekicks_contracts::provider::account::record::ProviderAccountNotification;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::{Feed, SendGate};
use sidekicks_provider::account::sign_in::ProviderAccountNotificationPublisher;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use super::ProviderAccountMethodSources;

// The notifications a subscription may fall behind by before it misses the oldest.
const NOTIFICATIONS_HELD: usize = 64;

/// The account plane's notifications, broadcast to every open subscription; one with none open
/// is heard by no one, since the notifications are wire-only and kept nowhere.
pub(crate) struct ProviderAccountNotifications {
    sender: broadcast::Sender<ProviderAccountNotification>,
}

impl ProviderAccountNotifications {
    /// A broadcast with no subscription open yet.
    pub(crate) fn new() -> Self {
        Self {
            sender: broadcast::Sender::new(NOTIFICATIONS_HELD),
        }
    }

    /// A subscription that reads every notification published from this call on, missing the
    /// oldest once it falls further behind than the broadcast holds.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ProviderAccountNotification> {
        self.sender.subscribe()
    }
}

impl ProviderAccountNotificationPublisher for ProviderAccountNotifications {
    fn publish(&self, notification: ProviderAccountNotification) {
        // With no subscription open the send finds no receiver, which is no failure.
        let _receivers = self.sender.send(notification);
    }
}

/// A subscription that fell further behind the broadcast than it holds, so it missed
/// notifications; its stream ends with this fault, and the client lists the accounts again.
#[derive(Debug, thiserror::Error)]
#[error("the subscription fell behind and missed {0} provider account notifications")]
struct NotificationsMissed(u64);

/// Registers `provider.account.subscribe` over `sources`' broadcast: each subscription reads every
/// notification published once its call is taken. Fails the start when it is already registered.
pub(super) fn register_provider_account_subscribe(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<ProviderAccountMethodSources>,
) -> Result<(), RegistrationError> {
    let subscribing = Arc::clone(sources);
    registry.register_subscription::<ProviderAccountSubscribe, _>(
        move |_request: EmptyPayload, _context: HandlerContext, subscription_id: SubscriptionId| {
            // Taken when the call is, so a change published right after the acknowledgment is read.
            let notifications = subscribing.publisher.subscribe();
            async move {
                let feed: Box<dyn Feed<Emission = ProviderAccountNotification>> =
                    Box::new(NotificationFeed { notifications });
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// One subscription's notifications, each read only once its lane has credit; the broadcast holds
/// what waits, so a slow reader costs at most the notifications the broadcast keeps.
struct NotificationFeed {
    notifications: broadcast::Receiver<ProviderAccountNotification>,
}

impl Feed for NotificationFeed {
    type Emission = ProviderAccountNotification;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<ProviderAccountNotification>, HandlerError>> {
        async move {
            // The gate first, so a read dropped while it waits takes no notification.
            if gate.ready().await.is_err() {
                return Ok(None);
            }
            match self.notifications.recv().await {
                Ok(notification) => Ok(Some(notification)),
                // The account plane dropped its broadcast at the daemon's stop.
                Err(RecvError::Closed) => Ok(None),
                Err(RecvError::Lagged(missed)) => Err(HandlerError::Internal(Box::new(
                    NotificationsMissed(missed),
                ))),
            }
        }
        .boxed()
    }
}
