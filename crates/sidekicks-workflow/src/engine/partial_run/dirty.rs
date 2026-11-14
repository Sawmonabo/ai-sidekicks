//! Which nodes a partial run cannot reuse because the workflow changed: each settled step's data
//! compared, by the version that computed it, with the target version, a node whose run members
//! changed dirtied with what an insert, a delete, a switch or a connection change reaches.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::iter;

use rusqlite::Connection;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDocumentHashedBody, WorkflowNodeId, WorkflowNodeKindId, WorkflowNodeOnError,
    WorkflowNodeRetry, WorkflowTriggerInput, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::versions::WorkflowVersionNode;

use super::{PartialRunPlanError, SettledStep};
use crate::definitions::stored_document::parse_stored_workflow_body;
use crate::definitions::versions::difference::{diff_workflow_bodies, version_node_id};
use crate::definitions::versions::history::{VersionRow, WorkflowVersions};
use crate::engine::tick::RunGraph;

/// The nodes of `graph`, the run graph of `target_version`, whose steps in `settled` a change since
/// the version that computed their data keeps a run from reusing, as [`dirty_nodes`] marks them.
/// Reads the target version's body and each version that computed those steps' data, and fails as
/// [`PartialRunPlanError`] says.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(super) fn read_dirty_nodes(
    connection: &Connection,
    target_version: &VersionRow,
    graph: &RunGraph,
    settled: &HashMap<WorkflowNodeId, Vec<SettledStep>>,
) -> Result<BTreeSet<WorkflowNodeId>, PartialRunPlanError> {
    let target_body = parse_stored_workflow_body(&target_version.definition_body)?;
    let mut node_ids_by_version: BTreeMap<WorkflowVersionId, BTreeSet<WorkflowNodeId>> =
        BTreeMap::new();
    for (node_id, steps) in settled {
        for step in steps {
            node_ids_by_version
                .entry(step.workflow_version_id)
                .or_default()
                .insert(node_id.clone());
        }
    }
    let versions = WorkflowVersions::new(connection);
    let sources = node_ids_by_version
        .into_iter()
        .map(|(workflow_version_id, node_ids)| {
            let version = versions.read_version(workflow_version_id)?;
            Ok(SourceVersion {
                body: parse_stored_workflow_body(&version.definition_body)?,
                node_ids,
            })
        })
        .collect::<Result<Vec<_>, PartialRunPlanError>>()?;
    Ok(dirty_nodes(&target_body, graph, &sources))
}

// A version that settled steps ran: its body, and the covered nodes whose settled step it ran.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(super) struct SourceVersion {
    pub(super) body: WorkflowDocumentHashedBody,
    pub(super) node_ids: BTreeSet<WorkflowNodeId>,
}

/// The nodes of `target_body`, whose run graph is `graph`, that a reused step cannot stand for,
/// each version of `sources` compared with the target and its marks kept only on the nodes whose
/// step it ran. A node whose [`RunMembers`] changed is dirty, and one switched on or off also marks
/// the nodes it feeds; a node inserted marks the nodes it feeds, and one deleted the nodes it fed
/// that remain; an added connection marks its destination, and a removed one its destination where
/// the target still holds it.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(super) fn dirty_nodes(
    target_body: &WorkflowDocumentHashedBody,
    graph: &RunGraph,
    sources: &[SourceVersion],
) -> BTreeSet<WorkflowNodeId> {
    let mut fed_places: Vec<Vec<usize>> = vec![Vec::new(); graph.node_count()];
    for place in 0..graph.node_count() {
        for &feeder in graph.forward_feeders(place) {
            fed_places[feeder].push(place);
        }
    }
    let target_node_ids: HashSet<&WorkflowNodeId> = iter::once(&target_body.trigger.id)
        .chain(target_body.nodes.iter().map(|node| &node.id))
        .collect();
    let mut dirty = BTreeSet::new();
    for source in sources {
        let difference = diff_workflow_bodies(&source.body, target_body);
        let mut marked: Vec<usize> = Vec::new();
        for change in &difference.nodes_changed {
            let (before, after) = (run_members(&change.before), run_members(&change.after));
            if before == after {
                continue;
            }
            let place = graph.place(version_node_id(&change.after));
            marked.push(place);
            if before.is_disabled != after.is_disabled {
                marked.extend(&fed_places[place]);
            }
        }
        for added in &difference.nodes_added {
            marked.extend(&fed_places[graph.place(version_node_id(added))]);
        }
        for removed in &difference.nodes_removed {
            let removed_id = version_node_id(removed);
            marked.extend(
                source
                    .body
                    .edges
                    .iter()
                    .filter(|edge| &edge.source == removed_id)
                    .filter(|edge| target_node_ids.contains(&edge.target))
                    .map(|edge| graph.place(&edge.target)),
            );
        }
        marked.extend(
            difference
                .edges_added
                .iter()
                .map(|edge| graph.place(&edge.target)),
        );
        marked.extend(
            difference
                .edges_removed
                .iter()
                .filter(|edge| target_node_ids.contains(&edge.target))
                .map(|edge| graph.place(&edge.target)),
        );
        dirty.extend(
            marked
                .into_iter()
                .map(|place| &graph.node(place).id)
                .filter(|node_id| source.node_ids.contains(*node_id))
                .cloned(),
        );
    }
    dirty
}

/// The members of a node that decide what it runs, so a change to one dirties it; a rename, a notes
/// edit or an `order` change leaves them as they were. Each is read as it behaves, so an absent
/// member and its default compare equal.
#[derive(PartialEq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
struct RunMembers<'node> {
    /// Its kind.
    kind: &'node WorkflowNodeKindId,
    /// Its kind's version.
    kind_version: SafeInt<1>,
    /// Its params, an agent node's provider binding among them.
    params: &'node JsonRecord,
    /// Whether it is switched off.
    is_disabled: bool,
    /// What its failure does, `stop` where it names none.
    on_error: WorkflowNodeOnError,
    /// Its retries; `None` for one try, whether named or not.
    retry: Option<WorkflowNodeRetry>,
    /// Whether it runs once, over its first item only.
    is_executed_once: bool,
    /// Whether it outputs one empty item where it would output none.
    always_outputs_data: bool,
    /// The inputs a trigger declares, empty where it names none; `None` for another node.
    inputs: Option<&'node [WorkflowTriggerInput]>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn run_members(node: &WorkflowVersionNode) -> RunMembers<'_> {
    macro_rules! run_members_of {
        ($node:expr, $inputs:expr) => {
            RunMembers {
                kind: &$node.kind,
                kind_version: $node.kind_version,
                params: &$node.params,
                is_disabled: $node.disabled == Some(true),
                on_error: $node.on_error.unwrap_or(WorkflowNodeOnError::Stop),
                retry: $node.retry.filter(|retry| retry.max_tries.get() > 1),
                is_executed_once: $node.execute_once == Some(true),
                always_outputs_data: $node.always_output_data == Some(true),
                inputs: $inputs,
            }
        };
    }
    match node {
        WorkflowVersionNode::Node(node) => run_members_of!(node, None),
        WorkflowVersionNode::Trigger(trigger) => {
            run_members_of!(
                trigger,
                Some(
                    trigger
                        .inputs
                        .as_ref()
                        .map_or(&[][..], UniqueList::as_slice)
                )
            )
        }
    }
}
