//! A person's Resume in the tick: refused, writing nothing, on a run with nothing a Resume lifts;
//! on a failed park, the failed step and each step the park canceled run again as new attempts
//! while every other wait stays; and a Resume moving a failed park to another version, its
//! unchanged steps kept and the rest run there.

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowVersionId,
};
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::{RunResumeIntake, RunResumeRefusal};
use crate::engine::tick::turns::EngineTickInput;
use crate::engine::tick::turns::tests::harness::{
    Harness, WAIT, attempt_column, edge, item, node, step_column,
};
use crate::test_rows::{insert_later_workflow_version, insert_workflow_version_body, stored_rows};

/// The version a re-pin moves the scope's run to.
const TARGET_VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70";

/// A person's Resume of the scope's run, moving it to `version_repin` where one is given,
/// answered with the loop's reply.
pub(in crate::engine::tick::turns) async fn resume(
    harness: &Harness,
    version_repin: Option<WorkflowVersionId>,
) -> Result<Option<WorkflowVersionId>, RunResumeRefusal> {
    let (reply, replied) = oneshot::channel();
    let intake = RunResumeIntake {
        run_id: harness.scope.run_id,
        version_repin,
        reply,
    };
    harness
        .inbox
        .send(EngineTickInput::Resume(intake))
        .await
        .unwrap_or_else(|_| panic!("the loop takes the Resume"));
    timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
}

/// The run's status as its row stores it.
fn run_status(rows: &Connection) -> String {
    rows.query_row("SELECT status FROM workflow_runs", [], |row| row.get(0))
        .expect("the run's row reads")
}

/// A Resume of a run with a step running, and of a run waiting only on a person's reply, is
/// refused with the words that say why, the stored rows and events byte-identical. Kills: the
/// two refusals swapped; a refusal that writes `workflow.run.resumed`; `AwaitsAnswer` answered
/// while a step runs.
#[rstest::rstest]
#[case::running("test.gated", "running", RunResumeRefusal::NotParked)]
#[case::awaiting_a_reply("test.ask", "waiting", RunResumeRefusal::AwaitsAnswer)]
#[tokio::test]
async fn a_resume_with_nothing_to_lift_is_refused_and_writes_nothing(
    #[case] kind: &str,
    #[case] status: &str,
    #[case] refusal: RunResumeRefusal,
) {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("S", kind, 1, None),
            ],
            &[edge("trigger", "S", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "S", "status").as_deref() == Some(status))
        .await;
    harness.wait_for_earlier_turns().await;
    let before = stored_rows(&harness.rows);

    let refused = resume(&harness, None)
        .await
        .expect_err("the Resume is refused");
    assert_eq!(
        std::mem::discriminant(&refused),
        std::mem::discriminant(&refusal)
    );
    harness.wait_for_earlier_turns().await;

    assert_eq!(stored_rows(&harness.rows), before);
}

/// A Resume of a run parked on F's failure while W waits on a reply runs F again as attempt 2,
/// in one write with `workflow.run.resumed`, which opens execution 1 and readies the attempt;
/// W keeps waiting and the run runs again. Kills: the attempt never readied; the epoch left at 0;
/// W's wait lifted with the park; the park left on the run's counts, keeping it `failed`.
#[tokio::test]
async fn a_resume_runs_a_failed_park_again_and_leaves_the_wait_beside_it() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
                node("W", "test.ask", 2, None),
            ],
            &[edge("trigger", "F", 0), edge("trigger", "W", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("waiting"))
        .await;
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| attempt_column(rows, "F", 1, "status").as_deref() == Some("failed"))
        .await;
    harness.wait_for_earlier_turns().await;

    assert_eq!(
        resume(&harness, None).await.expect("the Resume is taken"),
        None
    );
    harness
        .wait_until(|rows| attempt_column(rows, "F", 2, "status").as_deref() == Some("running"))
        .await;

    let (resumed, _, _, payload) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.resumed")
        .expect("the Resume is written");
    assert_eq!(payload["epoch"], json!(1));
    assert_eq!(payload["readied"][0]["nodeId"], json!("F"));
    assert_eq!(payload["readied"][0]["attempt"], json!(2));
    let (admitted, ..) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, payload)| {
            event_type == "workflow.phase.admitted" && payload["attempt"] == json!(2)
        })
        .expect("the attempt is admitted");
    assert!(
        admitted > resumed,
        "the attempt runs after the Resume's write"
    );
    assert_eq!(
        attempt_column(&harness.rows, "F", 1, "status").as_deref(),
        Some("failed")
    );
    assert_eq!(harness.status("W").as_deref(), Some("waiting"));
    assert_eq!(run_status(&harness.rows), "running");

    // The attempt fails again and parks the run once more.
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| attempt_column(rows, "F", 2, "status").as_deref() == Some("failed"))
        .await;
}

