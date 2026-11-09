//! Whether a parked run may move to another version of its workflow on Resume: a run with nothing
//! a Resume lifts, any attempt still in flight, or a target that cannot account for what the run
//! already did refuses the move, each before anything is written.

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "a Resume's version re-pin, which takes it")
)]

use std::collections::{HashSet, VecDeque};

use sidekicks_contracts::workflow::definition::document::{
    WorkflowDocumentHashedBody, WorkflowNodeId,
};
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use crate::engine::tick::commit::RunLiveStep;

/// Why a Resume may not move a run to another version.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RepinRefusal {
    /// Nothing waits on a Resume: no account park and no failed park.
    NotParked,
    /// The named attempt is still in flight: running, held, pending or waiting.
    AttemptInFlight(WorkflowStepKey),
    /// The target lacks a node whose outputs the run holds, or cannot reach a step it completed.
    VersionUnaccountable,
}

/// Why the run, whose live steps are `live_steps`, may not move to `target` on Resume, `None` where
/// it may: the run must be parked on a spent account or on a failure (`is_parked_on_failure`), no
/// attempt of it may be in flight, the earliest named where one is, and `target` must hold every
/// node in `held_nodes`, the nodes whose outputs the run holds, each reached from its trigger.
pub(crate) fn repin_refusal<'tick>(
    live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    is_parked_on_failure: bool,
    held_nodes: &HashSet<WorkflowNodeId>,
    target: &WorkflowDocumentHashedBody,
) -> Option<RepinRefusal> {
    let live_steps: Vec<RunLiveStep<'tick>> = live_steps.into_iter().collect();
    let is_account_parked = live_steps.iter().any(|live| {
        live.status == WorkflowStepStatus::Waiting
            && live.wait_cause == Some(WorkflowWaitCause::Account)
    });
    if !is_account_parked && !is_parked_on_failure {
        return Some(RepinRefusal::NotParked);
    }
    if let Some(in_flight) = live_steps
        .iter()
        .filter(|live| is_in_flight(live))
        .min_by_key(|live| live.step.execution_index)
    {
        return Some(RepinRefusal::AttemptInFlight(in_flight.step.clone()));
    }
    let reached = reached_nodes(target);
    let is_accounted = held_nodes.iter().all(|node_id| reached.contains(node_id));
    (!is_accounted).then_some(RepinRefusal::VersionUnaccountable)
}

/// Whether `live` is an attempt still in flight: running, held for memory, pending, or waiting on
/// anything at all.
fn is_in_flight(live: &RunLiveStep<'_>) -> bool {
    match live.status {
        WorkflowStepStatus::Running
        | WorkflowStepStatus::WaitingMemory
        | WorkflowStepStatus::Pending => true,
        WorkflowStepStatus::Waiting => match live.wait_cause {
            Some(
                WorkflowWaitCause::Approval
                | WorkflowWaitCause::Form
                | WorkflowWaitCause::Reply
                | WorkflowWaitCause::Account
                | WorkflowWaitCause::Chain,
            ) => true,
            None => unreachable!("a waiting step waits on a cause"),
        },
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

    /// Each refusal in its order: a run with no park is not parked even with nothing in flight;
    /// an account park, a step running beside a failed park, and a person's wait beside a failed
    /// park are each in flight, the earliest named; a failed park alone moves only to a target
    /// holding and reaching every node whose outputs the run holds. Mutations: check flight before
    /// the park; name the latest attempt; leave the chain's wait out of flight; accept a target
    /// missing a held node, or one that holds it unreached.
    #[test]
    fn a_repin_is_refused_in_order() {
        let failed = step("F", 1);
        let waiting = step("W", 2);
        let account = step("P", 3);
        let running = step("R", 0);

        let target = body(&["F", "W", "P"]);
        let held_a = held(&["A"]);

        assert_eq!(
            repin_refusal(
                [live(
                    WorkflowStepStatus::Waiting,
                    Some(WorkflowWaitCause::Reply),
                    &waiting
                )],
                false,
                &held_a,
                &target
            ),
            Some(RepinRefusal::NotParked)
        );
        assert_eq!(
            repin_refusal(
                [live(
                    WorkflowStepStatus::Waiting,
                    Some(WorkflowWaitCause::Account),
                    &account
                )],
                false,
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
                true,
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
                true,
                &held_a,
                &target,
            ),
            Some(RepinRefusal::AttemptInFlight(waiting.clone()))
        );
        let failed_alone = || [live(WorkflowStepStatus::Failed, None, &failed)];
        assert_eq!(repin_refusal(failed_alone(), true, &held_a, &target), None);
        assert_eq!(
            repin_refusal(failed_alone(), true, &held(&["A", "Gone"]), &target),
            Some(RepinRefusal::VersionUnaccountable)
        );
        let mut unreached = body(&["F"]);
        unreached.edges.retain(|edge| edge.target.as_str() != "A");
        assert_eq!(
            repin_refusal(failed_alone(), true, &held_a, &unreached),
            Some(RepinRefusal::VersionUnaccountable)
        );
    }
}
