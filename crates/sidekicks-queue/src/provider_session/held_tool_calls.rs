//! The tool calls a resting session held in the background when the daemon restarted, handed to
//! the driver of the session's stored leg to settle before any session resumes.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::session_control::SettleHeldToolCallsParams;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::schema::session_directory::read_session_state_through;

use crate::provider_session::ProviderSessions;
use crate::provider_session::errors::ProviderSessionError;

impl ProviderSessions {
    /// Hands the driver of `session_id`'s stored leg the calls the session held in the background
    /// when the daemon restarted, on the leg's account and conversation, under the session's
    /// transition lock, so a resume and the settle never overlap. Answers at once for a session
    /// this daemon already opened, whose process's resume rebuilt its calls, for one being deleted,
    /// and for one with no conversation. Fails as the reads fail, with
    /// [`ProviderSessionError::Provider`] when no driver answers the leg's provider, and as the
    /// driver fails.
    pub async fn settle_held_tool_calls(
        &self,
        session_id: SessionId,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        if self.lock_opened().contains_key(&session_id) {
            return Ok(());
        }
        let is_closed =
            match read_session_state_through::<ProviderSessionError>(&self.deps.pool, session_id)
                .await?
            {
                Some(SessionState::PurgeRequested) => return Ok(()),
                Some(SessionState::Closed) => true,
                Some(
                    SessionState::Provisioning | SessionState::Active | SessionState::Archived,
                )
                | None => false,
            };
        let Some(leg) = read_session_leg(&self.deps.pool, session_id).await? else {
            return Ok(());
        };
        let Some(conversation) = leg.resume_handle else {
            return Ok(());
        };
        let driver = self.deps.providers.lookup(&leg.provider_name)?;
        driver
            .settle_held_tool_calls(SettleHeldToolCallsParams {
                session_id,
                provider_account_id: leg.spawn_config.provider_account_id,
                conversation,
                runtime_metadata: leg.runtime_metadata,
                is_closed,
            })
            .await?;
        Ok(())
    }
}
