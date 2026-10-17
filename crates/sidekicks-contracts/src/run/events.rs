//! The stored payloads of a run's state changes, of the markers its provider reports, and of its
//! interventions, one per event type.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::event::envelope::SourcePosition;
use crate::orchestration::InterruptReason;
use crate::provider::driver::capabilities::ExecutionPosture;
use crate::provider::driver::intervention::InterventionType;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::DRIVER_WIRE_TOKEN_MAX_LEN;
use crate::provider::driver::recovery::RecoveryCondition;
use crate::provider::id::ProviderId;
use crate::run::control::{ProcessExit, RunCompletionKind, RunFailureCategory};
use crate::run::failure_cause::RunFailureCause;
use crate::run::id::RunId;
use crate::run::intervention::InterventionId;
use crate::run::state::RunState;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{True, literal};

/// A run state with a state-change event of its own: every state but `queued`, the run's birth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunStateChangeState {
    /// Its provider is starting.
    Starting,
    /// A turn is in flight.
    Running,
    /// Held on a person's approval.
    WaitingForApproval,
    /// Held on a person's answer.
    WaitingForInput,
    /// The step in flight is finishing after a pause was asked for.
    Pausing,
    /// Paused, with nothing running.
    Paused,
    /// Ended with its work done.
    Completed,
    /// Ended by an interrupt.
    Interrupted,
    /// A child ended by a stop that reached several agents.
    Stopped,
    /// Ended by a failure.
    Failed,
}

/// The run state a change enters; a state change never enters `queued`.
impl From<RunStateChangeState> for RunState {
    fn from(state: RunStateChangeState) -> Self {
        match state {
            RunStateChangeState::Starting => Self::Starting,
            RunStateChangeState::Running => Self::Running,
            RunStateChangeState::WaitingForApproval => Self::WaitingForApproval,
            RunStateChangeState::WaitingForInput => Self::WaitingForInput,
            RunStateChangeState::Pausing => Self::Pausing,
            RunStateChangeState::Paused => Self::Paused,
            RunStateChangeState::Completed => Self::Completed,
            RunStateChangeState::Interrupted => Self::Interrupted,
            RunStateChangeState::Stopped => Self::Stopped,
            RunStateChangeState::Failed => Self::Failed,
        }
    }
}

literal! {
    /// The `newState` of an `agent.run.starting` payload.
    pub enum AgentRunStartingNewState = "starting";
    /// The `newState` of an `agent.run.running` payload.
    pub enum AgentRunRunningNewState = "running";
    /// The `newState` of an `agent.run.waitingForApproval` payload.
    pub enum AgentRunWaitingForApprovalNewState = "waitingForApproval";
    /// The `newState` of an `agent.run.waitingForInput` payload.
    pub enum AgentRunWaitingForInputNewState = "waitingForInput";
    /// The `newState` of an `agent.run.pausing` payload.
    pub enum AgentRunPausingNewState = "pausing";
    /// The `newState` of an `agent.run.paused` payload.
    pub enum AgentRunPausedNewState = "paused";
    /// The `newState` of an `agent.run.completed` payload.
    pub enum AgentRunCompletedNewState = "completed";
    /// The `newState` of an `agent.run.interrupted` payload.
    pub enum AgentRunInterruptedNewState = "interrupted";
    /// The `newState` of an `agent.run.stopped` payload.
    pub enum AgentRunStoppedNewState = "stopped";
    /// The `newState` of an `agent.run.failed` payload.
    pub enum AgentRunFailedNewState = "failed";
}

/// Declares the stored payload of each `agent.run.<state>`: the transition with its new run
/// version, `failureCategory` and `recoveryCondition`, which any change may carry, and the members
/// its own state carries. Each refuses another state's `newState` and every member only another
/// state carries.
macro_rules! run_state_change_payloads {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident: $new_state:ty { $($extra:tt)* }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            /// The run.
            pub run_id: RunId,
            /// The run version after the transition.
            pub run_version: SafeInt<0>,
            /// The state it left.
            pub previous_state: RunState,
            /// The state it entered.
            pub new_state: $new_state,
            /// Why the run failed.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RunFailureCategory")]
            pub failure_category: Option<RunFailureCategory>,
            /// Why the run needs recovery.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RecoveryCondition")]
            pub recovery_condition: Option<RecoveryCondition>,
            $($extra)*
        }
    )+};
}

