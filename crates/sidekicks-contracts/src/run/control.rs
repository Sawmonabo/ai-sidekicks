//! Run control: pause and resume, the recovery question after a restart, the run state stream
//! and the run-control method table, which also serves the queue, interventions, a child's own
//! controls and the provider's choices a run waits on.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::ExitCode;
use crate::event::envelope::SourcePosition;
use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, stream_frame};
use crate::method::methods;
use crate::orchestration::InterruptReason;
use crate::provider::driver::capabilities::ExecutionPosture;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::provider::driver::recovery::RecoveryCondition;
use crate::provider::id::ProviderId;
use crate::run::children::{
    AgentChildRunInterruptRequest, AgentChildRunInterruptResponse,
    AgentChildRunPausedUpdateRequest, AgentChildRunPausedUpdateResponse, AgentChildRunSteerRequest,
    AgentChildRunStopAllRequest, AgentChildRunStopAllResponse,
};
use crate::run::failure_cause::RunFailureCause;
use crate::run::id::RunId;
use crate::run::intervention::{AgentRunInterveneRequest, AgentRunInterveneResponse};
use crate::run::provider_choice::{
    AgentRunRefusalChoiceResolveRequest, AgentRunUsageCreditsChoiceResolveRequest,
};
use crate::run::queue::{
    AgentQueueItemCancelRequest, AgentQueueItemCancelResponse, AgentQueueItemCreateRequest,
    AgentQueueItemCreateResponse, AgentQueueItemListRequest, AgentQueueItemListResponse,
    AgentQueueItemReorderRequest, AgentQueueItemSubscribeRequest, RunQueueStreamFrame,
};
use crate::run::state::RunState;
use crate::session::controls::events::RunSafetyBufferingUpdatedPayload;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{Never, True};

/// Why a run failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunFailureCategory {
    /// The provider failed the run.
    ProviderFailure,
    /// The link to the provider failed.
    TransportFailure,
    /// The daemon could not write the run's record.
    LocalPersistenceFailure,
    /// The daemon could not project the run's events.
    ProjectionFailure,
    /// The provider's safety check refused the turn with no other model to take it.
    Refused,
    /// A setup gate threw before the provider started the run.
    SetupFailure,
}

ts_constants! {
    /// The code of a move the run's current state does not allow, such as a second or late answer
    /// to a choice the run already settled.
    AGENT_RUN_INVALID_TRANSITION_CODE = RefusalCode::AgentRunInvalidTransition;
    /// The code of an `agent.run.pause` or `agent.run.resume` whose `expectedRunVersion` is not
    /// the run's current version, older or newer; nothing is written and the run is left as it
    /// was.
    AGENT_RUN_VERSION_STALE_CODE = RefusalCode::AgentRunVersionStale;
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
    pub output_tail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
}

/// A process a signal ended, and the last lines it printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProcessExitWithSignal {
    /// The signal's name.
    pub signal: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// Never present beside a signal.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub exit_code: Option<Never>,
    /// The last lines it printed.
    pub output_tail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
}

/// A provider service the daemon ended because it answered nothing, and the last lines it printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProcessExitAfterSilence {
    /// How long it answered nothing before the daemon ended it, in seconds.
    pub silent_seconds: SafeInt<1>,
    /// Never present beside a silence.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub exit_code: Option<Never>,
    /// Never present beside a silence.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub signal: Option<Never>,
    /// The last lines it printed.
    pub output_tail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
}

/// How a process ended under work it carried: exactly one of its exit code, the signal that ended
/// it and the silence the daemon ended a provider service for, and the last lines it printed.
/// `agent.run.failed` carries a provider process's under the turn, and a failed workflow step the
/// process it ran; a process the daemon closed itself for any other reason, or a sleep, records
/// none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProcessExit {
    /// Ended with an exit code.
    Code(ProcessExitWithCode),
    /// Ended by a signal.
    Signal(ProcessExitWithSignal),
    /// Ended by the daemon after it answered nothing.
    Silent(ProcessExitAfterSilence),
}

