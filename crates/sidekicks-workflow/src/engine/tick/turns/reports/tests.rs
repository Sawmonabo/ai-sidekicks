use std::time::Duration;

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tokio::time::timeout;

use crate::engine::tick::turns::tests::harness::{
    Harness, QUIET, WAIT, edge, item, node, retried, step_column,
};

/// `column` of attempt `attempt` of the step of `node_id`, `None` before its row is written.
fn attempt_column(rows: &Connection, node_id: &str, attempt: i64, column: &str) -> Option<String> {
    rows.query_row(
        &format!("SELECT {column} FROM workflow_steps WHERE node_id = ?1 AND attempt = ?2"),
        params![node_id, attempt],
        |row| row.get(0),
    )
    .ok()
}

/// The sequence and instant of the event of `event_type` on attempt `attempt` of `node_id`.
fn attempt_event(
    harness: &Harness,
    event_type: &str,
    node_id: &str,
    attempt: i64,
) -> (i64, String) {
    harness
        .events()
        .into_iter()
        .find(|(_, stored_type, _, payload)| {
            stored_type == event_type
                && payload["nodeId"] == json!(node_id)
                && payload["attempt"] == json!(attempt)
        })
        .map_or_else(
            || panic!("{node_id} attempt {attempt} has its {event_type}"),
            |(sequence, _, occurred_at, _)| (sequence, occurred_at),
        )
}

/// The record lines of each wave on `node_id`, as its reason and count.
fn waves_recorded(harness: &Harness, node_id: &str) -> Vec<(Value, Value)> {
    harness
        .records
        .lines()
        .into_iter()
        .filter(|line| {
            line.get("report") == Some(&json!("branchesCanceled"))
                && line.get("nodeId") == Some(&json!(node_id))
        })
        .map(|line| (line["reason"].clone(), line["count"].clone()))
        .collect()
}

/// F fails its first try and is retried after 1 s. Mutations: the wait skipped; the attempt
/// never dispatched; a timer that outlives its run's cancel.
#[rstest]
#[case::waits(false)]
#[case::canceled_run(true)]
#[tokio::test]
async fn a_retry_runs_its_next_attempt_after_its_wait(#[case] is_run_canceled: bool) {
    let mut harness = Harness::new(None).await;
    let cancel = harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                retried(node("F", "test.flaky", 1, None), 2, 1_000),
            ],
            &[edge("trigger", "F", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    if is_run_canceled {
        harness
            .wait_until(|rows| attempt_column(rows, "F", 1, "status").as_deref() == Some("failed"))
            .await;
        cancel.cancel();
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        assert_eq!(
            attempt_column(&harness.rows, "F", 2, "status").as_deref(),
            Some("pending")
        );
        let named: Vec<String> = harness
            .events()
            .into_iter()
            .filter(|(_, _, _, payload)| {
                payload["nodeId"] == json!("F") && payload["attempt"] == json!(2)
            })
            .map(|(_, event_type, _, _)| event_type)
            .collect();
        assert_eq!(named, ["workflow.phase.retried"]);
        return;
    }
    harness
        .wait_until(|rows| attempt_column(rows, "F", 2, "status").as_deref() == Some("succeeded"))
        .await;

    let (_, failed_at) = attempt_event(&harness, "workflow.step.failed", "F", 1);
    let (_, admitted_at) = attempt_event(&harness, "workflow.phase.admitted", "F", 2);
    let failed_at: jiff::Timestamp = failed_at.parse().expect("an instant reads");
    let admitted_at: jiff::Timestamp = admitted_at.parse().expect("an instant reads");
    assert!(
        admitted_at.duration_since(failed_at) >= jiff::SignedDuration::from_secs(1),
        "attempt 2 is admitted {admitted_at}, a second after attempt 1 failed {failed_at}"
    );
}

/// M takes A's items first while B still runs: A settles only once B runs, so the cancel lands on
/// a running step. Mutations: the wave written before B settles; B's own completion written; a
/// `siblingFailure` on a merge loser; the wave's event dropped because M settled first.
#[tokio::test]
async fn a_won_merge_cancels_its_running_loser_in_one_wave() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.gated", 1, None),
                node("B", "test.linger", 2, None),
                node("M", "test.first", 3, None),
            ],
            &[
                edge("trigger", "A", 0),
                edge("trigger", "B", 0),
                edge("A", "M", 0),
                edge("B", "M", 1),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.running.notified())
        .await
        .expect("B runs");
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "M", "status").as_deref() == Some("succeeded"))
        .await;
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("B's cancel reaches it");
    tokio::time::sleep(QUIET).await;

    let (completed, ..) = harness.event("workflow.step.completed", "A");
    let (canceling, ..) = harness.event("workflow.phase.canceling", "B");
    assert_eq!(
        canceling,
        completed + 1,
        "M's readying write holds B's cancel"
    );
    assert_eq!(harness.status("B").as_deref(), Some("running"));
    assert!(
        waves_recorded(&harness, "M").is_empty(),
        "the wave waits for B"
    );

    harness.signal.release.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("canceled"))
        .await;

    let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "M");
    let (canceled, ..) = harness.event("workflow.step.canceled", "B");
    assert_eq!(
        canceled,
        wave + 1,
        "one write holds the wave, then B's cancel"
    );
    assert_eq!(
        waves_recorded(&harness, "M"),
        [(json!("firstToArrive"), json!(1))]
    );
    let b_events: Vec<String> = harness
        .events()
        .into_iter()
        .filter(|(_, _, _, payload)| payload["nodeId"] == json!("B"))
        .map(|(_, event_type, _, _)| event_type)
        .collect();
    assert!(
        !b_events
            .iter()
            .any(|event_type| event_type == "workflow.phase.failed")
    );
    assert!(
        !b_events
            .iter()
            .any(|event_type| event_type == "workflow.step.completed")
    );
}