/// A Resume of a run parked on F's failure, which canceled its running sibling B, runs F and B
/// again as attempt 2 each. Kills: B dropped from the walk by the park's cancel, so its attempt is
/// never readied; B's attempt readied on another input.
#[tokio::test]
async fn a_resume_runs_each_step_the_park_canceled_again() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
                node("B", "test.wait", 2, None),
            ],
            &[edge("trigger", "F", 0), edge("trigger", "B", 0)],
            vec![item(json!({ "n": 1 }))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("running"))
        .await;
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| attempt_column(rows, "B", 1, "status").as_deref() == Some("canceled"))
        .await;
    harness.wait_for_earlier_turns().await;
    assert_eq!(run_status(&harness.rows), "failed");

    assert_eq!(
        resume(&harness, None).await.expect("the Resume is taken"),
        None
    );
    harness
        .wait_until(|rows| attempt_column(rows, "B", 2, "status").as_deref() == Some("running"))
        .await;

    let (_, _, _, payload) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.resumed")
        .expect("the Resume is written");
    let readied: Vec<_> = payload["readied"]
        .as_array()
        .expect("the Resume readies steps")
        .iter()
        .map(|readied| (readied["nodeId"].clone(), readied["attempt"].clone()))
        .collect();
    assert_eq!(
        readied,
        [(json!("F"), json!(2)), (json!("B"), json!(2))],
        "the failed step, then the step its park canceled"
    );
    assert_eq!(
        attempt_column(&harness.rows, "B", 2, "input_ref"),
        attempt_column(&harness.rows, "B", 1, "input_ref"),
        "B runs again on its own input"
    );
}

/// The stored body of a workflow whose trigger is the first of `nodes`.
fn body(nodes: &[WorkflowNode], edges: &[WorkflowEdge]) -> Value {
    json!({ "name": "Loop", "trigger": nodes[0], "nodes": nodes[1..], "edges": edges })
}

/// Stores the scope's workflow with its pinned version of `nodes` and `edges`, which the run
/// starts on, and its version 2, [`TARGET_VERSION_ID`], of `target_nodes` and `target_edges`.
pub(in crate::engine::tick::turns) fn store_versions(
    harness: &Harness,
    (nodes, edges): (&[WorkflowNode], &[WorkflowEdge]),
    (target_nodes, target_edges): (&[WorkflowNode], &[WorkflowEdge]),
) {
    let pinned = harness.scope.workflow_version_id.text();
    insert_workflow_version_body(
        &harness.rows,
        harness.scope.workflow_id.text().as_str(),
        pinned.as_str(),
        &body(nodes, edges),
    );
    insert_later_workflow_version(
        &harness.rows,
        pinned.as_str(),
        TARGET_VERSION_ID,
        2,
        &body(target_nodes, target_edges),
    );
}

/// The re-pin's target version.
pub(in crate::engine::tick::turns) fn target_version() -> WorkflowVersionId {
    WorkflowVersionId::new(TARGET_VERSION_ID).expect("the test's version id")
}

/// The version the run's row names.
pub(in crate::engine::tick::turns) fn run_version(rows: &Connection) -> String {
    rows.query_row("SELECT workflow_version_id FROM workflow_runs", [], |row| {
        row.get(0)
    })
    .expect("the run's row reads")
}

