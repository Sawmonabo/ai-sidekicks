//! The restart in the tick's loop: a loop stopped mid-run, its runs reloaded from the rows and
//! the log into a new loop, and each step the sweep finds settled, held again or kept waiting.

use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowEdge;
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::time::timeout;

use super::harness::ports::OrderedCall;
use super::harness::{Harness, WAIT, attempt_column, edge, item, node, retried, step_column};
use crate::engine::ports::{AgentStepOutcome, StepPayloadArtifacts as _};
use crate::engine::tick::turns::resuming::tests::resume;
use crate::engine::waits::PersonWaitAnswer;
use crate::runs::gate_resolution::tests::gate_answer;
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

/// A state the daemon's stop cuts a run in, each a row of the restart's table.
#[derive(Clone, Copy, Debug)]
enum Cut {
    /// A person's cancel, its running sibling winding down.
    CanceledWindingDown,
    /// A step running beside a sibling the memory gate holds.
    RunningBesideHeld,
    /// An agent step the memory gate holds, its run made.
    HeldAgent,
    /// An agent step running.
    RunningAgent,
    /// A retry attempt waiting out its wait, nothing else alive.
    RetryWaiting,
    /// A reply whose question the stop lost, its ask failing again.
    ReplyAskFailing,
    /// An approval asked after an earlier one was answered.
    SecondApproval,
    /// A reply whose suspension the log no longer holds.
    LogUnreadable,
}

/// Each state a stop cuts a run in comes back after the restart as its log says, and the rows
/// rebuild from the log. Mutations: the replay's cancel or wave dropped (the run ends crashed, or
/// no `branchesCanceled`); the sweep's crashed failure dropped (`A` stays `running`); the held
/// sibling left out of the park's cancels; a held agent step making a second run; a crashed step's
/// agent run left running; a pending retry crashing its run; a failed ask again kept as a fault
/// (`A` waits forever); the pause count reset at a run leaving its wait (pause 1 taken twice); the
/// card raised without its point; a lost ask panicking.
#[rstest]
#[case::canceled_winding_down(Cut::CanceledWindingDown)]
#[case::running_beside_held(Cut::RunningBesideHeld)]
#[case::held_agent(Cut::HeldAgent)]
#[case::running_agent(Cut::RunningAgent)]
#[case::retry_waiting(Cut::RetryWaiting)]
#[case::reply_ask_failing(Cut::ReplyAskFailing)]
#[case::second_approval(Cut::SecondApproval)]
#[case::log_unreadable(Cut::LogUnreadable)]
#[tokio::test]
async fn a_restart_finishes_what_the_stop_cut(#[case] cut: Cut) {
    let mut harness = Harness::new(None).await;
    cut_run(&mut harness, cut).await;
    harness.restart().await;
    match cut {
        Cut::CanceledWindingDown => {
            harness
                .wait_until(|rows| run_status(rows) == "canceled")
                .await;
            let canceled = step_events(&harness, "workflow.step.canceled", "A");
            assert_eq!(canceled.len(), 1);
            assert_eq!(canceled[0]["cancellationReason"], json!("runCanceled"));
            let waves = step_events_in(&harness.rows, "workflow.parallelJoin.branchesCanceled");
            assert_eq!(waves.len(), 1, "the cancel's wave closes once");
            assert!(
                step_events_in(&harness.rows, "workflow.run.crashed").is_empty(),
                "a canceled run never crashes"
            );
        }
        Cut::RunningBesideHeld => {
            harness
                .wait_until(|rows| {
                    attempt_column(rows, "B", 1, "status").as_deref() == Some("canceled")
                })
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
                .wait_until(|rows| {
                    attempt_column(rows, "B", 2, "status").as_deref() == Some("running")
                })
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
        }
        Cut::HeldAgent => {
            harness
                .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("running"))
                .await;
            let holds = step_events(&harness, "workflow.phase.waitingOnMemory", "A");
            assert_eq!(holds.len(), 2, "the restart opens a hold of its own");
            assert_ne!(holds[0]["waitingSinceSeq"], holds[1]["waitingSinceSeq"]);
            assert!(
                harness.agents.requests().is_empty(),
                "the held step takes back the run it made"
            );
            harness.agents.end(AgentStepOutcome::Completed {
                items: vec![item(json!({}))],
                cost: None,
            });
            harness
                .wait_until(|rows| run_status(rows) == "succeeded")
                .await;
        }
        Cut::RunningAgent => {
            timeout(WAIT, harness.agents.wait_for_cancel())
                .await
                .expect("the crashed step's agent run is stopped");
            harness
                .wait_until(|rows| run_status(rows) == "failed")
                .await;
            let failed = step_events(&harness, "workflow.step.failed", "A");
            assert_eq!(failed[0]["error"]["code"], json!("workflow.step.crashed"));
            assert!(
                harness.agents.requests().is_empty(),
                "the crashed step's agent run is stopped, not run again"
            );
        }
        Cut::RetryWaiting => {
            harness
                .wait_until(|rows| run_status(rows) == "succeeded")
                .await;
            assert_eq!(
                attempt_column(&harness.rows, "A", 2, "status").as_deref(),
                Some("succeeded")
            );
            assert!(
                step_events_in(&harness.rows, "workflow.run.crashed").is_empty(),
                "a run waiting out a retry goes on"
            );
        }
        Cut::ReplyAskFailing => {
            harness
                .wait_until(|rows| {
                    attempt_column(rows, "A", 1, "status").as_deref() == Some("failed")
                })
                .await;
            assert_eq!(run_status(&harness.rows), "failed");
        }
        Cut::SecondApproval => {
            let q_wait = harness.wait_id("Q");
            let is_q_card = |call: &OrderedCall| match call {
                OrderedCall::Ask { kind, wait_id } => *kind == "approval" && *wait_id == q_wait,
                OrderedCall::Point(_) => false,
            };
            let mut calls = Vec::new();
            while calls.iter().filter(|call| is_q_card(call)).count() < 2 {
                calls = harness.ordered_calls(calls.len() + 1).await;
            }
            let pauses: Vec<u64> = calls
                .iter()
                .filter_map(|call| match call {
                    OrderedCall::Point(request) => match &request.point {
                        WorkflowRunSnapshotPoint::Pause { pause_number, .. } => {
                            Some(pause_number.0.get())
                        }
                        WorkflowRunSnapshotPoint::Start { .. }
                        | WorkflowRunSnapshotPoint::End { .. } => None,
                    },
                    OrderedCall::Ask { .. } => None,
                })
                .collect();
            assert_eq!(pauses, [1, 2, 2], "the restart takes Q's own pause again");
            let last_point = calls
                .iter()
                .rposition(|call| matches!(call, OrderedCall::Point(_)));
            let last_card = calls.iter().rposition(is_q_card);
            assert!(last_point < last_card, "the card is raised after its point");
        }
        Cut::LogUnreadable => {
            harness
                .wait_until(|rows| run_status(rows) == "crashed")
                .await;
            assert_eq!(harness.status("A").as_deref(), Some("canceled"));
            let crashed = step_events_in(&harness.rows, "workflow.run.crashed");
            assert!(
                crashed[0].contains("no wait or no ask"),
                "the crash names its cause"
            );
            return;
        }
    }
    assert_rebuilds(&harness).await;
}