run_state_change_payloads! {
    /// The `agent.run.starting` payload.
    pub struct AgentRunStartingPayload: AgentRunStartingNewState {}

    /// The `agent.run.running` payload, which stamps the effective posture, final only once
    /// running.
    pub struct AgentRunRunningPayload: AgentRunRunningNewState {
        /// The effective posture, with the workspace root resolved.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ExecutionPosture")]
        pub execution_posture: Option<ExecutionPosture>,
    }

    /// The `agent.run.waitingForApproval` payload.
    pub struct AgentRunWaitingForApprovalPayload: AgentRunWaitingForApprovalNewState {}

    /// The `agent.run.waitingForInput` payload.
    pub struct AgentRunWaitingForInputPayload: AgentRunWaitingForInputNewState {}

    /// The `agent.run.pausing` payload.
    pub struct AgentRunPausingPayload: AgentRunPausingNewState {}

    /// The `agent.run.paused` payload.
    pub struct AgentRunPausedPayload: AgentRunPausedNewState {}

    /// The `agent.run.completed` payload, with whether its turn or its whole task finished.
    pub struct AgentRunCompletedPayload: AgentRunCompletedNewState {
        /// Present only on a terminal the daemon itself closed, which is never a crash.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        pub intended_close: Option<True>,
        /// Whether its turn or its whole task finished.
        pub completion_kind: RunCompletionKind,
    }

    /// The `agent.run.interrupted` payload, with why the daemon interrupted the run where it did so
    /// itself; the person's own interrupt carries none.
    pub struct AgentRunInterruptedPayload: AgentRunInterruptedNewState {
        /// Present only on a terminal the daemon itself closed, which is never a crash.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        pub intended_close: Option<True>,
        /// Why the daemon itself interrupted the run.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "InterruptReason")]
        pub trigger: Option<InterruptReason>,
    }

    /// The `agent.run.stopped` payload.
    pub struct AgentRunStoppedPayload: AgentRunStoppedNewState {
        /// Present only on a terminal the daemon itself closed, which is never a crash.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        pub intended_close: Option<True>,
    }

    /// The `agent.run.failed` payload, with its typed cause, the provider's own words and its
    /// process's own exit.
    pub struct AgentRunFailedPayload: AgentRunFailedNewState {
        /// Present only on a terminal the daemon itself closed, which is never a crash.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        pub intended_close: Option<True>,
        /// The run's typed failure cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RunFailureCause")]
        #[garde(dive)]
        pub failure_cause: Option<RunFailureCause>,
        /// The provider's own words on why it failed the run, shown whole and never parsed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
        pub provider_failure_detail: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
        /// How the provider process ended under the turn, where it ended on its own.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProcessExit")]
        pub process_exit: Option<ProcessExit>,
    }
}

/// Declares the payload of each provider marker: the run and its version when the marker was
/// recorded, which the marker leaves as it is, since it changes no state, and the marker's own
/// members.
macro_rules! run_marker_payloads {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident { $($extra:tt)* }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            /// The run.
            pub run_id: RunId,
            /// The run version when the marker was recorded.
            pub run_version: SafeInt<0>,
            $($extra)*
        }
    )+};
}

run_marker_payloads! {
    /// The `agent.run.providerInitialized` payload: the provider process reported its start for the
    /// run, with the model it runs where it named one.
    pub struct AgentRunProviderInitializedPayload {
        /// The provider.
        pub provider: ProviderId,
        /// The model it runs.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>")]
        pub model: Option<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>,
    }

    /// The `agent.turn.started` payload: a turn opened within the run, at the session position the
    /// provider named where it named one.
    pub struct AgentTurnStartedPayload {
        /// The turn's session position.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SourcePosition")]
        pub position: Option<SourcePosition>,
    }

    /// The `agent.run.workerShuttingDown` payload: the provider said its worker is shutting down
    /// mid-run, with its own reason where it sent one. An early warning, never the run's end.
    pub struct AgentRunWorkerShuttingDownPayload {
        /// The provider's reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
        pub reason: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    }
}

literal! {
    /// The actor of an intervention the daemon made itself, such as a stop at a spend limit.
    pub enum DaemonInterventionActor = const "daemon";
}

ts_constants! {
    /// The actor of an intervention the daemon made itself, such as a stop at a spend limit.
    DAEMON_INTERVENTION_ACTOR = DaemonInterventionActor::Value;
}

/// A device id as an intervention's actor: any device id but `daemon`, which names the daemon's
/// own intervention, so the two actor arms never both read one value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct InterventionDeviceActor(DeviceId);

impl InterventionDeviceActor {
    /// `device_id` as an actor, or `None` when it is `daemon`.
    pub fn new(device_id: DeviceId) -> Option<Self> {
        (device_id.as_str() != DaemonInterventionActor::TEXT).then_some(Self(device_id))
    }

    /// The device.
    pub fn device_id(&self) -> &DeviceId {
        &self.0
    }
}

impl<'de> Deserialize<'de> for InterventionDeviceActor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(DeviceId::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom("a device actor is never `daemon`, which names the daemon itself")
        })
    }
}

