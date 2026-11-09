//! The daemon's raw-message bucket as the drivers and the telemetry receiver reach it: each
//! message a provider sent, kept as text while `Record raw provider messages` is on.

#[cfg(test)]
pub(crate) mod test_port;

use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::port_registration::PortRegistration;

/// Where a provider's raw messages are recorded.
pub trait RawProviderMessages: Send + Sync {
    /// Whether `Record raw provider messages` is on now. Asked before a message's text is built,
    /// so nothing is built while it is off.
    fn is_recording(&self) -> bool;

    /// Records `message`, one message `provider` sent, as text.
    fn record(&self, provider: ProviderId, message: String) -> BoxFuture<'_, ()>;
}

/// Records `message`, the bytes of one message the provider `provider` names sent, as its text,
/// once `raw_messages` is registered and recording, resolving once it is written; otherwise its
/// text is never built and nothing is written.
pub(crate) async fn record_raw_provider_message(
    raw_messages: &PortRegistration<Arc<dyn RawProviderMessages>>,
    provider: impl FnOnce() -> ProviderId,
    message: &[u8],
) {
    if let Some(raw_messages) = raw_messages.port()
        && raw_messages.is_recording()
    {
        let text = String::from_utf8_lossy(message).into_owned();
        raw_messages.record(provider(), text).await;
    }
}
