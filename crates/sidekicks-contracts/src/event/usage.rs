//! The payloads of the usage telemetry events: a turn's tokens, a priced request and the context
//! window (the three metered readings), an account's quota snapshot, a provider's retry, the
//! provider's compaction of a run's context, and its move of a turn onto another model.
//!
//! The metered readings share the members the session, the run, the model and the subagent the
//! provider attributes a reading to; each adds its own. Every payload that names a run takes the
//! epoch stamp; the quota snapshot belongs to an account, names no run and takes none.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::definition::AgentId;
use crate::agent::definition::binding::ProviderToken;
use crate::context_window::ContextWindowSource;
use crate::event::envelope::{
    SourceEpoch, SourcePosition, check_epoch_stamp, epoch_stamp_dependent_required,
};
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::provider::account::record::{CredentialGeneration, ProviderAccountId};
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::run::id::RunId;
use crate::run::subagent::SubagentId;
use crate::session::cost::UsdMicros;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{SafeInt, SafeSignedInt};
use crate::wire::number::Number;
use crate::wire::text::{BoundedText, FreeFormText};

ts_constants! {
    /// The limit a quota snapshot without a `limitId` names.
    pub const DEFAULT_RATE_LIMIT_ID: &str = "default";
}

/// The `limitId` of an account limit scoped to one model: the limit's kind, a colon, then the
/// model's display name, as in `weekly_scoped:Opus`, so every reader of one window keys it alike.
#[must_use]
pub fn compose_scoped_limit_id(kind: &str, model_display_name: &str) -> String {
    format!("{kind}:{model_display_name}")
}

/// Whether a usage row's input figure has the cache's read and written tokens taken out of it:
/// taken out where the provider's breakdown showed them inside its input, else left in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum UsageContainment {
    /// The breakdown's sum identity showed the cache counts inside input, so they were subtracted.
    ConfirmedSubtracted,
    /// No identity held, so input is the raw figure: an overstatement, surfaced by a diagnostic.
    UnconfirmedUnsubtracted,
}

