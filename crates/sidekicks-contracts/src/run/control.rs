//! Run control: interventions on a running run, pause and resume, the recovery question after a
//! restart, the run state stream and the `run.*` method table, which also serves the queue, a
//! child's own controls and the provider's choices a run waits on.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::command::ExitCode;
use crate::event::envelope::SourcePosition;
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::{SubscribeAckResponse, stream_frame};
use crate::method::methods;
use crate::orchestration::InterruptReason;
use crate::provider::driver::capabilities::ExecutionPosture;
use crate::provider::driver::intervention::InterventionType;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::{
    DRIVER_WIRE_HANDLE_MAX_LEN, DRIVER_WIRE_REASON_MAX_LEN, DRIVER_WIRE_TOKEN_MAX_LEN,
};
use crate::provider::driver::recovery::RecoveryCondition;
use crate::provider::id::ProviderId;
use crate::run::children::{
    ChildInterruptRequest, ChildInterruptResponse, ChildPauseSetRequest, ChildPauseSetResponse,
    ChildSteerRequest, ChildrenStopRequest, ChildrenStopResponse,
};
use crate::run::failure_cause::RunFailureCause;
use crate::run::id::RunId;
use crate::run::provider_choice::{
    AgentRunRefusalChoiceResolveRequest, AgentRunUsageCreditsChoiceResolveRequest,
};
use crate::run::queue::{
    QueueItemCancelRequest, QueueItemCancelResponse, QueueItemCreateRequest,
    QueueItemCreateResponse, QueueItemId, QueueItemListRequest, QueueItemListResponse,
    QueueReorderRequest, RunQueueStreamFrame, RunQueueSubscribeRequest,
};
use crate::run::state::RunState;
use crate::session::controls::events::RunSafetyBufferingUpdatedPayload;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{Never, True};

branded_uuid_id! {
    /// Identifies one intervention on a run.
    InterventionId
}

/// Where an intervention stands, from request to outcome; each state has its own event. `failed`
/// is a dispatch that threw, so a request never stays `accepted` for good.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum InterventionState {
    /// Asked for.
    Requested,
    /// Taken by the daemon.
    Accepted,
    /// Carried out as asked.
    Applied,
    /// Refused.
    Rejected,
    /// Carried out through a fallback.
    Degraded,
    /// Outdated before it could apply.
    Expired,
    /// Its dispatch threw.
    Failed,
}

/// Why a run failed. The values carry spaces because they are wire words, not identifiers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum RunFailureCategory {
    /// The provider failed the run.
    #[serde(rename = "provider failure")]
    ProviderFailure,
    /// The link to the provider failed.
    #[serde(rename = "transport failure")]
    TransportFailure,
    /// The daemon could not write the run's record.
    #[serde(rename = "local persistence failure")]
    LocalPersistenceFailure,
    /// The daemon could not project the run's events.
    #[serde(rename = "projection failure")]
    ProjectionFailure,
    /// The provider's safety check refused the turn with no other model to take it.
    #[serde(rename = "refused")]
    Refused,
    /// A setup gate threw before the provider started the run.
    #[serde(rename = "setup failure")]
    SetupFailure,
}

ts_constants! {
    /// Every state an intervention passes through, `requested` first.
    INTERVENTION_STATES = InterventionState::VARIANTS;
    /// The code of a move the run's current state does not allow, such as a second or late answer
    /// to a choice the run already settled.
    RUN_INVALID_TRANSITION_CODE = RefusalCode::AgentRunInvalidTransition;
    /// The code of a `agent.run.pause` or `agent.run.resume` whose `expectedRunVersion` is not the
    /// run's current version, older or newer; nothing is written and the run is left as it was.
    RUN_VERSION_STALE_CODE = RefusalCode::AgentRunVersionStale;
}

