//! The events a workflow appends before any run exists: a version written, and a trigger or
//! schedule armed or fired, each naming the workflow rather than a run.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowNodeId, WorkflowVersionId,
};

/// `workflow.version.created`: a workflow was authored or a new version of it written; no run
/// exists yet, so it names the workflow and the version alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionCreatedPayload {
    /// The session the event is written to.
    pub session_id: SessionId,
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version written.
    pub workflow_version_id: WorkflowVersionId,
}

/// `workflow.schedule.armed` and `workflow.trigger.armed`: a schedule, or a file watch, webhook or
/// session-event filter, was armed on the workflow's trigger node.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowTriggerArmedPayload {
    /// The session the event is written to.
    pub session_id: SessionId,
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The trigger node armed.
    pub node_id: WorkflowNodeId,
}

/// `workflow.schedule.fired` and `workflow.trigger.fired`: an armed trigger fired, starting a run.
/// The workflow, the node and `scheduledInstant` together name the occurrence, so neither a restart
/// nor a second arming fires it twice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowTriggerFiredPayload {
    /// The session the event is written to.
    pub session_id: SessionId,
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The trigger node that fired.
    pub node_id: WorkflowNodeId,
    /// The occurrence's instant.
    #[garde(dive)]
    pub scheduled_instant: WireInstant,
}

/// The TypeScript module of the workflow's own events.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/events",
    doc: "The events a workflow appends before any run exists: a version written, and a trigger \
          or schedule armed or fired, each naming the workflow rather than a run.",
    definitions: &[
        Definition::read::<WorkflowVersionCreatedPayload>().checked(),
        Definition::read::<WorkflowTriggerArmedPayload>().checked(),
        Definition::read::<WorkflowTriggerFiredPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
