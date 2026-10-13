//! The step events a workflow run appends: a step started, finished, failed, skipped or canceled, a
//! phase suspended, failed or held for memory, and a gate resolved, each naming its step by the
//! step record's key.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::approval::ApprovalDecision;
use crate::provider::account::record::ProviderAccountId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::ComposedText;
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::definition::item::WorkflowStepError;
use crate::workflow::run::events::workflow_run_event;
use crate::workflow::run::step::record::{WorkflowCost, WorkflowPayloadRef, workflow_step_key};

ts_constants! {
    /// Every reason a step is skipped.
    pub const WORKFLOW_STEP_SKIP_REASONS: [WorkflowStepSkipReason; 2] =
        [WorkflowStepSkipReason::NoItems, WorkflowStepSkipReason::Disabled];
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

workflow_step_event! {
    /// `workflow.step_canceled`: a step that was running or waiting when its run ended failed or
    /// canceled, or a branch a first-to-arrive merge canceled once another branch arrived.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowStepCanceledPayload {}
}

workflow_step_event! {
    /// `workflow.step_started`: the input the step ran on.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepStartedPayload {
        /// The input.
        #[garde(dive)]
        pub input_ref: WorkflowPayloadRef,
    }
}

workflow_step_event! {
    /// `workflow.step_finished`: the output and log the step produced, and its cost if billed.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepFinishedPayload {
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
    }
}

workflow_step_event! {
    /// `workflow.step_failed`: the error, its failure code if one names it, and the failed item.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
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
            /// `workflow.phase_suspended`: a step started waiting: its `waitCause` and, for an
            /// `account` wait, the spent account the attention read groups it under and the
            /// durable resume instant where the wait armed one; absent, only the person resumes
            /// it. A wait on anything else names neither. The deadline a `Timeout` arms is
            /// written on the step's row and rides no event.
            #[derive(
                Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
            )]
            #[serde(
                tag = "waitCause",
                rename_all = "snake_case",
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
    }
}

/// Why a phase was canceled rather than failing on its own work: a sibling branch's failure ended
/// the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPhaseCancellationReason {
    /// A sibling branch failed and ended the run.
    SiblingFailure,
}

workflow_step_event! {
    /// `workflow.phase_failed`: a phase failed, on its own work or because a sibling branch's
    /// failure ended the run and so canceled it.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseFailedPayload {
        /// `sibling_failure` where a sibling branch's failure canceled the phase; `null` where the
        /// phase failed on its own work.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<WorkflowPhaseCancellationReason>")]
        pub cancellation_reason: Option<WorkflowPhaseCancellationReason>,
    }
}

workflow_step_event! {
    /// `workflow.phase_waiting_on_pool`: the memory gate holds the step before it starts, written
    /// on entry to the hold and every 30 seconds while it lasts; memory is the only pool, so the
    /// payload names none.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowPhaseWaitingOnPoolPayload {
        /// The envelope sequence the hold began at, which ties each repeat back to one hold.
        pub waiting_since_seq: SafeInt<0>,
    }
}

/// Why a step was skipped: its input carried no items, or its node is disabled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowStepSkipReason {
    /// Its input carried no items.
    NoItems,
    /// Its node is disabled.
    Disabled,
}

workflow_step_event! {
    /// `workflow.step_skipped`: why the step was skipped.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowStepSkippedPayload {
        /// Why.
        pub reason: WorkflowStepSkipReason,
    }
}

workflow_run_event! {
    /// `workflow.gate_resolved`: the answer, written with the approval record's entry in one step.
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
        pub gate_resolution_id: ComposedText,
        /// The device that answered.
        pub device_id: DeviceId,
    }
}

/// The TypeScript module of the step events.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/step/events",
    doc: "The step events a workflow run appends: a step started, finished, failed, skipped or \
          canceled, a phase suspended, failed or held for memory, and a gate resolved, each naming \
          its step by the step record's key.",
    definitions: &[
        Definition::read::<WorkflowStepCanceledPayload>().checked(),
        Definition::read::<WorkflowStepStartedPayload>().checked(),
        Definition::read::<WorkflowStepFinishedPayload>().checked(),
        Definition::read::<WorkflowStepFailedPayload>().checked(),
        Definition::read::<WorkflowPhaseSuspendedPayload>().checked(),
        Definition::read::<WorkflowPhaseCancellationReason>(),
        Definition::read::<WorkflowPhaseFailedPayload>().checked(),
        Definition::read::<WorkflowPhaseWaitingOnPoolPayload>().checked(),
        Definition::read::<WorkflowStepSkipReason>(),
        Definition::read::<WorkflowStepSkippedPayload>().checked(),
        Definition::read::<WorkflowGateResolvedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