/// Declares the interrupt's arms on `pending`: each repeats the guards every intervention carries
/// and the reason, then adds its own members.
macro_rules! intervention_interrupt_request {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "pending",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[schemars(inline)]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The run interrupted.
                target_run_id: RunId,
                /// The run version the caller last saw; an absent or outdated one is refused,
                /// never applied.
                expected_run_version: SafeInt<0>,
                /// The caller's key, stored with the intervention, so an identical retry answers
                /// the recorded outcome.
                client_idempotency_key: ClientUuid,
                /// The person's reason.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>")]
                reason: Option<FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>>,
                $($extra)*
            },
        )+}
    };
}

intervention_interrupt_request! {
    /// An interrupt of a run's turn, tagged on what becomes of the messages still waiting: sent as
    /// the next turn, or returned to the draft. Only the next turn may name a message to deliver
    /// first.
    pub enum InterventionInterruptRequest {
        /// The waiting messages go as the next turn.
        NextTurn {
            /// The message `Send now` puts ahead of the rest.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "QueueItemId")]
            deliver_first: Option<QueueItemId>,
        },
        /// The waiting messages return to the draft.
        ReturnToDraft {
            /// Never present: a message delivered first goes as the next turn.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            deliver_first: Option<Never>,
        },
    }
}

/// A caller's request to interrupt or retry a run; a person's steer is a `agent.queueItem.create`,
/// never an intervention. `fasterModelRetry` resends a turn the provider holds for a safety check
/// on `model`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum InterventionRequestPayload {
    /// Interrupts the run's turn.
    Interrupt(InterventionInterruptRequest),
    /// Retries the turn the provider holds on the faster model it names.
    FasterModelRetry {
        /// The run retried.
        target_run_id: RunId,
        /// The run version the caller last saw; an absent or outdated one is refused, never
        /// applied.
        expected_run_version: SafeInt<0>,
        /// The caller's key, stored with the intervention, so an identical retry answers the
        /// recorded outcome.
        client_idempotency_key: ClientUuid,
        /// The provider's id of the turn held.
        expected_turn_id: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
        /// The model the turn is sent again on.
        model: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
    },
}

/// Declares the intervention answer's arms on `state`: each repeats the members every answer
/// carries; the arms before the `;` carry no reason, and each arm after it adds its own.
macro_rules! intervention_request_response {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $plain_doc:literal])+ $plain_arm:ident,)+
            ;
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "state",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            $(
                $(#[doc = $plain_doc])+
                $plain_arm {
                    /// The intervention.
                    intervention_id: InterventionId,
                    /// What it does.
                    intervention_type: InterventionType,
                    /// The run version after the intervention, for the caller's next
                    /// `expectedRunVersion`.
                    run_version: SafeInt<0>,
                    /// Never present outside `rejected`.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "Never")]
                    rejection_reason: Option<Never>,
                    /// Never present outside `failed`.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "Never")]
                    failure_reason: Option<Never>,
                },
            )+
            $(
                $(#[doc = $arm_doc])+
                $arm {
                    /// The intervention.
                    intervention_id: InterventionId,
                    /// What it does.
                    intervention_type: InterventionType,
                    /// The run version after the intervention, for the caller's next
                    /// `expectedRunVersion`.
                    run_version: SafeInt<0>,
                    $($extra)*
                },
            )+
        }
    };
}

intervention_request_response! {
    /// The daemon's answer to an intervention request. A refused intervention is a normal answer in
    /// state `rejected` with a machine-readable `rejectionReason`, not a JSON-RPC error; one whose
    /// dispatch threw answers `failed` with its `failureReason`, the error's code or message, and a
    /// retry under the same key answers the same. No other state carries a reason.
    pub enum InterventionRequestResponse {
        /// Asked for.
        Requested,
        /// Taken by the daemon.
        Accepted,
        /// Carried out as asked.
        Applied,
        /// Carried out through a fallback.
        Degraded,
        /// Outdated before it could apply.
        Expired,
        ;
        /// Refused, with why.
        Rejected {
            /// The machine-readable cause, such as `provider.capability.unsupported`.
            rejection_reason: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
            /// Never present outside `failed`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            failure_reason: Option<Never>,
        },
        /// Its dispatch threw, with what it threw.
        Failed {
            /// The thrown error's code, else its message.
            failure_reason: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
            /// Never present outside `rejected`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            rejection_reason: Option<Never>,
        },
    }
}

