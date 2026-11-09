//! The tick's run endings: every step settling, `flow.stopError`, the run cap and a person's
//! cancel, each checked on its rows and events, and the card of an approval wait a cancel ends.

use std::collections::BTreeMap;

use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use tokio::time::timeout;

use crate::engine::tick::turns::ending::RunCancelRefusal;
use crate::engine::tick::turns::tests::harness::ports::WithdrawnCard;
use crate::engine::tick::turns::tests::harness::{
    Harness, QUIET, WAIT, edge, item, node, step_column,
};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::engine::waits::PersonWaitAnswer;
use crate::kinds::{PersonAsk, PersonWait};
use crate::runs::gate_resolution::tests::gate_answer;
use crate::test_rows::{execution_context_released_at, insert_live_execution_context};

/// The key of the step of `node_id`, read from its row.
fn step_key(harness: &Harness, node_id: &str) -> WorkflowStepKey {
    let (attempt, execution_index): (i64, i64) = harness
        .rows
        .query_row(
            "SELECT attempt, execution_index FROM workflow_steps WHERE node_id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the step's row reads");
    serde_json::from_value(json!({
        "workflowRunId": harness.scope.run_id, "nodeId": node_id,
        "attempt": attempt, "executionIndex": execution_index,
    }))
    .expect("the step's key reads")
}

/// `kind` reported on the step of `node_id` now, as its driver or the deadline clock would.
async fn report(harness: &Harness, node_id: &str, kind: StepReportKind) {
    let report = StepReport {
        step: step_key(harness, node_id),
        at: WireInstant::now(),
        kind,
    };
    harness
        .reports
        .send(report)
        .await
        .unwrap_or_else(|_| panic!("the loop takes the report"));
}

/// The run cap of 60 s passing, reported on the step of `node_id` as the deadline clock would.
async fn report_run_cap(harness: &Harness, node_id: &str) {
    let limit_ms = SafeInt::new(60_000).expect("a cap");
    report(harness, node_id, StepReportKind::RunCapped { limit_ms }).await;
}

/// The step's completion passing its one item on, as its driver would report it.
fn completed() -> StepReportKind {
    StepReportKind::Settled(StepSettlement::Completed {
        outputs: vec![vec![item(json!({}))]],
        cost: None,
        log_lines: Vec::new(),
        run_variables: BTreeMap::new(),
    })
}

/// The id of the stored event of `event_type`.
fn event_id(harness: &Harness, event_type: &str) -> String {
    harness
        .rows
        .query_row(
            "SELECT id FROM session_events WHERE type = ?1",
            [event_type],
            |row| row.get(0),
        )
        .expect("the event is stored")
}

/// The stored error of the step of `node_id`, as JSON.
fn step_error(harness: &Harness, node_id: &str) -> Value {
    let error_json =
        step_column(&harness.rows, node_id, "error_json").expect("the step keeps its error");
    serde_json::from_str(&error_json).expect("a stored error is JSON")
}

