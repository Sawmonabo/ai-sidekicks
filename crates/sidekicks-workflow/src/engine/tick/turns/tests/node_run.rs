//! A node run in the tick's loop: its walk seeded with the earlier steps it reuses, their skips
//! and the steps they ready in one write, kept to the places it covers, and a reused output that
//! lives in another session stored again in this run's.

use rstest::rstest;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowEdge, WorkflowNode, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::events::WorkflowNodeRun;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::harness::{Harness, edge, item, large_items, node};
use crate::engine::partial_run::{PartialRunPlan, read_settled_steps};
use crate::runs::step_payload::write_step_payload;
use crate::test_rows::{
    TEST_SESSION_ID, TestSettledStep, insert_run, insert_settled_step, test_node_id,
};

/// The earlier run whose settled steps the node runs reuse.
const EARLIER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";

/// One step of the earlier run: its node, its execution index, the `(node, execution index)` of
/// the step feeding each slot, and its main outputs' items.
type EarlierStep = (
    &'static str,
    u32,
    &'static [(&'static str, u32)],
    Vec<Vec<WorkflowItem>>,
);

/// The chain `T → A → B → C`.
fn chain() -> (Vec<WorkflowNode>, Vec<WorkflowEdge>) {
    let nodes = vec![
        node("T", "test.trigger", 0, None),
        node("A", "test.step", 1, None),
        node("B", "test.step", 2, None),
        node("C", "test.step", 3, None),
    ];
    let edges = vec![edge("T", "A", 0), edge("A", "B", 0), edge("B", "C", 0)];
    (nodes, edges)
}

/// The earlier run's steps of the chain, each output one item naming its node.
fn chain_steps() -> Vec<EarlierStep> {
    vec![
        ("T", 0, &[], vec![vec![named("T")]]),
        ("A", 1, &[("T", 0)], vec![vec![named("A")]]),
        ("B", 2, &[("A", 1)], vec![vec![named("B")]]),
        ("C", 3, &[("B", 2)], vec![vec![named("C")]]),
    ]
}

/// An item naming `node_id`.
fn named(node_id: &str) -> WorkflowItem {
    item(json!({ "node": node_id }))
}

/// The node run on `node_id` in `scope`.
fn node_run(node_id: &str, scope: WorkflowNodeExecuteScope) -> WorkflowNodeRun {
    WorkflowNodeRun {
        node_id: test_node_id(node_id),
        scope,
    }
}

/// The key of the earlier run's first attempt of `node_id` at `execution_index`.
fn earlier_key(node_id: &str, execution_index: u64) -> WorkflowStepKey {
    WorkflowStepKey {
        workflow_run_id: WorkflowRunId::new(EARLIER_RUN_ID).expect("the earlier run's id"),
        node_id: test_node_id(node_id),
        attempt: SafeInt::new(1).expect("1 is a whole number from 1"),
        execution_index: SafeInt::new(execution_index).expect("a small execution index"),
    }
}

/// Stores the earlier run of `version_id`, its every step succeeded with its outputs inline.
fn store_earlier_run(rows: &Connection, version_id: WorkflowVersionId, steps: &[EarlierStep]) {
    insert_run(
        rows,
        EARLIER_RUN_ID,
        version_id.text().as_str(),
        WorkflowRunStatus::Succeeded,
        "2026-10-02T00:00:00.000Z",
        Some("2026-10-02T01:00:00.000Z"),
    );
    for (node_id, execution_index, sources, outputs) in steps {
        let counts: Vec<u64> = outputs
            .iter()
            .map(|output| u64::try_from(output.len()).expect("a test output's length fits"))
            .collect();
        insert_settled_step(
            rows,
            EARLIER_RUN_ID,
            &TestSettledStep {
                node_id,
                attempt: 1,
                execution_index: *execution_index,
                status: WorkflowStepStatus::Succeeded,
                finished_at: "2026-10-02T00:30:00.000Z",
                sources,
                output_item_counts: &counts,
                pin_hash: None,
                reused_from: None,
            },
        );
        let items = WorkflowPayloadRef::Inline {
            items: outputs.concat(),
        };
        set_output_ref(rows, node_id, *execution_index, &items);
    }
}

