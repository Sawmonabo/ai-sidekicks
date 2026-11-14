//! The restart's sweep of what a stop left: a cut start's or turn's stored payloads deleted with
//! their reservations, while what a committed row names and what a live run's turn holds stay, and
//! a leftover that will not delete kept for the next restart.

use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use tokio::time::timeout;

use super::harness::{Harness, WAIT, edge, item, large_items, node, run_status, step_column};
use crate::engine::waits::PersonWaitAnswer;
use crate::runs::step_payload::read_step_payload;

/// How many payload reservations are stored.
fn reservations(rows: &Connection) -> i64 {
    rows.query_row(
        "SELECT count(*) FROM workflow_payload_reservations",
        [],
        |row| row.get(0),
    )
    .expect("the reservations count")
}

/// The restart's sweep deletes what a start the stop cut reserved under its run, with the
/// reservation, and leaves the artifact of a value a deleted run kept, which no reservation names.
/// Mutations: the sweep reading every artifact of the session (the kept artifact is deleted); the
/// sweep dropped (the start's payload and its reservation stay).
#[tokio::test]
async fn the_restart_sweep_deletes_what_a_cut_start_owns_and_keeps_kept_values() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("A", "test.keep", 1, None),
            ],
            &[edge("T", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;
    harness.wait_for_earlier_turns().await;
    let kept: String = harness
        .rows
        .query_row(
            "SELECT artifact_id FROM workflow_node_state WHERE artifact_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("the kept value names its artifact");
    let kept = ArtifactId::new(&kept).expect("the kept artifact's id reads");
    // The person deletes the run, which leaves its payloads and its kept values.
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    harness
        .rows
        .execute_batch(&format!(
            "PRAGMA foreign_keys = OFF;
             DELETE FROM workflow_steps WHERE workflow_run_id = '{run_id}';
             DELETE FROM workflow_runs WHERE id = '{run_id}';"
        ))
        .expect("the test deletes the run's rows");
    let cut_step: WorkflowStepKey = serde_json::from_value(json!({
        "workflowRunId": "0190a000-0000-7000-8000-0000000000c7",
        "nodeId": "T", "attempt": 1, "executionIndex": 0,
    }))
    .expect("the cut start's step key reads");
    // The cut start stores a payload under its run, and the stop comes before its run's write.
    let cut = harness
        .start_payloads(cut_step.workflow_run_id)
        .store_bytes(&cut_step, b"[]".to_vec(), 0)
        .await
        .expect("the cut start's payload is stored and reserved");

    harness.restart(Vec::new()).await;
    let deletes = harness.payloads.deletes();
    assert!(deletes.contains(&cut), "the cut start's payload is deleted");
    assert!(!deletes.contains(&kept), "the kept value's artifact stays");
    assert_eq!(
        reservations(&harness.rows),
        0,
        "the cut start's reservation is deleted with its payload"
    );
}

/// A turn the stop cuts between storing a payload and its write leaves no artifact after the
/// restart, and every artifact the start and a committed turn stored is kept. Mutations: a turn
/// storing without reserving its id first (the cut artifact stays); the sweep reading every
/// artifact of the session (a committed one is deleted); the turn's write keeping its run's
/// reservations (a committed artifact is deleted).
#[tokio::test]
async fn a_turn_cut_before_its_write_leaves_no_artifact_and_committed_ones_stay() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("T", "test.trigger", 0, None),
                node("L", "test.large", 1, None),
            ],
            &[edge("T", "L", 0)],
            large_items(),
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "L", "status").as_deref() == Some("running"))
        .await;
    harness.wait_for_earlier_turns().await;
    let written = harness.payloads.writes();
    assert!(
        written.iter().any(|kept| kept.step.node_id.as_str() == "L"),
        "the turn that readied L stored its input"
    );
    // L's settlement stores its output, and the stop comes before the turn's write.
    harness.payloads.hold_writes_past(written.len());
    harness.signal.release.notify_one();
    timeout(WAIT, harness.payloads.held_write())
        .await
        .expect("L's output is stored");
    let cut = harness.payloads.writes()[written.len()].artifact_id;

    harness.restart(Vec::new()).await;
    let deletes = harness.payloads.deletes();
    assert!(deletes.contains(&cut), "the cut turn's artifact is deleted");
    for kept in &written {
        assert!(
            !deletes.contains(&kept.artifact_id),
            "an artifact a committed write names stays"
        );
    }
    assert_eq!(
        reservations(&harness.rows),
        0,
        "the cut turn's reservations are deleted"
    );
}