/// The run's status, end and error as its row stores them.
fn run_row(rows: &Connection) -> (String, Option<String>, Option<String>) {
    rows.query_row(
        "SELECT status, finished_at, error_json FROM workflow_runs",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("the run's row reads")
}

/// Each run event of the log, as its type and payload, in sequence order.
fn run_events(harness: &Harness) -> Vec<(String, Value)> {
    harness
        .events()
        .into_iter()
        .filter(|(_, event_type, _, _)| {
            event_type.starts_with("workflow.run.") || event_type == "workflow.results.posted"
        })
        .map(|(_, event_type, _, payload)| (event_type, payload))
        .collect()
}

/// A run whose steps all succeed reads `succeeded`, ended at the instant of its last event,
/// with one `workflow.run.completed` in that write, its execution context released at that
/// instant and its session's binder told once, and leaves the live set; a chat's run posts its
/// results into its session once, as the write's last event after the ending, and a manual run
/// posts none. Mutations: write nothing for a run whose steps all settled, which leaves it
/// `running`; stamp the end with a fresh clock read; drop the context's release from the run's
/// end, or the binder's notice after it; post outside the ending's write; post for every mode.
#[rstest]
#[case::manual(WorkflowRunMode::Manual, false)]
#[case::chat(WorkflowRunMode::Chat, true)]
#[tokio::test]
async fn a_run_whose_steps_all_succeed_ends_succeeded(
    #[case] mode: WorkflowRunMode,
    #[case] posts_results: bool,
) {
    let mut harness = Harness::new(None).await;
    harness.scope.mode = mode;
    insert_live_execution_context(
        &harness.rows,
        harness.scope.run_id.text().as_str(),
        harness.scope.session_id.text().as_str(),
    );
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.step", 1, None),
            ],
            &[edge("trigger", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| run_row(rows).0 == "succeeded")
        .await;
    tokio::time::sleep(QUIET).await;

    let (_, _, completed_at, _) = harness.event("workflow.step.completed", "A");
    let ending_write: Vec<_> = harness
        .events()
        .into_iter()
        .filter(|(_, _, at, _)| at == &completed_at)
        .map(|(_, event_type, _, _)| event_type)
        .collect();
    let mut expected_tail = vec!["workflow.run.completed".to_owned()];
    if posts_results {
        expected_tail.push("workflow.results.posted".to_owned());
    }
    assert!(
        ending_write.ends_with(&expected_tail),
        "the ending rides A's write: {ending_write:?}"
    );
    assert_eq!(
        execution_context_released_at(&harness.rows, harness.scope.run_id.text().as_str()),
        Some(completed_at.clone())
    );
    assert_eq!(harness.notices.sessions(), vec![harness.scope.session_id]);
    assert_eq!(
        run_row(&harness.rows),
        ("succeeded".to_owned(), Some(completed_at), None)
    );
    let mut expected_run_events = vec![(
        "workflow.run.completed".to_owned(),
        json!({
            "sessionId": harness.scope.session_id,
            "workflowRunId": harness.scope.run_id,
            "definitionId": harness.scope.workflow_id,
            "workflowVersionId": harness.scope.workflow_version_id,
        }),
    )];
    if posts_results {
        expected_run_events.push((
            "workflow.results.posted".to_owned(),
            json!({
                "sessionId": harness.scope.session_id,
                "workflowRunId": harness.scope.run_id,
            }),
        ));
    }
    let ended: Vec<_> = run_events(&harness)
        .into_iter()
        .filter(|(event_type, _)| event_type != "workflow.run.started")
        .collect();
    assert_eq!(ended, expected_run_events);
    assert!(!harness.recorder.has_sequence(harness.scope.run_id));
}

/// `flow.stopError` ends the run `failed` with its error and `outcome: ended`, in the write
/// that cancels its sibling waiting on a reply, whose wait columns empty, and the run leaves
/// the live set though its failed step is still live. Mutations: leave the waiting sibling
/// waiting; end the run only once no step is live, which never happens after a failure.
#[tokio::test]
async fn a_stop_error_ends_the_run_failed_and_cancels_its_waiting_sibling() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("W", "test.ask", 1, None),
                node("S", "test.gatedStop", 2, None),
            ],
            &[edge("trigger", "W", 0), edge("trigger", "S", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("waiting"))
        .await;
    harness.signal.go.notify_one();
    harness.wait_until(|rows| run_row(rows).0 == "failed").await;
    tokio::time::sleep(QUIET).await;

    let (stored_status, finished_at, error_json) = run_row(&harness.rows);
    assert_eq!(stored_status, "failed");
    assert!(finished_at.is_some(), "the ended run has its end");
    let (_, _, _, step_failed) = harness.event("workflow.step.failed", "S");
    let run_error: Value =
        serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
    assert_eq!(run_error, step_failed["error"]);
    assert_eq!(harness.status("W").as_deref(), Some("canceled"));
    for column in [
        "wait_cause",
        "wait_id",
        "wait_started_at",
        "wait_deadline_at",
    ] {
        assert_eq!(step_column(&harness.rows, "W", column), None, "{column}");
    }
    let (canceled, ..) = harness.event("workflow.step.canceled", "W");
    let (failed, ..) = harness.event("workflow.step.failed", "S");
    assert!(canceled > failed, "S's failure write cancels W");
    let ended: Vec<Value> = run_events(&harness)
        .into_iter()
        .filter(|(event_type, _)| event_type == "workflow.run.failed")
        .map(|(_, payload)| payload["outcome"].clone())
        .collect();
    assert_eq!(ended, [json!("ended")]);
    assert!(
        !harness.recorder.has_sequence(harness.scope.run_id),
        "the ended run leaves the live set"
    );
}