/// Starts a run of `harness` and leaves it as `cut` says, for the restart to cut off.
async fn cut_run(harness: &mut Harness, cut: Cut) {
    let only = |kind: &str| vec![node("T", "test.trigger", 0, None), node("A", kind, 1, None)];
    let (nodes, edges, input) = match cut {
        Cut::CanceledWindingDown => (
            vec![
                node("T", "test.trigger", 0, None),
                node("A", "test.linger", 1, None),
                node("B", "test.step", 2, None),
            ],
            vec![edge("T", "A", 0), edge("A", "B", 0)],
            json!({}),
        ),
        Cut::RunningBesideHeld => {
            harness.agents.hold();
            (
                vec![
                    node("T", "test.trigger", 0, None),
                    node("A", "test.hangsFirst", 1, None),
                    node("B", "test.agent", 2, None),
                ],
                vec![edge("T", "A", 0), edge("T", "B", 0)],
                json!({ "hang": true }),
            )
        }
        Cut::HeldAgent => {
            harness.agents.hold();
            (only("test.agent"), vec![edge("T", "A", 0)], json!({}))
        }
        Cut::RunningAgent => (only("test.agent"), vec![edge("T", "A", 0)], json!({})),
        Cut::RetryWaiting => (
            vec![
                node("T", "test.trigger", 0, None),
                retried(node("A", "test.flaky", 1, None), 2, 2_000),
            ],
            vec![edge("T", "A", 0)],
            json!({}),
        ),
        Cut::ReplyAskFailing | Cut::LogUnreadable => {
            (only("test.ask"), vec![edge("T", "A", 0)], json!({}))
        }
        Cut::SecondApproval => (
            vec![
                node("T", "test.trigger", 0, None),
                node("P", "test.approve", 1, None),
                node("Q", "test.approve", 2, None),
            ],
            vec![edge("T", "P", 0), edge("P", "Q", 0)],
            json!({}),
        ),
    };
    harness
        .start(nodes, &edges, vec![item(input)], |_| {})
        .await;
    match cut {
        Cut::CanceledWindingDown => {
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
        }
        Cut::RunningBesideHeld => {
            harness
                .wait_until(|rows| {
                    step_column(rows, "A", "status").as_deref() == Some("running")
                        && step_column(rows, "B", "status").as_deref() == Some("waitingMemory")
                })
                .await;
        }
        Cut::HeldAgent => {
            harness
                .wait_until(|rows| {
                    step_column(rows, "A", "status").as_deref() == Some("waitingMemory")
                })
                .await;
        }
        Cut::RunningAgent => {
            harness
                .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("running"))
                .await;
        }
        Cut::RetryWaiting => {
            harness
                .wait_until(|rows| {
                    attempt_column(rows, "A", 2, "status").as_deref() == Some("pending")
                })
                .await;
        }
        Cut::ReplyAskFailing | Cut::LogUnreadable => {
            harness
                .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waiting"))
                .await;
            harness.wait_for_earlier_turns().await;
            if matches!(cut, Cut::ReplyAskFailing) {
                harness.asks.forget_questions();
                harness.asks.refuse_every_call();
            } else {
                harness
                    .rows
                    .execute(
                        "DELETE FROM session_events WHERE type = 'workflow.phase.suspended'",
                        [],
                    )
                    .expect("the test drops the wait's suspension");
            }
        }
        Cut::SecondApproval => {
            harness
                .wait_until(|rows| step_column(rows, "P", "status").as_deref() == Some("waiting"))
                .await;
            let gate = gate_answer(
                harness.scope.run_id.text().as_str(),
                1,
                WorkflowGateKind::HumanApproval,
                ApprovalDecision::Approved,
            );
            let answer = PersonWaitAnswer::Approval(ApprovalDecision::Approved);
            let answered = harness
                .answer(harness.wait_id("P"), answer, Some(gate))
                .await;
            assert_eq!(answered.expect("the loop answers"), Ok(()));
            harness
                .wait_until(|rows| step_column(rows, "Q", "status").as_deref() == Some("waiting"))
                .await;
            harness.wait_for_earlier_turns().await;
        }
    }
}

