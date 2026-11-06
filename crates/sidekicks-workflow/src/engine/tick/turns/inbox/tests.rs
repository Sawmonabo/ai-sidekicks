use std::time::{Duration, SystemTime};

use jiff::Timestamp;
use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::time::timeout;

use crate::engine::chain::KeepGoingAnswer;
use crate::engine::tick::turns::tests::harness::{
    Harness, QUIET, WAIT, edge, item, node, step_column,
};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::engine::waits::{PersonWaitAnswer, PersonWaitRefusal};
use crate::kinds::{StepFailure, uncoded_step_error};
use crate::runs::gate_resolution::tests::gate_answer;
use crate::test_rows::{TestStep, insert_chain_run, insert_step, insert_workflow_version};

/// The deadline the step of `node_id` waits until, as its row stores it.
fn stored_deadline(harness: &Harness, node_id: &str) -> String {
    step_column(&harness.rows, node_id, "wait_deadline_at").expect("the step's wait has a deadline")
}

/// `stored`, a stored instant, on the wall clock.
fn wall_instant(stored: &str) -> SystemTime {
    SystemTime::from(stored.parse::<Timestamp>().expect("a stored instant"))
}

/// The key of the step of `node_id`, as its row stores it.
fn stored_step(harness: &Harness, node_id: &str) -> WorkflowStepKey {
    let (run_id, attempt, execution_index): (String, u32, u32) = harness
        .rows
        .query_row(
            "SELECT workflow_run_id, attempt, execution_index FROM workflow_steps \
             WHERE node_id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the step's row");
    serde_json::from_value(json!({
        "workflowRunId": run_id, "nodeId": node_id, "attempt": attempt,
        "executionIndex": execution_index,
    }))
    .expect("the stored step's key")
}

/// The record lines of `record` naming `wait_id`.
fn wait_lines(harness: &Harness, record: &str, wait_id: UuidTextForm) -> Vec<Map<String, Value>> {
    harness
        .record_lines(record)
        .into_iter()
        .filter(|line| line["waitId"] == json!(wait_id))
        .collect()
}

/// The words of the outcomes answering the intent `intent`, paired by its sequence.
fn outcomes_of(harness: &Harness, intent: &Map<String, Value>) -> Vec<Value> {
    harness
        .records
        .lines()
        .into_iter()
        .filter(|line| {
            line["phase"] == json!("outcome") && line["intentSequence"] == intent["sequence"]
        })
        .map(|line| line["record"].clone())
        .collect()
}

/// An approval of the step `approve`, with its gate answer.
fn approval(
    harness: &Harness,
) -> (
    PersonWaitAnswer,
    Option<crate::runs::gate_resolution::WorkflowGateAnswer>,
) {
    (
        PersonWaitAnswer::Approval(ApprovalDecision::Approved),
        Some(gate_answer(
            harness.scope.run_id.text().as_str(),
            1,
            WorkflowGateKind::HumanApproval,
            ApprovalDecision::Approved,
        )),
    )
}

