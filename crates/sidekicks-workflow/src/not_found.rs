//! The not-found refusals every workflow store raises, one per kind of record: a workflow, a
//! version, a run or a step that no row answers to.

use std::fmt;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::workflow_run_not_found::workflow_run_not_found;

/// A workflow record no row answers to; nothing was read or written. Each kind answers its own
/// not-found code, with the address it was asked by as the detail.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowNotFound {
    /// No workflow in the library has the id (`workflow.definition.notFound`); a write to a
    /// deleted workflow is refused this way too, since it is no longer in the library.
    #[error("No workflow in the library answers to {definition_id}.")]
    Definition {
        /// The workflow asked for.
        definition_id: WorkflowDefinitionId,
    },
    /// No saved version answers to the number or the id asked for (`workflow.version.notFound`).
    #[error("No saved workflow version answers to {0}.")]
    Version(WorkflowVersionAddress),
    /// No run has the id (`workflow.run.notFound`).
    #[error("{}", workflow_run_not_found(.workflow_run_id))]
    Run {
        /// The run asked for.
        workflow_run_id: WorkflowRunId,
    },
    /// The run holds no step at the key (`workflow.step.notFound`).
    #[error(
        "Workflow run {} holds no step at node {}, attempt {}, execution {}.",
        .0.workflow_run_id,
        .0.node_id.as_str(),
        .0.attempt.get(),
        .0.execution_index.get()
    )]
    Step(WorkflowStepKey),
}

/// How a missing version was asked for: by its workflow and number, or by its own id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowVersionAddress {
    /// A workflow's version by its number.
    Number {
        /// The workflow.
        definition_id: WorkflowDefinitionId,
        /// The version's number, counted from 1.
        version_number: SafeInt<1>,
    },
    /// A version by its id.
    Id {
        /// The version.
        workflow_version_id: WorkflowVersionId,
    },
}

impl fmt::Display for WorkflowVersionAddress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number {
                definition_id,
                version_number,
            } => write!(
                formatter,
                "number {} of workflow {definition_id}",
                version_number.get()
            ),
            Self::Id {
                workflow_version_id,
            } => write!(formatter, "the id {workflow_version_id}"),
        }
    }
}

impl From<WorkflowNotFound> for DomainError {
    fn from(not_found: WorkflowNotFound) -> Self {
        let message = not_found.to_string();
        match not_found {
            WorkflowNotFound::Definition { definition_id } => {
                DomainError::new(message, RefusalCode::WorkflowDefinitionNotFound)
                    .with_detail(json!({ "definitionId": definition_id }))
            }
            WorkflowNotFound::Version(WorkflowVersionAddress::Number {
                definition_id,
                version_number,
            }) => DomainError::new(message, RefusalCode::WorkflowVersionNotFound).with_detail(
                json!({ "definitionId": definition_id, "versionNumber": version_number }),
            ),
            WorkflowNotFound::Version(WorkflowVersionAddress::Id {
                workflow_version_id,
            }) => DomainError::new(message, RefusalCode::WorkflowVersionNotFound)
                .with_detail(json!({ "workflowVersionId": workflow_version_id })),
            WorkflowNotFound::Run { workflow_run_id } => workflow_run_not_found(&workflow_run_id),
            WorkflowNotFound::Step(step_key) => {
                DomainError::new(message, RefusalCode::WorkflowStepNotFound).with_detail(step_key)
            }
        }
    }
}
