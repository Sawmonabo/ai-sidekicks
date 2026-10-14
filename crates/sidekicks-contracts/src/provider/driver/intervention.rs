//! How a caller acts on a live run through its driver: the interrupt, the intervention types and
//! their payloads, and the driver's result, read as provider output.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::driver::length_limits::DRIVER_FALLBACK_ACTION_MAX_LEN;
use crate::provider::driver::methods::DRIVER_WIRE_REASON_MAX_LEN;
use crate::run::id::RunId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

/// Asks a driver to interrupt one run, with an optional reason. A run's id is unique on its own,
/// so no session id sits beside it as a second key that could disagree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct InterruptRunParams {
    /// The run to interrupt.
    pub run_id: RunId,
    /// The person's reason.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>")]
    pub reason: Option<FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>>,
}

/// How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a
/// faster model, which the daemon carries out by stopping the turn and sending its message again on
/// the named model. A person's message mid-turn is a queue send, never an intervention.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InterventionType {
    /// Stops the turn.
    Interrupt,
    /// Stops the turn and sends its message again on a faster model.
    FasterModelRetry,
}

/// What an interrupt does with the messages still waiting for the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum InterruptPendingChoice {
    /// They go as the next turn.
    NextTurn,
    /// They return to the draft.
    ReturnToDraft,
}

/// The payload of an interrupt: what becomes of the waiting messages, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterruptPayload {
    /// What becomes of the waiting messages.
    pub pending: InterruptPendingChoice,
    /// The person's reason.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>")]
    pub reason: Option<FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>>,
}

/// The one intervention a client sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum InterruptInterventionType {
    /// An interrupt.
    Interrupt,
}

/// The request of `driver.applyIntervention`: an interrupt on a live run, so a steer, which only
/// the run queue delivers, is refused at parse. `expectedRunVersion` is the fail-closed comparand;
/// `clientIdempotencyKey` is the requester's key, passed through unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApplyInterventionRequest {
    /// Always `interrupt`.
    #[serde(rename = "type")]
    pub intervention_type: InterruptInterventionType,
    /// The run interrupted.
    pub target_run_id: RunId,
    /// The run version the caller saw.
    pub expected_run_version: SafeInt<0>,
    /// The requester's idempotency key.
    pub client_idempotency_key: ClientUuid,
    /// What the interrupt does.
    pub payload: InterruptPayload,
}

/// Whether an intervention landed as asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum InterventionResultStatus {
    /// As asked.
    Applied,
    /// Through a fallback.
    Degraded,
}

/// What a driver answers an intervention with, read as provider output. `fallbackAction` names
/// the fallback of a `degraded` result. `deliveredRunId` names the run a delivered message went to
/// when that is not its target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DriverInterventionResult {
    /// Whether it landed as asked.
    pub status: InterventionResultStatus,
    /// The fallback a degraded result took.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FALLBACK_ACTION_MAX_LEN>")]
    pub fallback_action: Option<FreeFormText<DRIVER_FALLBACK_ACTION_MAX_LEN>>,
    /// The run a delivered message went to, when not the target.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub delivered_run_id: Option<RunId>,
}

/// The TypeScript module of interventions.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/intervention",
    doc: "How a caller acts on a live run through its driver: the interrupt, the intervention \
          types and their payloads, and the driver's result, read as provider output.",
    definitions: &[
        Definition::read::<InterruptRunParams>().checked(),
        Definition::read::<InterventionType>().checked(),
        Definition::read::<InterruptPendingChoice>().checked(),
        Definition::read::<InterruptPayload>(),
        Definition::read::<ApplyInterventionRequest>().checked(),
        Definition::read::<DriverInterventionResult>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
