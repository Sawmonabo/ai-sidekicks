//! Where a driver hands a level or mode its provider reported running, changed in the provider
//! itself rather than by the daemon, for the daemon to follow.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

/// The daemon's follow of a level or mode the provider reported: it reads the driver's
/// reported level, moves the stored level and the posture under the session's lock and tells
/// every client; registered through a `PortRegistration`, so a report made before it is
/// registered is dropped.
pub trait SessionLevelFollower: Send + Sync {
    /// Follows `session_id`'s newest reported level. Fails when the move fails.
    fn follow_reported_level(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
