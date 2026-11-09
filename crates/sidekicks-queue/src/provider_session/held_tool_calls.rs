//! The tool calls a resting session held in the background when the daemon restarted or stopped,
//! handed to the driver of the session's stored leg to settle before any session resumes; and the
//! open held calls of the turns an undo cuts, handed to the opened session's driver to end stopped
//! before the cut.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::session_control::{HeldCallsSettle, SettleHeldToolCallsParams};
use sidekicks_provider::port::held_tool_calls::HeldToolCall;
use sidekicks_session::run::held_tool_calls::read_held_tool_calls;
use sidekicks_store::database::connection::read_pool::ReadLength;
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

    /// Hands the opened `session_id`'s driver the open held calls of the turns an undo cuts, those
    /// opened after `after_sequence`, the undo's point message, to end stopped on the session's
    /// live process, under the session's transition lock; answers at once when none is open. Each
    /// close is in the log once the driver answers, which one read of the same calls proves. Fails
    /// with [`ProviderSessionError::NotOpen`] for a session this daemon has not opened,
    /// [`ProviderSessionError::NoConversation`] for one whose leg names no conversation,
    /// [`ProviderSessionError::HeldCallsOpen`] naming each call still open after the settle, and as
    /// the reads and the driver fail.
    pub async fn settle_cut_held_tool_calls(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        let provider = self
            .lock_opened()
            .get(&session_id)
            .map(|opened| opened.provider.clone())
            .ok_or(ProviderSessionError::NotOpen { session_id })?;
        let driver = self.deps.providers.lookup(&provider)?;
        let calls = self.read_open_cut_calls(session_id, after_sequence).await?;
        if calls.is_empty() {
            return Ok(());
        }
        let stored = self
            .read_stored_conversation(session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        let named: Vec<_> = calls.iter().map(|call| call.tool_call_id.clone()).collect();
        driver
            .settle_held_tool_calls(SettleHeldToolCallsParams {
                session_id,
                provider_account_id: stored.provider_account_id,
                conversation: stored.conversation,
                runtime_metadata: stored.runtime_metadata,
                settle: HeldCallsSettle::Undo { calls },
            })
            .await?;
        let tool_call_ids: Vec<_> = self
            .read_open_cut_calls(session_id, after_sequence)
            .await?
            .into_iter()
            .map(|call| call.tool_call_id)
            .filter(|tool_call_id| named.contains(tool_call_id))
            .collect();
        if tool_call_ids.is_empty() {
            Ok(())
        } else {
            Err(ProviderSessionError::HeldCallsOpen {
                session_id,
                tool_call_ids,
            })
        }
    }

    // `session_id`'s held calls opened after `after_sequence` that are still open in its log.
    async fn read_open_cut_calls(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> Result<Vec<HeldToolCall>, ProviderSessionError> {
        let calls = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(read_held_tool_calls(
                    reader,
                    &session_id,
                    Some(after_sequence),
                )?)
            })
            .await?;
        Ok(calls
            .into_iter()
            .filter(|call| call.end_cause.is_none())
            .collect())
    }
}
