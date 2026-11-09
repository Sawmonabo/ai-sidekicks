//! A person's Resume in the tick: refused, writing nothing, on a run with nothing a Resume lifts;
//! on a failed park, the failed step and each step the park canceled run again as new attempts
//! while every other wait stays.

use rusqlite::Connection;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::{RunResumeIntake, RunResumeRefusal};
use crate::engine::tick::turns::EngineTickInput;
use crate::engine::tick::turns::tests::harness::{
    Harness, WAIT, attempt_column, edge, item, node, step_column,
};
use crate::test_rows::stored_rows;

/// A person's Resume of the scope's run, answered with the loop's reply.
pub(in crate::engine::tick::turns) async fn resume(
    harness: &Harness,
) -> Result<(), RunResumeRefusal> {
    let (reply, replied) = oneshot::channel();
    let intake = RunResumeIntake {
        run_id: harness.scope.run_id,
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

    assert_eq!(resume(&harness).await, Err(refusal));
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

    assert_eq!(resume(&harness).await, Ok(()));
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

    assert_eq!(resume(&harness).await, Ok(()));
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
