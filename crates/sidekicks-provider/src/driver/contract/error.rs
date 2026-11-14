//! The driver's error: why a driver operation did not answer, how it reaches a handler, and the
//! failure text it carries.

use std::error::Error;
use std::io;
use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::redaction::scrub_credentials;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::capability::probe::CapabilityProbeError;
use crate::driver::contract::sign_in::{NoPersonServerEntry, ProviderSignInFailure};
use crate::driver::error_causes::{
    ExecutableUnresolvable, ModelCatalogUnreadable, ProviderAxisInvalid, RequestUnanswered,
};
use crate::driver::run_control::{DriverRunRefusal, SteerTurnEndedError};
use crate::port::permission_ask::ProviderRuleNotKeptError;
use crate::runtime_binding::store::RuntimeBindingStoreError;

/// The fixed sentence every `provider.capability.unsupported` refusal carries.
pub(crate) const PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE: &str =
    "Requested capability is not supported by the driver";

/// Why a driver operation did not answer: a refusal a client reads by its code, a request the
/// provider got with no answer back, a steer whose turn ended before it was sent (the message
/// waits for the next turn), a run start the driver refused, a provider command that names no
/// runnable build, or a failure inside the driver, keeping its cause.
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    /// A refusal a client reads by its code.
    #[error(transparent)]
    Refused(Box<DomainError>),
    /// The request went out and no answer came, so the provider may still act on it.
    #[error(transparent)]
    Unanswered(Box<RequestUnanswered>),
    /// The turn a steer or a waiting continue was handed for ended before the message was sent.
    #[error(transparent)]
    SteerTurnEnded(#[from] SteerTurnEndedError),
    /// The driver refused a run's start before its provider saw it; the run fails as that refusal.
    #[error("the driver refused the run")]
    RunRefused(#[source] DriverRunRefusal),
    /// The capability probe could not read the provider, so nothing is declared from it.
    #[error("the provider's capability probe failed")]
    CapabilityProbe(#[source] CapabilityProbeError),
    /// The configured provider command names no runnable build.
    #[error(transparent)]
    ExecutableUnresolvable(Box<ExecutableUnresolvable>),
    /// The provider's model catalog reply could not be read, so no catalog is declared from it.
    #[error(transparent)]
    ModelCatalogUnreadable(Box<ModelCatalogUnreadable>),
    /// A provider axis the request set holds a value the provider does not offer now.
    #[error(transparent)]
    ProviderAxisInvalid(Box<ProviderAxisInvalid>),
    /// The answer reached the provider, which could not keep the rule it made.
    #[error(transparent)]
    RuleNotKept(#[from] ProviderRuleNotKeptError),
    /// A skill pick the provider's own list does not name in its folder; the run queue refuses
    /// the send for it.
    #[error("the provider does not list skill {} in {}", .0.name.as_str(), .0.folder_path.as_str())]
    SkillNotListed(QueuedSkillPick),
    /// An MCP sign-in through the provider's own client was asked for a binding with no entry of
    /// the person's.
    #[error(transparent)]
    NoPersonServerEntry(Box<NoPersonServerEntry>),
    /// An MCP sign-in through the provider's own client ended without a sign-in, for this kind of
    /// reason.
    #[error("the provider's own MCP sign-in did not sign in")]
    SignInFailed(#[source] ProviderSignInFailure),
    /// The driver or its provider failed.
    #[error("the provider driver failed")]
    Internal(#[source] Box<dyn Error + Send + Sync>),
}

// The large payloads are boxed so every `Result` carrying the error stays small.
const _: () = assert!(size_of::<DriverError>() <= 64);

impl DriverError {
    /// `failure`, which several waiters share, as one of them answers it: a refusal, a request
    /// with no answer and a command that names no runnable build under their own code, words and
    /// detail, any other failure as the driver's own, each with the shared failure underneath.
    pub(crate) fn shared(failure: &Arc<DriverError>) -> Self {
        let underneath = || -> Box<dyn Error + Send + Sync> {
            Box::new(SharedDriverFailure(Arc::clone(failure)))
        };
        match &**failure {
            Self::Refused(refusal) => Self::from(copy_refusal(refusal).with_source(underneath())),
            Self::Unanswered(unanswered) => Self::from(RequestUnanswered {
                refusal: copy_refusal(&unanswered.refusal).with_source(underneath()),
            }),
            Self::ExecutableUnresolvable(unresolvable) => Self::from(ExecutableUnresolvable {
                provider: unresolvable.provider.clone(),
                requested_command: unresolvable.requested_command.clone(),
                is_typed_path: unresolvable.is_typed_path,
                is_build_found: unresolvable.is_build_found,
                cause: io::Error::new(unresolvable.cause.kind(), underneath()),
            }),
            Self::SteerTurnEnded(_)
            | Self::RunRefused(_)
            | Self::CapabilityProbe(_)
            | Self::ModelCatalogUnreadable(_)
            | Self::ProviderAxisInvalid(_)
            | Self::RuleNotKept(_)
            | Self::SkillNotListed(_)
            | Self::NoPersonServerEntry(_)
            | Self::SignInFailed(_)
            | Self::Internal(_) => Self::Internal(underneath()),
        }
    }
}

// One failure several waiters share, under each waiter's own answer.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
struct SharedDriverFailure(Arc<DriverError>);

// `refusal`'s words, code and detail, with no failure underneath.
fn copy_refusal(refusal: &DomainError) -> DomainError {
    let mut copy = DomainError::new(refusal.message.clone(), refusal.code);
    copy.detail.clone_from(&refusal.detail);
    copy
}

impl From<DomainError> for DriverError {
    fn from(refusal: DomainError) -> Self {
        Self::Refused(Box::new(refusal))
    }
}

impl From<RequestUnanswered> for DriverError {
    fn from(unanswered: RequestUnanswered) -> Self {
        Self::Unanswered(Box::new(unanswered))
    }
}

impl From<ExecutableUnresolvable> for DriverError {
    fn from(unresolvable: ExecutableUnresolvable) -> Self {
        Self::ExecutableUnresolvable(Box::new(unresolvable))
    }
}

impl From<ModelCatalogUnreadable> for DriverError {
    fn from(unreadable: ModelCatalogUnreadable) -> Self {
        Self::ModelCatalogUnreadable(Box::new(unreadable))
    }
}

impl From<ProviderAxisInvalid> for DriverError {
    fn from(invalid: ProviderAxisInvalid) -> Self {
        Self::ProviderAxisInvalid(Box::new(invalid))
    }
}

impl From<NoPersonServerEntry> for DriverError {
    fn from(no_entry: NoPersonServerEntry) -> Self {
        Self::NoPersonServerEntry(Box::new(no_entry))
    }
}

impl From<ProviderSignInFailure> for DriverError {
    fn from(failure: ProviderSignInFailure) -> Self {
        Self::SignInFailed(failure)
    }
}

impl From<RuntimeBindingStoreError> for DriverError {
    /// A driver's read of the daemon's stored bindings that failed is the driver's own failure.
    fn from(error: RuntimeBindingStoreError) -> Self {
        Self::Internal(Box::new(error))
    }
}

impl From<DriverError> for HandlerError {
    /// A driver's refusal, and a request that got no answer, answer the call by the refusal's
    /// code; a failed capability probe and an unreadable model catalog answer
    /// `provider.unavailable`, the catalog's bounded fault as the provider failure's detail, and a
    /// command that names no runnable build as `ExecutableUnresolvable::into_refusal` says; a
    /// provider axis the provider does not offer answers `agent.providerAxisInvalid` naming the
    /// agent, the axis and the value; a steer whose turn ended, a refused run start, a rule the
    /// provider could not keep, a skill pick it does not list, an MCP sign-in binding with no entry
    /// of the person's or a provider's own MCP sign-in that did not sign in, reaching a handler, is
    /// a fault in the daemon, as is the driver's own failure.
    fn from(error: DriverError) -> Self {
        match error {
            DriverError::Refused(refusal) => Self::Refused(*refusal),
            DriverError::Unanswered(unanswered) => Self::Refused(unanswered.refusal),
            DriverError::CapabilityProbe(probe) => Self::Refused(
                DomainError::new(
                    "The provider's capabilities could not be read",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({ "providerFailureDetail": probe.to_string() }))
                .with_source(probe),
            ),
            DriverError::ExecutableUnresolvable(unresolvable) => {
                Self::Refused((*unresolvable).into_refusal())
            }
            DriverError::ModelCatalogUnreadable(unreadable) => Self::Refused(
                DomainError::new(
                    "The provider's model catalog could not be read",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({
                    "providerId": unreadable.provider.as_str(),
                    "providerFailureDetail": unreadable.detail.as_str(),
                }))
                .with_source(*unreadable),
            ),
            DriverError::ProviderAxisInvalid(invalid) => Self::Refused(
                DomainError::new(
                    "The provider does not offer this value now",
                    RefusalCode::AgentProviderAxisInvalid,
                )
                .with_detail(json!({
                    "agentId": invalid.agent_id,
                    "axis": <&str>::from(invalid.axis),
                    "value": invalid.value,
                })),
            ),
            DriverError::SteerTurnEnded(steer) => Self::Internal(Box::new(steer)),
            DriverError::RuleNotKept(not_kept) => Self::Internal(Box::new(not_kept)),
            DriverError::RunRefused(refusal) => Self::Internal(Box::new(refusal)),
            error @ DriverError::SkillNotListed(_) => Self::Internal(Box::new(error)),
            DriverError::NoPersonServerEntry(no_entry) => Self::Internal(no_entry),
            DriverError::SignInFailed(failure) => Self::Internal(Box::new(failure)),
            DriverError::Internal(fault) => Self::Internal(fault),
        }
    }
}

/// Fits failure text to a failure detail: every NUL dropped, ECMAScript whitespace trimmed from
/// both ends, cut to the cap in code points, and `empty_fallback` where nothing is left.
pub fn bound_failure_detail(
    detail: &str,
    empty_fallback: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
) -> FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN> {
    bound_provider_words(detail).unwrap_or(empty_fallback)
}

/// A provider's own words as a notice's or a row's text: any credential they quote masked, then
/// fitted to the failure-detail cap as [`bound_provider_words`] fits them; `None` where nothing is
/// left.
pub(crate) fn read_provider_words(
    words: &str,
) -> Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> {
    bound_provider_words(&scrub_credentials(words))
}

/// Fits a provider's words to text of at most `MAX` code points: every NUL dropped, ECMAScript
/// whitespace trimmed from both ends and the rest cut to the cap; `None` where nothing is left.
pub fn bound_provider_words<const MAX: usize>(words: &str) -> Option<FreeFormText<MAX>> {
    let without_nuls = words.replace('\0', "");
    let trimmed = without_nuls.trim_matches(is_ecmascript_whitespace);
    (!trimmed.is_empty()).then(|| {
        FreeFormText::new(cut_to_code_points(trimmed, MAX).to_owned())
            .expect("trimmed, NUL-free text cut to the cap is non-blank and within it")
    })
}
