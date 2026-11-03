//! The notice a held lead's continue posts when its provider refused it or failed to continue it:
//! the session's provider warning, a refusal, in the provider's own words, so every client reads
//! why the person's answers did not go on; and the category a failed continue halts its run under.
//! The failure itself stands.

use std::error::Error;
use std::sync::LazyLock;

use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::session::controls::events::{ProviderWarningSource, SessionNotice};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::error::bound_failure_detail;
use sidekicks_std::error_description::describe_error;

use super::ProviderSessions;
use super::errors::ProviderSessionError;
use super::provider_missing::is_provider_missing;

// The words a provider's failure to continue reads as where its own describe nothing.
static UNDESCRIBED_CONTINUE_FAILURE: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The provider could not continue the conversation.".to_owned())
            .expect("the fallback words are text")
    });

impl ProviderSessions {
    /// Answers `failed`, why the continue of `session_id`'s held lead failed, once the session's
    /// provider warning carrying the provider's words is posted where `failed` is the provider's
    /// refusal or its failure to continue, its answers given back or not; a missing provider's own
    /// notice names it instead, and a notice that could not be written is logged.
    pub(super) async fn answer_failed_continue(
        &self,
        session_id: SessionId,
        failed: ProviderSessionError,
    ) -> ProviderSessionError {
        let text = match (failed.provider_refusal(), failed.provider_failure()) {
            (Some(refusal), _) => refusal.clone(),
            (None, Some(failure)) if !is_provider_missing(failure) => bound_failure_detail(
                &describe_error(failure),
                UNDESCRIBED_CONTINUE_FAILURE.clone(),
            ),
            (None, Some(_) | None) => return failed,
        };
        let notice = SessionNotice::ProviderWarning {
            session_id,
            source: ProviderWarningSource::Refusal,
            text,
            details: None,
        };
        if let Err(error) = self
            .append_notice(session_id, notice, Vec::new(), None)
            .await
        {
            tracing::warn!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "the notice of a refused or failed continue could not be posted"
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

    /// The category a held lead's continue that failed with this halts its run under: none for the
    /// provider's refusal, which the session's notice carries, `providerFailure` where the
    /// provider failed to continue it, and `localPersistenceFailure` where a write of the daemon's
    /// own failed.
    pub fn continue_halt_category(&self) -> Option<RunFailureCategory> {
        if self.provider_refusal().is_some() {
            None
        } else if self.provider_failure().is_some() {
            Some(RunFailureCategory::ProviderFailure)
        } else {
            Some(RunFailureCategory::LocalPersistenceFailure)
        }
    }

    // The provider's failure to continue within this error, its answers given back or not: no
    // driver answers its provider, its driver failed the continue, or the session holds no
    // conversation to continue.
    fn provider_failure(&self) -> Option<&Self> {
        if let Self::ContinueNotReleased { failed, .. } = self {
            return failed.provider_failure();
        }
        matches!(
            self,
            Self::Provider(_)
                | Self::Driver(_)
                | Self::NoConversation { .. }
                | Self::NotResumable(_)
        )
        .then_some(self)
    }
}
