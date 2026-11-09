//! A partial run's plan: which of the nodes it covers execute and which reuse every settled step
//! they took in their source run, decided from the difference between the version that computed
//! each step's data and the target version, from whether each step sits beside the steps that fed
//! it, from whether its pin changed, and from what executes upstream of it; and a retry's, which
//! reuses its source run's steps outside the retried node and what it feeds.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::iter;
use std::sync::{Arc, LazyLock};

use fixedbitset::FixedBitSet;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowDocumentHashedBody, WorkflowNodeId,
    WorkflowNodeKindId, WorkflowNodeOnError, WorkflowNodeRetry, WorkflowTriggerInput,
    WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::versions::WorkflowVersionNode;
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::events::WorkflowReusedStep;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::definitions::stored_document::{StoredDocumentError, parse_stored_workflow_body};
use crate::definitions::versions::difference::{diff_workflow_bodies, version_node_id};
use crate::definitions::versions::history::{VersionRow, WorkflowVersions, WorkflowVersionsError};
use crate::engine::tick::{RunGraph, RunPin};

/// The statements a partial run's plan prepares on a read connection beside those of
/// `WorkflowVersions`: the read of a node's source run and the read of its steps in that run.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) const PARTIAL_RUN_PLAN_STATEMENT_CAPACITY: usize = 2;

// The run of a node's newest step that stored an output, among the runs of every version of the
// workflow: newest by its end, then by run, attempt and execution, so the pick is total.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
static SOURCE_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let settled = sql_list_of(
        [WorkflowStepStatus::Succeeded, WorkflowStepStatus::Skipped].map(<&'static str>::from),
    );
    format!(
        "SELECT step.workflow_run_id
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

// Every step of a node in one run, in execution order. A reused step's data was computed by the
// version its `reusedFrom` names, not by its own run's version.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
const NODE_STEPS_SQL: &str = "SELECT step.workflow_run_id, step.attempt, step.execution_index,
    step.status,
    COALESCE(json_extract(step.reused_from_json, '$.workflowVersionId'), run.workflow_version_id),
    run.session_id, step.source_json, step.input_ref, step.output_ref,
    step.output_item_counts_json, step.pin_hash, step.reused_from_json
  FROM workflow_runs AS run
  JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  WHERE run.id = @run_id AND step.node_id = @node_id
  ORDER BY step.execution_index";

/// What a partial run does with each node it covers: the nodes it executes, and the nodes whose
/// settled steps it reuses or, for a run of one node, reads as that node's prior input. Each list
/// is in execution order: a node follows every node that feeds it, and siblings go by place.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) struct PartialRunPlan {
    /// The nodes the run executes.
    pub(crate) executed: Vec<WorkflowNodeId>,
    /// For a run from a node or a retry, the nodes whose steps the run reuses, each with every
    /// settled step it took in its source run, in execution order; empty for a run of one node.
    pub(crate) reused: Vec<(WorkflowNodeId, Vec<SettledStep>)>,
    /// For a run of one node, the covered nodes whose steps it reads as its prior input, each with
    /// every settled step it took in its source run, in execution order, used as they are though
    /// the node changed since; empty for a run from a node.
    pub(crate) inputs: Vec<(WorkflowNodeId, Vec<SettledStep>)>,
}

impl PartialRunPlan {
    /// Makes every node a partial run on `target` covers over `graph` execute, in execution order,
    /// as a run whose trigger executes must: every covered node descends from the trigger.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.node.execute handler")
    )]
    pub(crate) fn execute_covered(&mut self, graph: &RunGraph, target: &WorkflowNodeId) {
        self.executed = covered_places(graph, graph.place(target))
            .into_iter()
            .map(|place| graph.node(place).id.clone())
            .collect();
        self.reused.clear();
        self.inputs.clear();
    }

    /// The places of `graph`, the graph the plan was made on, that the plan covers, by place, and
    /// each settled step a walk on it replays: every settled step of the nodes it reuses or reads as prior input, but those the walk skips
    /// on its own and so never readies to replay, every step of a node `graph` disables and a skip
    /// of its own that passed no items on.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn replayed(self, graph: &RunGraph) -> (Arc<[bool]>, Vec<ReplayedStep>) {
        let mut covered = vec![false; graph.node_count()];
        for node_id in &self.executed {
            covered[graph.place(node_id)] = true;
        }
        let mut replayed = Vec::new();
        for (node_id, steps) in self.reused.into_iter().chain(self.inputs) {
            let place = graph.place(&node_id);
            covered[place] = true;
            if graph.node(place).is_disabled {
                continue;
            }
            for settled in steps {
                let output_lengths: Vec<usize> = settled
                    .output_item_counts
                    .iter()
                    .map(|count| {
                        usize::try_from(count.get())
                            .expect("an output's item count fits in a pointer-sized integer")
                    })
                    .collect();
                let is_own_skip =
                    settled.status == WorkflowStepStatus::Skipped && settled.reused_from.is_none();
                if is_own_skip && output_lengths.iter().all(|&length| length == 0) {
                    continue;
                }
                replayed.push(ReplayedStep {
                    node_id: node_id.clone(),
                    settled,
                    output_lengths,
                });
            }
        }
        (Arc::from(covered), replayed)
    }
}

