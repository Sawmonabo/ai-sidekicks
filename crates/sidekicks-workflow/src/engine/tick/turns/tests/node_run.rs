//! A node run in the tick's loop: its walk seeded with the earlier steps it reuses, their skips
//! and the steps they ready in one write, kept to the places it covers with its target sealed, and
//! a reused payload that lives in another session stored again in this run's.

use std::collections::HashMap;

use rstest::rstest;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::events::WorkflowNodeRun;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::harness::{Harness, edge, item, large_items, node};
use crate::definitions::versions::history::WorkflowVersions;
use crate::engine::partial_run::{PartialRunPlan, plan_partial_run};
use crate::engine::tick::RunGraph;
use crate::runs::step_payload::write_step_payload;
use crate::test_rows::{
    EARLIER_RUN_ID, EarlierStep, TEST_SESSION_ID, assert_rebuild_rewrites_session_rows,
    earlier_key, set_payload_ref, store_earlier_run, test_node_id,
};

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

/// The plan the start makes of `node_run` of version `version_id` over the stored rows and
/// `graph`, with no pins, reusing runs that worked in no project's repository.
fn plan(
    rows: &Connection,
    graph: &RunGraph,
    version_id: WorkflowVersionId,
    node_run: &WorkflowNodeRun,
) -> PartialRunPlan {
    let version = WorkflowVersions::new(rows)
        .read_version(version_id)
        .expect("the run's version reads");
    let pins = HashMap::new();
    let (target, scope) = (&node_run.node_id, node_run.scope);
    plan_partial_run(rows, &version, graph, target, scope, &pins, None).expect("the plan reads")
}

/// Starts `node_run` over `nodes` and `edges` once `before` stored the earlier run, on the plan
/// the start makes of it.
async fn start_node_run(
    harness: &Harness,
    (nodes, edges): (Vec<WorkflowNode>, Vec<WorkflowEdge>),
    node_run: WorkflowNodeRun,
    before: impl FnOnce(&Connection),
) {
    let version_id = harness.scope.workflow_version_id;
    let planned = node_run.clone();
    harness
        .start_node_run(nodes, &edges, node_run, |rows, graph| {
            before(rows);
            plan(rows, graph, version_id, &planned)
        })
        .await;
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

/// A run from `C` with nothing changed reuses `T`, `A` and `B` and runs `C`: each reused step is
/// skipped `reused`, naming the earlier step it carries and recording that step's input as its
/// own, `C`'s `pending` row rides on `B`'s skip in the seed's one write, and `C` runs on `B`'s
/// earlier output; a rebuild from the log writes the run's rows byte-identical. Mutations: in
/// `RunWalk::reusing`, queue no seed step (the start finds no trigger input); record a reused
/// skip's input from its feeds (`T`'s reads empty); the fold's `workflow.step.skipped` arm
/// dropping `reusedFrom` or the steps the skip readied (the rebuilt rows differ).
#[tokio::test]
async fn run_from_here_reuses_the_clean_steps_and_runs_the_target() {
    let mut harness = Harness::new(None).await;
    let version_id = harness.scope.workflow_version_id;
    let trigger_input = WorkflowPayloadRef::Inline {
        items: vec![named("start")],
    };
    let earlier_input = trigger_input.clone();
    start_node_run(
        &harness,
        chain(),
        node_run("C", WorkflowNodeExecuteScope::FromHere),
        |rows| {
            store_earlier_run(rows, version_id.text().as_str(), &chain_steps());
            set_payload_ref(rows, "T", 0, "input_ref", &earlier_input);
        },
    )
    .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["C"]);
    for (node_id, execution_index) in [("T", 0), ("A", 1), ("B", 2)] {
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
    assert_eq!(payload_ref(&harness, "T", "input_ref"), trigger_input);
    let (_, _, skipped_at, skipped) = harness.event("workflow.step.skipped", "B");
    assert_eq!(skipped["readied"][0]["nodeId"], json!("C"));
    assert_eq!(column(&harness, "C", "started_at"), Some(skipped_at));
    assert_eq!(
        payload_ref(&harness, "C", "input_ref"),
        WorkflowPayloadRef::Inline {
            items: vec![named("B")]
        }
    );
    assert_rebuild_rewrites_session_rows(&harness.rows, harness.scope.session_id.text().as_str());
}

/// A run from `B` covers `T`, `A` and `B` alone, so `C`, which `B` feeds, gets no row and the run
/// ends once `B` settles. Mutation: in `start_run`, seed the walk with `None` for its covered set,
/// which readies `C` on `B`'s settle.
#[tokio::test]
async fn the_targets_descendants_never_run() {
    let mut harness = Harness::new(None).await;
    let version_id = harness.scope.workflow_version_id;
    start_node_run(
        &harness,
        chain(),
        node_run("B", WorkflowNodeExecuteScope::FromHere),
        |rows| store_earlier_run(rows, version_id.text().as_str(), &chain_steps()),
    )
    .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["B"]);
    assert_eq!(column(&harness, "C", "status"), None);
}