/// A process that ended with an exit code, and the last lines it printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProcessExitWithCode {
    /// The exit code.
    pub exit_code: ExitCode,
    /// Never present beside an exit code.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub signal: Option<Never>,
    /// The last lines it printed.
    pub output_tail: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
}

/// A process a signal ended, and the last lines it printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProcessExitWithSignal {
    /// The signal's name.
    pub signal: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    /// Never present beside a signal.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub exit_code: Option<Never>,
    /// The last lines it printed.
    pub output_tail: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
}

/// How a process that ended on its own exited: exactly one of its exit code and the signal that
/// ended it, and the last lines it printed. `agent.run.failed` carries a provider process's under
/// the turn, and a failed workflow step the process it ran; a process the daemon closed itself, or
/// a sleep, records none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProcessExit {
    /// Ended with an exit code.
    Code(ProcessExitWithCode),
    /// Ended by a signal.
    Signal(ProcessExitWithSignal),
}

/// How a completed run ended: its turn finished (`turn`) or its whole task did (`task`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunCompletionKind {
    /// The turn finished.
    Turn,
    /// The whole task finished.
    Task,
}

/// Declares the two bodies of a state change: each carries the members every transition has and
/// adds what its own target state may carry.
macro_rules! run_state_change_members {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident { $($extra:tt)* }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The run.
            pub run_id: RunId,
            /// The run version after the transition, which clients pass back as
            /// `expectedRunVersion`.
            pub run_version: SafeInt<0>,
            /// The state it left.
            pub previous_state: RunState,
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
            /// The provider's own words on why it failed the run, shown whole and never parsed.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
            pub provider_failure_detail: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
            /// Whether its turn or its whole task finished.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RunCompletionKind")]
            pub completion_kind: Option<RunCompletionKind>,
            /// Present only on a terminal the daemon itself closed, which is never a crash.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "True")]
            pub intended_close: Option<True>,
            /// The effective posture, stamped only on `running`, where it and the workspace root
            /// are final.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ExecutionPosture")]
            pub execution_posture: Option<ExecutionPosture>,
            /// Why the daemon itself stopped the run; absent when it did not.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "InterruptReason")]
            pub trigger: Option<InterruptReason>,
            $($extra)*
            /// When the transition happened.
            #[garde(dive)]
            pub timestamp: WireInstant,
        }
    )+};
}