/// A settled step a walk on a plan's graph replays, beside its node and its main outputs' item
/// counts in output order.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct ReplayedStep {
    /// The step's node.
    pub(crate) node_id: WorkflowNodeId,
    /// The step.
    pub(crate) settled: SettledStep,
    /// How many items each main output holds, in output order.
    pub(crate) output_lengths: Vec<usize>,
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
    /// A version a settled step's data was computed by could not be read.
    #[error("reading a version a settled step ran failed")]
    Version(#[from] WorkflowVersionsError),
    /// The target version's body, or the body of a version a settled step's data was computed by,
    /// does not read.
    #[error("a version's stored body does not read")]
    Body(#[from] StoredDocumentError),
}

/// A step of a node's source run that stored an output, which a partial run may reuse: a step that
/// succeeded or was skipped, with the version that computed its data.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) struct SettledStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Where it stands: succeeded, or skipped.
    pub(crate) status: WorkflowStepStatus,
    /// The version that computed its data: the one its `reused_from` names for a reused skip, its
    /// run's own for any other step.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// The session its run belongs to.
    pub(crate) session_id: SessionId,
    /// Per input slot, the step of its own run that fed it, `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// Its input.
    pub(crate) input_ref: WorkflowPayloadRef,
    /// Its output, every main output's items joined into one list.
    pub(crate) output_ref: WorkflowPayloadRef,
    /// How many items each main output holds, in output order.
    pub(crate) output_item_counts: Vec<SafeInt<0>>,
    /// The hash of the pin it ran on, or for a reused skip the hash its source step recorded;
    /// `None` where it gave no pin.
    pub(crate) pin_hash: Option<WorkflowContentHash>,
    /// For a reused skip, the step whose data it carries and that step's version; `None` for any
    /// other step.
    pub(crate) reused_from: Option<WorkflowReusedStep>,
}

impl SettledStep {
    /// The step whose data this one carries, which a run reusing it names: the step it reused for
    /// a reused skip, so a reuse of a reuse names the step that computed the data, else itself.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.node.execute handler")
    )]
    pub(crate) fn origin(&self) -> WorkflowReusedStep {
        self.reused_from
            .clone()
            .unwrap_or_else(|| WorkflowReusedStep {
                step: self.step.clone(),
                workflow_version_id: self.workflow_version_id,
            })
    }
}

/// Each of `node_ids` whose source run settled it, with every settled step it took in that run in
/// execution order. A node's source run is the run of its newest settled step among the runs of
/// every version of the workflow `definition_id`; a node no run settled, or with a step in that
/// run that neither succeeded nor was skipped, is left out, except a failed step a later attempt on
/// the same sources settled, which is passed over. Fails with the SQLite error,
/// `rusqlite::Error::FromSqlConversionFailure` for a stored value that does not read.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) fn read_settled_steps<'node>(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
    node_ids: impl IntoIterator<Item = &'node WorkflowNodeId>,
) -> rusqlite::Result<HashMap<WorkflowNodeId, Vec<SettledStep>>> {
    let mut source_run = connection.prepare_cached(SOURCE_RUN_SQL.as_str())?;
    let mut node_steps = connection.prepare_cached(NODE_STEPS_SQL)?;
    let mut settled = HashMap::new();
    for node_id in node_ids {
        let run_id: Option<String> = source_run
            .query_row(
                named_params! {
                    "@definition_id": definition_id.text().as_str(),
                    "@node_id": node_id.as_str(),
                },
                |row| row.get(0),
            )
            .optional()?;
        let Some(run_id) = run_id else {
            continue;
        };
        let steps = node_steps
            .query_map(
                named_params! { "@run_id": run_id, "@node_id": node_id.as_str() },
                |row| settled_step_from_row(node_id, row),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if let Some(steps) = settled_steps_of(steps) {
            settled.insert(node_id.clone(), steps);
        }
    }
    Ok(settled)
}

// The step of `node_id` that `NODE_STEPS_SQL` reads on `row`, whatever its status.
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
        status: text_column(row, 3, closed_word)?,
        workflow_version_id: text_column(row, 4, |text| WorkflowVersionId::new(&text))?,
        session_id: text_column(row, 5, |text| SessionId::new(&text))?,
        sources: text_column(row, 6, |text| serde_json::from_str(&text))?,
        input_ref: text_column(row, 7, |text| serde_json::from_str(&text))?,
        output_ref: text_column(row, 8, |text| serde_json::from_str(&text))?,
        output_item_counts: text_column(row, 9, |text| serde_json::from_str(&text))?,
        pin_hash: optional_text_column(row, 10, closed_word)?,
        reused_from: optional_text_column(row, 11, |text| serde_json::from_str(&text))?,
    })
}

