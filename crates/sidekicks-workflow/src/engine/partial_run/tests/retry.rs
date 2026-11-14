//! A retry from a step inside a loop replays the passes before the failing one and the steps of
//! the failing pass before the retried step, so only the retried step and what follows it run.

use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::{
    FIRST_RUN_ID, FIRST_VERSION_ID, RunRow, body, graph_of, kept_runs, names, node, parsed,
    reused_from, row, store_run_rows, store_versions,
};
use crate::engine::partial_run::plan_retry;
use crate::test_rows::{test_node_id, workflow_tables};

/// The loop `L` over two passes, its body `L → {X, P} → J → L` and its done output `L → D`: `X`
/// fails on the second pass, which cancels `P` beside it, so `J` and `D` never run then. A retry
/// from `X` replays `L`'s two steps and the first pass of `X`, `P` and `J`, and leaves `D` to run.
/// Mutation: drop the loop's body from the nodes a retry reads only up to their first unsettled
/// step (`P`'s canceled second pass makes it execute, running its first pass again).
#[test]
fn a_retry_inside_a_loop_replays_the_passes_before_the_failing_one() {
    let connection = workflow_tables();
    let looped = body(
        &[
            node("L", "test.loop", 1, &json!({})),
            node("X", "test.step", 2, &json!({})),
            node("P", "test.step", 3, &json!({})),
            node("J", "test.pair", 4, &json!({})),
            node("D", "test.step", 6, &json!({})),
        ],
        &[
            ("T", 0, "L", 0),
            ("L", 1, "X", 0),
            ("L", 1, "P", 0),
            ("X", 0, "J", 0),
            ("P", 0, "J", 1),
            ("J", 0, "L", 0),
            ("L", 0, "D", 0),
        ],
    );
    store_versions(&connection, &looped, &looped);
    let rows = [
        row("T", &[]),
        row("L", &[("T", 0)]),
        row("X", &[("L", 1)]),
        row("P", &[("L", 1)]),
        row("J", &[("X", 2), ("P", 3)]),
        row("L", &[("J", 4)]),
        RunRow {
            status: WorkflowStepStatus::Failed,
            ..row("X", &[("L", 5)])
        },
        RunRow {
            status: WorkflowStepStatus::Canceled,
            ..row("P", &[("L", 5)])
        },
    ];
    store_run_rows(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &rows);
    connection
        .execute(
            "UPDATE workflow_steps SET cancellation_reason = 'siblingFailure' \
             WHERE workflow_run_id = ?1 AND node_id = 'P' AND execution_index = 7",
            params![FIRST_RUN_ID],
        )
        .expect("the test records why P was canceled");
    let graph = graph_of(&parsed(&looped));
    let run_id = WorkflowRunId::new(FIRST_RUN_ID).expect("the test's run id");

    let planned =
        plan_retry(&connection, &graph, run_id, &test_node_id("X")).expect("the plan reads");

    let indices: Vec<(String, Vec<u64>)> = planned
        .reused
        .iter()
        .map(|(node_id, steps)| {
            let steps = steps.iter().map(|step| step.step.execution_index.get());
            (node_id.as_str().to_owned(), steps.collect())
        })
        .collect();
    assert_eq!(
        indices,
        [
            ("T", vec![0]),
            ("L", vec![1, 5]),
            ("X", vec![2]),
            ("P", vec![3]),
            ("J", vec![4]),
        ]
        .map(|(node_id, steps)| (node_id.to_owned(), steps))
    );
    assert_eq!(
        kept_runs(planned),
        (
            names(&["D"]),
            reused_from(FIRST_RUN_ID, &["T", "L", "X", "P", "J"]),
            Vec::new()
        )
    );
}