/// The `usage.tokenCount.recorded` payload: one turn's own token figures, never a running total, so
/// a run's or a session's total is the sum of its rows. A count is absent when the provider
/// reported none, never zero. The account is the one the turn was charged to: the account its
/// runtime binding names when the reading is recorded, never the provider's word, so a turn that
/// spans an account switch records its readings on each side of the switch under each account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct UsageTokenCountRecordedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run, absent on a turn no run owns.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The turn's total, when the provider gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub token_count: Option<SafeInt<0>>,
    /// The input tokens.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub input_tokens: Option<SafeInt<0>>,
    /// The output tokens.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub output_tokens: Option<SafeInt<0>>,
    /// The input tokens read from the provider's cache.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub cache_read_tokens: Option<SafeInt<0>>,
    /// The input tokens written to the provider's cache.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub cache_write_tokens: Option<SafeInt<0>>,
    /// The reasoning tokens.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub reasoning_tokens: Option<SafeInt<0>>,
    /// Whether `input_tokens` has the cache's read and written tokens taken out.
    pub containment: UsageContainment,
    /// The account the turn was charged to: its binding's account when the reading was recorded.
    pub provider_account_id: ProviderAccountId,
    /// The account's credential generation seen with the turn.
    pub credential_generation: CredentialGeneration,
    /// The model the provider attributes the reading to, absent when it attributes only
    /// the run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The subagent the provider attributes the reading to, paired with its start on the
    /// run, the provider and this id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SubagentId")]
    pub subagent_id: Option<SubagentId>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition` and
    /// `runId`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, self.run_id.is_some())
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The `usage.cost.updated` payload: one priced request, priced once when it completes and never
/// again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct UsageCostUpdatedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run, absent on a turn no run owns.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The request's price in whole millionths of a US dollar.
    pub cost_usd_micros: UsdMicros,
    /// The model the provider attributes the reading to, absent when it attributes only
    /// the run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The subagent the provider attributes the reading to, paired with its start on the
    /// run, the provider and this id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SubagentId")]
    pub subagent_id: Option<SubagentId>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition` and
    /// `runId`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, self.run_id.is_some())
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The `usage.contextWindow.updated` payload: the context window's reading. The two counts
/// travel together, absent only where the provider gave none (a bare signal that the window is
/// exceeded), and are never estimated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = window_dependent_required()))]
pub struct UsageContextWindowUpdatedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run, absent on a turn no run owns.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The tokens the conversation uses; comes with `windowMaxTokens`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    #[garde(custom(|used: &Option<SafeInt<0>>, (): &()| {
        check_window_counts(used.is_some(), self.window_max_tokens.is_some())
    }))]
    pub window_used_tokens: Option<SafeInt<0>>,
    /// The tokens the window holds; comes with `windowUsedTokens`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub window_max_tokens: Option<SafeInt<0>>,
    /// Where the window's figures came from.
    pub window_source: ContextWindowSource,
    /// Whether the provider's own reading shows the conversation past the window.
    pub exceeded: bool,
    /// The model the provider attributes the reading to, absent when it attributes only
    /// the run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The subagent the provider attributes the reading to, paired with its start on the
    /// run, the provider and this id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SubagentId")]
    pub subagent_id: Option<SubagentId>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition` and
    /// `runId`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, self.run_id.is_some())
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// Refuses one window count without the other.
fn check_window_counts(has_used: bool, has_max: bool) -> garde::Result {
    if has_used == has_max {
        Ok(())
    } else {
        Err(garde::Error::new(
            "windowUsedTokens and windowMaxTokens travel together",
        ))
    }
}

/// The context window reading's `dependentRequired`: the epoch stamp's pairs and the two counts.
fn window_dependent_required() -> Value {
    let mut dependent_required = epoch_stamp_dependent_required();
    if let Value::Object(members) = &mut dependent_required {
        members.insert(
            "windowUsedTokens".to_owned(),
            serde_json::json!(["windowMaxTokens"]),
        );
        members.insert(
            "windowMaxTokens".to_owned(),
            serde_json::json!(["windowUsedTokens"]),
        );
    }
    dependent_required
}

/// The `usage.rateLimit.updated` payload: a snapshot of one of an account's quotas, keyed by the
/// account, `limitId` and `windowMins`. It names no session and no run; the envelope binds it to
/// the machine's
/// sentinel session. A display reading only, never an input to a security or admission decision.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct UsageRateLimitUpdatedPayload {
    /// The provider.
    pub provider: ProviderId,
    /// The account the quota belongs to.
    pub provider_account_id: ProviderAccountId,
    /// The account's credential generation when the reading was taken, so a reading from before a
    /// sign-in again reads as stale.
    pub credential_generation: CredentialGeneration,
    /// Which of the account's limits this is; absent names [`DEFAULT_RATE_LIMIT_ID`].
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedText<1, EVENT_FIELD_MAX_LEN>")]
    pub limit_id: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The quota's window in minutes as the provider gave it; a reader drops a window at or below
    /// zero.
    pub window_mins: SafeSignedInt,
    /// The share of the window used, in percent as the provider gave it.
    pub used_percent: Number,
    /// When the window resets, absent when the provider did not say.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub resets_at: Option<WireInstant>,
}

/// Why a provider retried a request mid-run, in the vocabulary every provider's retry is read
/// into; `unknown` holds a cause the provider names that the vocabulary lacks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApiRetryErrorKind {
    /// The credentials were refused.
    AuthenticationFailed,
    /// The organization does not allow this sign-in.
    OauthOrgNotAllowed,
    /// The account's billing refused the request.
    BillingError,
    /// A rate limit was hit.
    RateLimit,
    /// The provider was overloaded.
    Overloaded,
    /// The request was refused as invalid.
    InvalidRequest,
    /// The model was not found.
    ModelNotFound,
    /// The provider's server failed.
    ServerError,
    /// The reply reached its output token limit.
    MaxOutputTokens,
    /// The account is on hold.
    AccountOnHold,
    /// The account must be verified before it is used again.
    VerificationRequired,
    /// The cloud provider's credentials were refused.
    CloudCredentialError,
    /// A cause the vocabulary lacks.
    Unknown,
}

/// The `usage.apiRequest.retried` payload: the provider retried a request mid-run, so trouble with
/// the account, its billing or its rate limits shows rather than passing in silence. It takes the
/// epoch stamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct UsageApiRequestRetriedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run whose request was retried.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The provider.
    pub provider: ProviderId,
    /// Why the request was retried.
    pub error_kind: ApiRetryErrorKind,
    /// How long the provider waits before the retry, in milliseconds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub retry_delay_ms: Option<SafeInt<0>>,
    /// Which attempt the retry is, as the provider counts them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub attempt: Option<SafeInt<0>>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition` and `runId`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, self.run_id.is_some())
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The `agent.run.context.compacted` payload: the provider shrank the run's own conversation
/// context, and no stored event changed. `summary` is the summary the provider kept, in its own
/// words and unchanged. It takes the epoch stamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct AgentRunContextCompactedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run whose context was compacted.
    pub run_id: RunId,
    /// The provider.
    pub provider: ProviderId,
    /// The tokens the context held before the compaction.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub pre_compaction_tokens: Option<SafeInt<0>>,
    /// The tokens the context holds after it; when present it replaces the run's last used-tokens
    /// reading.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub post_compaction_tokens: Option<SafeInt<0>>,
    /// The summary the provider kept, absent when it kept none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<{ usize::MAX }>")]
    pub summary: Option<FreeFormText<{ usize::MAX }>>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, true)
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// How long a provider's move onto another model holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModelRerouteScope {
    /// This turn.
    Turn,
    /// The rest of the session.
    Session,
    /// One helper's response: a subagent's, a side question's or a background fork's.
    Local,
}

