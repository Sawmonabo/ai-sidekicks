//! The checks a start passes before anything is made, and the reads only they need.

use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::list::{BoundedVec, UniqueList};
use sidekicks_contracts::workflow::definition::document::{WorkflowDefinitionId, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::definition::refusals::enabled_nodes_needing;
use sidekicks_contracts::workflow::run::control::{
    WorkflowRunProviderRequiredDetails, WorkflowRunRepositoryRequiredDetails,
    fill_workflow_trigger_inputs,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunTrigger;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_policy::authorizer::PolicyDecision;
use sidekicks_policy::workflow_start::{WorkflowStart, check_workflow_start};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_workspace::working_folder::read_working_folder;

use super::{
    CheckedStart, WorkflowRunStart, WorkflowRunStartError, WorkflowRunStarter, WorkflowStartArrival,
};
use crate::definitions::stored_document::parse_stored_workflow_body;
use crate::definitions::versions::history::WorkflowVersions;

// The level every run of the workflow runs at, its pinned test items and its provider.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
const DEFINITION_SCOPE_SQL: &str =
    "SELECT permission_level, pin_data_json, provider FROM workflow_definitions WHERE id = ?1";

impl WorkflowRunStarter {
    // The checks, in order, before anything is made: a trigger's fire under the workflow start
    // rule, the version, the session, the trigger's declared inputs, a project's repository for
    // the steps that need one, then the workflow's provider for the steps that run in its sandbox.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    pub(super) async fn check(
        &self,
        start: &WorkflowRunStart,
    ) -> Result<CheckedStart, WorkflowRunStartError> {
        // Only a trigger's fire is judged here, as this machine's owner.
        let judged_owner = match start.arrival {
            WorkflowStartArrival::Trigger => Some(self.machines.read_owner().await?),
            WorkflowStartArrival::Person | WorkflowStartArrival::Agent => None,
        };
        let workflow_version_id = start.workflow_version_id;
        let session_id = start.session_id;
        // The workflow's row is read once its version names it.
        let (version, session) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let version = WorkflowVersions::new(connection)
                    .read_version(workflow_version_id)
                    .map(|version| {
                        let definition = read_definition_scope(connection, version.definition_id);
                        (version, definition)
                    });
                Ok::<_, WorkflowRunStartError>((
                    version,
                    read_working_folder(connection, &session_id),
                ))
            })
            .await?;
        let (version, definition) = version?;
        let (permission_level, pin_data_json, provider) = definition?;
        if let Some(owner) = judged_owner {
            let decision = check_workflow_start(
                &self.authorizer,
                WorkflowStart {
                    owner: owner.as_ref(),
                    workflow_id: &version.definition_id,
                    posture: None,
                },
            );
            if let PolicyDecision::Deny { errors } = decision {
                return Err(start_denied(&errors).into());
            }
        }
        let session = session?;
        let body = parse_stored_workflow_body(&version.definition_body)?;
        let declared = body
            .trigger
            .inputs
            .as_ref()
            .map_or(&[][..], UniqueList::as_slice);
        let filled = fill_workflow_trigger_inputs(declared, &start.input).map_err(|details| {
            DomainError::new(
                "The start leaves an input unfilled, or gives one a value that does not fit it.",
                RefusalCode::WorkflowRunInputRequired,
            )
            .with_detail(details)
        })?;
        // A trigger that declares inputs starts on one item of their values; any other on the
        // items it was given.
        let start_items = if declared.is_empty() {
            start.input.clone()
        } else {
            vec![WorkflowItem {
                json: AnyValue(
                    serde_json::to_value(&filled).expect("input values write as a JSON object"),
                ),
                binary: None,
                paired_item: None,
                error: None,
            }]
        };
        let trigger_node = WorkflowNode::from(&body.trigger);
        // A step that needs a repository runs only in a project's; a chat's own folder is none.
        let is_in_project = session
            .repository
            .as_ref()
            .is_some_and(|repository| repository.is_project);
        if !is_in_project {
            let needing = enabled_nodes_needing(Some(&trigger_node), &body.nodes, |node| {
                self.kinds
                    .kind_of(node)
                    .is_some_and(|kind| kind.spec.needs_repository())
            });
            if let Some(node_ids) = BoundedVec::new(needing) {
                return Err(DomainError::new(
                    "The workflow holds a step that needs a project's repository, and this start \
                     works in none.",
                    RefusalCode::WorkflowRunRepositoryRequired,
                )
                .with_detail(WorkflowRunRepositoryRequiredDetails { node_ids })
                .into());
            }
        }
        // A step that runs in a sandbox runs in the workflow's provider's; with none it cannot.
        if provider.is_none() {
            let needing = enabled_nodes_needing(Some(&trigger_node), &body.nodes, |node| {
                self.kinds
                    .kind_of(node)
                    .is_some_and(|kind| kind.spec.runs_in_sandbox(&node.params))
            });
            if let Some(node_ids) = BoundedVec::new(needing) {
                return Err(DomainError::new(
                    "The workflow holds a step that runs in a provider's sandbox, and it names no \
                     provider.",
                    RefusalCode::WorkflowRunProviderRequired,
                )
                .with_detail(WorkflowRunProviderRequiredDetails { node_ids })
                .into());
            }
        }
        // The run's nodes are its trigger's and its version's.
        let nodes = std::iter::once(trigger_node)
            .chain(body.nodes)
            .map(|node| (node.id.clone(), node))
            .collect();
        Ok(CheckedStart {
            definition_id: version.definition_id,
            workflow_name: body.name,
            trigger_node: WorkflowRunTrigger {
                kind: start.trigger_kind,
                node_id: body.trigger.id,
            },
            nodes,
            edges: Arc::from(body.edges),
            start_items,
            session,
            permission_level,
            pin_data_json,
            provider,
        })
    }
}

// The workflow's level, its stored pins and its provider.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn read_definition_scope(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
) -> rusqlite::Result<(PermissionLevel, Option<String>, Option<ProviderId>)> {
    connection.prepare_cached(DEFINITION_SCOPE_SQL)?.query_row(
        [definition_id.text().as_str()],
        |row| {
            Ok((
                text_column(row, 0, closed_word)?,
                row.get(1)?,
                optional_text_column(row, 2, closed_word)?,
            ))
        },
    )
}

/// The refusal of a start the workflow start rule denied, with the rule's errors when it gave
/// any.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn start_denied(errors: &[String]) -> DomainError {
    let refusal = DomainError::new(
        "This workflow may not start: a rule stops it.",
        RefusalCode::WorkflowRunStartDenied,
    );
    if errors.is_empty() {
        refusal
    } else {
        refusal.with_detail(serde_json::json!({ "errors": errors }))
    }
}
