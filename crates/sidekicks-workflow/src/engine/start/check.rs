//! The checks a start passes before anything is made, and the reads only they need.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::list::{BoundedVec, UniqueList};
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowEdge, WorkflowNode, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::handle::{
    WorkflowHandleMode, WorkflowHandleType, parse_workflow_handle,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::definition::refusals::{
    WorkflowNodeHandles, enabled_nodes_needing,
};
use sidekicks_contracts::workflow::run::control::{
    WorkflowRunHandleUndeclaredDetails, WorkflowRunNodeKindUnavailableDetails,
    WorkflowRunProviderRequiredDetails, WorkflowRunRepositoryRequiredDetails,
    fill_workflow_trigger_inputs,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunTrigger;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_policy::authorizer::PolicyDecision;
use sidekicks_policy::workflow_start::{WorkflowStart, check_workflow_start};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column};
use sidekicks_workspace::working_folder::read_working_folder;

use super::{
    CheckedStart, WorkflowRunStart, WorkflowRunStartError, WorkflowRunStarter, WorkflowStartArrival,
};
use crate::definitions::stored_document::parse_stored_workflow_body;
use crate::definitions::versions::history::WorkflowVersions;
use crate::engine::tick::{RunGraph, RunGraphError};
use crate::kinds::NodeKindTable;

// The workflow's pinned test items and its provider.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
const DEFINITION_SCOPE_SQL: &str =
    "SELECT pin_data_json, provider FROM workflow_definitions WHERE id = ?1";

impl WorkflowRunStarter {
    // The checks, in order, before anything is made: a trigger's fire under the workflow start
    // rule, the version, the session, the trigger's declared inputs, a project's repository for
    // the steps that need one, the workflow's provider for the steps that run in its sandbox, then
    // the run's graph.
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
        let (pin_data_json, provider) = definition?;
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
        // The graph holds every node, disabled ones too, so each node's kind must be listed at its
        // version; every node that is not is named at once, in document order.
        let unavailable: Vec<WorkflowNodeId> = std::iter::once(&trigger_node)
            .chain(&body.nodes)
            .filter(|node| self.kinds.kind_of(node).is_none())
            .map(|node| node.id.clone())
            .collect();
        if !unavailable.is_empty() {
            return Err(node_kind_unavailable(unavailable).into());
        }
        // The run's nodes are its trigger's and its version's.
        let nodes: HashMap<WorkflowNodeId, WorkflowNode> = std::iter::once(trigger_node)
            .chain(body.nodes)
            .map(|node| (node.id.clone(), node))
            .collect();
        let undeclared = undeclared_handles(&nodes, &body.edges, &self.kinds);
        if !undeclared.is_empty() {
            return Err(handle_undeclared(undeclared).into());
        }
        let graph =
            RunGraph::new(&nodes, &body.trigger.id, &body.edges, &self.kinds).map_err(|error| {
                match error {
                    RunGraphError::UnknownKind { node_id } => node_kind_unavailable(vec![node_id]),
                    RunGraphError::UndeclaredHandle { node_id, handle } => {
                        handle_undeclared(vec![(node_id, handle)])
                    }
                }
            })?;
        Ok(CheckedStart {
            definition_id: version.definition_id,
            workflow_name: body.name,
            trigger_node: WorkflowRunTrigger {
                kind: start.trigger_kind,
                node_id: body.trigger.id,
            },
            nodes,
            graph: Arc::new(graph),
            start_items,
            session,
            pin_data_json,
            provider,
        })
    }
}

// The workflow's stored pins and its provider.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn read_definition_scope(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
) -> rusqlite::Result<(Option<String>, Option<ProviderId>)> {
    connection
        .prepare_cached(DEFINITION_SCOPE_SQL)?
        .query_row([definition_id.text().as_str()], |row| {
            Ok((row.get(0)?, optional_text_column(row, 1, closed_word)?))
        })
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

// The refusal naming `node_ids`, whose kinds the table does not list at their versions; at least
// one.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn node_kind_unavailable(node_ids: Vec<WorkflowNodeId>) -> DomainError {
    DomainError::new(
        "The workflow holds a step whose kind this daemon no longer offers at its version.",
        RefusalCode::WorkflowRunNodeKindUnavailable,
    )
    .with_detail(WorkflowRunNodeKindUnavailableDetails {
        node_ids: BoundedVec::new(node_ids).expect("a refused kind names a node"),
    })
}

// The refusal naming each edge end in `ends` whose handle its node's kind does not declare; at
// least one.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn handle_undeclared(ends: Vec<(WorkflowNodeId, NonEmptyText)>) -> DomainError {
    let (node_ids, handles) = ends.into_iter().unzip();
    DomainError::new(
        "The workflow joins a step at a connection its kind no longer has.",
        RefusalCode::WorkflowRunHandleUndeclared,
    )
    .with_detail(WorkflowRunHandleUndeclaredDetails {
        node_ids: BoundedVec::new(node_ids).expect("a refused handle names its node"),
        handles: BoundedVec::new(handles).expect("a refused handle is named"),
    })
}

// Each main edge end in `edges` whose handle its node's kind does not declare on that side, in edge
// order, each once; an edge with a tool end is left out, as the graph leaves it out.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn undeclared_handles(
    nodes: &HashMap<WorkflowNodeId, WorkflowNode>,
    edges: &[WorkflowEdge],
    kinds: &NodeKindTable,
) -> Vec<(WorkflowNodeId, NonEmptyText)> {
    let handles: HashMap<&WorkflowNodeId, WorkflowNodeHandles> = nodes
        .iter()
        .filter_map(|(node_id, node)| Some((node_id, kinds.kind_rules(node)?.handles)))
        .collect();
    let is_tool = |handle: &NonEmptyText| {
        parse_workflow_handle(handle.as_str()).handle_type == WorkflowHandleType::Tool
    };
    let mut undeclared = Vec::new();
    for edge in edges {
        if is_tool(&edge.source_handle) || is_tool(&edge.target_handle) {
            continue;
        }
        for (node_id, handle, mode) in [
            (
                &edge.source,
                &edge.source_handle,
                WorkflowHandleMode::Outputs,
            ),
            (
                &edge.target,
                &edge.target_handle,
                WorkflowHandleMode::Inputs,
            ),
        ] {
            let is_declared = handles.get(node_id).is_some_and(|declared| {
                declared.declared_position(handle.as_str(), mode).is_some()
            });
            let end = (node_id.clone(), handle.clone());
            if !is_declared && !undeclared.contains(&end) {
                undeclared.push(end);
            }
        }
    }
    undeclared
}