/// Why the provider moved a turn onto another model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModelRerouteCause {
    /// The provider's safety check.
    Safety,
    /// The model was not available.
    ModelUnavailable,
    /// The model was blocked for the account.
    ModelBlocked,
    /// The account ran out of credits.
    OutOfCredits,
}

/// The `agent.turn.rerouted` payload: the provider moved a turn onto another model and the turn
/// went on. `sentence`, `explanation` and `safetyCategory` are the provider's own. It takes the
/// epoch stamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct AgentTurnReroutedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run whose turn moved.
    pub run_id: RunId,
    /// The agent whose turn moved.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentId")]
    pub agent_id: Option<AgentId>,
    /// The model the turn was asked of.
    pub from_model: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The model the turn ran on, and the model it is priced at; a session-long move makes it the
    /// model the session runs on, so it takes a model id's bound.
    pub to_model: ProviderToken,
    /// How long the move holds.
    pub scope: ModelRerouteScope,
    /// The provider's own sentence, absent when it sent none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
    pub sentence: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    /// The provider's explanation, shown as sent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
    pub explanation: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    /// Why the provider moved the turn.
    pub cause: ModelRerouteCause,
    /// The provider's open safety category, such as `cyber` or `bio`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub safety_category: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, true)
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The TypeScript module of the usage telemetry payloads.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/usage",
    doc: "The payloads of the usage telemetry events: the three metered readings, an account's \
          quota snapshot, a provider's retry, a compaction of a run's context, and the provider's \
          move of a turn onto another model.",
    definitions: &[
        Definition::read::<UsageContainment>(),
        Definition::read::<UsageTokenCountRecordedPayload>().checked(),
        Definition::read::<UsageCostUpdatedPayload>().checked(),
        Definition::read::<UsageContextWindowUpdatedPayload>().checked(),
        Definition::read::<UsageRateLimitUpdatedPayload>().checked(),
        Definition::read::<ApiRetryErrorKind>(),
        Definition::read::<UsageApiRequestRetriedPayload>().checked(),
        Definition::read::<AgentRunContextCompactedPayload>().checked(),
        Definition::read::<ModelRerouteScope>(),
        Definition::read::<ModelRerouteCause>(),
        Definition::read::<AgentTurnReroutedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
