//! The step events a workflow run appends: a step started, finished, failed, skipped or canceled, a
//! phase admitted, started, progressed, canceling, retried, suspended, resumed, completed, failed
//! or held for memory, a join's siblings canceled, and a gate resolved, each naming its step by the
//! step record's key.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::approval::ApprovalDecision;
use crate::provider::account::record::ProviderAccountId;
use crate::session::controls::methods::PermissionLevel;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::id::UuidTextForm;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::NonEmptyText;
use crate::workflow::definition::document::{WorkflowContentHash, WorkflowNodeId};
use crate::workflow::definition::item::WorkflowStepError;
use crate::workflow::run::events::workflow_run_event;
use crate::workflow::run::gate_resolution::WorkflowGateResolutionId;
use crate::workflow::run::step::record::{
    WorkflowCost, WorkflowPayloadRef, WorkflowStepSource, workflow_step_key,
};

ts_constants! {
    /// Every reason a step is skipped.
    WORKFLOW_STEP_SKIP_REASONS = WorkflowStepSkipReason::VARIANTS;
}

/// Declares a step event's payload struct: the step it names, by its session and the members its
/// step record is keyed by, so an event and its step share one identity; then its own members.
macro_rules! workflow_step_event {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($members:tt)* }) => {
        workflow_step_key! {
            $(#[$attribute])+
            pub struct $name {
                /// The session the run lives in.
                pub session_id: SessionId,
                $($members)*
            }
        }
    };
}

workflow_step_key! {
    position
    /// A step the event's write readied, by its node, its attempt and which execution of the node,
    /// with what its `pending` row stores, so a rebuild writes the same row; the run is the
    /// event's own.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowReadiedStep {
        /// The feed of each main input slot in slot order, `null` for a slot nothing fed.
        pub sources: Vec<Option<WorkflowStepSource>>,
        /// The input.
        #[garde(dive)]
        pub input_ref: WorkflowPayloadRef,
    }
}

workflow_step_event! {
    /// `workflow.step.canceled`: a step that was running or waiting when its run ended failed or
    /// canceled, or a branch a first-to-arrive merge canceled once another branch arrived.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepCanceledPayload {
        /// The steps this event's write readied, each with what its `pending` row stores; empty
        /// where it readied none.
        #[garde(dive)]
        pub readied: Vec<WorkflowReadiedStep>,
    }
}

workflow_step_event! {
    /// `workflow.step.started`: the input the step ran on, for an agent step whose account could
    /// not run the run's permission level the level it ran at instead, and for a step that gave
    /// its node's pinned items the hash of that pin.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepStartedPayload {
        /// The input.
        #[garde(dive)]
        pub input_ref: WorkflowPayloadRef,
        /// Present on an agent step whose account could not run the run's level: the level it ran
        /// at instead.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "PermissionLevel")]
        pub permission_level: Option<PermissionLevel>,
        /// Present on a step that gave its node's pinned items in place of running: the content
        /// hash of that pin, which tells a later run whether the pin changed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowContentHash")]
        pub pin_hash: Option<WorkflowContentHash>,
    }
}

workflow_step_event! {
    /// `workflow.step.completed`: the output and log the step produced, and its cost if billed.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepCompletedPayload {
        /// The output.
        #[garde(dive)]
        pub output_ref: WorkflowPayloadRef,
        /// The log.
        #[garde(dive)]
        pub log_ref: WorkflowPayloadRef,
        /// What it cost; absent where no provider was billed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowCost")]
        pub cost: Option<WorkflowCost>,
        /// How many items each main output holds, in output order, the error output last where
        /// the node has one: the boundaries of the output lists `outputRef` stores joined.
        pub output_item_counts: Vec<SafeInt<0>>,
        /// The steps this event's write readied, each with what its `pending` row stores; empty
        /// where it readied none.
        #[garde(dive)]
        pub readied: Vec<WorkflowReadiedStep>,
    }
}

/// The output a failed step passed on where its node's `onError` passed its input on: one member
/// holding the ref and its counts, so neither is written without the other.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowPassedOnOutput {
    /// The output.
    #[garde(dive)]
    pub output_ref: WorkflowPayloadRef,
    /// How many items each main output holds, in output order: the boundaries of the output
    /// lists `outputRef` stores joined.
    pub output_item_counts: Vec<SafeInt<0>>,
}

