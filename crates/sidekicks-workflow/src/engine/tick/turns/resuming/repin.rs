//! Whether a parked run may move to another version of its workflow on Resume: any attempt still
//! in flight or settled in the turn ahead of the Resume, a target that cannot account for what the
//! run already did, or one lacking a failed step's node refuses the move, each before anything is
//! written; and the target as a move the Resume takes reads it: its graph, checked as a start
//! checks one, and the run's steps it keeps.

#![cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDocumentHashedBody, WorkflowName, WorkflowNode, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::stored_column::{closed_word, text_column};

use super::RunResumeRefusal;
use crate::definitions::stored_document::{StoredDocumentError, parse_stored_workflow_body};
use crate::definitions::versions::history::{WorkflowVersions, WorkflowVersionsError};
use crate::engine::partial_run::{PartialRunPlanError, plan_repin};
use crate::engine::start::check_run_graph;
use crate::engine::tick::RunGraph;
use crate::engine::tick::commit::RunLiveStep;
use crate::engine::tick::live_runs::LiveRun;
use crate::engine::tick::turns::EngineTick;
use crate::engine::tick::walk::KeptStep;
use crate::not_found::{WorkflowNotFound, WorkflowVersionAddress};

/// The statements a re-pin prepares on the tick's read connection: the target version's read,
/// which also reads each version that computed a kept step's data, the nodes whose outputs the run
/// holds, and the run's steps of one node.
pub(crate) const REPIN_STATEMENT_CAPACITY: usize = 3;

// The nodes of a run with a step that succeeded or was skipped, whose outputs the run holds.
const HELD_NODES_SQL: &str = "SELECT DISTINCT node_id FROM workflow_steps
  WHERE workflow_run_id = ?1 AND status IN ('succeeded', 'skipped')";

/// A run's move to another version of its workflow as its Resume takes it: the version, its name,
/// its nodes, the trigger's among them, its run graph, and the run's steps its rebuilt walk
/// keeps.
pub(super) struct RepinTarget {
    /// The version the run joins.
    pub(super) workflow_version_id: WorkflowVersionId,
    /// The workflow's name in that version.
    pub(super) workflow_name: WorkflowName,
    /// The version's nodes by id, the trigger included.
    pub(super) nodes: HashMap<WorkflowNodeId, WorkflowNode>,
    /// The version's run graph.
    pub(super) graph: Arc<RunGraph>,
    /// The places of the graph the rebuilt walk covers, by place.
    pub(super) covered: Arc<[bool]>,
    /// The run's steps the rebuilt walk settles again under their own keys, in execution order.
    pub(super) kept: Vec<KeptStep>,
}

