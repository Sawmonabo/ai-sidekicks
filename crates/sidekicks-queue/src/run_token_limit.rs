//! The token limit a new lead run is admitted with, which the daemon reads from its configuration
//! and registers for the queue.

use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;

/// The limits reader, registered through a `PortRegistration`.
pub trait RunTokenLimitReader: Send + Sync {
    /// The `Tokens per run` a new lead run of `session_id` is admitted with; `None` is no limit.
    fn tokens_per_run(&self, session_id: SessionId) -> Option<TokensPerRun>;
}
