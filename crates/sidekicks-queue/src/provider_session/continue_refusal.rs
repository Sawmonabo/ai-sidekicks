//! The notice a held lead's continue posts when its provider refused it: the session's provider
//! warning, a refusal, in the provider's own words, so every client reads why the person's answers
//! did not go on. The refusal itself stands.

use std::error::Error;

use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::session::controls::events::{ProviderWarningSource, SessionNotice};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::ProviderSessions;
use super::errors::ProviderSessionError;

impl ProviderSessions {
    /// Answers `failed`, why the continue of `session_id`'s held lead failed, once the session's
    /// provider warning carrying the provider's refusal is posted where `failed` is the provider's
    /// refusal, its answers given back or not; a notice that could not be written is logged.
    pub(super) async fn answer_failed_continue(
        &self,
        session_id: SessionId,
        failed: ProviderSessionError,
    ) -> ProviderSessionError {
        let Some(refusal) = failed.provider_refusal() else {
            return failed;
        };
        let notice = SessionNotice::ProviderWarning {
            session_id,
            source: ProviderWarningSource::Refusal,
            text: refusal.clone(),
            details: None,
        };
        if let Err(error) = self
            .append_notice(session_id, notice, Vec::new(), None)
            .await
        {
            tracing::warn!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "the notice of a refused continue could not be posted"
            );
        }
        failed
    }
}

impl ProviderSessionError {
    /// The provider's own words where this is its refusal of a resume, its answers given back or
    /// not; `None` for any other failure.
    pub fn provider_refusal(&self) -> Option<&FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> {
        if let Self::ResumeRefused {
            provider_failure_detail,
            ..
        } = self
        {
            return Some(provider_failure_detail);
        }
        if let Self::ContinueNotReleased { failed, .. } = self {
            return failed.provider_refusal();
        }
        None
    }
}
