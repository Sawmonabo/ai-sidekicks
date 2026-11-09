use rstest::rstest;
use rusqlite::params;
use serde_json::{Map, Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use tokio::time::timeout;

use crate::engine::ports::AgentStepOutcome;
use crate::engine::start::hash_run_pins;
use crate::kinds::uncoded_step_error;
use crate::test_rows::{TestStep, assert_rebuild_rewrites_run_rows, insert_step};

pub(super) mod harness;
mod node_run;
mod restart;
mod wait_questions;

use harness::{Harness, QUIET, WAIT, edge, item, large_items, node, step_column};

/// A run of three steps on a trigger input above the inline cap succeeds, each step's `pending`
/// row written in the write that readied it on the artifact its input is stored in, and a rebuild
/// from the log writes the run's rows byte-identical. Mutations: a pending row written in a later
/// write than the event that readied it; a step's `Admitted` written after its driver's reports;
/// the trigger given no `pending` row, which refuses its admission; the fold's `ready` writing a
/// readied step's input other than the artifact ref its event carries, or its
/// `workflow.run.completed` arm leaving the run unended (the rebuilt rows differ); the clear
/// deleting the runs before their steps (the steps' foreign key refuses the rebuild).
#[tokio::test]
async fn a_three_step_run_commits_each_step_with_what_it_readied() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.step", 1, None),
                node("B", "test.step", 2, None),
            ],
            &[edge("trigger", "A", 0), edge("A", "B", 0)],
            large_items(),
            |_| {},
        )
        .await;

    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("succeeded"))
        .await;
    let input_ref: Value = serde_json::from_str(
        &step_column(&harness.rows, "A", "input_ref").expect("A's input is stored"),
    )
    .expect("a stored payload ref is JSON");
    assert_eq!(input_ref["kind"], json!("artifact"));

    for (readying, readied) in [("trigger", "A"), ("A", "B")] {
        let (sequence, _, occurred_at, payload) =
            harness.event("workflow.step.completed", readying);
        assert_eq!(payload["readied"][0]["nodeId"], json!(readied));
        assert_eq!(
            step_column(&harness.rows, readied, "started_at"),
            Some(occurred_at)
        );
        let (admitted, ..) = harness.event("workflow.phase.admitted", readied);
        assert!(admitted > sequence);
    }
    for node_id in ["trigger", "A", "B"] {
        assert_eq!(harness.status(node_id).as_deref(), Some("succeeded"));
        let (admitted, ..) = harness.event("workflow.phase.admitted", node_id);
        let (started, ..) = harness.event("workflow.phase.started", node_id);
        assert!(admitted < started, "{node_id} is admitted before it starts");
    }
    harness.wait_for_earlier_turns().await;
    assert_rebuild_rewrites_run_rows(
        &harness.rows,
        harness.scope.session_id.text().as_str(),
        harness.scope.run_id.text().as_str(),
    );
}

/// A manual run whose `A` is pinned settles `A` on its pinned items, its row naming the pin's
/// hash, and a rebuild from the log writes the run's rows byte-identical. Mutation: the fold's
/// `workflow.step.started` arm dropping the event's `pinHash` (the rebuilt `pin_hash` reads NULL).
#[tokio::test]
async fn a_pinned_steps_hash_rebuilds_as_written() {
    let mut harness = Harness::new(None).await;
    let pins = json!({ "A": [{ "json": { "pinned": true } }] }).to_string();
    harness.scope.pins =
        hash_run_pins(Some(&pins), WorkflowRunMode::Manual).expect("the test's pins hash");
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.step", 1, None),
                node("B", "test.step", 2, None),
            ],
            &[edge("trigger", "A", 0), edge("A", "B", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("succeeded"))
        .await;

    assert!(step_column(&harness.rows, "A", "pin_hash").is_some());
    assert_eq!(step_column(&harness.rows, "B", "pin_hash"), None);
    harness.wait_for_earlier_turns().await;
    assert_rebuild_rewrites_run_rows(
        &harness.rows,
        harness.scope.session_id.text().as_str(),
        harness.scope.run_id.text().as_str(),
    );
}

