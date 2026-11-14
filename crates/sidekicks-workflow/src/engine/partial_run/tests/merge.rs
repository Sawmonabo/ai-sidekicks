//! A branch a first-to-arrive merge canceled counts as settled: a partial run in either scope and
//! a retry reuse it and the merge it lost, so neither runs again.

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::{
    FIRST_RUN_ID, FIRST_VERSION_ID, RunRow, body, graph_of, kept_runs, names, node, parsed, plan,
    reused_from, row, store_run_rows, store_versions,
};
use crate::engine::partial_run::plan_retry;
use crate::test_rows::{test_node_id, workflow_tables};

/// `T → {A, L} → M → X`, `M` merging `A` on its first input and `L` on its second, stored as both
/// versions with run 1, where `A` won, `M` ran on it, `L` was canceled by the merge, and `X` ended
/// as `x_status`.
fn store_merge_run(connection: &Connection, x_status: WorkflowStepStatus) -> Value {
    let merge = body(
        &[
            node("A", "test.step", 1, &json!({})),
            node("L", "test.step", 2, &json!({})),
            node("M", "test.pair", 3, &json!({})),
            node("X", "test.step", 4, &json!({})),
        ],
        &[
            ("T", 0, "A", 0),
            ("T", 0, "L", 0),
            ("A", 0, "M", 0),
            ("L", 0, "M", 1),
            ("M", 0, "X", 0),
        ],
    );
    store_versions(connection, &merge, &merge);
    let rows = [
        row("T", &[]),
        row("A", &[("T", 0)]),
        RunRow {
            status: WorkflowStepStatus::Canceled,
            ..row("L", &[("T", 0)])
        },
        row("M", &[("A", 1)]),
        RunRow {
            status: x_status,
            ..row("X", &[("M", 3)])
        },
    ];
    store_run_rows(connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &rows);
    connection
        .execute(
            "UPDATE workflow_steps SET cancellation_reason = 'mergeFirstToArrive' \
             WHERE workflow_run_id = ?1 AND node_id = 'L'",
            params![FIRST_RUN_ID],
        )
        .expect("the test records why L was canceled");
    merge
}

/// With nothing changed, a run on `X` reuses `L`'s canceled branch and the merge, in either scope,
/// and executes only `X`. Mutation: read a step a merge canceled as unsettled (`L`, `M` and `X`
/// execute).
#[rstest]
#[case::from_here(WorkflowNodeExecuteScope::FromHere)]
#[case::node(WorkflowNodeExecuteScope::Node)]
fn a_merges_canceled_branch_is_reused_with_the_merge(#[case] scope: WorkflowNodeExecuteScope) {
    let connection = workflow_tables();
    let merge = store_merge_run(&connection, WorkflowStepStatus::Succeeded);
    let kept = reused_from(FIRST_RUN_ID, &["T", "A", "L", "M"]);
    let (reused, inputs) = match scope {
        WorkflowNodeExecuteScope::FromHere => (kept, Vec::new()),
        WorkflowNodeExecuteScope::Node => (Vec::new(), kept),
    };
    assert_eq!(
        plan(&connection, &merge, "X", scope),
        (names(&["X"]), reused, inputs)
    );
}

/// A retry from `X`, which failed after the merge, reuses the merge and its canceled branch and
/// runs only `X` again. Mutation: read a step a merge canceled as unsettled (`L` and `M` execute).
#[test]
fn a_retry_reuses_a_merges_canceled_branch_upstream() {
    let connection = workflow_tables();
    let merge = store_merge_run(&connection, WorkflowStepStatus::Failed);
    let graph = graph_of(&parsed(&merge));
    let run_id = WorkflowRunId::new(FIRST_RUN_ID).expect("the test's run id");
    let planned =
        plan_retry(&connection, &graph, run_id, &test_node_id("X")).expect("the plan reads");
    assert_eq!(
        kept_runs(planned),
        (
            names(&["X"]),
            reused_from(FIRST_RUN_ID, &["T", "A", "L", "M"]),
            Vec::new()
        )
    );
}
