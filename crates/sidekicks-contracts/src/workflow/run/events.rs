//! The events a workflow run appends about the run as a whole: it started, was gated, waited,
//! failed, completed, was canceled, resumed or deleted, and its results were posted into a session.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::id::ProviderId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::NonEmptyText;
use crate::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
use crate::workflow::definition::item::WorkflowStepError;
use crate::workflow::run::control::{WorkflowCancelReason, names_whole_repin};
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::step::events::WorkflowReadiedStep;
use crate::workflow::run::step::record::{WorkflowPayloadRef, workflow_step_key};
use crate::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
};

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
    /// `workflow.run.started`: how the run was started and by whom, the trigger node that started
    /// it, its place in its chain and the input its trigger step starts on, so the run row
    /// rebuilds from events.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowRunStartedPayload {
        /// How it was started.
        pub mode: WorkflowRunMode,
        /// Who or what started it.
        pub started_by: WorkflowStartedBy,
        /// The trigger node that started it.
        pub trigger: WorkflowRunTrigger,
        /// Its place in its chain.
        pub chain: WorkflowRunChainPlace,
        /// The provider the run's command steps use; absent when the workflow names none.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderId")]
        pub provider: Option<ProviderId>,
        /// The input its trigger step starts on.
        #[garde(dive)]
        pub input_ref: WorkflowPayloadRef,
    }
}

workflow_run_event! {
    /// `workflow.run.canceled`, written with the status in one step, so rebuilding the run from the
    /// log cannot bring a canceled run back. `reason` is the person's, when one was given; a
    /// chain's `Stop them all` cancels with none. `error` is the run's error the cancel stored,
    /// carrying the reason as its message.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowRunCanceledPayload {
        /// The person's reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowCancelReason")]
        #[garde(dive)]
        pub reason: Option<WorkflowCancelReason>,
        /// The run's error, where the cancel stored one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepError")]
        #[garde(dive)]
        pub error: Option<WorkflowStepError>,
    }
}

workflow_run_event! {
    /// `workflow.run.deleted`, written with the delete of the run's rows in one step, so rebuilding
    /// the runs from the log leaves out a run the person deleted, whose earlier events the log
    /// keeps.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowRunDeletedPayload {}
}

workflow_run_event! {
    /// `workflow.gate.reached`: the run reached a gate that must be answered before it goes on.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowGateReachedPayload {}
}

/// Whether a failed run is parked, waiting for a person to resume it, or ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunFailedOutcome {
    /// A step failed under `onError: stop`, or the crash sweep failed it: the run holds where it
    /// stopped, with no end instant, until it is resumed, canceled or deleted.
    Parked,
    /// The run ended on its failure, with its end instant, and takes no resume.
    Ended,
}

workflow_step_key! {
    position
    /// The step whose failure ended a run, by its node, its attempt and which execution of the
    /// node; the run is the event's own.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowRunEndingStep {}
}

workflow_run_event! {
    /// `workflow.run.failed`: the run failed on a step and either parked or ended. A parked run
    /// leaves the cause to that step's own event; an ended run names the step its ending sits on
    /// and the run's error, which a run cap makes the cap's own.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[garde(custom(|payload: &Self, (): &()| names_its_ending_only_when_ended(payload)))]
    #[schemars(extend(
        "if" = { "properties": { "outcome": { "const": "ended" } }, "required": ["outcome"] },
        "then" = {
            "properties": { "endingStep": true, "error": true },
            "required": ["endingStep", "error"]
        },
        "else" = {
            "not": { "anyOf": [{ "required": ["endingStep"] }, { "required": ["error"] }] }
        },
    ))]
    pub struct WorkflowRunFailedPayload {
        /// Whether the run parked or ended.
        pub outcome: WorkflowRunFailedOutcome,
        /// The step the run's ending sits on; present exactly when the run ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowRunEndingStep")]
        pub ending_step: Option<WorkflowRunEndingStep>,
        /// The run's error; present exactly when the run ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepError")]
        #[garde(dive)]
        pub error: Option<WorkflowStepError>,
    }
}

/// Refuses a failed run's payload that names an ending step or an error unless the run ended, or
/// that leaves either out when it did.
fn names_its_ending_only_when_ended(payload: &WorkflowRunFailedPayload) -> garde::Result {
    let is_ended = payload.outcome == WorkflowRunFailedOutcome::Ended;
    if payload.ending_step.is_some() == is_ended && payload.error.is_some() == is_ended {
        Ok(())
    } else {
        Err(garde::Error::new(
            "an ended run names its ending step and its error, and a parked run neither",
        ))
    }
}

