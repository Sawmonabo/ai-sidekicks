//! How a driver wakes a session the daemon's idle sleep stopped, for a message that reached the
//! session's inbox or one the daemon sends it while it slept; a driver that finds it unregistered
//! refuses the message.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

/// The idle sleep's wake, registered through a `PortRegistration`.
pub trait SessionWaker: Send + Sync {
    /// Wakes `session_id` for a message, one its inbox received or one the daemon sends it:
    /// answers at once while it is awake, and otherwise once its process is up again, behind a
    /// stop in progress and joining a wake already under way. Fails when the session's resume
    /// failed or it closed.
    fn wake_for_message(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
