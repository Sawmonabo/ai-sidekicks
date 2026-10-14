//! The events a workflow run appends about the run as a whole: it started, was gated, waited,
//! failed, completed, was canceled, resumed or deleted, and its results were posted into a session.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
use crate::workflow::run::control::{WorkflowCancelReason, names_whole_repin};
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::step::record::workflow_step_key;
use crate::workflow::run::trigger::{WorkflowRunMode, WorkflowStartedBy};

/// Declares a run event's payload struct: the run it names (its session, its id, and the
/// definition and version it pins), then the payload's own members.
macro_rules! workflow_run_event {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($members:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The session the run lives in.
            pub session_id: $crate::session::id::SessionId,
            /// The run.
            pub workflow_run_id: $crate::workflow::run::id::WorkflowRunId,
            /// The definition it came from.
            pub definition_id: $crate::workflow::definition::document::WorkflowDefinitionId,
            /// The version it pins.
            pub workflow_version_id: $crate::workflow::definition::document::WorkflowVersionId,
            $($members)*
        }
    };
}

pub(crate) use workflow_run_event;

workflow_run_event! {
    /// `workflow.started`: how the run was started and by whom, so the run row rebuilds from
    /// events.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowStartedPayload {
        /// How it was started.
        pub mode: WorkflowRunMode,
        /// Who or what started it.
        pub started_by: WorkflowStartedBy,
    }
}

workflow_run_event! {
    /// `workflow.canceled`, written with the status in one step, so rebuilding the run from the log
    /// cannot bring a canceled run back. `reason` is the person's, when one was given; a chain's
    /// `Stop them all` cancels with none.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowCanceledPayload {
        /// The person's reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowCancelReason")]
        #[garde(dive)]
        pub reason: Option<WorkflowCancelReason>,
    }
}

workflow_run_event! {
    /// `workflow.run_deleted`, written with the delete of the run's rows in one step, so rebuilding
    /// the runs from the log leaves out a run the person deleted, whose earlier events the log
    /// keeps.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowRunDeletedPayload {}
}

workflow_run_event! {
    /// `workflow.gated`: the run reached a gate that must be answered before it goes on.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowGatedPayload {}
}

workflow_run_event! {
    /// `workflow.failed`: the run ended on a failure, whose cause its failed step's own event
    /// carries.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowFailedPayload {}
}

workflow_run_event! {
    /// `workflow.completed`: the run reached its last steps and succeeded.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowCompletedPayload {}
}

workflow_run_event! {
    /// `workflow.run_waiting`: the run started waiting, on a person, on its chain's question or on a
    /// spent provider account; the waiting step's own `workflow.phase_suspended` says which.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowRunWaitingPayload {}
}

workflow_step_key! {
    position
    /// One step a resumed run picks up, by its node, its attempt and which execution of the node;
    /// the run is the event's own.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowResumedStep {}
}

/// Where a resumed run picks up, so a reader rebuilds it without replaying the run's whole history:
/// the steps going on and the approval steps still waiting for an answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResumptionPoint {
    /// The steps going on.
    pub active_steps: Vec<WorkflowResumedStep>,
    /// The approval steps still waiting for an answer.
    pub pending_gates: Vec<WorkflowNodeId>,
}

workflow_run_event! {
    /// `workflow.resumed`: a person or an armed schedule resumed a waiting or failed run, with
    /// where it picks up and, only on an accepted re-pin, the version it left and the one it
    /// joined, both or neither.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[garde(custom(|payload: &Self, (): &()| names_whole_repin(
        payload.repinned_from_workflow_version_id.as_ref(),
        payload.repinned_to_workflow_version_id.as_ref(),
    )))]
    #[schemars(extend("type" = "object", "dependentRequired" = {
        "repinnedFromWorkflowVersionId": ["repinnedToWorkflowVersionId"],
        "repinnedToWorkflowVersionId": ["repinnedFromWorkflowVersionId"],
    }))]
    pub struct WorkflowResumedPayload {
        /// Where it picks up.
        pub resumption_point: WorkflowResumptionPoint,
        /// The version the run left, on an accepted re-pin.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowVersionId")]
        pub repinned_from_workflow_version_id: Option<WorkflowVersionId>,
        /// The version the run joined, on an accepted re-pin.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowVersionId")]
        pub repinned_to_workflow_version_id: Option<WorkflowVersionId>,
    }
}

/// `workflow.results_posted`: a finished run's results landed as the results row in `sessionId`,
/// the session that asked. It follows the run's final status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResultsPostedPayload {
    /// The session that asked.
    pub session_id: SessionId,
    /// The run.
    pub workflow_run_id: WorkflowRunId,
}

/// The TypeScript module of the run events.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/events",
    doc: "The events a workflow run appends about the run as a whole: it started, was gated, \
          waited, failed, completed, was canceled, resumed or deleted, and its results were posted \
          into a session.",
    definitions: &[
        Definition::read::<WorkflowStartedPayload>().checked(),
        Definition::read::<WorkflowCanceledPayload>().checked(),
        Definition::read::<WorkflowRunDeletedPayload>().checked(),
        Definition::read::<WorkflowGatedPayload>().checked(),
        Definition::read::<WorkflowFailedPayload>().checked(),
        Definition::read::<WorkflowCompletedPayload>().checked(),
        Definition::read::<WorkflowRunWaitingPayload>().checked(),
        Definition::read::<WorkflowResumedStep>(),
        Definition::read::<WorkflowResumptionPoint>(),
        Definition::read::<WorkflowResumedPayload>().checked(),
        Definition::read::<WorkflowResultsPostedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
