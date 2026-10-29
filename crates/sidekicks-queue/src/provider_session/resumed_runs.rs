//! The provider's answer for each live run a session's resume named, handed on before the resumed
//! binding is recorded, so each run is settled before it goes live on the resumed process.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::session_control::ResumedRunAnswer;

/// A session the provider resumed, and the provider's answer for each run its resume named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumedRuns {
    /// The session.
    pub session_id: SessionId,
    /// The provider's answer for each run the resume named, lead and children alike, in the
    /// provider's order.
    pub runs: Vec<ResumedRunAnswer>,
}

/// Takes the runs a resume found, after the provider answered and before the resumed binding is
/// recorded; the caller holds the session's transition lock, so an implementation takes no lock
/// of its own on the session. An error leaves the resumed binding unrecorded.
pub trait ResumedRunsIngress: Send + Sync {
    /// Settles each run of `resumed` as the provider's answer for it says.
    fn take_resumed_runs(
        &self,
        resumed: ResumedRuns,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
