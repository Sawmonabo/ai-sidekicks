//! The usage-limit signal and the spent-retries signal a driver hands over with a turn's end, which
//! a failed run's cause carries. A driver sends a usage-limit signal only when a structured event
//! its provider sends says the allowance is spent; prose, an exit code or a bare HTTP status never
//! count, and an unrecognized shape sends nothing. A usage-limit signal names the account and
//! credential generation it was reached on, which its consumers key on.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::provider::account::record::{CredentialGeneration, ProviderAccountId};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;

/// Why a provider refused for spend, on an axis apart from the recovery condition. Only the plan's
/// allowance for a rolling window clears on its own; a spent credit balance, a payment fault or a
/// spending ceiling needs a person, so such a turn ends on the driver's ordinary failure path.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum ProviderUsageLimitCause {
    /// The subscription's allowance for a rolling window is spent.
    PlanAllowanceExhausted,
}

ts_constants! {
    /// Every usage-limit cause.
    PROVIDER_USAGE_LIMIT_CAUSES = ProviderUsageLimitCause::VARIANTS;
}

/// The instant the provider named for the spent window to reset.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUsageLimitResetBoundary {
    /// When the window resets.
    #[garde(dive)]
    pub resets_at: WireInstant,
}

/// A recognized usage-limit refusal, on the account and credential generation of the conversation
/// that met it. A missing boundary means no reset instant was seen, so no resume is scheduled; it
/// does not mean the provider publishes none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUsageLimitSignal {
    /// Why the provider refused.
    #[garde(skip)]
    pub cause: ProviderUsageLimitCause,
    /// The account whose allowance is spent: the one the conversation ran on.
    #[garde(skip)]
    pub provider_account_id: ProviderAccountId,
    /// The account's credential generation when the limit was met, so a signal from before a
    /// sign-in again reads as stale.
    #[garde(skip)]
    pub credential_generation: CredentialGeneration,
    /// When the spent window resets, where the provider named it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderUsageLimitResetBoundary")]
    #[garde(dive)]
    pub reset_boundary: Option<ProviderUsageLimitResetBoundary>,
}

/// The cause a spent-retries signal carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum RetriesExhausted {
    /// The provider's own retries ran out.
    RetriesExhausted,
}

/// A turn that ended because the provider's own retries ran out: the provider did not answer.
/// Nothing clears on its own, so no reset boundary rides it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSpentRetriesSignal {
    /// Always `retriesExhausted`.
    pub cause: RetriesExhausted,
}

/// The TypeScript module of the provider's spend signals.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/usage-limit",
    doc: "The usage-limit signal and the spent-retries signal a driver hands over with a turn's \
          end, which a failed run's cause carries.",
    definitions: &[
        Definition::read::<ProviderUsageLimitCause>().checked(),
        Definition::read::<ProviderUsageLimitResetBoundary>().checked(),
        Definition::read::<ProviderUsageLimitSignal>(),
        Definition::read::<ProviderSpentRetriesSignal>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