/// P waits on an approval and Q on a reply, each asked once its wait is stored and each deadline
/// armed and cleared as a record line; the first of P's answer and its deadline settles P, the
/// other is refused, and the clock moves on to Q. Kills: the ask before the commit, and a second
/// ask; the reply before the write; two settlements of one wait; no read of the clock after the
/// answer or the timeout; an arm or clear line missing.
#[rstest]
#[case::answer_first(true)]
#[case::deadline_first(false)]
#[tokio::test]
async fn the_first_of_an_answer_and_the_deadline_settles_the_wait(#[case] is_answer_first: bool) {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("approve", "test.approve", 1, None),
                node("Q", "test.ask", 2, None),
            ],
            &[edge("trigger", "approve", 0), edge("trigger", "Q", 0)],
            vec![item(json!({ "name": "Ada" }))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| {
            ["approve", "Q"]
                .iter()
                .all(|node_id| step_column(rows, node_id, "status").as_deref() == Some("waiting"))
        })
        .await;
    harness.wait_for_earlier_turns().await;

    let (p_wait, q_wait) = (harness.wait_id("approve"), harness.wait_id("Q"));
    let calls = harness.asks.calls();
    assert_eq!(calls.len(), 2, "one ask per wait");
    for (node_id, kind, wait_id) in [("approve", "approval", p_wait), ("Q", "reply", q_wait)] {
        let call = calls
            .iter()
            .find(|call| call.step.node_id.as_str() == node_id)
            .expect("each wait is asked");
        assert_eq!(call.kind, kind);
        assert_eq!(call.wait_id, wait_id);
        assert_eq!(
            call.row_status.as_deref(),
            Some("waiting"),
            "{node_id} is asked once stored"
        );
        assert_eq!(call.row_wait_id, Some(wait_id.text().as_str().to_owned()));
        let armed = wait_lines(&harness, "deadlineArmed", wait_id);
        assert_eq!(armed.len(), 1, "{node_id}'s deadline is armed once");
        assert_eq!(armed[0]["at"], json!(stored_deadline(&harness, node_id)));
    }
    for (node_id, intent_word, wait_id) in [
        ("approve", "raisingCard", p_wait),
        ("Q", "openingQuestion", q_wait),
    ] {
        let intents = wait_lines(&harness, intent_word, wait_id);
        assert_eq!(intents.len(), 1, "{node_id}'s ask is recorded once");
        assert_eq!(intents[0]["nodeId"], json!(node_id));
        assert_eq!(outcomes_of(&harness, &intents[0]), [json!("done")]);
    }
    let q_deadline = wall_instant(&stored_deadline(&harness, "Q"));
    assert_eq!(
        harness.armed(),
        Some(wall_instant(&stored_deadline(&harness, "approve")))
    );

    let (answer, gate) = approval(&harness);
    if is_answer_first {
        assert_eq!(
            harness.answer(p_wait, answer.clone(), gate.clone()).await,
            Ok(Ok(()))
        );
        assert_eq!(harness.status("approve").as_deref(), Some("succeeded"));
        for event_type in [
            "workflow.gate.resolved",
            "workflow.phase.resumed",
            "workflow.step.completed",
        ] {
            harness.event(event_type, "approve");
        }
    } else {
        harness
            .clock
            .set_now(SystemTime::now() + Duration::from_secs(61));
        harness
            .wait_until(|rows| step_column(rows, "approve", "status").as_deref() == Some("failed"))
            .await;
        let error: Value = serde_json::from_str(
            &step_column(&harness.rows, "approve", "error_json").expect("the failed step's error"),
        )
        .expect("the error is JSON");
        assert_eq!(error["code"], json!("workflow.step.timedOut"));
        for column in ["wait_cause", "wait_id", "wait_deadline_at"] {
            assert_eq!(
                step_column(&harness.rows, "approve", column),
                None,
                "{column}"
            );
        }
    }
    assert_eq!(wait_lines(&harness, "deadlineCleared", p_wait).len(), 1);
    harness.wait_for_earlier_turns().await;
    assert_eq!(harness.armed(), Some(q_deadline), "the clock moves on to Q");

    let events = harness.events().len();
    assert_eq!(
        harness.answer(p_wait, answer, gate).await,
        Ok(Err(PersonWaitRefusal::NotWaiting))
    );
    assert_eq!(
        harness.events().len(),
        events,
        "a refused answer writes nothing"
    );
}

