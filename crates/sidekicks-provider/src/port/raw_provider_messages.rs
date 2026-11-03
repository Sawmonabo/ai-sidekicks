//! The daemon's raw-message bucket as the drivers and the telemetry receiver reach it: each
//! message a provider sent, kept as text while `Record raw provider messages` is on.

use futures::future::BoxFuture;
use sidekicks_contracts::provider::id::ProviderId;

/// Where a provider's raw messages are recorded.
pub trait RawProviderMessages: Send + Sync {
    /// Whether `Record raw provider messages` is on now. Asked before a message's text is built,
    /// so nothing is built while it is off.
    fn is_recording(&self) -> bool;

    /// Records `message`, one message `provider` sent, as text.
    fn record(&self, provider: ProviderId, message: String) -> BoxFuture<'_, ()>;
}
