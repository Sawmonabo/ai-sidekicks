//! The restart in the tick's loop: a loop stopped mid-run, its runs reloaded from the rows and
//! the log into a new loop, and each step the sweep finds settled, held again or kept waiting.

use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowEdge;
use tokio::time::timeout;

use super::harness::{Harness, WAIT, attempt_column, edge, item, node, step_column};
use crate::engine::ports::AgentStepOutcome;
use crate::engine::tick::turns::resuming::tests::resume;
use crate::engine::waits::PersonWaitAnswer;
use crate::test_rows::assert_rebuild_rewrites_session_rows;

/// The run's status.
fn run_status(rows: &Connection) -> String {
    rows.query_row("SELECT status FROM workflow_runs", [], |row| row.get(0))
        .expect("the run's row reads")
}

/// Every payload of the stored events of `event_type` on the step of `node_id`, in log order.
fn step_events(harness: &Harness, event_type: &str, node_id: &str) -> Vec<Value> {
    harness
        .events()
        .into_iter()
        .filter(|(_, stored_type, _, payload)| {
            stored_type == event_type && payload["nodeId"] == json!(node_id)
        })
        .map(|(.., payload)| payload)
        .collect()
}

/// Waits for every turn the test has seen, then checks that a rebuild from the log writes the
/// session's rows as the loops wrote them.
async fn assert_rebuilds(harness: &Harness) {
    harness.wait_for_earlier_turns().await;
    assert_rebuild_rewrites_session_rows(&harness.rows, harness.scope.session_id.text().as_str());
}

/// A step running when the daemon stops fails as crashed and parks its run, and a step the memory
/// gate held beside it is canceled at its last hold report and kept for the Resume, which runs
/// both again to the run's end; the rows rebuild from the log. Mutations: the sweep's crashed
/// failure dropped (`A` stays `running`); the held step left out of the park's cancels (`B` is
/// dispatched again unparked and never canceled); the replay dropping a park's cancel from the
/// walk (the Resume does not run `B` again and the run never ends).
#[tokio::test]
async fn a_running_step_crashes_and_parks_its_run_with_its_held_sibling() {
    let mut harness = Harness::new(None).await;
    harness.agents.hold();
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("A", "test.hangsFirst", 1, None),
                node("B", "test.agent", 2, None),
            ],
            &[edge("T", "A", 0), edge("T", "B", 0)],
            vec![item(json!({ "hang": true }))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| {
            step_column(rows, "A", "status").as_deref() == Some("running")
                && step_column(rows, "B", "status").as_deref() == Some("waitingMemory")
        })
        .await;

    harness.restart().await;
    harness
        .wait_until(|rows| attempt_column(rows, "B", 1, "status").as_deref() == Some("canceled"))
        .await;
    assert_eq!(
        attempt_column(&harness.rows, "A", 1, "status").as_deref(),
        Some("failed")
    );
    assert_eq!(run_status(&harness.rows), "failed");
    let failed = step_events(&harness, "workflow.step.failed", "A");
    assert_eq!(failed[0]["error"]["code"], json!("workflow.step.crashed"));
    assert_rebuilds(&harness).await;

    resume(&harness, None)
        .await
        .expect("the parked run resumes");
    harness
        .wait_until(|rows| attempt_column(rows, "B", 2, "status").as_deref() == Some("running"))
        .await;
    harness.agents.end(AgentStepOutcome::Completed {
        items: vec![item(json!({}))],
        cost: None,
    });
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;
    assert_eq!(
        attempt_column(&harness.rows, "A", 2, "status").as_deref(),
        Some("succeeded")
    );
    assert_rebuilds(&harness).await;
}

/// A run stopped twice inside its loop's body, once per batch, parks each time, and each Resume
/// runs the cut step again so the loop goes on to its next batch and its done branch; the second
/// Resume opens the run's third execution, restored from the log. Mutations: the replay skipping
/// a Resume's retries (the walk holds no live step and the run ends crashed); the loader leaving
/// the epoch at 0 (the second Resume writes epoch 1).
#[tokio::test]
async fn a_run_stopped_inside_its_loop_body_goes_on_with_its_batches() {
    let mut harness = Harness::new(None).await;
    let loop_body: WorkflowEdge = serde_json::from_value(json!({
        "id": "L-X", "source": "L", "sourceHandle": "outputs/main/1",
        "target": "X", "targetHandle": "inputs/main/0",
    }))
    .expect("the loop's body edge reads");
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("L", "test.batches", 1, None),
                node("X", "test.hangsFirst", 2, None),
                node("Y", "test.step", 3, None),
                node("D", "test.step", 4, None),
            ],
            &[
                edge("T", "L", 0),
                loop_body,
                edge("X", "Y", 0),
                edge("Y", "L", 0),
                edge("L", "D", 0),
            ],
            vec![item(json!({
                "batches": [{ "hang": true, "batch": 1 }, { "hang": true, "batch": 2 }],
            }))],
            |_| {},
        )
        .await;
    for pass in 1..=2 {
        let running = move |rows: &Connection| {
            rows.query_row(
                "SELECT COUNT(*) FROM workflow_steps \
                 WHERE node_id = 'X' AND status = 'running' AND attempt = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("X's rows read")
                == 1
        };
        harness.wait_until(running).await;
        harness.restart().await;
        harness
            .wait_until(|rows| run_status(rows) == "failed")
            .await;
        resume(&harness, None)
            .await
            .expect("the parked run resumes");
        let resumed = harness
            .events()
            .into_iter()
            .filter(|(_, event_type, ..)| event_type == "workflow.run.resumed")
            .map(|(.., payload)| payload["epoch"].clone())
            .next_back();
        assert_eq!(
            resumed,
            Some(json!(pass)),
            "the Resume opens execution {pass}"
        );
    }
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;
    assert_eq!(
        step_column(&harness.rows, "D", "status").as_deref(),
        Some("succeeded")
    );
    let passed: i64 = harness
        .rows
        .query_row(
            "SELECT COUNT(*) FROM workflow_steps WHERE node_id = 'Y' AND status = 'succeeded'",
            [],
            |row| row.get(0),
        )
        .expect("Y's rows read");
    assert_eq!(passed, 2, "each batch passes through the body once");
    assert_rebuilds(&harness).await;
}

