//! The notifications of `provider.account.subscribe`: one broadcast the account plane publishes
//! on and each open subscription reads from.

use sidekicks_contracts::provider::account::record::ProviderAccountNotification;
use sidekicks_provider::account::sign_in::ProviderAccountNotificationPublisher;
use tokio::sync::broadcast;

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

    /// A subscription's receiver of every notification published from now on.
    #[expect(
        dead_code,
        reason = "the provider.account.subscribe stream reads the notifications through it"
    )]
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
