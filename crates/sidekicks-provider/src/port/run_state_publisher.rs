//! Where the run engine's inbound dispatch sends a run's live-only state, a provider's safety hold
//! on a turn, to the subscribers of the run's session state stream. Nothing here is stored.

use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;

/// The run state stream's live intake, registered through a `PortRegistration`. It never blocks or
/// fails back into the provider's stream; it keeps a hold that is on in memory only, for a stream
/// that opens later, and a hold arriving before the publisher is registered is dropped.
pub trait RunStatePublisher: Send + Sync {
    /// Publishes a turn's safety hold, on or off.
    fn publish(&self, hold: RunSafetyBufferingUpdatedPayload);
}