/// An agent step held at the memory gate and canceled with its run settles `canceled` with the
/// whole milliseconds of its hold, and a rebuild from the log writes the run's rows
/// byte-identical. Mutations: the fold's `workflow.step.canceled` arm dropping the hold it cuts,
/// its `workflow.phase.waitingOnPool` arm keeping no hold report, or that type dropped from the
/// projection's event types, which a rebuild then never reads (the rebuilt `total_pool_wait_ms`
/// reads 0).
#[tokio::test]
async fn a_held_steps_cut_hold_rebuilds_as_written() {
    let mut harness = Harness::new(None).await;
    harness.agents.hold();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.agent", 1, None),
            ],
            &[edge("trigger", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waitingMemory"))
        .await;
    // The hold lasts long enough that its cut counts whole milliseconds.
    tokio::time::sleep(QUIET).await;
    let _replied = harness.cancel("Not needed any more").await;
    timeout(WAIT, harness.agents.wait_for_cancel())
        .await
        .expect("A's cancel stops its run");
    harness.agents.end(AgentStepOutcome::Failed {
        error: uncoded_step_error("the run was stopped".to_owned()),
    });
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("canceled"))
        .await;

    let held_ms: i64 = harness
        .rows
        .query_row(
            "SELECT total_pool_wait_ms FROM workflow_steps WHERE node_id = 'A'",
            [],
            |row| row.get(0),
        )
        .expect("A's row reads");
    assert!(held_ms > 0, "the cancel adds the hold it cut");
    harness.wait_for_earlier_turns().await;
    assert_rebuild_rewrites_run_rows(
        &harness.rows,
        harness.scope.session_id.text().as_str(),
        harness.scope.run_id.text().as_str(),
    );
}

/// A step keeping a value above the cap under a name whose value is kept in an artifact deletes
/// that artifact once its turn commits, and a delete the payload store refuses is recorded as a
/// fault. Mutations: drop the tick's `remove_dropped` loop (nothing is deleted); drop its fault
/// record (the refused case records nothing).
#[rstest]
#[case::deleted(false)]
#[case::left_behind(true)]
#[tokio::test]
async fn a_replaced_kept_artifact_is_deleted_after_its_turn(#[case] is_refusing_deletes: bool) {
    let mut harness = Harness::new(None).await;
    if is_refusing_deletes {
        harness.payloads.refuse_deletes();
    }
    let replaced = ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID");
    let workflow_id = harness.scope.workflow_id.text();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("K", "test.keep", 1, None),
            ],
            &[edge("trigger", "K", 0)],
            vec![item(json!({}))],
            |rows| {
                rows.execute(
                    "INSERT INTO workflow_node_state (definition_id, node_id, key, value_json, \
                     artifact_id, kept_by_run_id, updated_at) \
                     VALUES (?1, '', 'report', '{}', ?2, ?2, '2026-10-01T00:00:00.000Z')",
                    params![workflow_id.as_str(), replaced.to_string()],
                )
                .expect("the test keeps a value in an artifact");
            },
        )
        .await;

    harness
        .wait_until(|rows| step_column(rows, "K", "status").as_deref() == Some("succeeded"))
        .await;
    harness.wait_for_earlier_turns().await;

    let faults = harness.record_lines("turnPayloadLeftBehind");
    if is_refusing_deletes {
        assert_eq!(harness.payloads.deletes(), []);
        assert_eq!(faults.len(), 1);
    } else {
        assert_eq!(harness.payloads.deletes(), [replaced]);
        assert_eq!(faults, Vec::<Map<String, Value>>::new());
    }
}