/// Why a re-pin's reads did not finish; the run is left as it was.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepinReadError {
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The run's steps did not read.
    #[error("the run's steps did not read")]
    Rows(#[from] rusqlite::Error),
    /// The target version did not read.
    #[error(transparent)]
    Version(#[from] WorkflowVersionsError),
    /// The target version's stored body does not read.
    #[error(transparent)]
    Body(#[from] StoredDocumentError),
    /// The plan of the steps the run keeps did not read.
    #[error(transparent)]
    Plan(#[from] PartialRunPlanError),
}

impl EngineTick {
    /// The move of the run of `live`, which a Resume lifts, to `target`, or why it is refused with
    /// nothing written: `workflow.version.notFound` for a version no saved version of the run's
    /// workflow answers to, then each refusal of [`repin_refusal`] in its order, `settled_in_turn`
    /// the first step the Resume's turn settled ahead of it, then a start's checks of the target's
    /// graph for the run's repository and provider. The steps the run keeps are planned by
    /// [`plan_repin`]; their outputs are the run's own, already held.
    pub(super) async fn repin_target(
        &self,
        live: &LiveRun,
        settled_in_turn: Option<&WorkflowStepKey>,
        target: WorkflowVersionId,
    ) -> Result<RepinTarget, RunResumeRefusal> {
        let run_id = live.scope.run_id;
        let (version, held_nodes) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let version = WorkflowVersions::new(connection).read_version(target);
                Ok::<_, RepinReadError>((version, read_held_nodes(connection, run_id)?))
            })
            .await
            .map_err(RunResumeRefusal::Unread)?;
        let version = match version {
            Ok(version) if version.definition_id == live.scope.workflow_id => version,
            // Another workflow's version is none of this run's.
            Ok(_) => {
                let not_found = WorkflowNotFound::Version(WorkflowVersionAddress::Id {
                    workflow_version_id: target,
                });
                return Err(RunResumeRefusal::Target(not_found.into()));
            }
            Err(WorkflowVersionsError::NotFound(not_found)) => {
                return Err(RunResumeRefusal::Target(not_found.into()));
            }
            Err(error) => return Err(RunResumeRefusal::Unread(error.into())),
        };
        let body = parse_stored_workflow_body(&version.definition_body)
            .map_err(|error| RunResumeRefusal::Unread(error.into()))?;
        if let Some(refusal) = repin_refusal(live.live_steps(), settled_in_turn, &held_nodes, &body)
        {
            return Err(RunResumeRefusal::Repin(refusal));
        }
        let (nodes, graph) = check_run_graph(
            &self.kinds,
            &body,
            live.scope.project.is_some(),
            live.scope.provider.is_some(),
        )
        .map_err(RunResumeRefusal::Target)?;
        let graph = Arc::new(graph);
        let planned = Arc::clone(&graph);
        let plan = self
            .pool
            .read(ReadLength::Long, move |connection| {
                Ok::<_, RepinReadError>(plan_repin(connection, &version, &planned, run_id)?)
            })
            .await
            .map_err(RunResumeRefusal::Unread)?;
        let (covered, replayed) = plan.replayed(&graph);
        let mut kept: Vec<KeptStep> = replayed
            .into_iter()
            .map(|replayed| KeptStep {
                step: replayed.settled.step,
                output_lengths: replayed.output_lengths,
            })
            .collect();
        kept.sort_by_key(|kept| kept.step.execution_index.get());
        Ok(RepinTarget {
            workflow_version_id: target,
            workflow_name: body.name,
            nodes,
            graph,
            covered,
            kept,
        })
    }
}

/// The nodes of `run_id` whose outputs the run holds, each with a step that succeeded or was
/// skipped, read on `connection`.
fn read_held_nodes(
    connection: &Connection,
    run_id: WorkflowRunId,
) -> rusqlite::Result<HashSet<WorkflowNodeId>> {
    connection
        .prepare_cached(HELD_NODES_SQL)?
        .query_map([run_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })?
        .collect()
}

/// Why a Resume may not move a run to another version.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RepinRefusal {
    /// The named attempt is still in flight: running, held, pending or waiting, or it settled in
    /// the Resume's turn ahead of the Resume, so its row is not yet written.
    AttemptInFlight(WorkflowStepKey),
    /// The target lacks a node whose outputs the run holds, or cannot reach a step it completed.
    VersionUnaccountable,
    /// The target lacks the nodes of these failed steps, which the Resume would run again.
    FailedNodesMissing(Vec<WorkflowNodeId>),
}