// The settled steps of `steps`, every step of one node in its source run in execution order:
// `None` when a step neither succeeded nor was skipped, unless it failed and a later attempt on
// the same sources settled; that failed attempt is passed over, since it passed nothing on.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn settled_steps_of(steps: Vec<SettledStep>) -> Option<Vec<SettledStep>> {
    let is_settled = |step: &SettledStep| {
        matches!(
            step.status,
            WorkflowStepStatus::Succeeded | WorkflowStepStatus::Skipped
        )
    };
    let is_excused = |index: usize, step: &SettledStep| {
        step.status == WorkflowStepStatus::Failed
            && steps[index + 1..].iter().any(|later| {
                is_settled(later)
                    && later.step.attempt > step.step.attempt
                    && later.sources == step.sources
            })
    };
    let is_whole = steps
        .iter()
        .enumerate()
        .all(|(index, step)| is_settled(step) || is_excused(index, step));
    is_whole.then(|| steps.into_iter().filter(is_settled).collect())
}

/// The plan of a partial run of `target_version`, whose run graph is `graph`, on the node `target`,
/// which the graph holds, over `scope`, covering the places [`covered_places`] names, given the
/// run's `pins`. The target always executes; a covered node executes when its source run settled
/// none of its steps whole, when one of its steps was not fed by the steps the plan keeps for its
/// feeders, when its pin changed since its newest step, when [`executing_places`] says so, or, from
/// a node, when it is dirty; every other covered node's steps are reused from a node, or read as
/// the target's prior input for one node. Reads each covered node's settled steps and, from a node,
/// each version that computed their data, and fails as [`PartialRunPlanError`] says.
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
    pins: &HashMap<WorkflowNodeId, RunPin>,
) -> Result<PartialRunPlan, PartialRunPlanError> {
    let target_place = graph.place(target);
    let covered = covered_places(graph, target_place);
    let mut settled = read_settled_steps(
        connection,
        target_version.definition_id,
        covered.iter().map(|&place| &graph.node(place).id),
    )
    .map_err(PartialRunPlanError::SettledSteps)?;
    let dirty = match scope {
        WorkflowNodeExecuteScope::Node => BTreeSet::new(),
        WorkflowNodeExecuteScope::FromHere => {
            read_dirty_nodes(connection, target_version, graph, &settled)?
        }
    };
    let mut needs_execution = FixedBitSet::with_capacity(graph.node_count());
    needs_execution.insert(target_place);
    for &place in &covered {
        let node_id = &graph.node(place).id;
        let can_reuse = settled.get(node_id).is_some_and(|steps| {
            !dirty.contains(node_id)
                && is_fed_by_reused_steps(steps, &settled)
                && !has_pin_changed(steps, pins.get(node_id))
        });
        if !can_reuse {
            needs_execution.insert(place);
        }
    }
    let executing = executing_places(graph, &covered, needs_execution);
    let mut plan = PartialRunPlan {
        executed: Vec::new(),
        reused: Vec::new(),
        inputs: Vec::new(),
    };
    for place in covered {
        let node_id = graph.node(place).id.clone();
        if executing.contains(place) {
            plan.executed.push(node_id);
        } else {
            let steps = settled
                .remove(&node_id)
                .expect("a node that reuses its steps has settled steps");
            let kept = match scope {
                WorkflowNodeExecuteScope::Node => &mut plan.inputs,
                WorkflowNodeExecuteScope::FromHere => &mut plan.reused,
            };
            kept.push((node_id, steps));
        }
    }
    Ok(plan)
}