/// Mutations: the level read once per run, or taken from the scope or the session in place of
/// the workflow's at each turn.
#[tokio::test]
async fn a_level_change_reaches_the_next_dispatched_step() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.level", 1, None),
                node("B", "test.level", 2, None),
            ],
            &[edge("trigger", "A", 0), edge("A", "B", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("A runs");
    harness
        .rows
        .execute(
            "UPDATE workflow_definitions SET permission_level = 'ask' WHERE id = ?1",
            params![harness.scope.workflow_id.text().as_str()],
        )
        .expect("the test changes the workflow's level");
    harness.signal.release.notify_one();

    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("succeeded"))
        .await;

    for (node_id, level) in [("A", "yolo"), ("B", "ask")] {
        let output: Value = serde_json::from_str(
            &step_column(&harness.rows, node_id, "output_ref").expect("the step's output"),
        )
        .expect("the output ref is JSON");
        assert_eq!(
            output["items"][0]["json"]["level"],
            json!(level),
            "{node_id}"
        );
    }
}

/// A run whose last live step leaves it decides what still waits in that step's own write: a
/// step whose output is empty skips its successor, whose `workflow.step.skipped` carries the
/// row's sources, input, output and counts, and a cancel frees a join to run, which its
/// `workflow.step.canceled` readies. Mutations: a flush that waits for a later report; a step
/// the flush readies on no event.
#[rstest]
#[case::empty_output(false)]
#[case::cancel(true)]
#[tokio::test]
async fn a_quiet_run_flushes_in_the_same_turn(#[case] is_canceled: bool) {
    let mut harness = Harness::new(None).await;
    if !is_canceled {
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("X", "test.empty", 1, None),
                    node("Y", "test.step", 2, None),
                ],
                &[edge("trigger", "X", 0), edge("X", "Y", 0)],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        harness
            .wait_until(|rows| step_column(rows, "Y", "status").is_some())
            .await;
        let (completed, _, occurred_at, _) = harness.event("workflow.step.completed", "X");
        let (skipped, _, _, payload) = harness.event("workflow.step.skipped", "Y");
        assert_eq!(
            (skipped, payload["reason"].clone()),
            (completed + 1, json!("noItems"))
        );
        assert_eq!(harness.status("Y").as_deref(), Some("skipped"));
        for (member, column) in [
            ("sources", "source_json"),
            ("inputRef", "input_ref"),
            ("outputRef", "output_ref"),
            ("outputItemCounts", "output_item_counts_json"),
        ] {
            let stored: Value = serde_json::from_str(
                &step_column(&harness.rows, "Y", column).expect("the skipped step's column"),
            )
            .expect("the column holds JSON");
            assert_eq!(payload[member], stored, "{member}");
        }
        assert_eq!(
            step_column(&harness.rows, "Y", "started_at"),
            Some(occurred_at)
        );
        return;
    }
    let cancel = harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("P", "test.step", 1, None),
                node("Q", "test.wait", 2, None),
                node("M", "test.pair", 3, None),
            ],
            &[
                edge("trigger", "P", 0),
                edge("trigger", "Q", 0),
                edge("P", "M", 0),
                edge("Q", "M", 1),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "P", "status").as_deref() == Some("succeeded"))
        .await;
    cancel.cancel();

    harness
        .wait_until(|rows| step_column(rows, "M", "status").is_some())
        .await;
    let (_, _, occurred_at, payload) = harness.event("workflow.step.canceled", "Q");
    assert_eq!(payload["readied"][0]["nodeId"], json!("M"));
    assert_eq!(
        step_column(&harness.rows, "M", "started_at"),
        Some(occurred_at)
    );
}