/// The run cap reported on B fails A, the run's earliest running step, `timedOut` `runCap`
/// whatever its `onError`, winds B down in one wave on A, and the run ends `failed` with A's
/// error only once A's own cancel settles. Mutations: cap the step the report names; route the
/// cap by `onError`, which passes A's input on; end the run before A settles.
#[tokio::test]
async fn the_run_cap_fails_the_earliest_running_step_and_ends_once_it_settles() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.linger", 1, Some("continue")),
                node("B", "test.wait", 2, None),
            ],
            &[edge("trigger", "A", 0), edge("trigger", "B", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.running.notified())
        .await
        .expect("A runs");
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("running"))
        .await;
    report_run_cap(&harness, "B").await;
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("canceled"))
        .await;
    tokio::time::sleep(QUIET).await;

    assert_eq!(harness.status("A").as_deref(), Some("failed"));
    let capped = step_error(&harness, "A");
    assert_eq!(
        (&capped["code"], &capped["details"]["cause"]),
        (&json!("workflow.step.timedOut"), &json!("runCap"))
    );
    assert_eq!(
        run_row(&harness.rows),
        ("running".to_owned(), None, None),
        "the ending waits for A's own cancel"
    );
    let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "A");
    let (_, _, _, sibling) = harness.event("workflow.phase.failed", "B");
    let (canceled, ..) = harness.event("workflow.step.canceled", "B");
    assert_eq!(sibling["cancellationReason"], json!("siblingFailure"));
    assert!(canceled > wave);

    harness.signal.release.notify_one();
    harness.wait_until(|rows| run_row(rows).0 == "failed").await;

    let (_, finished_at, error_json) = run_row(&harness.rows);
    assert!(finished_at.is_some());
    let run_error: Value =
        serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
    assert_eq!(run_error, capped);
    let waves = harness
        .events()
        .into_iter()
        .filter(|(_, event_type, _, _)| event_type == "workflow.parallelJoin.branchesCanceled")
        .count();
    assert_eq!(waves, 1);
}

/// The run cap on a run parked on F's failure ends it `failed` with the cap's error while F
/// keeps its failed row and its own error. Mutations: write the cap's failure over F's row;
/// put F's error on the run; leave the parked run going.
#[tokio::test]
async fn the_run_cap_ends_a_parked_run_and_keeps_its_failed_steps_error() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
            ],
            &[edge("trigger", "F", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness.signal.go.notify_one();
    harness.wait_until(|rows| run_row(rows).0 == "failed").await;
    let parked_error = step_error(&harness, "F");
    assert_eq!(run_row(&harness.rows).1, None, "the run is parked");

    report_run_cap(&harness, "F").await;
    harness.wait_until(|rows| run_row(rows).1.is_some()).await;

    assert_eq!(harness.status("F").as_deref(), Some("failed"));
    assert_eq!(step_error(&harness, "F"), parked_error);
    let (_, _, error_json) = run_row(&harness.rows);
    let run_error: Value =
        serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
    assert_eq!(
        (&run_error["code"], &run_error["details"]["cause"]),
        (&json!("workflow.step.timedOut"), &json!("runCap"))
    );
    let outcomes: Vec<Value> = run_events(&harness)
        .into_iter()
        .filter(|(event_type, _)| event_type == "workflow.run.failed")
        .map(|(_, payload)| payload["outcome"].clone())
        .collect();
    assert_eq!(outcomes, [json!("parked"), json!("ended")]);
}

/// A person's cancel of a run with A and B running and W waiting on a reply cancels W in its
/// own turn and winds A and B down as one wave on A, the earliest: `canceled` is written, with
/// the person's reason and error on the event and the error on the row, only in the turn the
/// last of them settles, and the reply answers that event's id after that write. Every step
/// reads `runCanceled`. Mutations: write `canceled` in the cancel's own turn while a branch runs;
/// leave W waiting; drop the reason or the error; reply before the write; reply with the id of
/// another event of the write.
#[tokio::test]
async fn a_cancel_winds_the_run_down_and_writes_canceled_with_its_last_branch() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.linger", 1, None),
                node("B", "test.linger", 2, None),
                node("W", "test.ask", 3, None),
            ],
            &[
                edge("trigger", "A", 0),
                edge("trigger", "B", 0),
                edge("trigger", "W", 0),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| {
            ["A", "B"]
                .iter()
                .all(|node_id| step_column(rows, node_id, "status").as_deref() == Some("running"))
                && step_column(rows, "W", "status").as_deref() == Some("waiting")
        })
        .await;
    let mut replied = harness.cancel("Not needed any more").await;
    harness
        .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("canceled"))
        .await;
    // Each release must find its step waiting for it, since a release with none waiting keeps
    // only one.
    tokio::time::sleep(QUIET).await;
    harness.signal.release.notify_one();
    tokio::time::sleep(QUIET).await;

    assert_eq!(run_row(&harness.rows).0, "running", "a branch still runs");
    assert!(
        replied.try_recv().is_err(),
        "the reply waits for the ending"
    );

    harness.signal.release.notify_one();
    harness
        .wait_until(|rows| run_row(rows).0 == "canceled")
        .await;

    let canceled_event_id = timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
        .expect("the cancel is taken");
    let (canceled_sequence, _, _, canceled) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.canceled")
        .expect("the run's cancel is written");
    assert_eq!(
        canceled_event_id.as_str(),
        event_id(&harness, "workflow.run.canceled")
    );
    let error = json!({ "message": "Not needed any more" });
    assert_eq!(canceled["reason"], json!("Not needed any more"));
    assert_eq!(canceled["error"], error);
    let (_, finished_at, error_json) = run_row(&harness.rows);
    assert!(finished_at.is_some());
    let stored: Value =
        serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
    assert_eq!(stored, error);
    let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "A");
    assert!(
        canceled_sequence > wave,
        "the ending rides the wave's write"
    );
    for node_id in ["A", "B", "W"] {
        let (_, _, _, phase_failed) = harness.event("workflow.phase.failed", node_id);
        assert_eq!(
            phase_failed["cancellationReason"],
            json!("runCanceled"),
            "{node_id}"
        );
        assert_eq!(harness.status(node_id).as_deref(), Some("canceled"));
    }
}