/// Points the earlier run's step of `node_id` at `execution_index` at `output_ref`.
fn set_output_ref(
    rows: &Connection,
    node_id: &str,
    execution_index: u32,
    output_ref: &WorkflowPayloadRef,
) {
    rows.execute(
        "UPDATE workflow_steps SET output_ref = ?1 \
         WHERE workflow_run_id = ?2 AND node_id = ?3 AND execution_index = ?4",
        params![
            serde_json::to_string(output_ref).expect("a payload ref writes as JSON"),
            EARLIER_RUN_ID,
            node_id,
            execution_index
        ],
    )
    .expect("the test stores the earlier step's output");
}

/// The plan of a node run in `scope` that executes `executed` and keeps the earlier run's steps of
/// `kept`, reused from a node or read as the target's prior input for one node.
fn plan(
    rows: &Connection,
    definition_id: WorkflowDefinitionId,
    scope: WorkflowNodeExecuteScope,
    executed: &[&str],
    kept: &[&str],
) -> PartialRunPlan {
    let kept_ids: Vec<_> = kept.iter().map(|node_id| test_node_id(node_id)).collect();
    let mut settled =
        read_settled_steps(rows, definition_id, &kept_ids).expect("the earlier steps read");
    let kept = kept_ids
        .into_iter()
        .map(|node_id| {
            let steps = settled
                .remove(&node_id)
                .expect("the earlier run settled it");
            (node_id, steps)
        })
        .collect();
    let executed = executed
        .iter()
        .map(|node_id| test_node_id(node_id))
        .collect();
    match scope {
        WorkflowNodeExecuteScope::FromHere => PartialRunPlan {
            executed,
            reused: kept,
            inputs: Vec::new(),
        },
        WorkflowNodeExecuteScope::Node => PartialRunPlan {
            executed,
            reused: Vec::new(),
            inputs: kept,
        },
    }
}

/// `column` of this run's step of `node_id`, `None` while it has no row.
fn column(harness: &Harness, node_id: &str, column: &str) -> Option<String> {
    harness
        .rows
        .query_row(
            &format!(
                "SELECT {column} FROM workflow_steps WHERE workflow_run_id = ?1 AND node_id = ?2"
            ),
            params![harness.scope.run_id.text().as_str(), node_id],
            |row| row.get(0),
        )
        .optional()
        .expect("the test reads this run's step")
}

/// `column` of this run's step of `node_id` read as a payload ref.
fn payload_ref(harness: &Harness, node_id: &str, column_name: &str) -> WorkflowPayloadRef {
    serde_json::from_str(&column(harness, node_id, column_name).expect("the step has a row"))
        .expect("a stored payload ref reads")
}

/// Waits until this run has ended and every turn it took is over, and answers how it ended.
async fn ended(harness: &mut Harness) -> String {
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    let status = move |rows: &Connection| -> Option<String> {
        rows.query_row(
            "SELECT status FROM workflow_runs WHERE id = ?1 AND finished_at IS NOT NULL",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .expect("the test reads the run")
    };
    harness.wait_until(|rows| status(rows).is_some()).await;
    harness.wait_for_earlier_turns().await;
    status(&harness.rows).expect("the run ended")
}

/// The nodes whose steps reached their executors, in the order they started.
fn ran(harness: &Harness) -> Vec<String> {
    harness
        .events()
        .into_iter()
        .filter(|(_, event_type, ..)| event_type == "workflow.phase.started")
        .map(|(.., payload)| payload["nodeId"].as_str().expect("a node id").to_owned())
        .collect()
}

/// `T` and `A` are reused and `B` and `C` run: the reused steps are skipped `reused` naming the
/// earlier steps they carry, `B`'s `pending` row rides on `A`'s skip in the seed's one write, and
/// `B` runs on `A`'s earlier output. Mutation: in `RunWalk::reusing`, queue no seed step, so the
/// walk readies `T` to run and the start finds no trigger input (`start_run`'s trigger `expect`).
#[tokio::test]
async fn run_from_here_reuses_the_clean_steps_and_runs_the_dirty_ones() {
    let mut harness = Harness::new(None).await;
    let (version_id, definition_id) =
        (harness.scope.workflow_version_id, harness.scope.workflow_id);
    let (nodes, edges) = chain();
    harness
        .start_node_run(
            nodes,
            &edges,
            node_run("C", WorkflowNodeExecuteScope::FromHere),
            |rows| {
                store_earlier_run(rows, version_id, &chain_steps());
                plan(
                    rows,
                    definition_id,
                    WorkflowNodeExecuteScope::FromHere,
                    &["B", "C"],
                    &["T", "A"],
                )
            },
        )
        .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["B", "C"]);
    for (node_id, execution_index) in [("T", 0), ("A", 1)] {
        assert_eq!(
            column(&harness, node_id, "status").as_deref(),
            Some("skipped")
        );
        let reused_from: Value = serde_json::from_str(
            &column(&harness, node_id, "reused_from_json").expect("a reused skip names its step"),
        )
        .expect("the reused step reads");
        assert_eq!(reused_from["step"]["workflowRunId"], json!(EARLIER_RUN_ID));
        assert_eq!(
            reused_from["step"]["executionIndex"],
            json!(execution_index)
        );
    }
    let (_, _, skipped_at, skipped) = harness.event("workflow.step.skipped", "A");
    assert_eq!(skipped["readied"][0]["nodeId"], json!("B"));
    assert_eq!(column(&harness, "B", "started_at"), Some(skipped_at));
    assert_eq!(
        payload_ref(&harness, "B", "input_ref"),
        WorkflowPayloadRef::Inline {
            items: vec![named("A")]
        }
    );
}