workflow_step_event! {
    /// `workflow.step.failed`: the error, its failure code if one names it, the failed item, the
    /// words a person typed with the Decline that failed it, the step's log, and the output it
    /// passed on where its node's `onError` passed its input on.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepFailedPayload {
        /// The error.
        #[garde(dive)]
        pub error: WorkflowStepError,
        /// The item that failed, by its index.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        pub failed_item_index: Option<SafeInt<0>>,
        /// Present where the person's Decline on the command step's own approval card failed it
        /// and they typed words on its `why not` line: those words.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "NonEmptyText")]
        pub decline_reason: Option<NonEmptyText>,
        /// The log.
        #[garde(dive)]
        pub log_ref: WorkflowPayloadRef,
        /// Present only where the node's `onError` passed its input on: that output and its
        /// counts.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowPassedOnOutput")]
        #[garde(dive)]
        pub passed_on: Option<WorkflowPassedOnOutput>,
        /// The steps this event's write readied, each with what its `pending` row stores; empty
        /// where it readied none.
        #[garde(dive)]
        pub readied: Vec<WorkflowReadiedStep>,
    }
}

/// Declares `WorkflowPhaseSuspendedPayload` with the step members every wait cause repeats.
macro_rules! phase_suspended_payload {
    ($($(#[doc = $doc:literal])+ $arm:ident { $($fields:tt)* })+) => {
        workflow_step_key! {
            enum [
                /// The session the run lives in.
                session_id: SessionId,
            ]
            /// `workflow.phase.suspended`: a step started waiting: its `waitCause` and, for an
            /// `account` wait, the spent account the attention read groups it under and the
            /// durable resume instant where the wait armed one; absent, only the person resumes
            /// it. A wait on anything else names neither. A wait on a person's approval, form or
            /// reply carries the deadline its node's `Timeout` arms, the `waitId` its answer
            /// names and the `logRef` the step wrote before it waited; a wait on an account or a
            /// chain's question carries none of them.
            #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
            #[serde(
                tag = "waitCause",
                rename_all = "camelCase",
                rename_all_fields = "camelCase",
                deny_unknown_fields
            )]
            #[garde(allow_unvalidated)]
            pub enum WorkflowPhaseSuspendedPayload {$(
                $(#[doc = $doc])+
                $arm { $($fields)* }
            )+}
        }
    };
}

phase_suspended_payload! {
    /// Waiting on a spent provider account.
    Account {
        /// The spent account.
        provider_account_id: ProviderAccountId,
        /// When the wait resumes itself; absent, only the person resumes it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        resume_at: Option<WireInstant>,
        /// Never present: only a wait on a person gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_deadline_at: Option<Never>,
        /// Never present: only a wait on a person carries a wait id.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_id: Option<Never>,
        /// Never present: only a wait on a person writes a log before it waits.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        log_ref: Option<Never>,
    }
    /// Waiting on a person's approval.
    Approval {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// When the wait gives up, where the node's `Timeout` armed one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        wait_deadline_at: Option<WireInstant>,
        /// The wait the person's answer must name to settle it.
        wait_id: UuidTextForm,
        /// Always present: the log the step wrote before it waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowPayloadRef")]
        #[garde(dive)]
        log_ref: Option<WorkflowPayloadRef>,
    }
    /// Waiting on a person's form.
    Form {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// When the wait gives up, where the node's `Timeout` armed one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        wait_deadline_at: Option<WireInstant>,
        /// The wait the person's answer must name to settle it.
        wait_id: UuidTextForm,
        /// Always present: the log the step wrote before it waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowPayloadRef")]
        #[garde(dive)]
        log_ref: Option<WorkflowPayloadRef>,
    }
    /// Waiting on a person's chat reply.
    Reply {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// When the wait gives up, where the node's `Timeout` armed one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        wait_deadline_at: Option<WireInstant>,
        /// The wait the person's answer must name to settle it.
        wait_id: UuidTextForm,
        /// Always present: the log the step wrote before it waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowPayloadRef")]
        #[garde(dive)]
        log_ref: Option<WorkflowPayloadRef>,
    }
    /// Waiting on its chain's question.
    Chain {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// Never present: only a wait on a person gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_deadline_at: Option<Never>,
        /// Never present: only a wait on a person carries a wait id.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_id: Option<Never>,
        /// Never present: only a wait on a person writes a log before it waits.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        log_ref: Option<Never>,
    }
}

/// Why a phase was canceled rather than failing on its own work: a sibling branch's failure ended
/// the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowPhaseCancellationReason {
    /// A sibling branch failed and ended the run.
    SiblingFailure,
}