run_state_change_members! {
    /// A transition into any state but `failed`, which carries no failure cause or process exit.
    pub struct RunStateChangeMembers {
        /// Never present outside `failed`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub failure_cause: Option<Never>,
        /// Never present outside `failed`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub process_exit: Option<Never>,
    }

    /// A transition into `failed`, with its typed cause and its provider process's own exit.
    pub struct RunFailedStateChangeMembers {
        /// The run's typed failure cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RunFailureCause")]
        #[garde(dive)]
        pub failure_cause: Option<RunFailureCause>,
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

/// One run state transition as `agent.run.subscribe` delivers it, tagged on its new state, with its
/// new run version; only a transition into `failed` carries a failure cause or a process exit.
/// `sessionId` is carried by the subscription's scope, not repeated per event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "newState", rename_all = "camelCase")]
pub enum RunStateChangeEvent {
    /// Into `queued`.
    Queued(#[garde(dive)] RunStateChangeMembers),
    /// Into `starting`.
    Starting(#[garde(dive)] RunStateChangeMembers),
    /// Into `running`.
    Running(#[garde(dive)] RunStateChangeMembers),
    /// Into `waitingForApproval`.
    WaitingForApproval(#[garde(dive)] RunStateChangeMembers),
    /// Into `waitingForInput`.
    WaitingForInput(#[garde(dive)] RunStateChangeMembers),
    /// Into `pausing`.
    Pausing(#[garde(dive)] RunStateChangeMembers),
    /// Into `paused`.
    Paused(#[garde(dive)] RunStateChangeMembers),
    /// Into `completed`.
    Completed(#[garde(dive)] RunStateChangeMembers),
    /// Into `interrupted`.
    Interrupted(#[garde(dive)] RunStateChangeMembers),
    /// Into `stopped`.
    Stopped(#[garde(dive)] RunStateChangeMembers),
    /// Into `failed`.
    Failed(#[garde(dive)] RunFailedStateChangeMembers),
}

/// A run rewound to an earlier turn boundary, carried on `agent.run.subscribe`, and the stored
/// `agent.run.rolledBack` payload. It is not a state transition, so it has no previous or new
/// state, and it carries no tag: its closed members keep it apart from the state change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRolledBackEvent {
    /// The session.
    pub session_id: SessionId,
    /// The run rewound.
    pub run_id: RunId,
    /// The run version after the rollback advanced it.
    pub run_version: SafeInt<0>,
    /// The turn boundary the run landed at, as a session position: the request's target, or the
    /// landing the driver confirmed when that differs.
    pub target_position: SourcePosition,
}

/// One delivery on `agent.run.subscribe`: a state change, a rollback, or the provider's safety hold
/// on the run's turn. The hold is a live detail only this stream carries, never written to the
/// session's history. None carries a tag; their closed members keep them apart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum RunStateStreamEvent {
    /// A state transition.
    StateChange(#[garde(dive)] RunStateChangeEvent),
    /// A rollback.
    RolledBack(#[garde(skip)] AgentRunRolledBackEvent),
    /// The provider's safety hold or its release.
    SafetyBuffering(#[garde(skip)] RunSafetyBufferingUpdatedPayload),
}

/// One change on `agent.run.subscribe`: the delivery and the cursor of the event it came from, or,
/// for the provider's safety hold, which the session's history never records, the session's
/// newest cursor when it went out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RunStateStreamChange {
    /// The position.
    pub cursor: EventCursor,
    /// The delivery.
    #[garde(dive)]
    pub event: RunStateStreamEvent,
}

stream_frame! {
    /// The value of each `agent.run.subscribe` notify: the changes since the previous frame.
    pub struct RunStateStreamFrame(RunStateStreamChange);
}

/// Pauses a run. Not an intervention, but guarded by the same mandatory `expectedRunVersion`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunPauseRequest {
    /// The run.
    pub target_run_id: RunId,
    /// The run version the caller last saw.
    pub expected_run_version: SafeInt<0>,
}

/// Resumes a paused run, guarded by the same mandatory `expectedRunVersion`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunResumeRequest {
    /// The run.
    pub target_run_id: RunId,
    /// The run version the caller last saw.
    pub expected_run_version: SafeInt<0>,
}

/// The run's state after a run-control call and its advanced `runVersion`, so the caller can guard
/// its next request without reading `agent.run.subscribe`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunControlResponse {
    /// The run.
    pub run_id: RunId,
    /// Its state now.
    pub new_state: RunState,
    /// Its run version now.
    pub run_version: SafeInt<0>,
}

/// The person's answer when a resumed conversation and the service's record disagree. Provider
/// ahead: `keepProvider` keeps what it did, `undoToAgreed` cuts back to where both agree.
/// Service ahead: `continueProvider` goes on from the provider's record, `handOver` starts a new
/// conversation with the hand-over brief.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunRecoveryChoice {
    /// Keep what the provider did.
    KeepProvider,
    /// Cut back to where both agree.
    UndoToAgreed,
    /// Go on from the provider's record.
    ContinueProvider,
    /// Start a new conversation with the hand-over brief.
    HandOver,
}

/// Answers the recovery question a restart left a run halted on (`agent.run.recovery.resolve`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunRecoveryResolveRequest {
    /// The run.
    pub run_id: RunId,
    /// The person's answer.
    pub choice: RunRecoveryChoice,
}

/// The payload of `agent.run.recovery.resolved`: which choice settled the question.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRecoveryResolvedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The answer that settled it.
    pub choice: RunRecoveryChoice,
}

/// The payload of `agent.run.recoverySteps.added`: after a restart, `count` steps from the
/// provider's own record that only read were added to the transcript as the provider recorded them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRecoveryStepsAddedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// How many steps were added, at least one.
    pub count: SafeInt<1>,
    /// The provider whose record they came from.
    pub provider: ProviderId,
}

/// Opens a session's run state stream: every run in the session, the lead and each child, which
/// the caller fans out by `runId`. With `afterCursor`, the stream first replays each change the
/// session's record holds after that cursor, then follows live; without it, it follows from now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RunStateSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// Replay from after this position.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub after_cursor: Option<EventCursor>,
}

methods! {
    /// The run-control methods: the queue, interventions, pause and resume, the state stream, a
    /// child's own controls, the recovery question and the provider's choices a run waits on.
    pub const RUN_CONTROL_METHOD_DESCRIPTORS = [
        /// Sends a message into a run's queue, or edits one still waiting.
        AgentQueueItemCreate = mutation "agent.queueItem.create" {
            mutating: true,
            params: QueueItemCreateRequest,
            result: QueueItemCreateResponse,
            refusals: [
                SessionNotFound,
                SessionAlreadyClosed,
                SessionChangeRefused,
                ProviderUnavailable,
                ProviderTimeout,
                AgentQueueItemPersistenceUnavailable,
                AgentQueueItemNotFound,
                AgentQueueItemChangeRefused,
                AgentQueueItemRunChanged,
                SkillPathRefused,
                SessionMessageTooLarge,
            ],
        },
        /// Reads a queue in the daemon's order.
        AgentQueueItemList = query "agent.queueItem.list" {
            mutating: false,
            params: QueueItemListRequest,
            result: QueueItemListResponse,
            refusals: [SessionNotFound, AgentChildRunControlRefused],
        },
        /// Removes a waiting message.
        AgentQueueItemCancel = mutation "agent.queueItem.cancel" {
            mutating: true,
            params: QueueItemCancelRequest,
            result: QueueItemCancelResponse,
            refusals: [AgentQueueItemNotFound, AgentQueueItemChangeRefused, AgentChildRunControlRefused],
        },
        /// Puts the waiting messages in a new order.
        AgentQueueItemReorder = mutation "agent.queueItem.reorder" {
            mutating: true,
            params: QueueReorderRequest,
            result: QueueItemListResponse,
            refusals: [
                SessionNotFound,
                AgentQueueItemNotFound,
                AgentQueueItemChangeRefused,
                AgentChildRunControlRefused,
            ],
        },
        /// Follows a queue's changes.
        AgentQueueItemSubscribe = subscription "agent.queueItem.subscribe" {
            mutating: false,
            params: RunQueueSubscribeRequest,
            result: SubscribeAckResponse,
            emission: RunQueueStreamFrame,
            refusals: [
                SessionNotFound,
                ProviderUnavailable,
                SessionEventCursorUnresolvable,
                AgentChildRunControlRefused,
            ],
        },
        /// Interrupts a run or retries its turn on a faster model.
        AgentRunIntervene = mutation "agent.run.intervene" {
            mutating: true,
            params: InterventionRequestPayload,
            result: InterventionRequestResponse,
            refusals: [AgentRunNotFound, AgentInterventionIdempotencyConflict],
        },
        /// Pauses a run.
        AgentRunPause = mutation "agent.run.pause" {
            mutating: true,
            params: AgentRunPauseRequest,
            result: AgentRunControlResponse,
            refusals: [AgentRunNotFound, AgentRunVersionStale, AgentRunInvalidTransition, ProviderUnavailable],
        },
        /// Resumes a paused run.
        AgentRunResume = mutation "agent.run.resume" {
            mutating: true,
            params: AgentRunResumeRequest,
            result: AgentRunControlResponse,
            refusals: [AgentRunNotFound, AgentRunVersionStale, AgentRunInvalidTransition, ProviderUnavailable],
        },
        /// Follows every run state change in a session.
        AgentRunSubscribe = subscription "agent.run.subscribe" {
            mutating: false,
            params: RunStateSubscribeRequest,
            result: SubscribeAckResponse,
            emission: RunStateStreamFrame,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable],
        },
        /// Steers one child of a session, live or ended.
        AgentChildRunSteer = mutation "agent.childRun.steer" {
            mutating: true,
            params: ChildSteerRequest,
            result: QueueItemCreateResponse,
            refusals: [
                SessionNotFound,
                AgentChildRunControlRefused,
                AgentQueueItemNotFound,
                AgentQueueItemChangeRefused,
                AgentQueueItemPersistenceUnavailable,
                SessionMessageTooLarge,
            ],
        },
        /// Interrupts one live child of a run.
        AgentChildRunInterrupt = mutation "agent.childRun.interrupt" {
            mutating: true,
            params: ChildInterruptRequest,
            result: ChildInterruptResponse,
            refusals: [AgentRunNotFound, AgentChildRunControlRefused, AgentQueueItemNotFound],
        },
        /// Pauses or resumes one live child of a run.
        AgentChildRunPausedUpdate = mutation "agent.childRun.paused.update" {
            mutating: true,
            params: ChildPauseSetRequest,
            result: ChildPauseSetResponse,
            refusals: [AgentRunNotFound, AgentChildRunControlRefused],
        },
        /// Stops every live child of a run.
        AgentChildRunStopAll = mutation "agent.childRun.stopAll" {
            mutating: true,
            params: ChildrenStopRequest,
            result: ChildrenStopResponse,
            refusals: [AgentRunNotFound],
        },
        /// Answers the recovery question a restart left a run halted on.
        AgentRunRecoveryResolve = mutation "agent.run.recovery.resolve" {
            mutating: true,
            params: AgentRunRecoveryResolveRequest,
            result: AgentRunControlResponse,
            refusals: [AgentRunNotFound, AgentRunInvalidTransition, AgentRunRecoveryFailed],
        },
        /// Answers the choice a refused turn waits on.
        AgentRunRefusalChoiceResolve = mutation "agent.run.refusalChoice.resolve" {
            mutating: true,
            params: AgentRunRefusalChoiceResolveRequest,
            result: AgentRunControlResponse,
            refusals: [AgentRunNotFound, AgentRunInvalidTransition, ProviderUnavailable],
        },
        /// Answers the choice a turn past the plan's allowance waits on.
        AgentRunUsageCreditsChoiceResolve = mutation "agent.run.usageCreditsChoice.resolve" {
            mutating: true,
            params: AgentRunUsageCreditsChoiceResolveRequest,
            result: AgentRunControlResponse,
            refusals: [AgentRunNotFound, AgentRunInvalidTransition, ProviderUnavailable],
        },
    ];
}

/// The TypeScript module of run control.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/control",
    doc: "Run control: interventions on a running run, pause and resume, the recovery question \
          after a restart, the run state stream and the `run.*` method table, which also serves \
          the queue, a child's own controls and the provider's choices a run waits on.",
    definitions: &[
        Definition::read::<InterventionId>().checked(),
        Definition::read::<InterventionState>(),
        Definition::read::<RunFailureCategory>().checked(),
        Definition::read::<InterventionRequestPayload>().checked(),
        Definition::read::<InterventionRequestResponse>().checked(),
        Definition::read::<ProcessExit>().checked(),
        Definition::read::<RunCompletionKind>().checked(),
        Definition::read::<RunStateChangeEvent>().checked(),
        Definition::read::<AgentRunRolledBackEvent>().checked(),
        Definition::read::<RunStateStreamEvent>(),
        Definition::read::<RunStateStreamChange>(),
        Definition::read::<RunStateStreamFrame>().checked(),
        Definition::read::<AgentRunPauseRequest>().checked(),
        Definition::read::<AgentRunResumeRequest>().checked(),
        Definition::read::<AgentRunControlResponse>().checked(),
        Definition::read::<RunRecoveryChoice>(),
        Definition::read::<AgentRunRecoveryResolveRequest>().checked(),
        Definition::read::<AgentRunRecoveryResolvedPayload>().checked(),
        Definition::read::<AgentRunRecoveryStepsAddedPayload>().checked(),
        Definition::read::<RunStateSubscribeRequest>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&RUN_CONTROL_METHOD_DESCRIPTORS],
};