/// Y is readied in the walk turn that X's completion wins M on, on M's losing input. Mutations: Y
/// dispatched; Y with no row; Y kept live, so the run never goes quiet and leaves the live set.
#[tokio::test]
async fn a_step_on_a_losing_branch_readied_with_the_win_never_runs() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("X", "test.step", 1, None),
                node("Y", "test.step", 2, None),
                node("M", "test.first", 3, None),
            ],
            &[
                edge("trigger", "X", 0),
                edge("X", "M", 0),
                edge("X", "Y", 0),
                edge("Y", "M", 1),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "M", "status").as_deref() == Some("succeeded"))
        .await;
    tokio::time::sleep(QUIET).await;

    assert_eq!(harness.status("Y").as_deref(), Some("canceled"));
    let (completed, _, _, completed_payload) = harness.event("workflow.step.completed", "X");
    let readied: Vec<Value> = completed_payload["readied"]
        .as_array()
        .expect("the completion names what it readied")
        .iter()
        .map(|readied| readied["nodeId"].clone())
        .collect();
    assert!(readied.contains(&json!("M")) && readied.contains(&json!("Y")));
    let (canceled, _, _, canceled_payload) = harness.event("workflow.step.canceled", "Y");
    assert_eq!(
        canceled,
        completed + 1,
        "Y is canceled in the write that readied M"
    );
    assert_eq!(canceled_payload["readied"], json!([]));
    assert!(
        harness
            .events()
            .iter()
            .all(
                |(_, event_type, _, payload)| event_type != "workflow.phase.admitted"
                    || payload["nodeId"] != json!("Y")
            )
    );
    assert!(
        !harness.recorder.has_sequence(harness.scope.run_id),
        "the run goes quiet and leaves the live set"
    );
}

/// F fails with no error route, so it parks its run while B runs: F fails only once B runs, so
/// the cancel lands on a running step. Mutations: B's absorbed completion readying C; no
/// `siblingFailure` on B; the wave written before B settles.
#[tokio::test]
async fn a_park_winds_down_its_running_sibling_and_starts_nothing_after_it() {
    let mut harness = Harness::new(None).await;
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
                node("B", "test.linger", 2, None),
                node("C", "test.step", 3, None),
            ],
            &[
                edge("trigger", "F", 0),
                edge("trigger", "B", 0),
                edge("B", "C", 0),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.running.notified())
        .await
        .expect("B runs");
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "F", "status").as_deref() == Some("failed"))
        .await;
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("B's cancel reaches it");
    tokio::time::sleep(QUIET).await;

    let (failed, ..) = harness.event("workflow.step.failed", "F");
    let (canceling, ..) = harness.event("workflow.phase.canceling", "B");
    assert_eq!(canceling, failed + 1, "F's failure write holds B's cancel");
    let (_, _, _, run_failed) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.failed")
        .expect("the run's park is written");
    assert_eq!(run_failed["outcome"], json!("parked"));
    let run_status: String = harness
        .rows
        .query_row(
            "SELECT status FROM workflow_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .expect("the run's row reads");
    assert_eq!(run_status, "failed");
    assert_eq!(harness.status("B").as_deref(), Some("running"));
    assert!(
        waves_recorded(&harness, "F").is_empty(),
        "the wave waits for B"
    );

    harness.signal.release.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("canceled"))
        .await;

    let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "F");
    let (phase_failed, _, _, phase_failed_payload) = harness.event("workflow.phase.failed", "B");
    let (canceled, ..) = harness.event("workflow.step.canceled", "B");
    assert_eq!(
        (phase_failed, canceled),
        (wave + 1, wave + 2),
        "one write holds the wave, then B's sibling failure and cancel"
    );
    assert_eq!(
        phase_failed_payload["cancellationReason"],
        json!("siblingFailure")
    );
    assert_eq!(
        waves_recorded(&harness, "F"),
        [(json!("siblingFailure"), json!(1))]
    );
    assert_eq!(harness.status("C"), None);
}
