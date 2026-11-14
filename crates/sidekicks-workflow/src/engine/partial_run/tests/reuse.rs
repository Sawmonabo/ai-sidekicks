//! Which steps of a node a partial run reuses: every settled step it took in its source run, in
//! execution order, fed by its feeders' reused steps and checked against the version that computed
//! its data.

use std::collections::HashMap;

use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::{
    CHAIN, CHAIN_STEPS, FIRST_RUN_ID, FIRST_VERSION_ID, RunRow, SECOND_RUN_ID, SECOND_VERSION_ID,
    body, chain, chain_nodes, kept_runs, names, node, plan, planned, reused_from, row,
    store_run_rows, store_run_steps, store_versions,
};
use crate::engine::partial_run::SettledStep;
use crate::test_rows::{test_node_id, workflow_tables};

/// Each node of `nodes` with the execution indices of its steps, in the order the plan keeps them.
fn execution_indices(nodes: &[(WorkflowNodeId, Vec<SettledStep>)]) -> Vec<(String, Vec<u64>)> {
    nodes
        .iter()
        .map(|(node_id, steps)| {
            let indices = steps
                .iter()
                .map(|step| step.step.execution_index.get())
                .collect();
            (node_id.as_str().to_owned(), indices)
        })
        .collect()
}

/// The loop `T → L`, its body `L → X → L` and its done output `L → D`, `X` ordered before `L`, so
/// the place order `T, X, L, D` is not the order they run in, stored as both versions.
fn store_loop(connection: &Connection) -> Value {
    let loop_body = body(
        &[
            node("X", "test.step", 1, &json!({})),
            node("L", "test.loop", 2, &json!({})),
            node("D", "test.step", 3, &json!({})),
        ],
        &[
            ("T", 0, "L", 0),
            ("L", 1, "X", 0),
            ("X", 0, "L", 0),
            ("L", 0, "D", 0),
        ],
    );
    store_versions(connection, &loop_body, &loop_body);
    loop_body
}

/// A step of the loop's run: its node and the `(node, execution index)` that fed each slot.
type LoopStep = (&'static str, Vec<(&'static str, u32)>);

/// The steps of a loop of two items: `L` starts each pass and ends the loop, `X` runs once a pass,
/// its second step fed by `second_x_source`, and `D` takes the loop's done output.
fn two_item_loop_steps(second_x_source: &[(&'static str, u32)]) -> Vec<LoopStep> {
    vec![
        ("T", vec![]),
        ("L", vec![("T", 0)]),
        ("X", vec![("L", 1)]),
        ("L", vec![("X", 2)]),
        ("X", second_x_source.to_vec()),
        ("L", vec![("X", 4)]),
        ("D", vec![("L", 5)]),
    ]
}

/// Stores `steps` as run 1's succeeded first attempts.
fn store_first_run(connection: &Connection, steps: &[LoopStep]) {
    let steps: Vec<(&str, &[(&str, u32)])> = steps
        .iter()
        .map(|(node_id, sources)| (*node_id, sources.as_slice()))
        .collect();
    store_run_steps(connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &steps);
}

/// A clean loop that ran its body twice is reused, after it, with every step of the loop and its
/// body, each node's steps in execution order and the nodes in the order they run, not by place.
/// Mutations: take only a node's newest step (`L` keeps 5 alone, `X` 4 alone); list the nodes by
/// place (`X` comes before `L`).
#[test]
fn a_clean_loop_is_reused_with_every_iteration() {
    let connection = workflow_tables();
    let loop_body = store_loop(&connection);
    store_first_run(&connection, &two_item_loop_steps(&[("L", 3)]));
    let plan = planned(
        &connection,
        &loop_body,
        "D",
        WorkflowNodeExecuteScope::FromHere,
        &HashMap::new(),
    );
    assert_eq!(plan.executed, vec![test_node_id("D")]);
    assert_eq!(
        execution_indices(&plan.reused),
        vec![
            ("T".to_owned(), vec![0]),
            ("L".to_owned(), vec![1, 3, 5]),
            ("X".to_owned(), vec![2, 4]),
        ]
    );
}

/// `X`'s first step was fed by `L`'s reused step but its second by a step `L` did not keep, so `X`
/// executes, lifting its loop, and `D` after it. Mutation: check only a node's first step's sources
/// (`L` and `X` are reused).
#[test]
fn a_step_whose_second_iteration_has_another_feeder_executes() {
    let connection = workflow_tables();
    let loop_body = store_loop(&connection);
    store_first_run(&connection, &two_item_loop_steps(&[("L", 9)]));
    assert_eq!(
        kept_runs(planned(
            &connection,
            &loop_body,
            "D",
            WorkflowNodeExecuteScope::FromHere,
            &HashMap::new(),
        )),
        (
            names(&["L", "X", "D"]),
            reused_from(FIRST_RUN_ID, &["T"]),
            Vec::new()
        )
    );
}

/// A failed attempt that a retry on the same sources settled is passed over, so `A` is reused with
/// its retry alone; a failure no retry settled, beside a succeeded step of `A` in the same run,
/// makes `A` execute and the nodes after it. Mutations: drop the excuse (`excused` executes `A`);
/// keep the excused failure among the steps (`excused` keeps 1 and 2); drop the unsettled check
/// (`lone` reuses `A`).
#[rstest]
#[case::excused(
    &[
        RunRow { status: WorkflowStepStatus::Failed, ..row("A", &[("T", 0)]) },
        RunRow { attempt: 2, ..row("A", &[("T", 0)]) },
        row("B", &[("A", 2)]),
    ],
    &["C"],
    &[("T", vec![0]), ("A", vec![2]), ("B", vec![3])],
)]
#[case::lone(
    &[
        row("A", &[("T", 0)]),
        RunRow { status: WorkflowStepStatus::Failed, ..row("A", &[("T", 0)]) },
        row("B", &[("A", 1)]),
    ],
    &["A", "B", "C"],
    &[("T", vec![0])],
)]
fn a_retried_failure_is_excused_and_a_lone_one_is_not(
    #[case] middle: &[RunRow<'static>],
    #[case] executed: &[&str],
    #[case] reused: &[(&str, Vec<u64>)],
) {
    let connection = workflow_tables();
    let chain = body(&chain(), CHAIN);
    store_versions(&connection, &chain, &chain);
    let rows: Vec<RunRow<'_>> = [row("T", &[])]
        .into_iter()
        .chain(middle.iter().copied())
        .chain([row("C", &[("B", 3)])])
        .collect();
    store_run_rows(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &rows);
    let plan = planned(
        &connection,
        &chain,
        "C",
        WorkflowNodeExecuteScope::FromHere,
        &HashMap::new(),
    );
    assert_eq!(kept_runs(plan.clone()).0, names(executed));
    assert_eq!(
        execution_indices(&plan.reused),
        reused
            .iter()
            .map(|(node_id, indices)| ((*node_id).to_owned(), indices.clone()))
            .collect::<Vec<_>>()
    );
}

