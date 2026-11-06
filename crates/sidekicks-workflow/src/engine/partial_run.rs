//! A partial run's plan: the newest settled step of each node it covers, across every run of the
//! workflow, and the nodes the difference between the version each step ran and the target
//! version marks dirty.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::iter;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDocumentHashedBody, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::versions::WorkflowVersionNode;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{safe_int_column, text_column};

use crate::definitions::versions::difference::diff_workflow_bodies;
use crate::engine::tick::RunGraph;

/// The statements a partial run's plan prepares on a read connection beside those of
/// `WorkflowVersions`: the read of a node's newest settled step.
#[expect(dead_code, reason = "the workflow.node.execute handler")]
pub(crate) const PARTIAL_RUN_PLAN_STATEMENT_CAPACITY: usize = 1;

// A node's newest step that stored an output, among the runs of every version of the workflow:
// newest by its end, then by run, attempt and execution, so the pick is total.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
static NEWEST_SETTLED_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let settled = sql_list_of(
        [WorkflowStepStatus::Succeeded, WorkflowStepStatus::Skipped].map(<&'static str>::from),
    );
    format!(
        "SELECT step.workflow_run_id, step.attempt, step.execution_index, run.workflow_version_id,
    step.source_json, step.output_ref, step.output_item_counts_json
  FROM workflow_versions AS version
  JOIN workflow_runs AS run ON run.workflow_version_id = version.id
  JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  WHERE version.definition_id = @definition_id AND step.node_id = @node_id
    AND step.status IN ({settled})
  ORDER BY step.finished_at DESC, step.workflow_run_id DESC, step.attempt DESC,
    step.execution_index DESC
  LIMIT 1"
    )
});

/// A node's newest step that stored an output, which a partial run may reuse: a step that
/// succeeded or was skipped, with the version its run executed.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) struct SettledStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The version the step's run executed, which its output was computed from.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// Per input slot, the step of its own run that fed it, `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// Its output, every main output's items joined into one list.
    pub(crate) output_ref: WorkflowPayloadRef,
    /// How many items each main output holds, in output order.
    pub(crate) output_item_counts: Vec<SafeInt<0>>,
}

/// Each of `node_ids` that has one, with its newest settled step among the runs of every version
/// of the workflow `definition_id`; a node no run settled is left out. Fails with the SQLite
/// error, `rusqlite::Error::FromSqlConversionFailure` for a stored value that does not read.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) fn read_settled_steps<'node>(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
    node_ids: impl IntoIterator<Item = &'node WorkflowNodeId>,
) -> rusqlite::Result<HashMap<WorkflowNodeId, SettledStep>> {
    let mut statement = connection.prepare_cached(NEWEST_SETTLED_STEP_SQL.as_str())?;
    let mut settled = HashMap::new();
    for node_id in node_ids {
        let step = statement
            .query_row(
                named_params! {
                    "@definition_id": definition_id.text().as_str(),
                    "@node_id": node_id.as_str(),
                },
                |row| settled_step_from_row(node_id, row),
            )
            .optional()?;
        if let Some(step) = step {
            settled.insert(node_id.clone(), step);
        }
    }
    Ok(settled)
}

// The settled step of `node_id` that `NEWEST_SETTLED_STEP_SQL` reads on `row`.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn settled_step_from_row(node_id: &WorkflowNodeId, row: &Row<'_>) -> rusqlite::Result<SettledStep> {
    Ok(SettledStep {
        step: WorkflowStepKey {
            workflow_run_id: text_column(row, 0, |text| WorkflowRunId::new(&text))?,
            node_id: node_id.clone(),
            attempt: safe_int_column(row, 1)?,
            execution_index: safe_int_column(row, 2)?,
        },
        workflow_version_id: text_column(row, 3, |text| WorkflowVersionId::new(&text))?,
        sources: text_column(row, 4, |text| serde_json::from_str(&text))?,
        output_ref: text_column(row, 5, |text| serde_json::from_str(&text))?,
        output_item_counts: text_column(row, 6, |text| serde_json::from_str(&text))?,
    })
}

// A version that settled steps ran: its body, and the covered nodes whose settled step it ran.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
struct SourceVersion {
    body: WorkflowDocumentHashedBody,
    node_ids: BTreeSet<WorkflowNodeId>,
}

/// The nodes of `target_body`, whose run graph is `graph`, that a reused step cannot stand for,
/// each version of `sources` compared with the target and its marks kept only on the nodes whose
/// step it ran. A changed node is dirty, and one switched on or off also marks the nodes it feeds;
/// a node inserted marks the nodes it feeds, and one deleted the nodes it fed that remain; an added
/// connection marks its destination.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn dirty_nodes(
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
            let place = graph.place(version_node_id(&change.after));
            marked.push(place);
            if is_switched_off(&change.before) != is_switched_off(&change.after) {
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

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn version_node_id(node: &WorkflowVersionNode) -> &WorkflowNodeId {
    match node {
        WorkflowVersionNode::Node(node) => &node.id,
        WorkflowVersionNode::Trigger(trigger) => &trigger.id,
    }
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn is_switched_off(node: &WorkflowVersionNode) -> bool {
    match node {
        WorkflowVersionNode::Node(node) => node.disabled == Some(true),
        WorkflowVersionNode::Trigger(trigger) => trigger.disabled == Some(true),
    }
}

#[cfg(test)]
mod tests;