workflow_step_event! {
    /// `workflow.phase.failed`: a phase failed, on its own work or because a sibling branch's
    /// failure ended the run and so canceled it.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseFailedPayload {
        /// `siblingFailure` where a sibling branch's failure canceled the phase; `null` where the
        /// phase failed on its own work.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<WorkflowPhaseCancellationReason>")]
        pub cancellation_reason: Option<WorkflowPhaseCancellationReason>,
    }
}

workflow_step_event! {
    /// `workflow.phase.waitingOnPool`: the memory gate holds the step before it starts, written
    /// on entry to the hold and every 30 seconds while it lasts; memory is the only pool, so the
    /// payload names none.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseWaitingOnPoolPayload {
        /// The envelope sequence the hold began at, which ties each repeat back to one hold.
        pub waiting_since_seq: SafeInt<0>,
    }
}

workflow_step_event! {
    /// `workflow.phase.admitted`: the memory gate admitted the step, which may start.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseAdmittedPayload {}
}

workflow_step_event! {
    /// `workflow.phase.started`: an admitted phase began.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseStartedPayload {}
}

workflow_step_event! {
    /// `workflow.phase.progressed`: a phase reported progress, at its phase type's own cadence.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseProgressedPayload {}
}

workflow_step_event! {
    /// `workflow.phase.canceling`: a phase was asked to stop and is winding down.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseCancelingPayload {}
}

workflow_step_event! {
    /// `workflow.phase.retried`: a failed phase was retried; the step named is the new attempt.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowPhaseRetriedPayload {
        /// The steps this event's write readied, each with what its `pending` row stores; empty
        /// where it readied none.
        #[garde(dive)]
        pub readied: Vec<WorkflowReadiedStep>,
    }
}

workflow_step_event! {
    /// `workflow.phase.resumed`: a waiting step resumed.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseResumedPayload {}
}

workflow_step_event! {
    /// `workflow.phase.completed`: a phase finished, and its gate may be answered.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseCompletedPayload {}
}

workflow_step_event! {
    /// `workflow.parallelJoin.branchesCanceled`: one wave of running sibling branches was canceled
    /// at the join, because the run ended failed or canceled or a first-to-arrive merge took its
    /// first input; each sibling's own `workflow.step.canceled` follows.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowParallelJoinBranchesCanceledPayload {}
}

/// Why a step was skipped: its input carried no items, or its node is disabled.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowStepSkipReason {
    /// Its input carried no items.
    NoItems,
    /// Its node is disabled.
    Disabled,
}

workflow_step_event! {
    /// `workflow.step.skipped`: why the step was skipped, what fed it, the input it skipped and
    /// the output it passed on.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepSkippedPayload {
        /// Why.
        pub reason: WorkflowStepSkipReason,
        /// The feed of each main input slot in slot order, `null` for a slot nothing fed.
        pub sources: Vec<Option<WorkflowStepSource>>,
        /// The input.
        #[garde(dive)]
        pub input_ref: WorkflowPayloadRef,
        /// The output it passed on.
        #[garde(dive)]
        pub output_ref: WorkflowPayloadRef,
        /// How many items each main output carries on, in output order: the boundaries of the
        /// output lists `outputRef` stores joined.
        pub output_item_counts: Vec<SafeInt<0>>,
        /// The steps this event's write readied, each with what its `pending` row stores; empty
        /// where it readied none.
        #[garde(dive)]
        pub readied: Vec<WorkflowReadiedStep>,
    }
}

workflow_run_event! {
    /// `workflow.gate.resolved`: the answer, written with the approval record's entry in one step.
    /// `nodeId` names the approval step; a chain's question names none. `deviceId` is the device
    /// that answered.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowGateResolvedPayload {
        /// The approval step answered; absent for a chain's question.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowNodeId")]
        pub node_id: Option<WorkflowNodeId>,
        /// The answer.
        pub outcome: ApprovalDecision,
        /// The answer's row in the gate resolutions.
        pub gate_resolution_id: WorkflowGateResolutionId,
        /// The device that answered.
        pub device_id: DeviceId,
    }
}