/// An ask that cannot be raised fails its step through the step's error setting, here a park,
/// its wait cleared; a second failure of the parked step writes nothing. Kills: the failure
/// reported as an at-once failure, whose admission breaks the row's check and drops the run; the
/// failure only recorded, the step left waiting; no read of the clock after it; a second
/// settlement of a parked failed step.
#[tokio::test]
async fn a_failed_ask_fails_its_step() {
    let mut harness = Harness::new(None).await;
    harness.asks.refuse_every_call();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("approve", "test.approve", 1, None),
            ],
            &[edge("trigger", "approve", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "approve", "status").as_deref() == Some("failed"))
        .await;
    harness.wait_for_earlier_turns().await;

    let error: Value = serde_json::from_str(
        &step_column(&harness.rows, "approve", "error_json").expect("the failed step's error"),
    )
    .expect("the error is JSON");
    assert_eq!(error["code"], Value::Null, "{error}");
    for column in ["wait_cause", "wait_id", "wait_deadline_at"] {
        assert_eq!(
            step_column(&harness.rows, "approve", column),
            None,
            "{column}"
        );
    }
    let (suspended, ..) = harness.event("workflow.phase.suspended", "approve");
    assert!(
        harness
            .events()
            .iter()
            .all(|(sequence, event_type, _, payload)| {
                event_type != "workflow.phase.admitted"
                    || payload["nodeId"] != json!("approve")
                    || *sequence < suspended
            }),
        "the failure admits nothing"
    );
    let (_, _, _, run_failed) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.failed")
        .expect("the run parks");
    assert_eq!(run_failed["outcome"], json!("parked"));
    let intents = harness.record_lines("raisingCard");
    assert_eq!(intents.len(), 1);
    assert_eq!(outcomes_of(&harness, &intents[0]), [json!("failed")]);
    assert_eq!(harness.record_lines("turnWriteFailed").len(), 0);
    assert_eq!(harness.armed(), None);

    // A timeout of the same wait, as a clock read between its fire and its write would send.
    harness
        .reports
        .send(StepReport {
            step: stored_step(&harness, "approve"),
            at: WireInstant::now(),
            kind: StepReportKind::Settled(StepSettlement::Failed {
                failure: StepFailure::Failed(Box::new(uncoded_step_error(
                    "a doubled timeout".to_owned(),
                ))),
                log_lines: Vec::new(),
            }),
        })
        .await
        .unwrap_or_else(|_| panic!("the loop takes the report"));
    tokio::time::sleep(QUIET).await;
    let failures = harness
        .events()
        .into_iter()
        .filter(|(_, event_type, _, payload)| {
            event_type == "workflow.step.failed" && payload["nodeId"] == json!("approve")
        })
        .count();
    assert_eq!(failures, 1);
}

/// A park keeps its run's waits, so an answer still settles one, and the parked run starts
/// nothing its answer readies. Kills: the park canceling a wait; a step dispatched in a parked
/// run.
#[tokio::test]
async fn a_parked_run_keeps_its_waits_and_starts_nothing_new() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
                node("W", "test.ask", 2, None),
                node("Z", "test.step", 3, None),
            ],
            &[
                edge("trigger", "F", 0),
                edge("trigger", "W", 0),
                edge("W", "Z", 0),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("waiting"))
        .await;
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "F", "status").as_deref() == Some("failed"))
        .await;
    assert_eq!(harness.status("W").as_deref(), Some("waiting"));

    let reply = PersonWaitAnswer::Reply(NonEmptyText::new("Ship it".to_owned()).expect("a reply"));
    assert_eq!(
        harness.answer(harness.wait_id("W"), reply, None).await,
        Ok(Ok(()))
    );
    assert_eq!(harness.status("W").as_deref(), Some("succeeded"));
    let (completed, _, _, payload) = harness.event("workflow.step.completed", "W");
    assert_eq!(payload["readied"][0]["nodeId"], json!("Z"));
    let (canceled, ..) = harness.event("workflow.step.canceled", "Z");
    assert_eq!(canceled, completed + 1);
    assert!(
        harness.events().iter().all(|(_, event_type, _, payload)| {
            event_type != "workflow.phase.admitted" || payload["nodeId"] != json!("Z")
        }),
        "a parked run dispatches nothing"
    );
}