/// A run of `X`, inside the body of the loop `L`, replays `T`, runs `L` and then `X` on the loop's
/// first batch, and ends: `X` feeds nothing, neither `Y`, the body node after it, nor `L` where `X`
/// closes the loop itself, so no later pass runs. Mutation: in `fill`, feed out of the sealed
/// target (where `X` closes the loop, `L` runs again).
#[rstest]
#[case::target_closes_its_loop(false)]
#[case::target_before_the_bodys_end(true)]
#[tokio::test]
async fn a_target_inside_a_loop_runs_on_the_loops_first_batch_and_the_run_ends(
    #[case] is_followed: bool,
) {
    let mut harness = Harness::new(None).await;
    let version_id = harness.scope.workflow_version_id;
    let mut nodes = vec![
        node("T", "test.trigger", 0, None),
        node("L", "test.loop", 1, None),
        node("X", "test.step", 2, None),
        node("D", "test.step", 4, None),
    ];
    let loop_body: WorkflowEdge = serde_json::from_value(json!({
        "id": "L-X", "source": "L", "sourceHandle": "outputs/main/1",
        "target": "X", "targetHandle": "inputs/main/0",
    }))
    .expect("the loop's body edge reads");
    let mut edges = vec![edge("T", "L", 0), loop_body, edge("L", "D", 0)];
    if is_followed {
        nodes.push(node("Y", "test.step", 3, None));
        edges.extend([edge("X", "Y", 0), edge("Y", "L", 0)]);
    } else {
        edges.push(edge("X", "L", 0));
    }
    let steps: Vec<EarlierStep> = vec![("T", 0, &[], vec![vec![named("T")]])];
    start_node_run(
        &harness,
        (nodes, edges),
        node_run("X", WorkflowNodeExecuteScope::Node),
        |rows| store_earlier_run(rows, version_id.text().as_str(), &steps),
    )
    .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["L", "X"]);
    // The first batch's item, whatever lineage the loop's inputs give it.
    let WorkflowPayloadRef::Inline { items } = payload_ref(&harness, "X", "input_ref") else {
        panic!("X's input is stored inline");
    };
    let batch: Vec<&Value> = items.iter().map(|input| &input.json.0).collect();
    assert_eq!(batch, [&json!({ "pass": 1 })]);
    assert_eq!(column(&harness, "Y", "status"), None);
    assert_eq!(column(&harness, "D", "status"), None);
}