/// `A` ran on version 1; a node run on version 2 reused `T`, `A` and `B` from it; `A`'s params
/// differ between the two, so a plan on version 2 checks `A`'s reused row against version 1 and
/// executes `A`, and the `T` it reuses names run 1's step, which computed its data. Mutations: read
/// a reused row's version from its own run (`A` and `B` are reused); name the reused row itself as
/// the origin (`T` names run 2).
#[test]
fn a_reused_step_is_checked_against_its_origins_version() {
    let connection = workflow_tables();
    let first = body(&chain(), CHAIN);
    let second = body(
        &chain_nodes("A", &json!({ "params": { "note": "x" } })),
        CHAIN,
    );
    store_versions(&connection, &first, &second);
    store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, CHAIN_STEPS);
    let reused =
        |(node_id, sources): (&'static str, &'static [(&'static str, u32)]), index| RunRow {
            status: WorkflowStepStatus::Skipped,
            reused_from: Some((FIRST_RUN_ID, index, FIRST_VERSION_ID)),
            ..row(node_id, sources)
        };
    let rows: Vec<RunRow<'_>> = CHAIN_STEPS[..3]
        .iter()
        .zip(0..)
        .map(|(&step, index)| reused(step, index))
        .chain([row("C", &[("B", 2)])])
        .collect();
    store_run_rows(&connection, SECOND_RUN_ID, SECOND_VERSION_ID, 2, &rows);
    let plan = planned(
        &connection,
        &second,
        "C",
        WorkflowNodeExecuteScope::FromHere,
        &HashMap::new(),
    );
    let origin = plan.reused[0].1[0].origin();
    assert_eq!(
        kept_runs(plan),
        (
            names(&["A", "B", "C"]),
            reused_from(SECOND_RUN_ID, &["T"]),
            Vec::new()
        )
    );
    assert_eq!(
        (
            origin.step.workflow_run_id,
            origin.step.execution_index.get(),
            origin.workflow_version_id
        ),
        (
            WorkflowRunId::new(FIRST_RUN_ID).expect("the test's run id"),
            0,
            WorkflowVersionId::new(FIRST_VERSION_ID).expect("the test's version id")
        )
    );
}

/// A covered node no run settled executes, and so does every node after it. Mutation: reuse a
/// node with no settled step (the plan finds no step to reuse for it).
#[test]
fn a_covered_node_with_no_settled_step_executes() {
    let connection = workflow_tables();
    let chain = body(&chain(), CHAIN);
    store_versions(&connection, &chain, &chain);
    let steps: &[(&str, &[(&str, u32)])] = &[("T", &[]), ("A", &[("T", 0)]), ("C", &[("B", 9)])];
    store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, steps);
    assert_eq!(
        plan(&connection, &chain, "C", WorkflowNodeExecuteScope::FromHere),
        (
            names(&["B", "C"]),
            reused_from(FIRST_RUN_ID, &["T", "A"]),
            Vec::new()
        )
    );
}

/// After a later run re-ran `T` and `A` alone, `B`'s newest step was fed by the older `A`, so it
/// is not reused beside the newer one and executes. Mutation: reuse a step whatever fed it (`B` is
/// reused from the older run).
#[test]
fn a_step_fed_by_another_run_than_its_reused_feeders_executes() {
    let connection = workflow_tables();
    let chain = body(&chain(), CHAIN);
    store_versions(&connection, &chain, &chain);
    store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, CHAIN_STEPS);
    store_run_steps(
        &connection,
        SECOND_RUN_ID,
        SECOND_VERSION_ID,
        2,
        &CHAIN_STEPS[..2],
    );
    assert_eq!(
        plan(&connection, &chain, "C", WorkflowNodeExecuteScope::FromHere),
        (
            names(&["B", "C"]),
            reused_from(SECOND_RUN_ID, &["T", "A"]),
            Vec::new()
        )
    );
}