/// A step winding down after the person's cancel when the daemon stops settles canceled, and the
/// run, its ending lost with the stop, ends crashed. Mutations: the sweep's cancel of a step
/// winding down dropped (`A` stays `running` and the run never ends); the crashed ending left
/// unset (the run ends `succeeded`); the reload refusing the run (its crash carries the reason).
#[tokio::test]
async fn a_step_winding_down_settles_canceled_and_its_run_crashes() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("A", "test.linger", 1, None),
                node("B", "test.step", 2, None),
            ],
            &[edge("T", "A", 0), edge("A", "B", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.running.notified())
        .await
        .expect("A runs");
    let _replied = harness.cancel("Not needed any more").await;
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("A winds down");
    harness
        .wait_until(|rows| !step_events_in(rows, "workflow.phase.canceling").is_empty())
        .await;

    harness.restart().await;
    harness
        .wait_until(|rows| run_status(rows) == "crashed")
        .await;
    assert_eq!(harness.status("A").as_deref(), Some("canceled"));
    let crashed = step_events_in(&harness.rows, "workflow.run.crashed");
    assert_eq!(crashed.len(), 1);
    let crashed: Value = serde_json::from_str(&crashed[0]).expect("the crashed event reads");
    assert_eq!(
        crashed.get("error"),
        None,
        "the run was taken back before it crashed"
    );
    assert_rebuilds(&harness).await;
}

/// A step waiting on a person's reply keeps its wait across the restart without asking again,
/// and the reply lands on the new loop and ends the run. Mutations: the reattach's open question
/// read as gone (the restart records the wait not taken back); the waiting step crashed by the
/// sweep (`A` fails).
#[tokio::test]
async fn a_waiting_step_keeps_its_wait_across_the_restart() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("A", "test.ask", 1, None),
            ],
            &[edge("T", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waiting"))
        .await;

    harness.restart().await;
    let reply = PersonWaitAnswer::Reply(NonEmptyText::new("Yes".to_owned()).expect("a reply"));
    let answered = harness.answer(harness.wait_id("A"), reply, None).await;
    assert_eq!(answered.expect("the loop replies"), Ok(()));
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;
    assert_eq!(harness.asks.calls().len(), 1, "the reply is asked once");
    assert!(
        harness.record_lines("fault").is_empty(),
        "the wait is taken back"
    );
    assert_rebuilds(&harness).await;
}

/// A step the memory gate held when the daemon stops is held again on an event of the restart's
/// own, a new hold beside the cut one, and admitted by the new loop's gate; the rows rebuild from
/// the log. Mutations: the sweep's hold report dropped (one `waitingOnMemory` only); its hold named
/// on the step's old readying sequence (the new hold reads as the old one's report and the
/// rebuilt pool wait differs).
#[tokio::test]
async fn a_held_step_is_held_again_and_admitted_by_the_new_loop() {
    let mut harness = Harness::new(None).await;
    harness.agents.hold();
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("A", "test.agent", 1, None),
            ],
            &[edge("T", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waitingMemory"))
        .await;

    harness.restart().await;
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("running"))
        .await;
    let holds = step_events(&harness, "workflow.phase.waitingOnMemory", "A");
    assert_eq!(holds.len(), 2, "the restart opens a hold of its own");
    assert_ne!(holds[0]["waitingSinceSeq"], holds[1]["waitingSinceSeq"]);
    harness.agents.end(AgentStepOutcome::Completed {
        items: vec![item(json!({}))],
        cost: None,
    });
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;
    assert_rebuilds(&harness).await;
}

/// The payloads of the stored events of `event_type`, read on `rows`.
fn step_events_in(rows: &Connection, event_type: &str) -> Vec<String> {
    let mut statement = rows
        .prepare("SELECT payload FROM session_events WHERE type = ?1 ORDER BY sequence")
        .expect("the test reads the events");
    statement
        .query_map([event_type], |row| row.get(0))
        .expect("the events read")
        .collect::<rusqlite::Result<_>>()
        .expect("each event reads")
}
