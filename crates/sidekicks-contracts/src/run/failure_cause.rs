//! Why a run failed, as `agent.run.failed` records it: one closed union of causes, each provider's
//! own normalized into it by its driver, so a reload redraws the run's last row from the cause
//! alone.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::account::record::{CredentialGeneration, ProviderAccountId};
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::provider::driver::usage_limit::ProviderUsageLimitResetBoundary;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::literal;
use crate::wire::text::FreeFormText;

literal! {
    /// The `origin` of a cause the driver normalized from the provider's own.
    pub enum ProviderFailureOrigin = "provider";
    /// The `origin` of a cause the app's own refusal or failure produced.
    pub enum DaemonFailureOrigin = "daemon";
}

/// Who ended a refused turn: the provider, whose cause the driver normalized, or the app's own
/// refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunRefusedOrigin {
    /// The provider's safety check refused it.
    Provider,
    /// The app's own refusal ended it.
    Daemon,
}

/// Why a run failed, on `agent.run.failed`, discriminated on `cause`: the refusal, the provider's
/// usage limit, the provider's spent retries, a setup gate's failure, a turn too long for the
/// context window, or no flex capacity for a turn on flex. A reload redraws the run's last row from
/// this cause alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "cause",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum RunFailureCause {
    /// A turn the provider's safety check refused with no other model to take it: the refusing
    /// model, and the provider's own sentence, explanation and check category when it sends them.
    Refused {
        /// Who ended the turn.
        origin: RunRefusedOrigin,
        /// The refusing model.
        model: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
        /// The provider's own sentence, where it sent one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
        sentence: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
        /// The provider's explanation, shown verbatim, where it sent one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
        explanation: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
        /// The provider's open safety category, such as `cyber`, where it sent one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
        safety_category: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    },
    /// The subscription's allowance for a rolling window is spent, the provider's usage limit
    /// (`ProviderUsageLimitCause::PlanAllowanceExhausted`), on the account and credential
    /// generation the run's conversation ran on, with the reset boundary its driver held when the
    /// turn failed, so `Limit reached · resets at <time>` is redrawn from this record alone.
    PlanAllowanceExhausted {
        /// Always `provider`.
        origin: ProviderFailureOrigin,
        /// The account whose allowance is spent.
        provider_account_id: ProviderAccountId,
        /// The account's credential generation when the limit was met.
        credential_generation: CredentialGeneration,
        /// When the spent window resets; absent when no reset instant was known.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderUsageLimitResetBoundary")]
        #[garde(dive)]
        reset_boundary: Option<ProviderUsageLimitResetBoundary>,
    },
    /// The provider's own retries ran out: it did not answer.
    RetriesExhausted {
        /// Always `provider`.
        origin: ProviderFailureOrigin,
    },
    /// A setup gate's throw before the provider started the run, which ends it
    /// `starting -> failed`: the error's code when the gate threw a coded error, and its own words.
    SetupFailed {
        /// Always `daemon`.
        origin: DaemonFailureOrigin,
        /// The gate's error code, such as `workspace.executionRoot.unresolved`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
        code: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
        /// The gate's own words.
        message: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// A turn too long for the context window even after compaction, cut back out of the
    /// conversation: the person's message goes back to the composer as a failed send.
    ContextWindowExceeded {
        /// Always `provider`.
        origin: ProviderFailureOrigin,
        /// The message that goes back to the composer.
        returned_message_id: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    },
    /// A turn sent on the flex speed that the provider failed for want of flex capacity, which it
    /// does not retry: the same turn can go again on flex, or once on the standard speed.
    FlexCapacityUnavailable {
        /// Always `provider`.
        origin: ProviderFailureOrigin,
    },
}

/// The TypeScript module of a run's failure cause.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/failure-cause",
    doc: "Why a run failed, as `agent.run.failed` records it: one closed union of causes, each \
          provider's own normalized into it by its driver.",
    definitions: &[
        Definition::read::<RunRefusedOrigin>(),
        Definition::read::<RunFailureCause>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