/// Why the daemon itself ended a run `stopped`: the run passed the token limit the person set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StopTrigger {
    /// The token limit was passed.
    TokenLimit,
}

/// Declares the four bodies of a state change: each carries the members every transition has and
/// adds what its own target state may carry. A body marked `not_failed` also refuses the failure
/// cause and the process exit, which only `failed` carries.
macro_rules! run_state_change_members {
    (@body $(#[doc = $doc:literal])+ $name:ident { $($extra:tt)* }) => {
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
            #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
            pub provider_failure_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
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
            $($extra)*
            /// When the transition happened.
            #[garde(dive)]
            pub timestamp: WireInstant,
        }
    };
    (@kind failed $(#[doc = $doc:literal])+ $name:ident { $($extra:tt)* }) => {
        run_state_change_members!(@body $(#[doc = $doc])+ $name { $($extra)* });
    };
    (@kind not_failed $(#[doc = $doc:literal])+ $name:ident { $($extra:tt)* }) => {
        run_state_change_members!(@body $(#[doc = $doc])+ $name {
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
            $($extra)*
        });
    };
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident: $kind:ident { $($extra:tt)* }
    )+) => {$(
        run_state_change_members!(@kind $kind $(#[doc = $doc])+ $name { $($extra)* });
    )+};
}

run_state_change_members! {
    /// A transition into any state but `interrupted`, `stopped` or `failed`, which carries no
    /// failure cause, process exit or trigger.
    pub struct RunStateChangeMembers: not_failed {
        /// Never present outside `interrupted` and `stopped`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub trigger: Option<Never>,
    }

    /// A transition into `interrupted`, with the daemon's own interrupt reason where it has one.
    pub struct RunInterruptedStateChangeMembers: not_failed {
        /// Why the daemon itself interrupted the run; absent when it did not.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "InterruptReason")]
        pub trigger: Option<InterruptReason>,
    }

    /// A transition into `stopped`, with the daemon's own stop reason where it has one.
    pub struct RunStoppedStateChangeMembers: not_failed {
        /// Why the daemon itself stopped the run; absent when it did not.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "StopTrigger")]
        pub trigger: Option<StopTrigger>,
    }

    /// A transition into `failed`, with its typed cause and its provider process's own exit.
    pub struct RunFailedStateChangeMembers: failed {
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
        /// Never present outside `interrupted` and `stopped`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub trigger: Option<Never>,
    }
}

/// One run state transition as `agent.run.subscribe` delivers it, tagged on its new state, with its
/// new run version; only a transition into `failed` carries a failure cause or a process exit, and
/// only one into `interrupted` or `stopped` carries the daemon's own trigger. `sessionId` is
/// carried by the subscription's scope, not repeated per event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "newState", rename_all = "camelCase")]
pub enum RunStateChangeEvent {
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
    Interrupted(#[garde(dive)] RunInterruptedStateChangeMembers),
    /// Into `stopped`.
    Stopped(#[garde(dive)] RunStoppedStateChangeMembers),
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
pub struct AgentRunSubscribeRequest {
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
            params: AgentQueueItemCreateRequest,
            result: AgentQueueItemCreateResponse,
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
            params: AgentQueueItemListRequest,
            result: AgentQueueItemListResponse,
            refusals: [SessionNotFound, AgentChildRunNotFound, AgentChildRunControlRefused],
        },
        /// Removes a waiting message.
        AgentQueueItemCancel = mutation "agent.queueItem.cancel" {
            mutating: true,
            params: AgentQueueItemCancelRequest,
            result: AgentQueueItemCancelResponse,
            refusals: [
                AgentQueueItemNotFound,
                AgentQueueItemChangeRefused,
                AgentChildRunNotFound,
                AgentChildRunControlRefused,
            ],
        },
        /// Puts the waiting messages in a new order.
        AgentQueueItemReorder = mutation "agent.queueItem.reorder" {
            mutating: true,
            params: AgentQueueItemReorderRequest,
            result: AgentQueueItemListResponse,
            refusals: [
                SessionNotFound,
                AgentQueueItemNotFound,
                AgentQueueItemChangeRefused,
                AgentChildRunNotFound,
                AgentChildRunControlRefused,
            ],
        },
        /// Follows a queue's changes.
        AgentQueueItemSubscribe = subscription "agent.queueItem.subscribe" {
            mutating: false,
            params: AgentQueueItemSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: RunQueueStreamFrame,
            refusals: [
                SessionNotFound,
                ProviderUnavailable,
                SessionEventCursorUnresolvable,
                AgentChildRunNotFound,
                AgentChildRunControlRefused,
            ],
        },
        /// Interrupts a run or retries its turn on a faster model.
        AgentRunIntervene = mutation "agent.run.intervene" {
            mutating: true,
            params: AgentRunInterveneRequest,
            result: AgentRunInterveneResponse,
            refusals: [AgentRunNotFound, AgentInterventionIdempotencyConflict],
        },
        /// Pauses a run.
        AgentRunPause = mutation "agent.run.pause" {
            mutating: true,
            params: AgentRunPauseRequest,
            result: AgentRunControlResponse,
            refusals: [
                AgentRunNotFound,
                AgentRunVersionStale,
                AgentRunInvalidTransition,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
            ],
        },
        /// Resumes a paused run.
        AgentRunResume = mutation "agent.run.resume" {
            mutating: true,
            params: AgentRunResumeRequest,
            result: AgentRunControlResponse,
            refusals: [
                AgentRunNotFound,
                AgentRunVersionStale,
                AgentRunInvalidTransition,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
            ],
        },
        /// Follows every run state change in a session.
        AgentRunSubscribe = subscription "agent.run.subscribe" {
            mutating: false,
            params: AgentRunSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: RunStateStreamFrame,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable],
        },
        /// Steers one child of a session, live or ended.
        AgentChildRunSteer = mutation "agent.childRun.steer" {
            mutating: true,
            params: AgentChildRunSteerRequest,
            result: AgentQueueItemCreateResponse,
            refusals: [
                SessionNotFound,
                AgentChildRunNotFound,
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
            params: AgentChildRunInterruptRequest,
            result: AgentChildRunInterruptResponse,
            refusals: [
                AgentRunNotFound,
                AgentChildRunNotFound,
                AgentChildRunControlRefused,
                AgentQueueItemNotFound,
            ],
        },
        /// Pauses or resumes one live child of a run.
        AgentChildRunPausedUpdate = mutation "agent.childRun.paused.update" {
            mutating: true,
            params: AgentChildRunPausedUpdateRequest,
            result: AgentChildRunPausedUpdateResponse,
            refusals: [AgentRunNotFound, AgentChildRunNotFound, AgentChildRunControlRefused],
        },
        /// Stops every live child of a run.
        AgentChildRunStopAll = mutation "agent.childRun.stopAll" {
            mutating: true,
            params: AgentChildRunStopAllRequest,
            result: AgentChildRunStopAllResponse,
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
            refusals: [
                AgentRunNotFound,
                AgentRunInvalidTransition,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
            ],
        },
        /// Answers the choice a turn past the plan's allowance waits on.
        AgentRunUsageCreditsChoiceResolve = mutation "agent.run.usageCreditsChoice.resolve" {
            mutating: true,
            params: AgentRunUsageCreditsChoiceResolveRequest,
            result: AgentRunControlResponse,
            refusals: [
                AgentRunNotFound,
                AgentRunInvalidTransition,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
            ],
        },
    ];
}

/// The TypeScript module of run control.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/control",
    doc: "Run control: pause and resume, the recovery question after a restart, the run state \
          stream and the run-control method table, which also serves the queue, interventions, \
          a child's own controls and the provider's choices a run waits on.",
    definitions: &[
        Definition::read::<RunFailureCategory>().checked(),
        Definition::read::<ProcessExit>().checked(),
        Definition::read::<StopTrigger>().checked(),
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
        Definition::read::<AgentRunSubscribeRequest>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&RUN_CONTROL_METHOD_DESCRIPTORS],
};
