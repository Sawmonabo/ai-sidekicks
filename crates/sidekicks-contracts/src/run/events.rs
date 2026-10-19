//! The stored payloads of a run's state changes, of the markers its provider reports, of its turns'
//! starts and ends, and of its interventions, one per event type.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::event::envelope::SourcePosition;
use crate::orchestration::InterruptReason;
use crate::provider::driver::capabilities::ExecutionPosture;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use crate::provider::driver::recovery::RecoveryCondition;
use crate::provider::id::ProviderId;
use crate::run::control::{ProcessExit, RunFailureCategory, StopTrigger};
use crate::run::failure_cause::RunFailureCause;
use crate::run::id::RunId;
use crate::run::intervention::{InterventionId, InterventionType};
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
    /// Its turn cut by an interrupt, resting until a send continues it.
    Interrupted,
    /// Ended by a stop: a child ended by a stop that reached several agents, or a run at its token
    /// limit.
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

    /// The `agent.run.completed` payload.
    pub struct AgentRunCompletedPayload: AgentRunCompletedNewState {
        /// Present only on a terminal the daemon itself closed, which is never a crash.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        pub intended_close: Option<True>,
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

    /// The `agent.run.stopped` payload, with why the daemon stopped the run where it did so
    /// itself.
    pub struct AgentRunStoppedPayload: AgentRunStoppedNewState {
        /// Present only on a terminal the daemon itself closed, which is never a crash.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        pub intended_close: Option<True>,
        /// Why the daemon itself stopped the run.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "StopTrigger")]
        pub trigger: Option<StopTrigger>,
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
        #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
        pub provider_failure_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
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

/// Who reported a turn's end, not who cut the turn: the provider, whose own end frame arrived, or
/// the daemon, which wrote the end with no provider frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnEndOrigin {
    /// The provider's own end frame arrived.
    Provider,
    /// The daemon wrote the end with no provider frame.
    Daemon,
}

/// Why a turn was interrupted or failed, where the daemon knows it: it saw the provider process
/// exit, a restart settled the open turn, or a limit the person set cut it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnEndCause {
    /// The daemon saw the provider process exit under the turn.
    ProcessExit,
    /// A restart settled the open turn.
    DaemonRestart,
    /// The step limit cut the turn.
    StepLimit,
    /// The spend limit cut the turn.
    SpendLimit,
    /// The token limit cut the turn.
    TokenLimit,
}

/// Declares the payload of each forward run event, a provider's marker or a turn's start or end:
/// the run and its version when the event was recorded, which the event leaves as it is, since it
/// changes no state, and the event's own members.
macro_rules! run_event_payloads {
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
            /// The run version when the event was recorded.
            pub run_version: SafeInt<0>,
            $($extra)*
        }
    )+};
}

run_event_payloads! {
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
        #[schemars(with = "FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>")]
        pub model: Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
    }

    /// The `agent.turn.started` payload: a turn opened within the run, at the session position the
    /// provider named where it named one.
    pub struct AgentTurnStartedPayload {
        /// The turn's number within its run, from 1.
        pub turn_number: SafeInt<1>,
        /// The turn's session position.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SourcePosition")]
        pub position: Option<SourcePosition>,
    }

    /// The `agent.turn.completed` payload: the turn ended normally, as the provider reported it.
    pub struct AgentTurnCompletedPayload {
        /// The turn's number within its run.
        pub turn_number: SafeInt<1>,
    }

    /// The `agent.turn.interrupted` payload: the turn was cut, its partial output kept.
    pub struct AgentTurnInterruptedPayload {
        /// The turn's number within its run.
        pub turn_number: SafeInt<1>,
        /// Who reported the turn's end.
        pub origin: TurnEndOrigin,
        /// Why the turn ended, where the daemon knows it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "TurnEndCause")]
        pub cause: Option<TurnEndCause>,
    }

    /// The `agent.turn.failed` payload: the turn failed.
    pub struct AgentTurnFailedPayload {
        /// The turn's number within its run.
        pub turn_number: SafeInt<1>,
        /// Who reported the turn's end.
        pub origin: TurnEndOrigin,
        /// Why the turn ended, where the daemon knows it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "TurnEndCause")]
        pub cause: Option<TurnEndCause>,
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
        #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
        pub reason: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
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
        /// The thrown error's code, else its message, or why it never completed or was never
        /// sent.
        pub failure_reason: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    }
}

/// The TypeScript module of a run's stored payloads.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/events",
    doc: "The stored payloads of a run's state changes, of the markers its provider reports, of \
          its turns' starts and ends, and of its interventions, one per event type.",
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
        Definition::read::<TurnEndOrigin>(),
        Definition::read::<TurnEndCause>(),
        Definition::read::<AgentTurnCompletedPayload>().checked(),
        Definition::read::<AgentTurnInterruptedPayload>().checked(),
        Definition::read::<AgentTurnFailedPayload>().checked(),
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

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use crate::event::session::SessionEvent;

    const SESSION_ID: &str = "0190f2a0-0000-7000-8000-000000000000";
    const RUN_ID: &str = "0190f2a0-0000-7000-8000-000000000001";

    /// A run event of `event_type` whose payload is the run's keys and `members`.
    fn run_event(event_type: &str, members: &Value) -> Value {
        let mut payload = json!({ "sessionId": SESSION_ID, "runId": RUN_ID, "runVersion": 3 });
        for (key, value) in members.as_object().expect("the members are an object") {
            payload[key] = value.clone();
        }
        json!({ "type": event_type, "payload": payload })
    }

    #[rstest]
    #[case::turn_completed("agent.turn.completed", json!({ "turnNumber": 1 }))]
    #[case::turn_interrupted_by_the_provider(
        "agent.turn.interrupted",
        json!({ "turnNumber": 2, "origin": "provider" })
    )]
    #[case::turn_interrupted_at_the_token_limit(
        "agent.turn.interrupted",
        json!({ "turnNumber": 2, "origin": "daemon", "cause": "tokenLimit" })
    )]
    #[case::turn_failed_by_the_provider(
        "agent.turn.failed",
        json!({ "turnNumber": 4, "origin": "provider" })
    )]
    #[case::turn_failed_on_a_process_exit(
        "agent.turn.failed",
        json!({ "turnNumber": 4, "origin": "daemon", "cause": "processExit" })
    )]
    #[case::run_stopped_at_the_token_limit(
        "agent.run.stopped",
        json!({ "previousState": "running", "newState": "stopped", "trigger": "tokenLimit" })
    )]
    fn a_turn_end_and_a_token_limit_stop_round_trip(
        #[case] event_type: &str,
        #[case] members: Value,
    ) {
        let stored = run_event(event_type, &members);
        let event: SessionEvent =
            serde_json::from_value(stored.clone()).expect("the stored event reads");
        assert_eq!(event.event_type().as_str(), event_type);
        assert_eq!(
            serde_json::to_value(&event).expect("the event writes"),
            stored
        );
    }

    #[test]
    fn a_completed_run_refuses_a_completion_kind() {
        let members = json!({ "previousState": "running", "newState": "completed" });
        let completed = run_event("agent.run.completed", &members);
        serde_json::from_value::<SessionEvent>(completed.clone())
            .expect("a completed run without a completion kind reads");

        let mut with_kind = completed;
        with_kind["payload"]["completionKind"] = json!("turn");
        assert!(serde_json::from_value::<SessionEvent>(with_kind).is_err());
    }
}
