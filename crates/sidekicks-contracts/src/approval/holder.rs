//! What holds an approval ask open: the agent run whose action it gates, or the workflow wait whose
//! approval step or chain question it asks.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::run::id::RunId;
use crate::wire::id::UuidTextForm;
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::run::id::WorkflowRunId;

/// What holds an ask open: exactly one agent run or one workflow wait, by `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ApprovalHolder {
    /// The agent run whose action the ask gates.
    Run {
        /// The run.
        run_id: RunId,
    },
    /// The workflow wait that asks, closed only with its wait.
    Wait {
        /// The workflow run the wait belongs to.
        workflow_run_id: WorkflowRunId,
        /// The wait.
        wait_id: UuidTextForm,
        /// The step's node; absent on a chain's question, which no step asks.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowNodeId")]
        node_id: Option<WorkflowNodeId>,
    },
}

impl ApprovalHolder {
    /// The run, where an agent run holds the ask.
    pub fn run_id(&self) -> Option<RunId> {
        match self {
            Self::Run { run_id } => Some(*run_id),
            Self::Wait { .. } => None,
        }
    }
}