/// A session reloaded beside a live run whose turn has stored a payload and not yet written leaves
/// that artifact, and the turn's committed row names it and reads it back. Mutation: the start's
/// hold on its run not handed to the tick (the reload deletes the artifact).
#[tokio::test]
async fn a_reload_beside_a_live_turn_leaves_the_artifact_its_write_names() {
    let mut harness = Harness::new(None).await;
    let nodes = vec![
        node("T", "test.trigger", 0, None),
        node("L", "test.large", 1, None),
    ];
    harness
        .start(nodes, &[edge("T", "L", 0)], large_items(), |_| {})
        .await;
    harness
        .wait_until(|rows| step_column(rows, "L", "status").as_deref() == Some("running"))
        .await;
    harness.wait_for_earlier_turns().await;
    // L's settlement stores its output, and its turn waits on the store before its write.
    let written = harness.payloads.writes().len();
    harness.payloads.hold_writes_past(written);
    harness.signal.release.notify_one();
    timeout(WAIT, harness.payloads.held_write())
        .await
        .expect("L's output is stored");
    let stored = harness.payloads.writes()[written].artifact_id;

    harness
        .reloader()
        .reload_session(harness.scope.session_id)
        .await
        .expect("the session reloads");
    assert!(
        !harness.payloads.deletes().contains(&stored),
        "the live turn's artifact stays"
    );
    harness.payloads.release_held_write();
    harness
        .wait_until(|rows| step_column(rows, "L", "status").as_deref() == Some("succeeded"))
        .await;
    let output_ref: WorkflowPayloadRef = serde_json::from_str(
        &step_column(&harness.rows, "L", "output_ref").expect("L's output is stored"),
    )
    .expect("L's output reads as a payload ref");
    let named = match &output_ref {
        WorkflowPayloadRef::Artifact { artifact_id, .. } => Some(*artifact_id),
        WorkflowPayloadRef::Inline { .. } => None,
    };
    assert_eq!(
        named,
        Some(stored),
        "L's row names the artifact its turn stored"
    );
    let items = read_step_payload(harness.payloads.as_ref(), &output_ref)
        .await
        .expect("L's output reads back");
    // The engine pairs each output item with its input, so the data is what L wrote.
    let data: Vec<_> = items.into_iter().map(|item| item.json).collect();
    let produced: Vec<_> = large_items().into_iter().map(|item| item.json).collect();
    assert_eq!(data, produced);
    assert!(
        !harness.payloads.deletes().contains(&stored),
        "the named artifact stays"
    );
    assert_eq!(
        reservations(&harness.rows),
        0,
        "the turn's write deletes its reservations"
    );
}

/// Leftovers a stop left that will not delete are kept with their reservations and recorded as
/// faults on their run's one sequence, and the session's runs are still taken back: the waiting run
/// takes its reply and ends. Mutations: a failed leftover delete failing the reload (the restart
/// panics); the run's sequence ended after each fault (both faults carry sequence 1).
#[tokio::test]
async fn a_leftover_that_will_not_delete_keeps_its_reservation_and_the_runs_come_back() {
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
    let cut_step: WorkflowStepKey = serde_json::from_value(json!({
        "workflowRunId": "0190a000-0000-7000-8000-0000000000c8",
        "nodeId": "T", "attempt": 1, "executionIndex": 0,
    }))
    .expect("the cut start's step key reads");
    let mut cut_payloads = harness.start_payloads(cut_step.workflow_run_id);
    for _ in 0..2 {
        cut_payloads
            .store_bytes(&cut_step, b"[]".to_vec(), 0)
            .await
            .expect("the cut start's payload is stored and reserved");
    }
    drop(cut_payloads);
    harness.payloads.refuse_deletes();

    harness.restart(Vec::new()).await;
    let reply = PersonWaitAnswer::Reply(NonEmptyText::new("Yes".to_owned()).expect("a reply"));
    let answered = harness.answer(harness.wait_id("A"), reply, None).await;
    assert_eq!(answered.expect("the loop replies"), Ok(()));
    harness
        .wait_until(|rows| run_status(rows) == "succeeded")
        .await;
    assert_eq!(
        reservations(&harness.rows),
        2,
        "the leftovers' reservations are kept for the next restart"
    );
    let kept = harness.record_lines("stopLeftoverKept");
    let cut_run = json!(cut_step.workflow_run_id.text().as_str());
    assert!(kept.iter().all(|line| line["workflowRunId"] == cut_run));
    let sequences: Vec<&Value> = kept.iter().map(|line| &line["sequence"]).collect();
    assert_eq!(sequences, [&json!(1), &json!(2)]);
}
