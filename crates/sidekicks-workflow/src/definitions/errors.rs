//! The refusals of a workflow save: a document that breaks a rule, and a save based on a version
//! that is no longer the latest.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::definition::refusals::{
    WorkflowDefinitionFinding, WorkflowDefinitionRefusedDetails,
};

use sidekicks_ipc::domain_error::DomainError;

/// Why a save was refused; nothing was saved for either. Each answers its own code.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DefinitionRefusal {
    /// The document breaks one or more rules (`workflow.definition.refused`), every finding
    /// listed in the order the check raised them; a refusal is raised only with a finding.
    #[error("The workflow was refused with {} finding(s).", .findings.len())]
    Refused {
        /// Every finding, at least one.
        findings: Vec<WorkflowDefinitionFinding>,
    },
    /// The version the save was based on is no longer the latest (`workflow.version.stale`).
    #[error(
        "Workflow {definition_id} is at version {}, not {}; nothing was saved.",
        .latest_version_number.get(),
        .expected_version_number.get()
    )]
    VersionStale {
        /// The workflow saved.
        definition_id: WorkflowDefinitionId,
        /// The version the save was based on.
        expected_version_number: SafeInt<1>,
        /// The workflow's latest version.
        latest_version_number: SafeInt<1>,
    },
}

impl From<DefinitionRefusal> for DomainError {
    fn from(refusal: DefinitionRefusal) -> Self {
        let message = refusal.to_string();
        match refusal {
            DefinitionRefusal::Refused { findings } => {
                let details = WorkflowDefinitionRefusedDetails {
                    findings: BoundedVec::new(findings)
                        .expect("a save is refused only with at least one finding"),
                };
                DomainError::new(message, RefusalCode::WorkflowDefinitionRefused)
                    .with_detail(details)
            }
            DefinitionRefusal::VersionStale {
                definition_id,
                expected_version_number,
                latest_version_number,
            } => DomainError::new(message, RefusalCode::WorkflowVersionStale).with_detail(json!({
                "definitionId": definition_id,
                "expectedVersionNumber": expected_version_number,
                "latestVersionNumber": latest_version_number,
            })),
        }
    }
}
