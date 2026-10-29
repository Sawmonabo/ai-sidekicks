//! The one `workflow.run.notFound` refusal the workflow runs' stores and the attention seen mark
//! raise for a workflow run id that no run answers to.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;

use crate::domain_error::DomainError;

/// The refusal of `workflow_run_id`, which names no run the caller can reach; the id goes out as
/// the reply's `workflowRunId` field.
pub fn workflow_run_not_found(workflow_run_id: &WorkflowRunId) -> DomainError {
    DomainError::new(
        format!("No workflow run answers to {workflow_run_id}."),
        RefusalCode::WorkflowRunNotFound,
    )
    .with_detail(json!({ "workflowRunId": workflow_run_id }))
}