/// Why the run, whose live steps are `live_steps`, may not move to `target` on Resume, `None` where
/// it may: no attempt of it may be in flight, the earliest named where one is, nor settled in the
/// Resume's turn ahead of it (`settled_in_turn`); `target` must hold every node in `held_nodes`,
/// the nodes whose outputs the run holds, each reached from its trigger; and it must hold the node
/// of every failed step, each named where it lacks one.
pub(crate) fn repin_refusal<'tick>(
    live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    settled_in_turn: Option<&WorkflowStepKey>,
    held_nodes: &HashSet<WorkflowNodeId>,
    target: &WorkflowDocumentHashedBody,
) -> Option<RepinRefusal> {
    let live_steps: Vec<RunLiveStep<'tick>> = live_steps.into_iter().collect();
    if let Some(in_flight) = live_steps
        .iter()
        .filter(|live| is_in_flight(live))
        .min_by_key(|live| live.step.execution_index)
    {
        return Some(RepinRefusal::AttemptInFlight(in_flight.step.clone()));
    }
    if let Some(settled) = settled_in_turn {
        return Some(RepinRefusal::AttemptInFlight(settled.clone()));
    }
    let reached = reached_nodes(target);
    if !held_nodes.iter().all(|node_id| reached.contains(node_id)) {
        return Some(RepinRefusal::VersionUnaccountable);
    }
    let mut missing: Vec<WorkflowNodeId> = live_steps
        .iter()
        .filter(|live| live.status == WorkflowStepStatus::Failed)
        .map(|live| &live.step.node_id)
        .filter(|node_id| {
            target.trigger.id != **node_id && !target.nodes.iter().any(|node| node.id == **node_id)
        })
        .cloned()
        .collect();
    missing.sort();
    missing.dedup();
    (!missing.is_empty()).then_some(RepinRefusal::FailedNodesMissing(missing))
}

/// Whether `live` is an attempt still in flight: running, held for memory, pending, or waiting on
/// anything at all.
fn is_in_flight(live: &RunLiveStep<'_>) -> bool {
    match live.status {
        WorkflowStepStatus::Running
        | WorkflowStepStatus::WaitingMemory
        | WorkflowStepStatus::Pending
        | WorkflowStepStatus::Waiting => true,
        WorkflowStepStatus::Succeeded
        | WorkflowStepStatus::Failed
        | WorkflowStepStatus::Skipped
        | WorkflowStepStatus::Canceled => false,
    }
}

