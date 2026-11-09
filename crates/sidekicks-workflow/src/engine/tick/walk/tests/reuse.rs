//! A partial run's walk: kept to the places it covers, and seeded with the earlier steps it reuses.

use std::sync::Arc;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{WorkflowEdge, WorkflowVersionId};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowReusedStep;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::{edge, graph, node, open_rounds, readied, run_id, sources};
use crate::engine::tick::walk::{
    ReusedSeedStep, ReusedStepRecord, RunGraph, RunWalk, WalkSkipReason, WalkTurn,
};
use crate::test_rows::test_node_id;

/// The earlier run whose steps the seeds reuse.
const EARLIER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";

/// The version the earlier run executed.
const EARLIER_VERSION_ID: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c";

/// The earlier run's step of `node_id` at `execution_index`, whose main outputs held
/// `output_lengths` items, as a seed reuses it.
fn earlier_step(node_id: &str, execution_index: u64, output_lengths: &[usize]) -> ReusedSeedStep {
    let step = WorkflowStepKey {
        workflow_run_id: WorkflowRunId::new(EARLIER_RUN_ID).expect("the earlier run's id"),
        node_id: test_node_id(node_id),
        attempt: SafeInt::new(1).expect("1 is a whole number from 1"),
        execution_index: SafeInt::new(execution_index).expect("a small execution index"),
    };
    ReusedSeedStep {
        node_id: test_node_id(node_id),
        output_lengths: output_lengths.to_vec(),
        record: ReusedStepRecord {
            from: WorkflowReusedStep {
                step,
                workflow_version_id: WorkflowVersionId::new(EARLIER_VERSION_ID)
                    .expect("the earlier version's id"),
            },
            output_ref: WorkflowPayloadRef::Inline { items: Vec::new() },
            pin_hash: None,
        },
    }
}

/// The edges of a chain through `node_ids` in order, each feeding the next's first main input.
fn chain(node_ids: &[&str]) -> Vec<WorkflowEdge> {
    node_ids
        .windows(2)
        .map(|pair| edge(pair[0], 0, pair[1], 0))
        .collect()
}

/// Whether each node of `graph`, by place, is one of `node_ids`.
fn covered(graph: &RunGraph, node_ids: &[&str]) -> Arc<[bool]> {
    (0..graph.node_count())
        .map(|place| node_ids.contains(&graph.node(place).id.as_str()))
        .collect()
}

/// Each answer of `turn` as one line: skipped steps, each reused one naming the earlier step it
/// carries, then ready ones, each with its node, run index, execution index and sources.
fn replayed(turn: &WalkTurn) -> Vec<String> {
    let skipped = turn.skipped.iter().map(|skip| {
        let reason = match &skip.reason {
            WalkSkipReason::Reused(record) => format!(
                "reused {}@{}",
                record.from.step.node_id.as_str(),
                record.from.step.execution_index.get()
            ),
            reason @ (WalkSkipReason::NoItems | WalkSkipReason::Disabled) => format!("{reason:?}"),
        };
        format!(
            "skipped {} run {} exec {} from {} {reason} outputs {:?}",
            skip.step.node_id.as_str(),
            skip.run_index,
            skip.step.execution_index.get(),
            sources(&skip.sources),
            skip.output_lengths
        )
    });
    let ready = turn.ready.iter().map(|ready| {
        format!(
            "ready {} run {} exec {} from {}",
            ready.step.node_id.as_str(),
            ready.run_index,
            ready.step.execution_index.get(),
            sources(&ready.sources)
        )
    });
    skipped.chain(ready).collect()
}

/// The seed replays the reused steps from the start, each settled at once under this run's own
/// execution index and answered as a reused skip naming the earlier step, and readies the first
/// executing step on the last reused one. Mutation: emit a reused step as a skip without settling
/// it in `replay_reused`, so `B` never readies.
#[test]
fn the_seed_replays_reused_steps_and_readies_the_first_executing_one() {
    let graph = graph(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("B", "test.step", 2, false),
            node("C", "test.step", 3, false),
        ],
        &chain(&["trigger", "A", "B", "C"]),
    );
    let seed = vec![earlier_step("trigger", 0, &[1]), earlier_step("A", 2, &[2])];
    let mut walk = RunWalk::reusing(graph, run_id(), None, seed);

    assert_eq!(
        replayed(&walk.start()),
        [
            "skipped trigger run 0 exec 0 from  reused trigger@0 outputs [1]",
            "skipped A run 0 exec 1 from trigger:0@0 reused A@2 outputs [2]",
            "ready B run 0 exec 2 from A:0@1",
        ]
    );
}

/// The seed replays every reused pass of a loop, each loop and body step in its earlier run's
/// order, and readies the node after the loop's done output on the last pass. Mutation: take only
/// the first reused step of each place in `reusing`, so the loop's second pass is readied to run.
#[test]
fn the_seed_replays_every_reused_iteration_of_a_loop() {
    let graph = graph(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("L", "test.loop", 1, false),
            node("B", "test.step", 2, false),
            node("D", "test.step", 3, false),
        ],
        &[
            edge("trigger", 0, "L", 0),
            edge("B", 0, "L", 0),
            edge("L", 0, "D", 0),
            edge("L", 1, "B", 0),
        ],
    );
    let seed = vec![
        earlier_step("trigger", 0, &[1]),
        earlier_step("L", 1, &[0, 2]),
        earlier_step("B", 2, &[2]),
        earlier_step("L", 3, &[0, 2]),
        earlier_step("B", 4, &[2]),
        earlier_step("L", 5, &[3, 0]),
    ];
    let mut walk = RunWalk::reusing(graph, run_id(), None, seed);

    assert_eq!(
        replayed(&walk.start()),
        [
            "skipped trigger run 0 exec 0 from  reused trigger@0 outputs [1]",
            "skipped L run 0 exec 1 from trigger:0@0 reused L@1 outputs [0, 2]",
            "skipped B run 0 exec 2 from L:1@1 reused B@2 outputs [2]",
            "skipped L run 1 exec 3 from B:0@2 reused L@3 outputs [0, 2]",
            "skipped B run 1 exec 4 from L:1@3 reused B@4 outputs [2]",
            "skipped L run 2 exec 5 from B:0@4 reused L@5 outputs [3, 0]",
            "ready D run 0 exec 6 from L:0@5",
        ]
    );
    assert_eq!(open_rounds(&walk, "D"), Vec::<u64>::new());
}

/// A place outside a partial run's covered set is never readied: the feeds into it open no round,
/// so the target's descendants never run. Mutation: drop the covered check in `fill`, which
/// readies `B` on `A`'s settle.
#[test]
fn a_place_outside_the_covered_set_is_never_readied() {
    let graph = graph(
        vec![
            node("trigger", "test.trigger", 0, false),
            node("A", "test.step", 1, false),
            node("B", "test.step", 2, false),
        ],
        &chain(&["trigger", "A", "B"]),
    );
    let covered = covered(&graph, &["trigger", "A"]);
    let mut walk = RunWalk::reusing(graph, run_id(), Some(covered), Vec::new());

    let start_turn = walk.start();
    let a_turn = walk.settle(&readied(&start_turn, "trigger"), &[1]);
    assert_eq!(replayed(&a_turn), ["ready A run 0 exec 1 from trigger:0@0"]);
    let b_turn = walk.settle(&readied(&a_turn, "A"), &[1]);
    assert_eq!(replayed(&b_turn), Vec::<String>::new());
    assert_eq!(open_rounds(&walk, "B"), Vec::<u64>::new());
}
