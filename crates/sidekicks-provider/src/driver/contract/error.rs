//! The driver's error: why a driver operation did not answer, how it reaches a handler, and the
//! failure text it carries.

use std::error::Error;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::capability::probe::CapabilityProbeError;
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
    Refused(#[from] DomainError),
    /// The request went out and no answer came, so the provider may still act on it.
    #[error(transparent)]
    Unanswered(RequestUnanswered),
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
    ExecutableUnresolvable(ExecutableUnresolvable),
    /// The provider's model catalog reply could not be read, so no catalog is declared from it.
    #[error(transparent)]
    ModelCatalogUnreadable(ModelCatalogUnreadable),
    /// A provider axis the request set holds a value the provider does not offer now.
    #[error(transparent)]
    ProviderAxisInvalid(ProviderAxisInvalid),
    /// The answer reached the provider, which could not keep the rule it made.
    #[error(transparent)]
    RuleNotKept(#[from] ProviderRuleNotKeptError),
    /// A skill pick the provider's own list does not name in its folder; the run queue refuses
    /// the send for it.
    #[error("the provider does not list skill {} in {}", .0.name.as_str(), .0.folder_path.as_str())]
    SkillNotListed(QueuedSkillPick),
    /// The driver or its provider failed.
    #[error("the provider driver failed")]
    Internal(#[source] Box<dyn Error + Send + Sync>),
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
    /// provider could not keep or a skill pick it does not list, reaching a handler, is a fault in
    /// the daemon, as is the driver's own failure.
    fn from(error: DriverError) -> Self {
        match error {
            DriverError::Refused(refusal)
            | DriverError::Unanswered(RequestUnanswered { refusal }) => Self::Refused(refusal),
            DriverError::CapabilityProbe(probe) => Self::Refused(
                DomainError::new(
                    "The provider's capabilities could not be read",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({ "providerFailureDetail": probe.to_string() }))
                .with_source(probe),
            ),
            DriverError::ExecutableUnresolvable(unresolvable) => {
                Self::Refused(unresolvable.into_refusal())
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
                .with_source(unreadable),
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
    let without_nuls = detail.replace('\0', "");
    let trimmed = without_nuls.trim_matches(is_ecmascript_whitespace);
    if trimmed.is_empty() {
        return empty_fallback;
    }
    FreeFormText::new(cut_to_code_points(trimmed, PROVIDER_FAILURE_DETAIL_MAX_LEN).to_owned())
        .expect("trimmed, NUL-free text cut to the cap is non-blank and within it")
}