/// A turn whose write is refused, here at a row already holding its readied step's place, drops
/// its run. Mutations: the turn's artifact left behind; the run kept live; its steps left running.
#[tokio::test]
async fn a_failed_turn_drops_its_run_and_deletes_its_payloads() {
    let mut harness = Harness::new(None).await;
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("S", "test.wait", 1, None),
                node("X", "test.large", 2, None),
                node("A", "test.step", 3, None),
            ],
            &[
                edge("trigger", "S", 0),
                edge("trigger", "X", 0),
                edge("X", "A", 0),
            ],
            vec![item(json!({}))],
            |rows| {
                insert_step(
                    rows,
                    &run_id,
                    &TestStep {
                        execution_index: 3,
                        status: WorkflowStepStatus::Pending,
                        wait_cause: None,
                        wait_account_id: None,
                        resume_at: None,
                    },
                );
            },
        )
        .await;
    harness
        .wait_until(|rows| {
            ["S", "X"]
                .iter()
                .all(|node_id| step_column(rows, node_id, "status").as_deref() == Some("running"))
        })
        .await;
    harness.signal.release.notify_one();

    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("the dropped run's cancel reaches its running step");
    tokio::time::sleep(QUIET).await;

    let written: Vec<_> = harness
        .payloads
        .writes()
        .into_iter()
        .map(|kept| kept.artifact_id)
        .collect();
    assert_eq!(written.len(), 2, "X's output and A's input are artifacts");
    assert_eq!(harness.payloads.deletes(), written);
    let failed = harness.record_lines("turnWriteFailed");
    assert_eq!(failed.len(), 1);
    let error = failed[0]["error"].as_str().expect("the error is text");
    assert!(error.contains("UNIQUE constraint failed"), "{error}");
    assert_eq!(harness.status("S").as_deref(), Some("running"));
    assert_eq!(harness.status("X").as_deref(), Some("running"));
    assert!(
        harness
            .events()
            .iter()
            .all(|(_, event_type, _, _)| event_type != "workflow.step.canceled"),
        "a later report of the dropped run writes nothing"
    );
}

/// A's output, its input passed on, is above the inline cap, and the store refuses every write
/// past A's input; with no error route the failure parks the run, and passed on, the input the
/// failure passes on cannot be stored either, which ends the run. Mutations: the failure swallowed
/// and the step left running; a re-report with no bound; a retry; a park or an end that writes no
/// run event.
#[rstest]
#[case::no_on_error(None, 1)]
#[case::continue_passes_on(Some("continue"), 2)]
#[tokio::test]
async fn a_step_whose_payload_cannot_be_stored_fails_in_its_place(
    #[case] on_error: Option<&str>,
    #[case] write_failures: usize,
) {
    let mut harness = Harness::new(Some(3)).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.step", 1, on_error),
            ],
            &[edge("trigger", "A", 0)],
            large_items(),
            |_| {},
        )
        .await;

    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("failed"))
        .await;
    tokio::time::sleep(QUIET).await;

    let error: Value = serde_json::from_str(
        &step_column(&harness.rows, "A", "error_json").expect("the failed step's error"),
    )
    .expect("the error is JSON");
    assert_eq!(
        error["message"],
        json!("the step's payload could not be stored")
    );
    assert_eq!(
        step_column(&harness.rows, "A", "output_item_counts_json").as_deref(),
        Some("[]")
    );
    let output: Value = serde_json::from_str(
        &step_column(&harness.rows, "A", "output_ref").expect("the step's output"),
    )
    .expect("the output ref is JSON");
    assert_eq!(output, json!({ "kind": "inline", "items": [] }));
    let failed_events: Vec<String> = harness
        .events()
        .into_iter()
        .filter(|(_, _, _, payload)| payload["nodeId"] == json!("A"))
        .map(|(_, event_type, _, _)| event_type)
        .filter(|event_type| event_type.ends_with(".failed"))
        .collect();
    assert_eq!(
        failed_events,
        ["workflow.phase.failed", "workflow.step.failed"]
    );
    // With no error route the failure parks the run; passed on, the refused pass-on ends it.
    let run_failures: Vec<Value> = harness
        .events()
        .into_iter()
        .filter(|(_, event_type, _, _)| event_type == "workflow.run.failed")
        .map(|(_, _, _, payload)| payload["outcome"].clone())
        .collect();
    let outcome = if on_error.is_none() {
        "parked"
    } else {
        "ended"
    };
    assert_eq!(run_failures, [json!(outcome)]);
    assert_eq!(
        harness.record_lines("settlementWriteFailed").len(),
        write_failures
    );
    assert_eq!(harness.payloads.writes().len(), 3);
}
