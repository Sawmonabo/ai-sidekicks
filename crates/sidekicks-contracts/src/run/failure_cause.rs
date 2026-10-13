//! Why a run failed, as `run.failed` records it: one closed union of causes, each provider's own
//! normalized into it by its driver, so a reload redraws the run's last row from the cause alone.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::DRIVER_WIRE_HANDLE_MAX_LEN;
use crate::provider::driver::usage_limit::{
    ProviderUsageLimitCause, ProviderUsageLimitResetBoundary, RetriesExhausted,
};
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::literal;
use crate::wire::text::FreeFormText;

literal! {
    /// The `cause` of a refused turn.
    pub enum RefusedCauseKind = "refused";
    /// The `cause` of a setup gate's failure.
    pub enum SetupFailedCauseKind = "setup-failed";
    /// The `cause` of a turn too long for the context window.
    pub enum ContextWindowExceededCauseKind = "context-window-exceeded";
    /// The `cause` of a turn on flex that found no flex capacity.
    pub enum FlexCapacityUnavailableCauseKind = "flex-capacity-unavailable";
    /// The `origin` of a cause the driver normalized from the provider's own.
    pub enum ProviderFailureOrigin = "provider";
    /// The `origin` of a cause the app's own refusal or failure produced.
    pub enum DaemonFailureOrigin = "daemon";
}

/// Who ended a refused turn: the provider, whose cause the driver normalized, or the app's own
/// refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunRefusedOrigin {
    /// The provider's safety check refused it.
    Provider,
    /// The app's own refusal ended it.
    Daemon,
}

/// A turn the provider's safety check refused with no other model to take it: the refusing model,
/// and the provider's own sentence, explanation and check category when it sends them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RunRefusedCause {
    /// Always `refused`.
    pub cause: RefusedCauseKind,
    /// Who ended the turn.
    pub origin: RunRefusedOrigin,
    /// The refusing model.
    pub model: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    /// The provider's own sentence, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    pub sentence: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    /// The provider's explanation, shown verbatim, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    pub explanation: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    /// The provider's open safety category, such as `cyber`, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>")]
    pub safety_category: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
}

/// The provider's usage limit, with the reset boundary its driver held when the turn failed, so
/// `Limit reached · resets at <time>` is redrawn from this record alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct RunUsageLimitCause {
    /// Why the provider refused for spend.
    pub cause: ProviderUsageLimitCause,
    /// Always `provider`.
    pub origin: ProviderFailureOrigin,
    /// When the spent window resets; absent when no reset instant was known.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderUsageLimitResetBoundary")]
    #[garde(dive)]
    pub reset_boundary: Option<ProviderUsageLimitResetBoundary>,
}

/// The provider's own retries ran out: it did not answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RunRetriesExhaustedCause {
    /// Always `retries-exhausted`.
    pub cause: RetriesExhausted,
    /// Always `provider`.
    pub origin: ProviderFailureOrigin,
}

/// A setup gate's throw before the provider started the run, which ends it `starting -> failed`:
/// the error's code when the gate threw a coded error, and its own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RunSetupFailedCause {
    /// Always `setup-failed`.
    pub cause: SetupFailedCauseKind,
    /// Always `daemon`.
    pub origin: DaemonFailureOrigin,
    /// The gate's error code, such as `workspace.execution_root_unresolved`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>")]
    pub code: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
    /// The gate's own words.
    pub message: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
}

/// A turn too long for the context window even after compaction, cut back out of the
/// conversation: the person's message goes back to the composer as a failed send.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RunContextWindowExceededCause {
    /// Always `context-window-exceeded`.
    pub cause: ContextWindowExceededCauseKind,
    /// Always `provider`.
    pub origin: ProviderFailureOrigin,
    /// The message that goes back to the composer.
    pub returned_message_id: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
}

/// A turn sent on the flex speed that the provider failed for want of flex capacity, which it does
/// not retry: the same turn can go again on flex, or once on the standard speed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RunFlexCapacityUnavailableCause {
    /// Always `flex-capacity-unavailable`.
    pub cause: FlexCapacityUnavailableCauseKind,
    /// Always `provider`.
    pub origin: ProviderFailureOrigin,
}

/// Why a run failed, on `run.failed`: the refusal, the provider's usage limit, the provider's spent
/// retries, a setup gate's failure, a turn too long for the context window, or no flex capacity
/// for a turn on flex. A reload redraws the run's last row from this cause alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum RunFailureCause {
    /// The refusal.
    Refused(RunRefusedCause),
    /// The usage limit.
    UsageLimit(#[garde(dive)] RunUsageLimitCause),
    /// The spent retries.
    RetriesExhausted(RunRetriesExhaustedCause),
    /// The setup gate's failure.
    SetupFailed(RunSetupFailedCause),
    /// The turn too long for the window.
    ContextWindowExceeded(RunContextWindowExceededCause),
    /// No flex capacity.
    FlexCapacityUnavailable(RunFlexCapacityUnavailableCause),
}

/// The TypeScript module of a run's failure cause.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/failure-cause",
    doc: "Why a run failed, as `run.failed` records it: one closed union of causes, each \
          provider's own normalized into it by its driver.",
    definitions: &[
        Definition::read::<RunRefusedOrigin>(),
        Definition::read::<RunFailureCause>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
