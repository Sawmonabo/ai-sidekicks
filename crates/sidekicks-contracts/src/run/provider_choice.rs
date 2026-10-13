//! The choices a provider asks the person to make while a run waits on the answer: Claude Code's
//! retry-or-edit choice when its safety check refuses a turn and names a fallback model, and its
//! switch-or-credits choice when a turn on Fable needs usage credits. Each has a resolve request,
//! which the `run.*` method table serves, and the payloads of the event that asks and the event
//! that records how it settled.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::DRIVER_WIRE_HANDLE_MAX_LEN;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeSignedInt;
use crate::wire::literal;
use crate::wire::text::FreeFormText;

/// The person's answer when Claude Code's safety check refuses a turn and names a fallback model:
/// `retry_fallback` goes on on the fallback model, and `edit_prompt` ends the turn refused and
/// returns the message to the composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunRefusalChoice {
    /// Go on on the fallback model.
    RetryFallback,
    /// End the turn refused and return the message to the composer.
    EditPrompt,
}

/// Answers the retry-or-edit choice a refused run waits on (`run.refusalChoiceResolve`). The first
/// answer settles it; a second or late one is refused with `run.invalid_transition`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRefusalChoiceResolveRequest {
    /// The run that waits.
    pub run_id: RunId,
    /// The answer.
    pub choice: RunRefusalChoice,
}

/// The payload of `run.refusal_choice_requested`: the refusing model, the fallback it names, the
/// provider's own sentence and check category when it sends them, and the ids of the rows already
/// streamed for the refused answer, which leave the flow when the choice is answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRefusalChoiceRequestedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run that waits.
    pub run_id: RunId,
    /// The model that refused.
    pub refused_model: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    /// The model a retry goes on on.
    pub fallback_model: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    /// The provider's own sentence, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    pub sentence: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    /// The provider's open safety category, where it sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>")]
    pub safety_category: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
    /// The rows already streamed for the refused answer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<EVENT_FIELD_MAX_LEN>>")]
    pub retracted_message_ids: Option<Vec<FreeFormText<EVENT_FIELD_MAX_LEN>>>,
}

literal! {
    /// The settlement the daemon records for an interrupt or a message sent while the
    /// retry-or-edit choice waits; the driver maps Claude Code's own `cancelled` to it.
    pub enum RunRefusalChoiceCanceled = "canceled";
}

/// How the retry-or-edit choice settled: the person's answer, or canceled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RunRefusalChoiceSettlement {
    /// The person's answer.
    Answered(RunRefusalChoice),
    /// An interrupt or a message sent while it waited.
    Canceled(RunRefusalChoiceCanceled),
}

/// The payload of `run.refusal_choice_resolved`: the answer that settled the choice, and the device
/// that sent a person's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRefusalChoiceResolvedPayload {
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

/// The person's answer when a turn on Fable needs usage credits: `switch_default` moves the turn
/// to the fallback model, and `consent` goes on on usage credits, which Claude Code accepts only
/// while credits are on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunUsageCreditsChoice {
    /// Move the turn to the fallback model.
    SwitchDefault,
    /// Go on on usage credits.
    Consent,
}

/// Answers the switch-or-credits choice a Fable run waits on (`run.usageCreditsChoiceResolve`).
/// The first answer settles it; a second or late one is refused with `run.invalid_transition`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunUsageCreditsChoiceResolveRequest {
    /// The run that waits.
    pub run_id: RunId,
    /// The answer.
    pub choice: RunUsageCreditsChoice,
}

/// The payload of `run.usage_credits_choice_requested`: the model that needs credits, whether
/// credits are on, the balance and its currency when Claude Code reports them, and the model a
/// switch moves to when Claude Code's model list names one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunUsageCreditsChoiceRequestedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run that waits.
    pub run_id: RunId,
    /// The model that needs credits.
    pub model_name: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    /// Whether usage credits are on.
    pub overages_enabled: bool,
    /// The credit balance in cents, where Claude Code reports it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeSignedInt")]
    pub balance_cents: Option<SafeSignedInt>,
    /// The balance's currency, where Claude Code reports it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>")]
    pub currency: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
    /// The model a switch moves to, where Claude Code's model list names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>")]
    pub fallback_model: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
}

/// How the switch-or-credits choice ended with no answer: `interrupted` is an interrupt or an
/// undo while it waits, which ends the turn on Fable, and `unanswered` is Claude Code settling it
/// when a message is sent while it waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunUsageCreditsChoiceUnanswered {
    /// An interrupt or an undo while it waited.
    Interrupted,
    /// A message sent while it waited.
    Unanswered,
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

/// The payload of `run.usage_credits_choice_resolved`: how the choice settled, and the device that
/// sent a person's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunUsageCreditsChoiceResolvedPayload {
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
          retry-or-edit choice after a refusal and the switch-or-credits choice on Fable.",
    definitions: &[
        Definition::read::<RunRefusalChoice>(),
        Definition::read::<RunRefusalChoiceResolveRequest>().checked(),
        Definition::read::<RunRefusalChoiceRequestedPayload>().checked(),
        Definition::read::<RunRefusalChoiceSettlement>(),
        Definition::read::<RunRefusalChoiceResolvedPayload>().checked(),
        Definition::read::<RunUsageCreditsChoice>(),
        Definition::read::<RunUsageCreditsChoiceResolveRequest>().checked(),
        Definition::read::<RunUsageCreditsChoiceRequestedPayload>().checked(),
        Definition::read::<RunUsageCreditsChoiceUnanswered>(),
        Definition::read::<RunUsageCreditsChoiceSettlement>(),
        Definition::read::<RunUsageCreditsChoiceResolvedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