/// The nodes of `body` its trigger reaches along its connections, the trigger included.
fn reached_nodes(body: &WorkflowDocumentHashedBody) -> HashSet<&WorkflowNodeId> {
    let mut reached = HashSet::from([&body.trigger.id]);
    let mut next = VecDeque::from([&body.trigger.id]);
    while let Some(node_id) = next.pop_front() {
        for edge in body.edges.iter().filter(|edge| &edge.source == node_id) {
            if reached.insert(&edge.target) {
                next.push_back(&edge.target);
            }
        }
    }
    reached
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;
    use sidekicks_contracts::workflow::definition::document::{
        WorkflowDocumentHashedBody, WorkflowNodeId,
    };
    use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

    use super::{RepinRefusal, repin_refusal};
    use crate::engine::tick::commit::RunLiveStep;
    use crate::test_rows::test_node_id;

    /// Attempt 1 of node `node_id` at `execution_index`.
    fn step(node_id: &str, execution_index: u64) -> WorkflowStepKey {
        serde_json::from_value(json!({
            "workflowRunId": "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c",
            "nodeId": node_id, "attempt": 1, "executionIndex": execution_index,
        }))
        .expect("the test's step key reads")
    }

    /// A body whose trigger `start` feeds `A`, which feeds each node of `fed_by_a`.
    fn body(fed_by_a: &[&str]) -> WorkflowDocumentHashedBody {
        let node = |id: &str| {
            json!({ "id": id, "kind": "test.step", "kindVersion": 1, "name": id, "order": 1,
                    "params": {} })
        };
        let edge = |source: &str, target: &str| {
            json!({ "id": format!("{source}-{target}"), "source": source,
                    "sourceHandle": "outputs/main/0", "target": target,
                    "targetHandle": "inputs/main/0" })
        };
        let mut nodes = vec![node("A")];
        let mut edges = vec![edge("start", "A")];
        for id in fed_by_a {
            nodes.push(node(id));
            edges.push(edge("A", id));
        }
        serde_json::from_value(json!({
            "name": "Nightly",
            "trigger": { "id": "start", "kind": "trigger.manual", "kindVersion": 1,
                         "name": "Start", "order": 0, "params": {} },
            "nodes": nodes, "edges": edges,
        }))
        .expect("the test's body reads")
    }

    /// `step` live as `status`, waiting on `wait_cause` where it waits.
    fn live(
        status: WorkflowStepStatus,
        wait_cause: Option<WorkflowWaitCause>,
        step: &WorkflowStepKey,
    ) -> RunLiveStep<'_> {
        RunLiveStep {
            step,
            status,
            wait_cause,
        }
    }

    /// The nodes `node_ids`, as the nodes whose outputs a run holds.
    fn held(node_ids: &[&str]) -> HashSet<WorkflowNodeId> {
        node_ids.iter().map(|id| test_node_id(id)).collect()
    }

    /// Each refusal in its order: an account park, a step running beside a failed park, and a
    /// person's wait beside a failed park are each in flight, the earliest named, and so is a step
    /// the Resume's turn settled ahead of it; a failed park alone moves only to a target holding
    /// and reaching every node whose outputs the run holds, and holding the failed step's node.
    /// Mutations: name the latest attempt; leave the chain's wait out of flight; let a step the
    /// turn settled pass; accept a target missing a held node, one that holds it unreached, or one
    /// lacking the failed step's node.
    #[test]
    fn a_repin_is_refused_in_order() {
        let failed = step("F", 1);
        let waiting = step("W", 2);
        let account = step("P", 3);
        let running = step("R", 0);
        let settled = step("S", 4);

        let target = body(&["F", "W", "P"]);
        let held_a = held(&["A"]);

        assert_eq!(
            repin_refusal(
                [live(
                    WorkflowStepStatus::Waiting,
                    Some(WorkflowWaitCause::Account),
                    &account
                )],
                None,
                &held_a,
                &target
            ),
            Some(RepinRefusal::AttemptInFlight(account.clone()))
        );
        assert_eq!(
            repin_refusal(
                [
                    live(WorkflowStepStatus::Failed, None, &failed),
                    live(
                        WorkflowStepStatus::Waiting,
                        Some(WorkflowWaitCause::Chain),
                        &waiting
                    ),
                    live(WorkflowStepStatus::Running, None, &running),
                ],
                None,
                &held_a,
                &target,
            ),
            Some(RepinRefusal::AttemptInFlight(running.clone()))
        );
        assert_eq!(
            repin_refusal(
                [
                    live(WorkflowStepStatus::Failed, None, &failed),
                    live(
                        WorkflowStepStatus::Waiting,
                        Some(WorkflowWaitCause::Approval),
                        &waiting
                    ),
                ],
                None,
                &held_a,
                &target,
            ),
            Some(RepinRefusal::AttemptInFlight(waiting.clone()))
        );
        let failed_alone = || [live(WorkflowStepStatus::Failed, None, &failed)];
        assert_eq!(
            repin_refusal(failed_alone(), Some(&settled), &held_a, &target),
            Some(RepinRefusal::AttemptInFlight(settled.clone()))
        );
        assert_eq!(repin_refusal(failed_alone(), None, &held_a, &target), None);
        assert_eq!(
            repin_refusal(failed_alone(), None, &held(&["A", "Gone"]), &target),
            Some(RepinRefusal::VersionUnaccountable)
        );
        let mut unreached = body(&["F"]);
        unreached.edges.retain(|edge| edge.target.as_str() != "A");
        assert_eq!(
            repin_refusal(failed_alone(), None, &held_a, &unreached),
            Some(RepinRefusal::VersionUnaccountable)
        );
        assert_eq!(
            repin_refusal(failed_alone(), None, &held_a, &body(&["W"])),
            Some(RepinRefusal::FailedNodesMissing(vec![test_node_id("F")]))
        );
    }
}