/// The TypeScript module of the step events.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/step/events",
    doc: "The step events a workflow run appends: a step started, finished, failed, skipped or \
          canceled, a phase admitted, started, progressed, canceling, retried, suspended, resumed, \
          completed, failed or held for memory, a join's siblings canceled, and a gate resolved, \
          each naming its step by the step record's key.",
    definitions: &[
        Definition::read::<WorkflowReadiedStep>(),
        Definition::read::<WorkflowStepCanceledPayload>().checked(),
        Definition::read::<WorkflowStepStartedPayload>().checked(),
        Definition::read::<WorkflowStepCompletedPayload>().checked(),
        Definition::read::<WorkflowPassedOnOutput>(),
        Definition::read::<WorkflowStepFailedPayload>().checked(),
        Definition::read::<WorkflowPhaseSuspendedPayload>().checked(),
        Definition::read::<WorkflowPhaseCancellationReason>(),
        Definition::read::<WorkflowPhaseFailedPayload>().checked(),
        Definition::read::<WorkflowPhaseWaitingOnPoolPayload>().checked(),
        Definition::read::<WorkflowPhaseAdmittedPayload>().checked(),
        Definition::read::<WorkflowPhaseStartedPayload>().checked(),
        Definition::read::<WorkflowPhaseProgressedPayload>().checked(),
        Definition::read::<WorkflowPhaseCancelingPayload>().checked(),
        Definition::read::<WorkflowPhaseRetriedPayload>().checked(),
        Definition::read::<WorkflowPhaseResumedPayload>().checked(),
        Definition::read::<WorkflowPhaseCompletedPayload>().checked(),
        Definition::read::<WorkflowParallelJoinBranchesCanceledPayload>().checked(),
        Definition::read::<WorkflowStepSkipReason>(),
        Definition::read::<WorkflowStepSkippedPayload>().checked(),
        Definition::read::<WorkflowGateResolvedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::WorkflowPhaseSuspendedPayload;

    const SESSION: &str = "018f0000-0000-7000-8000-000000000001";
    const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
    const ACCOUNT: &str = "018f0000-0000-7000-8000-00000000000c";
    const DEADLINE: &str = "2020-01-01T10:00:00.000Z";
    const WAIT: &str = "018f0000-0000-7000-8000-00000000000d";

    /// An empty inline log, the one a person's wait carries.
    fn empty_log() -> Value {
        json!({"kind": "inline", "items": []})
    }

    /// A step event's payload: the step it names, then `members`.
    fn step_payload(members: Value) -> Value {
        let mut payload = json!({
            "sessionId": SESSION, "workflowRunId": WORKFLOW_RUN, "nodeId": "ask",
            "attempt": 1, "executionIndex": 0,
        });
        if let (Some(payload), Value::Object(members)) = (payload.as_object_mut(), members) {
            payload.extend(members);
        }
        payload
    }

    /// A deadline rides a wait on a person and is refused on any other wait. Mutations: refuse it
    /// on a person's wait; keep it on an account or chain wait.
    #[rstest]
    #[case::approval(json!({"waitCause": "approval", "waitId": WAIT, "logRef": empty_log()}), true)]
    #[case::form(json!({"waitCause": "form", "waitId": WAIT, "logRef": empty_log()}), true)]
    #[case::reply(json!({"waitCause": "reply", "waitId": WAIT, "logRef": empty_log()}), true)]
    #[case::account(json!({"waitCause": "account", "providerAccountId": ACCOUNT}), false)]
    #[case::chain(json!({"waitCause": "chain"}), false)]
    fn phase_suspended_carries_a_deadline_only_on_a_wait_on_a_person(
        #[case] wait: Value,
        #[case] is_carried: bool,
    ) {
        let without_deadline = step_payload(wait.clone());
        assert!(
            serde_json::from_value::<WorkflowPhaseSuspendedPayload>(without_deadline).is_ok(),
            "the wait reads without a deadline"
        );
        let mut with_deadline = wait;
        if let Some(members) = with_deadline.as_object_mut() {
            members.insert("waitDeadlineAt".into(), json!(DEADLINE));
        }
        let wire = step_payload(with_deadline);
        let written = serde_json::from_value::<WorkflowPhaseSuspendedPayload>(wire.clone())
            .ok()
            .map(|read| serde_json::to_value(read).expect("a read payload writes"));
        assert_eq!(written, is_carried.then_some(wire));
    }
}