/// The restart's sweep deletes a copy a start the stop cut left in the session, and leaves the
/// artifact of a value a deleted run kept, which only the kept value names. Mutations: the kept
/// values left out of the sweep's read (the kept artifact is deleted); the sweep dropped (the copy
/// stays).
#[tokio::test]
async fn the_payload_sweep_keeps_kept_values_and_deletes_cut_copies() {
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
    let copy = harness
        .payloads
        .write(harness.scope.session_id, &cut_step, b"[]".to_vec(), 0)
        .await
        .expect("the cut start's copy is stored");

    harness.restart().await;
    let deletes = harness.payloads.deletes();
    assert!(deletes.contains(&copy), "the cut start's copy is deleted");
    assert!(!deletes.contains(&kept), "the kept value's artifact stays");
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

/// A run whose version no longer reads at the restart ends crashed, its waiting step canceled on a
/// `workflow.step.canceled` of its own, so a rebuild from the log writes the rows the ending wrote.
/// Mutations: the unrunnable ending's cancel written without its event (no `workflow.step.canceled`
/// and the rebuilt step differs); the cancel of the run's steps dropped (`A` stays `waiting`).
#[tokio::test]
async fn an_unrunnable_run_cancels_its_steps_on_their_own_events() {
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
    harness
        .rows
        .execute("UPDATE workflow_versions SET definition_body = '{}'", [])
        .expect("the test breaks the run's version");

    harness.restart().await;
    harness
        .wait_until(|rows| run_status(rows) == "crashed")
        .await;
    assert_eq!(harness.status("A").as_deref(), Some("canceled"));
    assert_eq!(
        step_events(&harness, "workflow.step.canceled", "A").len(),
        1
    );
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
