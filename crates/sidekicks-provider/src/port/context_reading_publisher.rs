//! Where a driver reports a session's context reading: the window, where the session compacts and
//! the provider's own usage figures, one latest reading per session that the ring and the
//! inspector's `Context` section both read. A reading made before the publisher is registered is
//! dropped.

use sidekicks_contracts::session::inspector::SessionContextReading;

/// The context readings' intake, registered through a `PortRegistration`. It keeps only the
/// latest reading of each session and never blocks or fails back into the provider's stream.
pub trait ContextReadingPublisher: Send + Sync {
    /// The session's newest context reading, replacing the one held.
    fn publish_context_reading(&self, reading: SessionContextReading);
}
