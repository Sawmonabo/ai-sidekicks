//! The two ends between the idle sleep and the one place a session's process opens or resumes,
//! the run queue's provider sessions: that place tells the idle sleep of each opening and each
//! close, and the idle sleep brings a sleeping session's process up through it, so no conversation
//! is opened twice.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::idle_sleep::SessionSleepState;

/// What the idle sleep hears from the place a session's process opens.
pub trait SessionProcessFollower: Send + Sync {
    /// `session_id`'s process opened or resumed: it is followed awake, its idle clock running
    /// once nothing holds it.
    fn follow_awake(&self, session_id: SessionId);

    /// `session_id` closed, its process ended: it is no longer followed, and its stored timed
    /// fires go.
    fn forget_closed(&self, session_id: SessionId);
}

/// Where the idle sleep brings a sleeping session's process up.
pub trait SessionProcessWaker: Send + Sync {
    /// Brings `session_id`'s process up under the session's transition lock: the driver's wake
    /// of a session this daemon opened, else one resume of its stored conversation, recorded as
    /// the session's opening. Answers where the driver left the session; fails for a session
    /// closed or being deleted, with no process brought up, and as the wake or the resume fails.
    fn wake_process(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, Box<dyn Error + Send + Sync>>>;
}