/// A cancel reaching a run whose pause takes two points, P's and Q's, both still capturing, waits
/// only for the capture that ends first, then cancels the run while Q's capture still runs, and
/// raises no card for either approval. Mutations: take the cancel while the first capture runs;
/// hold it until the pause's last point ends; raise the abandoned pause's cards.
#[tokio::test]
async fn a_cancel_reaching_a_pausing_run_is_taken_when_its_first_capture_ends() {
    let mut harness = Harness::new(None).await;
    harness.points.set_gate(false);
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("P", "test.wait", 1, None),
                node("Q", "test.wait", 2, None),
            ],
            &[edge("trigger", "P", 0), edge("trigger", "Q", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| {
            ["P", "Q"]
                .iter()
                .all(|node_id| step_column(rows, node_id, "status").as_deref() == Some("running"))
        })
        .await;
    // Both sent with no await between them, so one turn takes the two approvals.
    for node_id in ["P", "Q"] {
        let wait = PersonWait {
            ask: PersonAsk::Approval {
                prompt: ComposedText::new("Ship it?".to_owned()).expect("a prompt"),
            },
            timeout: None,
        };
        let settled = StepSettlement::PersonWait {
            wait,
            admission: None,
            log_lines: Vec::new(),
        };
        report(&harness, node_id, StepReportKind::Settled(settled)).await;
    }
    assert_eq!(
        harness.ordered_calls(2).await.len(),
        2,
        "both points are taken"
    );
    let mut replied = harness.cancel("Stop").await;
    tokio::time::sleep(QUIET).await;

    assert_eq!(harness.status("P").as_deref(), Some("waiting"));
    assert!(
        replied.try_recv().is_err(),
        "the cancel waits for the capture"
    );

    harness.points.end_capture(1);
    harness
        .wait_until(|rows| run_row(rows).0 == "canceled")
        .await;
    timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
        .expect("the cancel is taken");
    harness.points.set_gate(true);
    tokio::time::sleep(QUIET).await;

    for node_id in ["P", "Q"] {
        assert_eq!(harness.status(node_id).as_deref(), Some("canceled"));
    }
    assert_eq!(
        harness.ordered_calls(2).await.len(),
        2,
        "no card is raised for the abandoned pause"
    );
}