/// Keep going for a chain whose first run the loop does not drive commits its one write before
/// it replies, and a second finds no question left. Kills: the refusal at the kept-going update
/// dropped unreplied; the reply before the write; a first run that is not live refused.
#[tokio::test]
async fn keep_going_through_the_inbox_answers_once_its_write_commits() {
    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e90";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e91";
    const ROOT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e92";
    let harness = Harness::new(None).await;
    insert_workflow_version(&harness.rows, DEFINITION_ID, VERSION_ID, "Chain");
    insert_chain_run(
        &harness.rows,
        ROOT_RUN_ID,
        VERSION_ID,
        harness.scope.session_id.text().as_str(),
        "2026-10-02T00:00:00.000Z",
        None,
    );
    let root = WorkflowRunId::new(ROOT_RUN_ID).expect("the test's run id");
    let keep_going = || {
        KeepGoingAnswer::new(
            &root,
            gate_answer(
                ROOT_RUN_ID,
                1,
                WorkflowGateKind::Chain,
                ApprovalDecision::Approved,
            ),
        )
        .expect("an approval of the first run's question keeps it going")
    };

    assert_eq!(harness.keep_going(keep_going()).await, Ok(Ok(())));
    let kept_going: i64 = harness
        .rows
        .query_row(
            "SELECT chain_kept_going FROM workflow_runs WHERE id = ?1",
            [ROOT_RUN_ID],
            |row| row.get(0),
        )
        .expect("the first run's row");
    assert_eq!(kept_going, 1);
    let events = harness.events();
    let (_, _, _, resolved) = events
        .iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.gate.resolved")
        .expect("the answer is stored");
    assert_eq!(resolved.get("nodeId"), None);

    assert_eq!(
        harness.keep_going(keep_going()).await,
        Ok(Err(PersonWaitRefusal::NotWaiting))
    );
    assert_eq!(harness.events().len(), events.len());
    assert_eq!(harness.record_lines("keepGoingFailed").len(), 0);
}

/// A run dropped on a failed write leaves its waits off the clock, and an answer to one is not
/// taken rather than refused. Kills: not waiting answered for a dropped run's wait; the dropped
/// run not skipped by the clock; no read of the clock after a drop.
#[tokio::test]
async fn a_dropped_runs_waits_are_not_taken_and_leave_the_clock() {
    let mut harness = Harness::new(None).await;
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("W", "test.ask", 1, None),
                node("S", "test.wait", 2, None),
                node("G", "test.gated", 3, None),
                node("A", "test.step", 4, None),
            ],
            &[
                edge("trigger", "W", 0),
                edge("trigger", "S", 0),
                edge("trigger", "G", 0),
                edge("G", "A", 0),
            ],
            vec![item(json!({}))],
            // A's place, after the trigger's three successors, is taken, so the write readying A
            // is refused.
            |rows| {
                insert_step(
                    rows,
                    &run_id,
                    &TestStep {
                        execution_index: 4,
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
            step_column(rows, "W", "status").as_deref() == Some("waiting")
                && ["S", "G"].iter().all(|node_id| {
                    step_column(rows, node_id, "status").as_deref() == Some("running")
                })
        })
        .await;
    harness.wait_for_earlier_turns().await;
    assert_eq!(harness.asks.calls().len(), 1, "W is asked");
    assert_eq!(
        harness.armed(),
        Some(wall_instant(&stored_deadline(&harness, "W")))
    );
    let w_wait = harness.wait_id("W");

    harness.signal.go.notify_one();
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("the dropped run's cancel reaches its running step");

    let reply = PersonWaitAnswer::Reply(NonEmptyText::new("Ship it".to_owned()).expect("a reply"));
    assert!(
        harness.answer(w_wait, reply, None).await.is_err(),
        "the answer to a dropped run's wait is not taken"
    );
    harness.wait_for_earlier_turns().await;
    assert_eq!(harness.armed(), None);
    assert_eq!(harness.record_lines("turnWriteFailed").len(), 1);
}
