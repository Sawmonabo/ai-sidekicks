//! Where the Claude driver keeps the advisor Claude Code resolved for a session no one picked one
//! for, so every later start runs with it and a later change to the person's own setting never
//! reaches the session.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

/// The session store's record of a resolved advisor, registered through a `PortRegistration`;
/// until it is, the resolution lives only as long as the session's process.
pub(crate) trait ClaudeSessionAdvisorStore: Send + Sync {
    /// Keeps `advisor_model` (`None` for no advisor) as `session_id`'s own advisor unless the
    /// session's advisor was already set. Fails when the write fails.
    fn record_resolved(
        &self,
        session_id: SessionId,
        advisor_model: Option<String>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