workflow_run_event! {
    /// `workflow.run.completed`: the run reached its last steps and succeeded.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowRunCompletedPayload {}
}

workflow_run_event! {
    /// `workflow.run.waiting`: the run started waiting, on a person, on its chain's question or on
    /// a spent provider account; the waiting step's own `workflow.phase.suspended` says which.
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
    /// `workflow.run.resumed`: a person or an armed schedule resumed a waiting or failed run, with
    /// where it picks up and, only on an accepted re-pin, the version it left and the one it
    /// joined, both or neither.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
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
    pub struct WorkflowRunResumedPayload {
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
        /// The steps this event's write readied, each with what its `pending` row stores; empty
        /// where it readied none.
        #[garde(dive)]
        pub readied: Vec<WorkflowReadiedStep>,
    }
}

/// `workflow.results.posted`: a finished run's results landed as the results row in `sessionId`,
/// the session that asked. It follows the run's final status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResultsPostedPayload {
    /// The session that asked.
    pub session_id: SessionId,
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// The run's summary line as the post found it; absent where the run wrote none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub summary: Option<NonEmptyText>,
}

/// The TypeScript module of the run events.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/events",
    doc: "The events a workflow run appends about the run as a whole: it started, was gated, \
          waited, failed, completed, was canceled, resumed or deleted, and its results were posted \
          into a session.",
    definitions: &[
        Definition::read::<WorkflowRunStartedPayload>().checked(),
        Definition::read::<WorkflowRunCanceledPayload>().checked(),
        Definition::read::<WorkflowRunDeletedPayload>().checked(),
        Definition::read::<WorkflowGateReachedPayload>().checked(),
        Definition::read::<WorkflowRunFailedOutcome>(),
        Definition::read::<WorkflowRunEndingStep>(),
        Definition::read::<WorkflowRunFailedPayload>().checked(),
        Definition::read::<WorkflowRunCompletedPayload>().checked(),
        Definition::read::<WorkflowRunWaitingPayload>().checked(),
        Definition::read::<WorkflowResumedStep>(),
        Definition::read::<WorkflowResumptionPoint>(),
        Definition::read::<WorkflowRunResumedPayload>().checked(),
        Definition::read::<WorkflowResultsPostedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::WorkflowRunFailedPayload;

    /// The step an ended run names.
    fn ending_step() -> Value {
        json!({"nodeId": "ask", "attempt": 1, "executionIndex": 2})
    }

    /// The run's error an ended run names.
    fn run_error() -> Value {
        json!({"message": "the run passed its cap", "nodeId": "ask"})
    }

    /// An ended run names its ending step and its error, and a parked run neither. Mutation:
    /// drop the garde check on `WorkflowRunFailedPayload`, which lets every refused case through.
    #[rstest]
    #[case::parked("parked", None, None, true)]
    #[case::parked_naming_an_error("parked", None, Some(run_error()), false)]
    #[case::parked_naming_a_step("parked", Some(ending_step()), None, false)]
    #[case::ended("ended", Some(ending_step()), Some(run_error()), true)]
    #[case::ended_without_its_error("ended", Some(ending_step()), None, false)]
    #[case::ended_without_its_step("ended", None, Some(run_error()), false)]
    fn a_failed_run_names_its_ending_only_when_it_ended(
        #[case] outcome: &str,
        #[case] step: Option<Value>,
        #[case] error: Option<Value>,
        #[case] is_accepted: bool,
    ) {
        let mut wire = json!({
            "sessionId": "018f0000-0000-7000-8000-000000000001",
            "workflowRunId": "018f0000-0000-7000-8000-000000000004",
            "definitionId": "018f0000-0000-7000-8000-000000000005",
            "workflowVersionId": "018f0000-0000-7000-8000-000000000006",
            "outcome": outcome,
        });
        if let Some(members) = wire.as_object_mut() {
            if let Some(step) = step {
                members.insert("endingStep".into(), step);
            }
            if let Some(error) = error {
                members.insert("error".into(), error);
            }
        }
        let payload =
            serde_json::from_value::<WorkflowRunFailedPayload>(wire).expect("the payload reads");
        assert_eq!(garde::Validate::validate(&payload).is_ok(), is_accepted);
    }
}