/// The nodes of `graph`, the run graph of `target_version`, whose steps in `settled` a change since
/// the version that computed their data keeps a run from reusing, as [`dirty_nodes`] marks them.
/// Reads the target version's body and each version that computed those steps' data, and fails as
/// [`PartialRunPlanError`] says.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn read_dirty_nodes(
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

/// The places a partial run on the node at `target` covers, in either scope, in execution order: a
/// node after every node that feeds it along forward main edges, siblings lowest place first. They
/// are the target and its ancestors, then the body of every covered loop, each node that joins
/// bringing its own ancestors, until nothing joins. Each node joins once, and no descendant of the
/// target joins, so a target inside a loop's body leaves the body after it out.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn covered_places(graph: &RunGraph, target: usize) -> Vec<usize> {
    let mut covered = FixedBitSet::with_capacity(graph.node_count());
    let mut joining = vec![target];
    while let Some(place) = joining.pop() {
        if covered.contains(place) || graph.ancestors(place).any(|ancestor| ancestor == target) {
            continue;
        }
        covered.insert(place);
        joining.extend(graph.ancestors(place));
        if graph.node(place).loop_output.is_some() {
            joining.extend(
                (0..graph.node_count()).filter(|&inside| graph.is_in_loop_body(inside, place)),
            );
        }
    }
    in_execution_order(graph, covered)
}

/// The places of `places` in execution order: a node after every node of `places` that feeds it
/// along forward main edges, siblings lowest place first.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn in_execution_order(graph: &RunGraph, mut places: FixedBitSet) -> Vec<usize> {
    // Forward main edges hold no cycle, so some node left always has no ancestor left.
    let mut ordered = Vec::with_capacity(places.count_ones(..));
    loop {
        let next = places.ones().find(|&place| {
            graph
                .ancestors(place)
                .all(|ancestor| !places.contains(ancestor))
        });
        let Some(next) = next else {
            return ordered;
        };
        places.set(next, false);
        ordered.push(next);
    }
}

/// The plan of a retry from the node at `target` of `graph`, the graph of the version its source
/// run `source_run_id` pinned. The target and every node it feeds execute, and so does each node
/// the source run never reached or whose steps in it did not all settle, or were not fed by the
/// steps the plan keeps for its feeders, with what [`executing_places`] adds, the walk deciding
/// whether a node never reached is reached now; every other node reuses its steps in the source
/// run as they are, since both runs pin one version. Fails with the SQLite error, or
/// `rusqlite::Error::FromSqlConversionFailure` for a stored value that does not read.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
pub(crate) fn plan_retry(
    connection: &Connection,
    graph: &RunGraph,
    source_run_id: WorkflowRunId,
    target: &WorkflowNodeId,
) -> rusqlite::Result<PartialRunPlan> {
    let target_place = graph.place(target);
    let mut needs_execution = FixedBitSet::with_capacity(graph.node_count());
    needs_execution.insert(target_place);
    let settled = read_run_settled_steps(
        connection,
        graph,
        source_run_id,
        &mut needs_execution,
        |place| {
            place == target_place
                || graph
                    .ancestors(place)
                    .any(|ancestor| ancestor == target_place)
        },
    )?;
    Ok(plan_over_run(graph, settled, needs_execution))
}

/// The plan of a run of `run_id` moved to `target_version`, whose run graph is `graph`: each node
/// whose steps in the run all settled, were fed by the steps the plan keeps for its feeders and
/// that `target_version` leaves as the version that computed their data held it reuses them; every
/// other node executes, the target's changed, added and removed nodes as [`dirty_nodes`] marks
/// them among them, with what [`executing_places`] adds. The trigger's steps, the run's start, are
/// always kept. Reads the run's steps, the target's body and each version that computed the steps'
/// data, and fails as [`PartialRunPlanError`] says.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn plan_repin(
    connection: &Connection,
    target_version: &VersionRow,
    graph: &RunGraph,
    run_id: WorkflowRunId,
) -> Result<PartialRunPlan, PartialRunPlanError> {
    let mut needs_execution = FixedBitSet::with_capacity(graph.node_count());
    let settled =
        read_run_settled_steps(connection, graph, run_id, &mut needs_execution, |_| false)
            .map_err(PartialRunPlanError::SettledSteps)?;
    let trigger_id = &graph.node(graph.trigger()).id;
    for node_id in read_dirty_nodes(connection, target_version, graph, &settled)? {
        if &node_id != trigger_id {
            needs_execution.insert(graph.place(&node_id));
        }
    }
    Ok(plan_over_run(graph, settled, needs_execution))
}