/// A run from `B` covers `T`, `A` and `B` alone, so `C`, which `B` feeds, gets no row and the run
/// ends once `B` settles. Mutation: in `start_run`, seed the walk with `None` for its covered set,
/// which readies `C` on `B`'s settle.
#[tokio::test]
async fn the_targets_descendants_never_run() {
    let mut harness = Harness::new(None).await;
    let (version_id, definition_id) =
        (harness.scope.workflow_version_id, harness.scope.workflow_id);
    let (nodes, edges) = chain();
    harness
        .start_node_run(
            nodes,
            &edges,
            node_run("B", WorkflowNodeExecuteScope::FromHere),
            |rows| {
                store_earlier_run(rows, version_id, &chain_steps());
                plan(
                    rows,
                    definition_id,
                    WorkflowNodeExecuteScope::FromHere,
                    &["B"],
                    &["T", "A"],
                )
            },
        )
        .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["B"]);
    assert_eq!(column(&harness, "C", "status"), None);
}

/// A run of `X`, inside the body of the loop `L`, replays `T` and the loop's first pass, runs `X`
/// on that pass's batch, and ends without running `Y`, the body node after `X`, or any later pass.
/// Mutation: in `StartedNodeRun::from_plan`, cover every place of the graph, so `Y` runs and the
/// loop's second pass replays.
#[tokio::test]
async fn a_target_inside_a_loop_runs_on_the_loops_first_batch_and_the_run_ends() {
    let mut harness = Harness::new(None).await;
    let (version_id, definition_id) =
        (harness.scope.workflow_version_id, harness.scope.workflow_id);
    let nodes = vec![
        node("T", "test.trigger", 0, None),
        node("L", "test.loop", 1, None),
        node("X", "test.step", 2, None),
        node("Y", "test.step", 3, None),
        node("D", "test.step", 4, None),
    ];
    let loop_body: WorkflowEdge = serde_json::from_value(json!({
        "id": "L-X", "source": "L", "sourceHandle": "outputs/main/1",
        "target": "X", "targetHandle": "inputs/main/0",
    }))
    .expect("the loop's body edge reads");
    let edges = vec![
        edge("T", "L", 0),
        loop_body,
        edge("X", "Y", 0),
        edge("Y", "L", 0),
        edge("L", "D", 0),
    ];
    let steps: Vec<EarlierStep> = vec![
        ("T", 0, &[], vec![vec![named("T")]]),
        ("L", 1, &[("T", 0)], vec![Vec::new(), vec![named("L")]]),
        ("X", 2, &[("L", 1)], vec![vec![named("X")]]),
        ("Y", 3, &[("X", 2)], vec![vec![named("Y")]]),
        ("L", 4, &[("Y", 3)], vec![vec![named("L")], Vec::new()]),
        ("D", 5, &[("L", 4)], vec![vec![named("D")]]),
    ];
    harness
        .start_node_run(
            nodes,
            &edges,
            node_run("X", WorkflowNodeExecuteScope::Node),
            |rows| {
                store_earlier_run(rows, version_id, &steps);
                plan(
                    rows,
                    definition_id,
                    WorkflowNodeExecuteScope::Node,
                    &["X"],
                    &["T", "L"],
                )
            },
        )
        .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["X"]);
    assert_eq!(
        payload_ref(&harness, "X", "input_ref"),
        WorkflowPayloadRef::Inline {
            items: vec![named("L")]
        }
    );
    assert_eq!(column(&harness, "L", "status").as_deref(), Some("skipped"));
    assert_eq!(column(&harness, "Y", "status"), None);
    assert_eq!(column(&harness, "D", "status"), None);
}

