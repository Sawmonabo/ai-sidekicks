//! The turns a restart kept running on a provider, in a session the start does not resume, handed
//! to the driver of the session's leg to end there.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::session_control::{
    EndKeptTurnsParams, KeptRunTurns, KeptTurnsEnding,
};
use tokio_util::sync::CancellationToken;

use crate::provider_session::ProviderSessions;
use crate::provider_session::errors::ProviderSessionError;

impl ProviderSessions {
    /// Hands `runs`, the turns a restart kept in `session_id`, to the driver of the session's
    /// stored leg, on the leg's account and conversation, to end under `stop`; a session with no
    /// conversation holds no turn, and answers at once with an ending already ended. Answers once
    /// the driver holds the session for the work, with the driver's ending of that work. Fails as
    /// the leg's read fails, with [`ProviderSessionError::Provider`] when no driver answers its
    /// provider, and as the driver fails.
    pub async fn end_kept_turns(
        &self,
        session_id: SessionId,
        runs: Vec<KeptRunTurns>,
        stop: CancellationToken,
    ) -> Result<KeptTurnsEnding, ProviderSessionError> {
        let Some(stored) = self.read_stored_conversation(session_id).await? else {
            return Ok(KeptTurnsEnding::ended_now());
        };
        Ok(stored
            .driver
            .end_kept_turns(EndKeptTurnsParams {
                session_id,
                provider_account_id: stored.provider_account_id,
                conversation: stored.conversation,
                runtime_metadata: stored.runtime_metadata,
                runs,
                stop,
            })
            .await?)
    }
}
