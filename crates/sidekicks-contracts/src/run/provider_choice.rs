//! The choices a provider asks the person to make while a run waits on the answer: the
//! retry-or-edit choice when its safety check refuses a turn and names a fallback model, and the
//! switch-or-credits choice when a turn's model needs usage credits. Each has a resolve request,
//! which the run-control method table serves, and the payloads of the event that asks and the event
//! that records how it settled.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeSignedInt;
use crate::wire::text::FreeFormText;

/// The person's answer when the provider's safety check refuses a turn and names a fallback model:
/// `retryFallback` goes on on the fallback model, and `editPrompt` ends the turn refused and
/// returns the message to the composer. The driver translates each value to the provider's own
/// answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunRefusalChoice {
    /// Go on on the fallback model.
    RetryFallback,
    /// End the turn refused and return the message to the composer.
    EditPrompt,
}

/// Answers the retry-or-edit choice a refused run waits on (`agent.run.refusalChoice.resolve`). The
/// first answer settles it; a second or late one is refused with `agent.run.invalidTransition`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunRefusalChoiceResolveRequest {
    /// The run that waits.
    pub run_id: RunId,
    /// The answer.
    pub choice: RunRefusalChoice,
}

/// The payload of `agent.run.refusalChoice.requested`: the refusing model, the fallback it names,
/// the provider's own sentence and check category when it sends them, and the ids of the rows
/// already streamed for the refused answer, which leave the flow when the choice is answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRefusalChoiceRequestedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run that waits.
    pub run_id: RunId,
    /// The model that refused.
    pub refused_model: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// The model a retry goes on on.
    pub fallback_model: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// The provider's own sentence, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
    pub sentence: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    /// The provider's open safety category, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
    pub safety_category: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The rows already streamed for the refused answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<EVENT_FIELD_MAX_LEN>>")]
    pub retracted_message_ids: Option<Vec<FreeFormText<EVENT_FIELD_MAX_LEN>>>,
}

/// How the retry-or-edit choice ended with no answer: `canceled` is an interrupt or a message sent
/// while it waits, or an interrupted end of its run, and the driver maps the provider's own cancel
/// answer to it; `runEnded` is any other end of its run, a restart of the background service
/// among them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunRefusalChoiceUnanswered {
    /// An interrupt or a message sent while it waited, or its run's interrupted end.
    Canceled,
    /// Any other end of its run.
    RunEnded,
}

/// How the retry-or-edit choice settled: the person's answer, or an end with none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RunRefusalChoiceSettlement {
    /// The person's answer.
    Answered(RunRefusalChoice),
    /// An end with no answer.
    Canceled(RunRefusalChoiceUnanswered),
}

/// The payload of `agent.run.refusalChoice.resolved`: the answer that settled the choice, and the
/// device that sent a person's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRefusalChoiceResolvedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// How it settled.
    pub choice: RunRefusalChoiceSettlement,
    /// The device that sent a person's answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DeviceId")]
    pub device_id: Option<DeviceId>,
}

/// The person's answer when a turn's model needs usage credits: `switchDefault` moves the turn to
/// the fallback model, and `consent` goes on on usage credits, which the provider accepts only
/// while credits are on. The driver translates each value to the provider's own answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunUsageCreditsChoice {
    /// Move the turn to the fallback model.
    SwitchDefault,
    /// Go on on usage credits.
    Consent,
}

/// Answers the switch-or-credits choice a run waits on (`agent.run.usageCreditsChoice.resolve`).
/// The first answer settles it; a second or late one is refused with `agent.run.invalidTransition`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunUsageCreditsChoiceResolveRequest {
    /// The run that waits.
    pub run_id: RunId,
    /// The answer.
    pub choice: RunUsageCreditsChoice,
}

/// The payload of `agent.run.usageCreditsChoice.requested`: the model that needs credits, whether
/// credits are on, the balance and its currency when the provider reports them, and the model a
/// switch moves to when the provider's model list names one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunUsageCreditsChoiceRequestedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run that waits.
    pub run_id: RunId,
    /// The model that needs credits.
    pub model_name: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// Whether usage credits are on.
    pub overages_enabled: bool,
    /// The credit balance in cents, where the provider reports it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeSignedInt")]
    pub balance_cents: Option<SafeSignedInt>,
    /// The balance's currency, where the provider reports it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
    pub currency: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The model a switch moves to, where the provider's model list names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
    pub fallback_model: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
}

/// How the switch-or-credits choice ended with no answer: `interrupted` is an interrupt or an
/// undo while it waits, which ends the turn on that model, or an interrupted end of its run;
/// `unanswered` is the provider settling it when a message is sent while it waits; `runEnded` is
/// any other end of its run, a restart of the background service among them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunUsageCreditsChoiceUnanswered {
    /// An interrupt or an undo while it waited, or its run's interrupted end.
    Interrupted,
    /// A message sent while it waited.
    Unanswered,
    /// Any other end of its run.
    RunEnded,
}

/// How the switch-or-credits choice settled: the person's answer, or an end with none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RunUsageCreditsChoiceSettlement {
    /// The person's answer.
    Answered(RunUsageCreditsChoice),
    /// An end with no answer.
    Unanswered(RunUsageCreditsChoiceUnanswered),
}

/// The payload of `agent.run.usageCreditsChoice.resolved`: how the choice settled, and the device
/// that sent a person's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunUsageCreditsChoiceResolvedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// How it settled.
    pub choice: RunUsageCreditsChoiceSettlement,
    /// The device that sent a person's answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DeviceId")]
    pub device_id: Option<DeviceId>,
}

/// The TypeScript module of the choices a provider asks for.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/provider-choice",
    doc: "The choices a provider asks the person to make while a run waits on the answer: the \
          retry-or-edit choice after a refusal and the switch-or-credits choice when a model \
          needs usage credits.",
    definitions: &[
        Definition::read::<RunRefusalChoice>(),
        Definition::read::<AgentRunRefusalChoiceResolveRequest>().checked(),
        Definition::read::<AgentRunRefusalChoiceRequestedPayload>().checked(),
        Definition::read::<RunRefusalChoiceUnanswered>(),
        Definition::read::<RunRefusalChoiceSettlement>(),
        Definition::read::<AgentRunRefusalChoiceResolvedPayload>().checked(),
        Definition::read::<RunUsageCreditsChoice>(),
        Definition::read::<AgentRunUsageCreditsChoiceResolveRequest>().checked(),
        Definition::read::<AgentRunUsageCreditsChoiceRequestedPayload>().checked(),
        Definition::read::<RunUsageCreditsChoiceUnanswered>(),
        Definition::read::<RunUsageCreditsChoiceSettlement>(),
        Definition::read::<AgentRunUsageCreditsChoiceResolvedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