/// The settled steps in `run_id` of each node of `graph` that `is_passed_over` does not name, each
/// in execution order; a node the run never reached, or whose steps in it did not all settle, is
/// added to `needs_execution` instead. Fails with the SQLite error, or
/// `rusqlite::Error::FromSqlConversionFailure` for a stored value that does not read.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn read_run_settled_steps(
    connection: &Connection,
    graph: &RunGraph,
    run_id: WorkflowRunId,
    needs_execution: &mut FixedBitSet,
    is_passed_over: impl Fn(usize) -> bool,
) -> rusqlite::Result<HashMap<WorkflowNodeId, Vec<SettledStep>>> {
    let mut node_steps = connection.prepare_cached(NODE_STEPS_SQL)?;
    let mut settled = HashMap::new();
    for place in (0..graph.node_count()).filter(|&place| !is_passed_over(place)) {
        let node_id = &graph.node(place).id;
        let steps = node_steps
            .query_map(
                named_params! {
                    "@run_id": run_id.text().as_str(),
                    "@node_id": node_id.as_str(),
                },
                |row| settled_step_from_row(node_id, row),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let kept = if steps.is_empty() {
            None
        } else {
            settled_steps_of(steps)
        };
        match kept {
            Some(steps) => {
                settled.insert(node_id.clone(), steps);
            }
            None => needs_execution.insert(place),
        }
    }
    Ok(settled)
}

/// The plan over every node of `graph` reusing steps of one run, given each node's `settled` steps
/// in it and `needs_execution`, the places that cannot reuse theirs: a node whose steps were not
/// fed by the steps the plan keeps for its feeders executes too, with what [`executing_places`]
/// adds; every other node with settled steps reuses them.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn plan_over_run(
    graph: &RunGraph,
    mut settled: HashMap<WorkflowNodeId, Vec<SettledStep>>,
    mut needs_execution: FixedBitSet,
) -> PartialRunPlan {
    for (node_id, steps) in &settled {
        if !is_fed_by_reused_steps(steps, &settled) {
            needs_execution.insert(graph.place(node_id));
        }
    }
    let mut every_place = FixedBitSet::with_capacity(graph.node_count());
    every_place.insert_range(..);
    let places = in_execution_order(graph, every_place);
    let executing = executing_places(graph, &places, needs_execution);
    let mut plan = PartialRunPlan {
        executed: Vec::new(),
        reused: Vec::new(),
        inputs: Vec::new(),
    };
    for place in places {
        let node_id = &graph.node(place).id;
        if executing.contains(place) {
            plan.executed.push(node_id.clone());
        } else if let Some(steps) = settled.remove(node_id) {
            plan.reused.push((node_id.clone(), steps));
        }
    }
    plan
}

/// Whether every step of `steps`, one node's settled steps, was fed by the very steps `settled`
/// holds for its feeders: each slot's source is one of that node's settled steps, in the same run
/// at the same execution index. A step computed from other feeder outputs than the ones reused
/// beside it cannot be reused with them, and a source whose node the run does not cover has none.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn is_fed_by_reused_steps(
    steps: &[SettledStep],
    settled: &HashMap<WorkflowNodeId, Vec<SettledStep>>,
) -> bool {
    steps.iter().all(|step| {
        step.sources.iter().flatten().all(|source| {
            settled.get(&source.node_id).is_some_and(|feeder_steps| {
                feeder_steps.iter().any(|feeder| {
                    feeder.step.workflow_run_id == step.step.workflow_run_id
                        && feeder.step.execution_index == source.execution_index
                })
            })
        })
    })
}

/// Whether the node whose settled steps are `steps` is given `pin` in this run where its newest
/// step ran on another one: a pin added, changed or removed. Only a step that ran, or a reused skip
/// carrying the hash its source step ran on, records the pin it ran on; a disabled or no-items
/// skip never ran and is not compared.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
fn has_pin_changed(steps: &[SettledStep], pin: Option<&RunPin>) -> bool {
    let newest = steps
        .last()
        .expect("a node with settled steps has at least one");
    let has_run = newest.status == WorkflowStepStatus::Succeeded || newest.reused_from.is_some();
    has_run && newest.pin_hash.as_ref() != pin.map(|pin| &pin.hash)
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
/// step it ran. A node whose [`RunMembers`] changed is dirty, and one switched on or off also marks
/// the nodes it feeds; a node inserted marks the nodes it feeds, and one deleted the nodes it fed
/// that remain; an added connection marks its destination, and a removed one its destination where
/// the target still holds it.
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

#[cfg(test)]
mod tests;