/// Each step of `node_id` in execution order: its execution index, its attempt, its status and
/// the steps that fed it.
fn node_steps(rows: &Connection, node_id: &str) -> Vec<(i64, i64, String, Value)> {
    rows.prepare(
        "SELECT execution_index, attempt, status, source_json FROM workflow_steps \
         WHERE node_id = ?1 ORDER BY execution_index",
    )
    .expect("the test reads the steps")
    .query_map(params![node_id], |row| {
        let sources: String = row.get(3)?;
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            serde_json::from_str(&sources).expect("a stored step's sources are JSON"),
        ))
    })
    .expect("the test reads the steps")
    .collect::<rusqlite::Result<_>>()
    .expect("the steps read")
}

/// The scope's run of `nodes` and `edges` started, its last node `F` failed and the run parked
/// on it.
async fn park_on_f(harness: &mut Harness, nodes: Vec<WorkflowNode>, edges: &[WorkflowEdge]) {
    harness
        .start(nodes, edges, vec![item(json!({ "n": 1 }))], |_| {})
        .await;
    harness
        .wait_until(|rows| step_column(rows, "F", "status").as_deref() == Some("running"))
        .await;
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| attempt_column(rows, "F", 1, "status").as_deref() == Some("failed"))
        .await;
    harness.wait_for_earlier_turns().await;
}

/// A Resume moving a run parked on F's failure to version 2, where F's kind passes its input on,
/// answers the version the run left, writes `workflow.run.resumed` naming both versions and the
/// target, moves the run's row to the target, keeps the trigger's step as it stands, writing it
/// no new row, and runs F as attempt 2 on the target's kind, fed by that step, which ends the run
/// succeeded. Kills: the run's row left on its version; the event's version pair left off; the
/// trigger's step written again; F run on the pinned kind, failing again; F's tries counted from 1
/// again.
#[tokio::test]
async fn a_repin_runs_the_failed_step_on_the_target_version() {
    let mut harness = Harness::new(None).await;
    let pinned = harness.scope.workflow_version_id;
    let nodes = vec![
        node("trigger", "test.trigger", 0, None),
        node("F", "test.gatedFailure", 1, None),
    ];
    let edges = [edge("trigger", "F", 0)];
    let target_nodes = [
        node("trigger", "test.trigger", 0, None),
        node("F", "test.step", 1, None),
    ];
    store_versions(&harness, (&nodes, &edges), (&target_nodes, &edges));
    park_on_f(&mut harness, nodes, &edges).await;

    assert_eq!(
        resume(&harness, Some(target_version()))
            .await
            .expect("the re-pin is taken"),
        Some(pinned)
    );
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;

    assert_eq!(run_version(&harness.rows), TARGET_VERSION_ID);
    let (_, _, _, resumed) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.resumed")
        .expect("the Resume is written");
    assert_eq!(resumed["repinnedFromWorkflowVersionId"], json!(pinned));
    assert_eq!(
        resumed["repinnedToWorkflowVersionId"],
        json!(TARGET_VERSION_ID)
    );
    assert_eq!(resumed["workflowVersionId"], json!(TARGET_VERSION_ID));
    let trigger = node_steps(&harness.rows, "trigger");
    assert_eq!(
        trigger.len(),
        1,
        "the trigger's step is kept, not written again"
    );
    let f_steps = node_steps(&harness.rows, "F");
    let f_tries: Vec<(i64, &str)> = f_steps
        .iter()
        .map(|(_, attempt, status, _)| (*attempt, status.as_str()))
        .collect();
    assert_eq!(f_tries, [(1, "failed"), (2, "succeeded")]);
    assert_eq!(
        f_steps[1].3[0]["executionIndex"],
        json!(trigger[0].0),
        "F runs on the trigger's kept step"
    );
}

