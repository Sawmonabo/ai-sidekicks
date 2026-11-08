//! A partial run's plan: which of the nodes it covers execute and which reuse their newest
//! settled step from any run of the workflow, decided from the difference between the version
//! each step ran and the target version, from whether each step sits beside the steps that fed it,
//! and from what executes upstream of it.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::iter;
use std::sync::LazyLock;

use fixedbitset::FixedBitSet;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDocumentHashedBody, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::versions::WorkflowVersionNode;
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{safe_int_column, text_column};

use crate::definitions::stored_document::{StoredDocumentError, parse_stored_workflow_body};
use crate::definitions::versions::difference::{diff_workflow_bodies, version_node_id};
use crate::definitions::versions::history::{VersionRow, WorkflowVersions, WorkflowVersionsError};
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

/// What a partial run does with each node it covers: the nodes it executes and the nodes whose
/// settled step it reuses, each list in graph order, so the executed list is execution order.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) struct PartialRunPlan {
    /// The nodes the run executes.
    pub(crate) executed: Vec<WorkflowNodeId>,
    /// The nodes whose step the run reuses, each with that step.
    pub(crate) reused: Vec<(WorkflowNodeId, SettledStep)>,
}

/// Why a partial run could not be planned.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) enum PartialRunPlanError {
    /// SQLite failed the read of the nodes' settled steps, or a stored value did not read.
    #[error("reading the nodes' settled steps failed")]
    SettledSteps(#[source] rusqlite::Error),
    /// A version a settled step ran could not be read.
    #[error("reading a version a settled step ran failed")]
    Version(#[from] WorkflowVersionsError),
    /// The target version's body, or the body of a version a settled step ran, does not read.
    #[error("a version's stored body does not read")]
    Body(#[from] StoredDocumentError),
}

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

/// The plan of a partial run of `target_version`, whose run graph is `graph`, on the node `target`,
/// which the graph holds, over `scope`: the target alone, or the target and its ancestors. The
/// target always executes; a covered node executes when it has no settled step, when it is dirty,
/// when its step was not fed by the steps the plan reuses for its feeders, or when
/// [`executing_places`] says so; every other covered node reuses its step. Reads each covered
/// node's settled step and each version those steps ran, and fails as [`PartialRunPlanError`]
/// says.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) fn plan_partial_run(
    connection: &Connection,
    target_version: &VersionRow,
    graph: &RunGraph,
    target: &WorkflowNodeId,
    scope: WorkflowNodeExecuteScope,
) -> Result<PartialRunPlan, PartialRunPlanError> {
    let target_place = graph.place(target);
    let mut covered: Vec<usize> = match scope {
        WorkflowNodeExecuteScope::Node => vec![target_place],
        WorkflowNodeExecuteScope::FromHere => graph
            .ancestors(target_place)
            .chain(iter::once(target_place))
            .collect(),
    };
    covered.sort_unstable();
    let mut settled = read_settled_steps(
        connection,
        target_version.definition_id,
        covered.iter().map(|&place| &graph.node(place).id),
    )
    .map_err(PartialRunPlanError::SettledSteps)?;
    let target_body = parse_stored_workflow_body(&target_version.definition_body)?;
    let mut node_ids_by_version: BTreeMap<WorkflowVersionId, BTreeSet<WorkflowNodeId>> =
        BTreeMap::new();
    for (node_id, step) in &settled {
        node_ids_by_version
            .entry(step.workflow_version_id)
            .or_default()
            .insert(node_id.clone());
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
    let dirty = dirty_nodes(&target_body, graph, &sources);
    let mut needs_execution = FixedBitSet::with_capacity(graph.node_count());
    needs_execution.insert(target_place);
    for &place in &covered {
        let node_id = &graph.node(place).id;
        let can_reuse = settled
            .get(node_id)
            .is_some_and(|step| !dirty.contains(node_id) && is_fed_by_reused_steps(step, &settled));
        if !can_reuse {
            needs_execution.insert(place);
        }
    }
    let executing = executing_places(graph, &covered, needs_execution);
    let mut plan = PartialRunPlan {
        executed: Vec::new(),
        reused: Vec::new(),
    };
    for place in covered {
        let node_id = graph.node(place).id.clone();
        if executing.contains(place) {
            plan.executed.push(node_id);
        } else {
            let step = settled
                .remove(&node_id)
                .expect("a node that reuses its step has a settled step");
            plan.reused.push((node_id, step));
        }
    }
    Ok(plan)
}

/// Whether `step` was fed by the very steps `settled` holds for its feeders: each slot's source is
/// that node's settled step, in the same run at the same execution index. A step computed from
/// another run's feeder outputs than the ones reused beside it cannot be reused with them.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn is_fed_by_reused_steps(
    step: &SettledStep,
    settled: &HashMap<WorkflowNodeId, SettledStep>,
) -> bool {
    step.sources.iter().flatten().all(|source| {
        settled.get(&source.node_id).is_some_and(|feeder| {
            feeder.step.workflow_run_id == step.step.workflow_run_id
                && feeder.step.execution_index == source.execution_index
        })
    })
}

/// The places of `covered`, a partial run's nodes, that execute, given `needs_execution`, the
/// covered places that cannot reuse their step. Each execution rule is applied until none adds a
/// node: [`is_fed_by_executing_node`] and [`lifts_its_loop`].
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn executing_places(
    graph: &RunGraph,
    covered: &[usize],
    mut needs_execution: FixedBitSet,
) -> FixedBitSet {
    loop {
        let mut executing = FixedBitSet::with_capacity(graph.node_count());
        for &place in covered {
            if needs_execution.contains(place)
                || is_fed_by_executing_node(graph, &needs_execution, place)
            {
                executing.insert(place);
            }
        }
        let lifted: Vec<usize> = covered
            .iter()
            .copied()
            .filter(|&place| !needs_execution.contains(place))
            .filter(|&place| lifts_its_loop(graph, &executing, place))
            .collect();
        if lifted.is_empty() {
            return executing;
        }
        needs_execution.extend(lifted);
    }
}

/// Whether the node at `place` is fed, along forward main edges, by a node of `needs_execution`
/// directly or through other nodes, so it executes too: its stored output was computed from inputs
/// that no longer hold.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn is_fed_by_executing_node(graph: &RunGraph, needs_execution: &FixedBitSet, place: usize) -> bool {
    graph
        .ancestors(place)
        .any(|ancestor| needs_execution.contains(ancestor))
}

/// Whether the node at `place` is a loop's node with a node of `executing` in its body, so the loop
/// executes whole: a pass of a loop never runs in part.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn lifts_its_loop(graph: &RunGraph, executing: &FixedBitSet, place: usize) -> bool {
    graph.node(place).loop_output.is_some()
        && executing
            .ones()
            .any(|inside| graph.is_in_loop_body(inside, place))
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
fn is_switched_off(node: &WorkflowVersionNode) -> bool {
    match node {
        WorkflowVersionNode::Node(node) => node.disabled == Some(true),
        WorkflowVersionNode::Trigger(trigger) => trigger.disabled == Some(true),
    }
}

#[cfg(test)]
mod tests;