/// A cancel of a run parked on F's failure while W waits on a reply ends the run `canceled` in
/// the cancel's own write, W canceled with it, and F keeps its failed row and its own error.
/// Mutations: leave the parked sibling waiting; wait for a turn that never comes; write the
/// cancel over F's row.
#[tokio::test]
async fn a_cancel_ends_a_parked_run_in_its_own_write() {
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
    // W's wait keeps the parked run's row `waiting`.
    harness
        .wait_until(|rows| step_column(rows, "F", "status").as_deref() == Some("failed"))
        .await;
    assert_eq!(run_row(&harness.rows).0, "waiting");
    let parked_error = step_error(&harness, "F");

    let replied = harness.cancel("Not needed any more").await;
    harness
        .wait_until(|rows| run_row(rows).0 == "canceled")
        .await;

    let canceled_event_id = timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
        .expect("the cancel is taken");
    assert_eq!(
        canceled_event_id.as_str(),
        event_id(&harness, "workflow.run.canceled")
    );
    assert_eq!(harness.status("F").as_deref(), Some("failed"));
    assert_eq!(step_error(&harness, "F"), parked_error);
    assert_eq!(harness.status("W").as_deref(), Some("canceled"));
    let (_, _, w_canceled_at, _) = harness.event("workflow.step.canceled", "W");
    let (_, _, run_canceled_at, _) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.canceled")
        .expect("the run's cancel is written");
    assert_eq!(run_canceled_at, w_canceled_at, "one write ends both");
}

/// A cancel that reaches the tick in the batch that starts its run, ahead of the start, is taken:
/// the run ends `canceled` before its trigger ever runs, and nothing is dispatched for it.
/// Mutations: route the cancel in arrival order, which answers it not held; dispatch the steps of
/// a run the turn ended, which panics the tick.
#[tokio::test]
async fn a_cancel_ahead_of_its_runs_start_cancels_the_run_unrun() {
    let mut harness = Harness::new(None).await;
    let (cancel, replied) = harness.cancel_input("Wrong workflow");
    let inbox = harness.inbox.clone();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.step", 1, None),
            ],
            &[edge("trigger", "A", 0)],
            vec![item(json!({}))],
            |_| {
                inbox
                    .try_send(cancel)
                    .unwrap_or_else(|_| panic!("the loop's inbox takes the cancel"));
            },
        )
        .await;
    harness
        .wait_until(|rows| run_row(rows).0 == "canceled")
        .await;

    timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
        .expect("the cancel is taken");
    assert_eq!(harness.status("trigger").as_deref(), Some("canceled"));
    let started = harness
        .events()
        .into_iter()
        .filter(|(_, event_type, _, _)| event_type == "workflow.step.started")
        .count();
    assert_eq!(started, 0, "no step runs");
}

/// A cancel taken in the turn whose report settles the run's last step is refused as for an
/// ended run, and the run ends `succeeded`. Mutations: write `canceled` for a run whose steps
/// all succeeded.
#[tokio::test]
async fn a_cancel_in_the_turn_the_last_step_settles_leaves_the_run_succeeded() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.wait", 1, None),
            ],
            &[edge("trigger", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("running"))
        .await;
    // Both sent with no await between them, so one turn takes the completion and the cancel.
    report(&harness, "A", completed()).await;
    let replied = harness.cancel("Too late").await;
    harness.wait_until(|rows| run_row(rows).1.is_some()).await;

    let answer = timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply");
    assert_eq!(answer, Err(RunCancelRefusal::Ending));
    assert_eq!(run_row(&harness.rows).0, "succeeded");
}

/// The run cap reported in the turn whose report settles the run's last live step, its next one
/// only readied, ends the run `failed` on the cap and cancels that readied step unrun. Mutations:
/// expect a live step to cut, which panics the tick; leave the readied step to run.
#[tokio::test]
async fn the_run_cap_with_no_live_step_cancels_what_the_turn_readied() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.wait", 1, None),
                node("B", "test.step", 2, None),
            ],
            &[edge("trigger", "A", 0), edge("A", "B", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("running"))
        .await;
    // Both sent with no await between them, so one turn takes the completion and the cap.
    report(&harness, "A", completed()).await;
    report_run_cap(&harness, "A").await;
    harness.wait_until(|rows| run_row(rows).0 == "failed").await;

    assert_eq!(harness.status("A").as_deref(), Some("succeeded"));
    assert_eq!(harness.status("B").as_deref(), Some("canceled"));
    let (_, finished_at, error_json) = run_row(&harness.rows);
    assert!(finished_at.is_some());
    let run_error: Value =
        serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
    assert_eq!(
        (&run_error["code"], &run_error["details"]["cause"]),
        (&json!("workflow.step.timedOut"), &json!("runCap"))
    );
}