impl JsonSchema for InterventionDeviceActor {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "InterventionDeviceActor".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "allOf": [
                generator.subschema_for::<DeviceId>(),
                { "not": { "const": DaemonInterventionActor::TEXT } },
            ],
        })
    }
}

/// Who an intervention is from: the daemon for its own, or the device whose connection carried
/// it. Never a person. The arms are disjoint: a device actor is never `daemon`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum InterventionActor {
    /// The daemon's own.
    Daemon(DaemonInterventionActor),
    /// The device whose connection carried it.
    Device(InterventionDeviceActor),
}

literal! {
    /// The `state` of an `agent.intervention.requested` payload.
    pub enum AgentInterventionRequestedState = "requested";
    /// The `state` of an `agent.intervention.accepted` payload.
    pub enum AgentInterventionAcceptedState = "accepted";
    /// The `state` of an `agent.intervention.applied` payload.
    pub enum AgentInterventionAppliedState = "applied";
    /// The `state` of an `agent.intervention.rejected` payload.
    pub enum AgentInterventionRejectedState = "rejected";
    /// The `state` of an `agent.intervention.degraded` payload.
    pub enum AgentInterventionDegradedState = "degraded";
    /// The `state` of an `agent.intervention.expired` payload.
    pub enum AgentInterventionExpiredState = "expired";
    /// The `state` of an `agent.intervention.failed` payload.
    pub enum AgentInterventionFailedState = "failed";
}

/// Declares the stored payload of each `agent.intervention.<state>`, whose `state` is its own
/// type's state and whose `actor` the envelope repeats; each refuses another `state`, and only
/// `failed` carries a reason.
macro_rules! intervention_event_payloads {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident: $state:ty { $($extra:tt)* }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            /// The intervention.
            pub intervention_id: InterventionId,
            /// The run it acts on.
            pub target_run_id: RunId,
            /// What it does.
            #[serde(rename = "type")]
            pub intervention_type: InterventionType,
            /// Its state.
            pub state: $state,
            /// Who it is from.
            pub actor: InterventionActor,
            $($extra)*
        }
    )+};
}

intervention_event_payloads! {
    /// The `agent.intervention.requested` payload.
    pub struct AgentInterventionRequestedPayload: AgentInterventionRequestedState {}

    /// The `agent.intervention.accepted` payload.
    pub struct AgentInterventionAcceptedPayload: AgentInterventionAcceptedState {}

    /// The `agent.intervention.applied` payload.
    pub struct AgentInterventionAppliedPayload: AgentInterventionAppliedState {}

    /// The `agent.intervention.rejected` payload.
    pub struct AgentInterventionRejectedPayload: AgentInterventionRejectedState {}

    /// The `agent.intervention.degraded` payload.
    pub struct AgentInterventionDegradedPayload: AgentInterventionDegradedState {}

    /// The `agent.intervention.expired` payload.
    pub struct AgentInterventionExpiredPayload: AgentInterventionExpiredState {}

    /// The `agent.intervention.failed` payload, with why, in the words its reply and its stored row
    /// carry.
    pub struct AgentInterventionFailedPayload: AgentInterventionFailedState {
        /// The thrown error's code, else its message.
        pub failure_reason: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
    }
}

/// The TypeScript module of a run's stored payloads.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/events",
    doc: "The stored payloads of a run's state changes, of the markers its provider reports, and \
          of its interventions, one per event type.",
    definitions: &[
        Definition::read::<RunStateChangeState>(),
        Definition::read::<AgentRunStartingPayload>(),
        Definition::read::<AgentRunRunningPayload>(),
        Definition::read::<AgentRunWaitingForApprovalPayload>(),
        Definition::read::<AgentRunWaitingForInputPayload>(),
        Definition::read::<AgentRunPausingPayload>(),
        Definition::read::<AgentRunPausedPayload>(),
        Definition::read::<AgentRunCompletedPayload>(),
        Definition::read::<AgentRunInterruptedPayload>(),
        Definition::read::<AgentRunStoppedPayload>(),
        Definition::read::<AgentRunFailedPayload>(),
        Definition::read::<AgentRunProviderInitializedPayload>().checked(),
        Definition::read::<AgentTurnStartedPayload>().checked(),
        Definition::read::<AgentRunWorkerShuttingDownPayload>().checked(),
        Definition::read::<InterventionActor>(),
        Definition::read::<AgentInterventionRequestedPayload>(),
        Definition::read::<AgentInterventionAcceptedPayload>(),
        Definition::read::<AgentInterventionAppliedPayload>(),
        Definition::read::<AgentInterventionRejectedPayload>(),
        Definition::read::<AgentInterventionDegradedPayload>(),
        Definition::read::<AgentInterventionExpiredPayload>(),
        Definition::read::<AgentInterventionFailedPayload>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