/// A run of `C` alone replays `T`, `A` and `B` as its prior input and runs only `C`, on `B`'s
/// earlier output. Mutation: in `StartedNodeRun::from_plan`, seed `reused` without `inputs`, so
/// the walk readies `T` to run with no trigger input and `C` never readies.
#[tokio::test]
async fn run_this_node_runs_the_target_on_its_prior_input() {
    let mut harness = Harness::new(None).await;
    let version_id = harness.scope.workflow_version_id;
    start_node_run(
        &harness,
        chain(),
        node_run("C", WorkflowNodeExecuteScope::Node),
        |rows| store_earlier_run(rows, version_id.text().as_str(), &chain_steps()),
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

/// `A`'s earlier input and output, each stored as an artifact, are stored again under `A`'s
/// earlier step in this run's session when the earlier run lives in another session, and its refs
/// kept as they are when both share the session; `A`'s skip records them and `B` runs on its
/// items either way, with no other payload written. A restart then deletes only the payload a
/// start stored under a run a stop left with no row, never a copy or an original a record names.
/// Mutations: in `store_in_session`, keep the earlier refs whatever their session (no copy is
/// written); store no input copy (`A`'s input stays the other session's); the reload's check of
/// what names a payload dropped (the copies are deleted); its payload sweep dropped (the stranded
/// payload stays).
#[rstest]
#[case::another_session(false)]
#[case::the_same_session(true)]
#[tokio::test]
async fn a_reused_payload_of_another_session_is_stored_again(#[case] is_same_session: bool) {
    let mut harness = Harness::new(None).await;
    let version_id = harness.scope.workflow_version_id;
    let this_session = harness.scope.session_id;
    let earlier_session = if is_same_session {
        this_session
    } else {
        SessionId::new(TEST_SESSION_ID).expect("the test's session id")
    };
    let mut stored = Vec::new();
    for items in [large_items(), large_items()] {
        let stored_ref = write_step_payload(
            harness.payloads.as_ref(),
            earlier_session,
            &earlier_key("A", 1),
            &items,
        )
        .await
        .expect("the earlier payload is stored");
        stored.push(stored_ref);
    }
    let (earlier_output, earlier_input) = (stored[0].clone(), stored[1].clone());
    let (output_ref, input_ref) = (earlier_output.clone(), earlier_input.clone());
    start_node_run(
        &harness,
        chain(),
        node_run("B", WorkflowNodeExecuteScope::FromHere),
        |rows| {
            let mut steps = chain_steps();
            steps[1].3 = vec![large_items()];
            store_earlier_run(rows, version_id.text().as_str(), &steps);
            set_payload_ref(rows, "A", 1, "output_ref", &output_ref);
            set_payload_ref(rows, "A", 1, "input_ref", &input_ref);
            rows.execute(
                "UPDATE workflow_runs SET session_id = ?1 WHERE id = ?2",
                params![earlier_session.text().as_str(), EARLIER_RUN_ID],
            )
            .expect("the test moves the earlier run to its session");
        },
    )
    .await;

    assert_eq!(ended(&mut harness).await, "succeeded");
    assert_eq!(ran(&harness), ["B"]);
    let writes = harness.payloads.writes();
    // Past the two the test stored, a write under `A`'s earlier step is a copy.
    let earlier_a = earlier_key("A", 1);
    let copies: Vec<_> = writes
        .iter()
        .skip(2)
        .filter(|kept| kept.step == earlier_a)
        .collect();
    let (output_ref, input_ref) = (
        payload_ref(&harness, "A", "output_ref"),
        payload_ref(&harness, "A", "input_ref"),
    );
    if is_same_session {
        assert_eq!((output_ref, input_ref), (earlier_output, earlier_input));
        assert_eq!(copies.len(), 0);
    } else {
        assert_eq!(copies.len(), 2);
        let copied_refs = [output_ref, input_ref];
        for ((copy, original), copied_ref) in copies.iter().zip(&writes).zip(copied_refs) {
            assert_eq!(
                (copy.session_id, &copy.step, &copy.bytes),
                (this_session, &earlier_a, &original.bytes)
            );
            let WorkflowPayloadRef::Artifact { artifact_id, .. } = copied_ref else {
                panic!("the copy is an artifact");
            };
            assert_eq!(artifact_id, copy.artifact_id);
        }
    }
    assert_eq!(
        column(&harness, "B", "status").as_deref(),
        Some("succeeded")
    );

    let stranded_key = WorkflowStepKey {
        workflow_run_id: WorkflowRunId::new("019a2b3c-0000-7000-8000-00000000c0de")
            .expect("a run id no row holds"),
        ..earlier_key("T", 0)
    };
    let stranded = write_step_payload(
        harness.payloads.as_ref(),
        this_session,
        &stranded_key,
        &large_items(),
    )
    .await
    .expect("the stranded payload is stored");
    let WorkflowPayloadRef::Artifact {
        artifact_id: stranded_id,
        ..
    } = stranded
    else {
        panic!("the stranded payload is an artifact");
    };
    harness.restart(Vec::new()).await;
    assert_eq!(
        harness.payloads.deletes(),
        [stranded_id],
        "only the payload nothing names is deleted"
    );
}