/// A cancel of a run waiting only on W's reply ends it `canceled` in the cancel's own write,
/// asking no one again, and tells the session's binder. Mutations: hold the cancel for a turn W
/// never reports; ask W's question again; drop the binder's notice after the cancel.
#[tokio::test]
async fn a_cancel_of_a_run_waiting_on_a_person_ends_it_asking_no_one() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("W", "test.ask", 1, None),
            ],
            &[edge("trigger", "W", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("waiting"))
        .await;
    let asked = harness.ordered_calls(1).await.len();

    let replied = harness.cancel("Not needed any more").await;
    timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
        .expect("the cancel is taken");
    harness.wait_for_earlier_turns().await;

    assert_eq!(run_row(&harness.rows).0, "canceled");
    assert_eq!(harness.status("W").as_deref(), Some("canceled"));
    assert_eq!(harness.ordered_calls(asked).await.len(), asked);
    assert_eq!(harness.notices.sessions().len(), 1);
}

/// A cancel of a run parked on F's failure with nothing waiting beside it, its row `failed` and
/// unfinished, ends it `canceled` with F's failed row kept. Mutations: refuse a parked run as
/// ended; write the cancel over F's row.
#[tokio::test]
async fn a_cancel_ends_a_run_parked_on_its_failure_alone() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
            ],
            &[edge("trigger", "F", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| run_row(rows) == ("failed".to_owned(), None, None))
        .await;

    let replied = harness.cancel("Not needed any more").await;
    timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the loop keeps the reply")
        .expect("the cancel is taken");
    harness.wait_for_earlier_turns().await;

    assert_eq!(run_row(&harness.rows).0, "canceled");
    assert_eq!(harness.status("F").as_deref(), Some("failed"));
}

/// How the test's approval wait ends.
#[derive(Clone, Copy, Debug)]
enum ApprovalWaitEnding {
    /// A person's cancel of its run.
    Canceled,
    /// An approval of its card.
    Answered,
}

/// A cancel of a run waiting on an approval withdraws the wait's card once, after the write that
/// ends the wait commits, its intent and outcome recorded; an answered approval withdraws none.
/// Kills: the withdraw not queued in `report_settlement`; the withdraw made before the write; an
/// answer's settlement queuing one.
#[rstest]
#[case::canceled(ApprovalWaitEnding::Canceled)]
#[case::answered(ApprovalWaitEnding::Answered)]
#[tokio::test]
async fn an_approval_wait_ended_unanswered_withdraws_its_card_after_its_write(
    #[case] ending: ApprovalWaitEnding,
) {
    let mut harness = Harness::new(None).await;
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
        .wait_until(|rows| step_column(rows, "approve", "status").as_deref() == Some("waiting"))
        .await;
    harness.wait_for_earlier_turns().await;
    let wait_id = harness.wait_id("approve");

    let expected = match ending {
        ApprovalWaitEnding::Canceled => {
            let replied = harness.cancel("Not needed any more").await;
            timeout(WAIT, replied)
                .await
                .expect("the loop replies in time")
                .expect("the loop keeps the reply")
                .expect("the cancel is taken");
            vec![WithdrawnCard {
                wait_id,
                is_wait_stored: false,
            }]
        }
        ApprovalWaitEnding::Answered => {
            let run_id = harness.scope.run_id.text().as_str().to_owned();
            let decision = ApprovalDecision::Approved;
            let gate = gate_answer(&run_id, 1, WorkflowGateKind::HumanApproval, decision);
            let answer = PersonWaitAnswer::Approval(decision);
            assert_eq!(
                harness.answer(wait_id, answer, Some(gate)).await,
                Ok(Ok(()))
            );
            Vec::new()
        }
    };
    harness.wait_for_earlier_turns().await;

    assert_eq!(harness.asks.withdrawn(), expected);
    let intents = harness.record_lines("withdrawingCard");
    assert_eq!(intents.len(), expected.len());
    for intent in &intents {
        assert_eq!(intent["waitId"], json!(wait_id));
        let outcomes: Vec<Value> = harness
            .records
            .lines()
            .into_iter()
            .filter(|line| {
                line["phase"] == json!("outcome") && line["intentSequence"] == intent["sequence"]
            })
            .map(|line| line["record"].clone())
            .collect();
        assert_eq!(outcomes, [json!("done")]);
    }
}