/// A Resume moving a run parked on F's failure, after `A` and `B` succeeded, to a version that
/// changes B's params keeps A's step as it stands, writing it no new row, and runs B and F again
/// on the target, B fresh on A's kept step and F as its next attempt. Kills: B's step kept though
/// B changed; A run or written again though it did not change; B fed by anything but A's kept
/// step; F, after B, never run.
#[tokio::test]
async fn a_repin_reuses_the_unchanged_steps_and_runs_a_changed_node_and_what_follows() {
    let mut harness = Harness::new(None).await;
    let nodes = vec![
        node("trigger", "test.trigger", 0, None),
        node("A", "test.step", 1, None),
        node("B", "test.step", 2, None),
        node("F", "test.gatedFailure", 3, None),
    ];
    let edges = [
        edge("trigger", "A", 0),
        edge("A", "B", 0),
        edge("B", "F", 0),
    ];
    let mut changed_b = node("B", "test.step", 2, None);
    changed_b.params =
        serde_json::from_value(json!({ "changed": true })).expect("the test's params read");
    let target_nodes = [
        node("trigger", "test.trigger", 0, None),
        node("A", "test.step", 1, None),
        changed_b,
        node("F", "test.step", 3, None),
    ];
    store_versions(&harness, (&nodes, &edges), (&target_nodes, &edges));
    park_on_f(&mut harness, nodes, &edges).await;

    resume(&harness, Some(target_version()))
        .await
        .expect("the re-pin is taken");
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;

    let a_steps = node_steps(&harness.rows, "A");
    assert_eq!(a_steps.len(), 1, "A's step is kept, not written again");
    let b_steps = node_steps(&harness.rows, "B");
    let b_tries: Vec<(i64, &str)> = b_steps
        .iter()
        .map(|(_, attempt, status, _)| (*attempt, status.as_str()))
        .collect();
    assert_eq!(
        b_tries,
        [(1, "succeeded"), (1, "succeeded")],
        "B runs again on the target"
    );
    assert_eq!(
        b_steps[1].3[0]["executionIndex"],
        json!(a_steps[0].0),
        "B runs again on A's kept step"
    );
    let f_tries: Vec<(i64, String)> = node_steps(&harness.rows, "F")
        .into_iter()
        .map(|(_, attempt, status, _)| (attempt, status))
        .collect();
    assert_eq!(
        f_tries,
        [(1, "failed".to_owned()), (2, "succeeded".to_owned())]
    );
}

/// A re-pin of a run with nothing a Resume lifts is refused as the plain Resume is, its rows
/// byte-identical and its version unmoved: a run with its step running alone is not parked, and a
/// canceled or an ended run, which the tick no longer holds, is answered from its rows. Kills: the
/// re-pin's reads or move ahead of the plain Resume's refusal; a refused re-pin writing the run's
/// version; a run the tick no longer holds moved.
#[rstest::rstest]
#[case::running_alone("test.gated", "running")]
#[case::canceled("test.wait", "canceled")]
#[case::ended("test.step", "succeeded")]
#[tokio::test]
async fn a_repin_with_nothing_to_lift_is_refused_and_writes_nothing(
    #[case] kind: &str,
    #[case] status: &str,
) {
    let mut harness = Harness::new(None).await;
    let pinned = harness.scope.workflow_version_id.text();
    let nodes = vec![
        node("trigger", "test.trigger", 0, None),
        node("S", kind, 1, None),
    ];
    let edges = [edge("trigger", "S", 0)];
    let target_nodes = [
        node("trigger", "test.trigger", 0, None),
        node("S", "test.step", 1, None),
    ];
    store_versions(&harness, (&nodes, &edges), (&target_nodes, &edges));
    harness
        .start(nodes, &edges, vec![item(json!({}))], |_| {})
        .await;
    if status != "succeeded" {
        harness
            .wait_until(|rows| step_column(rows, "S", "status").as_deref() == Some("running"))
            .await;
    }
    if status == "canceled" {
        let _replied = harness.cancel("Stop").await;
    }
    harness.wait_until(|rows| run_status(rows) == status).await;
    harness.wait_for_earlier_turns().await;
    let before = stored_rows(&harness.rows);

    let refused = resume(&harness, Some(target_version()))
        .await
        .expect_err("the re-pin is refused");
    harness.wait_for_earlier_turns().await;

    if status == "running" {
        assert!(
            matches!(refused, RunResumeRefusal::NotParked),
            "{refused:?}"
        );
    } else {
        assert!(matches!(refused, RunResumeRefusal::NotHeld), "{refused:?}");
    }
    assert_eq!(stored_rows(&harness.rows), before);
    assert_eq!(run_version(&harness.rows), pinned.as_str());
}
