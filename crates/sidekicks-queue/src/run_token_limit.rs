//! The token limit a new lead run is admitted with, which the daemon reads from the session's own
//! limits, else its configuration, and registers for the queue.

use futures::future::BoxFuture;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;

use crate::error::QueueError;

/// The limits reader, registered through a `PortRegistration`.
pub trait RunTokenLimitReader: Send + Sync {
    /// The `Tokens per run` a new lead run of `session_id` is admitted with; `None` is no limit.
    /// Fails as the read of the session's limits fails.
    fn tokens_per_run(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<TokensPerRun>, QueueError>>;
}