/// A run of `C` alone replays `T`, `A` and `B` as its prior input and runs only `C`, on `B`'s
/// earlier output. Mutation: in `StartedNodeRun::from_plan`, seed `reused` without `inputs`, so
/// the walk readies `T` to run with no trigger input and `C` never readies.
#[tokio::test]
async fn run_this_node_runs_the_target_on_its_prior_input() {
    let mut harness = Harness::new(None).await;
    let (version_id, definition_id) =
        (harness.scope.workflow_version_id, harness.scope.workflow_id);
    let (nodes, edges) = chain();
    harness
        .start_node_run(
            nodes,
            &edges,
            node_run("C", WorkflowNodeExecuteScope::Node),
            |rows| {
                store_earlier_run(rows, version_id, &chain_steps());
                plan(
                    rows,
                    definition_id,
                    WorkflowNodeExecuteScope::Node,
                    &["C"],
                    &["T", "A", "B"],
                )
            },
        )
        .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["C"]);
    assert_eq!(
        payload_ref(&harness, "C", "input_ref"),
        WorkflowPayloadRef::Inline {
            items: vec![named("B")]
        }
    );
}

/// `A`'s earlier output, stored as an artifact, is stored again under this run's step in this
/// run's session when the earlier run lives in another session, and its ref kept as it is when
/// both share the session; `B` runs on its items either way. Mutation: in `reused_output_ref`,
/// keep the earlier step's ref whatever its session, so the other session's case writes no copy.
#[rstest]
#[case::another_session(false)]
#[case::the_same_session(true)]
#[tokio::test]
async fn a_reused_output_of_another_session_is_stored_again(#[case] is_same_session: bool) {
    let mut harness = Harness::new(None).await;
    let (version_id, definition_id) =
        (harness.scope.workflow_version_id, harness.scope.workflow_id);
    let this_session = harness.scope.session_id;
    let earlier_session = if is_same_session {
        this_session
    } else {
        SessionId::new(TEST_SESSION_ID).expect("the test's session id")
    };
    let earlier_ref = write_step_payload(
        harness.payloads.as_ref(),
        earlier_session,
        &earlier_key("A", 1),
        &large_items(),
    )
    .await
    .expect("the earlier output is stored");
    let (nodes, edges) = chain();
    let stored_ref = earlier_ref.clone();
    harness
        .start_node_run(
            nodes,
            &edges,
            node_run("B", WorkflowNodeExecuteScope::FromHere),
            |rows| {
                let mut steps = chain_steps();
                steps[1].3 = vec![large_items()];
                store_earlier_run(rows, version_id, &steps);
                set_output_ref(rows, "A", 1, &stored_ref);
                rows.execute(
                    "UPDATE workflow_runs SET session_id = ?1 WHERE id = ?2",
                    params![earlier_session.text().as_str(), EARLIER_RUN_ID],
                )
                .expect("the test moves the earlier run to its session");
                plan(
                    rows,
                    definition_id,
                    WorkflowNodeExecuteScope::FromHere,
                    &["B"],
                    &["T", "A"],
                )
            },
        )
        .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["B"]);
    let copies: Vec<_> = harness
        .payloads
        .writes()
        .into_iter()
        .filter(|kept| {
            kept.step.node_id.as_str() == "A" && kept.step.workflow_run_id == harness.scope.run_id
        })
        .collect();
    let output_ref = payload_ref(&harness, "A", "output_ref");
    if is_same_session {
        assert_eq!(output_ref, earlier_ref);
        assert_eq!(copies, []);
    } else {
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].session_id, this_session);
        assert_eq!(
            copies[0].bytes,
            serde_json::to_vec(&large_items()).expect("the items write as JSON")
        );
        let WorkflowPayloadRef::Artifact { artifact_id, .. } = output_ref else {
            panic!("the copy is an artifact");
        };
        assert_eq!(artifact_id, copies[0].artifact_id);
    }
    assert_eq!(
        column(&harness, "B", "status").as_deref(),
        Some("succeeded")
    );
}
