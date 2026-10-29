//! `session.restart`: starts a session's provider process again after it ended and stayed down,
//! resuming its conversation through the provider's own resume, under a binding the provider
//! sessions mint, open and record as an opening's resume does. The driver clears its crash count,
//! announces the provider is back once it runs, and on a process several sessions share brings
//! back every session it held.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionRestart, SessionTargetRequest};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_queue::provider_session::{ProviderSessionError, ProviderSessions};

/// Registers `session.restart` over `provider_sessions`, which run each restart under the
/// session's transition lock, so none brings a process up while a close is ending the session or
/// after it. A closed session is refused `session.alreadyClosed` and one being deleted
/// `session.changeRefused`, the driver never called; a session with no conversation to resume
/// `session.notFound`, a provider no driver answers `provider.notFound`, a driver that cannot
/// resume `provider.capability.unsupported` (the driver never called), a resume the provider
/// refused for its sign-in `provider.account.notAuthenticated`, and any other resume it could not
/// make `provider.unavailable`. Fails the start when the method is already registered.
pub(crate) fn register_session_restart(
    registry: &mut MethodRegistryBuilder,
    provider_sessions: Arc<ProviderSessions>,
) -> Result<(), RegistrationError> {
    registry.register::<SessionRestart, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let provider_sessions = Arc::clone(&provider_sessions);
            async move {
                let session_id = request.session_id;
                provider_sessions
                    .restart(session_id)
                    .await
                    .map_err(|error| restart_failure(error, session_id))?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}

// The answer to a restart of `session_id` that failed with `error`: `session.notFound` for a
// session with no conversation, the provider's refusal of its resume by why it refused, and
// otherwise as the provider sessions answer.
fn restart_failure(error: ProviderSessionError, session_id: SessionId) -> HandlerError {
    match error {
        ProviderSessionError::NoConversation { .. } => session_not_found(&session_id).into(),
        ProviderSessionError::ResumeRefused {
            provider,
            recovery_condition: RecoveryCondition::ReauthRequired,
            provider_failure_detail,
            ..
        } => DomainError::new(
            "The provider refused the account's sign-in",
            RefusalCode::ProviderAccountNotAuthenticated,
        )
        .with_detail(json!({
            "providerId": provider,
            "providerFailureDetail": provider_failure_detail,
        }))
        .into(),
        ProviderSessionError::ResumeRefused {
            provider,
            recovery_condition: recovery_condition @ RecoveryCondition::RecoveryNeeded,
            provider_failure_detail,
            ..
        } => DomainError::new(
            "The provider could not restart the session",
            RefusalCode::ProviderUnavailable,
        )
        .with_detail(json!({
            "providerId": provider,
            "recoveryCondition": recovery_condition,
            "providerFailureDetail": provider_failure_detail,
        }))
        .into(),
        other @ (ProviderSessionError::Compose { .. }
        | ProviderSessionError::AdmittedAccount(_)
        | ProviderSessionError::NoPosture { .. }
        | ProviderSessionError::NoContractVersion { .. }
        | ProviderSessionError::Provider(_)
        | ProviderSessionError::Driver(_)
        | ProviderSessionError::NotResumable(_)
        | ProviderSessionError::Closed { .. }
        | ProviderSessionError::BeingDeleted { .. }
        | ProviderSessionError::NotOpen { .. }
        | ProviderSessionError::Cursor(_)
        | ProviderSessionError::UnrecordedNotClosed { .. }
        | ProviderSessionError::Store(_)
        | ProviderSessionError::PostureRefused { .. }
        | ProviderSessionError::GitFolder { .. }
        | ProviderSessionError::LevelNotStored { .. }
        | ProviderSessionError::LevelNotMovedBack { .. }
        | ProviderSessionError::ModeNotStored { .. }
        | ProviderSessionError::ModeNotMovedBack { .. }
        | ProviderSessionError::Read(_)
        | ProviderSessionError::Pool(_)) => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_queue::provider_session::ProviderSessionError;

    use super::restart_failure;

    const SESSION: &str = "0b7f3c1e-9a52-4d6b-8e21-5f4c7d9a1b30";

    /// What a restart failed with, before the handler answers it.
    #[derive(Clone, Copy, Debug)]
    enum Failure {
        /// The session has no conversation to resume.
        NoConversation,
        /// The provider refused the resume with this condition.
        ResumeRefused(RecoveryCondition),
    }

    // Each failure the handler maps answers its own refusal, with the provider and its words:
    // killed by a session with no conversation answered as a fault, and by the two conditions
    // answered alike or as a fault.
    #[rstest]
    #[case::no_conversation(
        Failure::NoConversation,
        RefusalCode::SessionNotFound,
        json!({ "sessionId": SESSION })
    )]
    #[case::resume_failed(
        Failure::ResumeRefused(RecoveryCondition::RecoveryNeeded),
        RefusalCode::ProviderUnavailable,
        json!({
            "providerId": PROVIDERS[0].id,
            "recoveryCondition": "recoveryNeeded",
            "providerFailureDetail": "the process exited",
        })
    )]
    #[case::sign_in_refused(
        Failure::ResumeRefused(RecoveryCondition::ReauthRequired),
        RefusalCode::ProviderAccountNotAuthenticated,
        json!({
            "providerId": PROVIDERS[0].id,
            "providerFailureDetail": "the process exited",
        })
    )]
    fn a_failed_restart_answers_its_refusal(
        #[case] failure: Failure,
        #[case] code: RefusalCode,
        #[case] fields: Value,
    ) {
        let session_id = SessionId::new(SESSION).expect("the id is a UUID");
        let error = match failure {
            Failure::NoConversation => ProviderSessionError::NoConversation { session_id },
            Failure::ResumeRefused(recovery_condition) => ProviderSessionError::ResumeRefused {
                session_id,
                provider: ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id"),
                recovery_condition,
                provider_failure_detail: FreeFormText::new("the process exited".to_owned())
                    .expect("the detail is valid text"),
            },
        };

        let refusal = match restart_failure(error, session_id) {
            HandlerError::Refused(refusal) => refusal,
            other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
                panic!("expected a refusal, got {other:?}")
            }
        };

        assert_eq!(refusal.code, code, "{failure:?}");
        assert_eq!(
            Value::Object(refusal.detail.expect("the refusal carries fields")),
            fields,
            "{failure:?}"
        );
    }
}
