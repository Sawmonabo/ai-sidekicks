//! The tool calls a resting session held in the background when the daemon restarted or stopped,
//! handed to the driver of the session's stored leg to settle before any session resumes.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::session_control::{HeldCallsSettle, SettleHeldToolCallsParams};
use sidekicks_store::database::schema::session_directory::read_session_state_through;

use crate::provider_session::ProviderSessions;
use crate::provider_session::errors::ProviderSessionError;

impl ProviderSessions {
    /// Hands the driver of `session_id`'s stored leg the calls the session held in the background
    /// when the daemon restarted, or stopped at the person's Stop when `is_under_stop`, on the leg's
    /// account and conversation, under the session's transition lock, so a resume and the settle
    /// never overlap; a closed session's calls settle as closed either way. Answers at once for a
    /// session this daemon already opened, whose process's resume rebuilt its calls, for one being
    /// deleted, and for one with no conversation. Fails as the reads fail, with
    /// [`ProviderSessionError::Provider`] when no driver answers the leg's provider, and as the
    /// driver fails.
    pub async fn settle_held_tool_calls(
        &self,
        session_id: SessionId,
        is_under_stop: bool,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        if self.is_opened(session_id) {
            return Ok(());
        }
        let settle =
            match read_session_state_through::<ProviderSessionError>(&self.deps.pool, session_id)
                .await?
            {
                Some(SessionState::PurgeRequested) => return Ok(()),
                Some(SessionState::Closed) => HeldCallsSettle::Closed,
                Some(
                    SessionState::Provisioning | SessionState::Active | SessionState::Archived,
                )
                | None => {
                    if is_under_stop {
                        HeldCallsSettle::Stopped
                    } else {
                        HeldCallsSettle::Restarted
                    }
                }
            };
        let Some(stored) = self.read_stored_conversation(session_id).await? else {
            return Ok(());
        };
        stored
            .driver
            .settle_held_tool_calls(SettleHeldToolCallsParams {
                session_id,
                provider_account_id: stored.provider_account_id,
                conversation: stored.conversation,
                runtime_metadata: stored.runtime_metadata,
                settle,
            })
            .await?;
        Ok(())
    }
}
