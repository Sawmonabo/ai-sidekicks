//! A form's or a reply's wait marks its session question settled in the write that ends the
//! wait, once, with how it ended; an approval's wait, which rides its card, marks none.

use std::time::{Duration, SystemTime};

use rstest::rstest;
use serde_json::{Map, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::time::timeout;

use super::harness::{Harness, WAIT, edge, item, node, step_column};
use crate::engine::tick::{StepReport, StepReportKind};
use crate::engine::waits::PersonWaitAnswer;
use crate::engine::waits::answers::EngineAnswers;
use crate::runs::gate_resolution::tests::gate_answer;
use crate::test_rows::{TEST_NODE_ID, assert_rebuild_rewrites_run_rows};

/// How the case's wait ends.
#[derive(Clone, Copy, Debug)]
enum WaitEnding {
    /// A form's answer through the engine's answers.
    FormAnswered,
    /// A reply whose own deadline passes.
    ReplyTimedOut,
    /// A reply waiting when the person cancels its run.
    ReplyCanceled,
    /// A reply the run cap cuts.
    ReplyCapped,
    /// An approval's answer.
    ApprovalAnswered,
}

/// The key of the step of `node_id`, as its row stores it.
fn stored_step(harness: &Harness, node_id: &str) -> WorkflowStepKey {
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

/// Each ending writes exactly one `question.wait.settled` naming its wait, with its outcome, at
/// the instant of the event that ends the wait and after it; an approval writes none. A rebuild of
/// the run's rows from the log writes them byte-identical, the answered approval's run, which its
/// gate answer keeps through the clear, written over. Kills: the mark left out of an answer's or a
/// settlement's write; a deadline read as ended or the run cap read as timed out; the mark written
/// twice, or for an approval; a step arm of the fold dropped or writing other columns, its wait id
/// left unset or its pool wait miscounted (the rebuilt rows differ or a resume is refused); the
/// clear removing a run a gate answer names (its foreign key refuses the rebuild).
#[rstest]
#[case::form_answered(WaitEnding::FormAnswered)]
#[case::reply_timed_out(WaitEnding::ReplyTimedOut)]
#[case::reply_canceled(WaitEnding::ReplyCanceled)]
#[case::reply_capped(WaitEnding::ReplyCapped)]
#[case::approval_answered(WaitEnding::ApprovalAnswered)]
#[tokio::test]
async fn a_waits_end_marks_its_question_once_in_its_own_write(#[case] ending: WaitEnding) {
    let (node_id, kind) = match ending {
        WaitEnding::FormAnswered => ("W", "test.form"),
        WaitEnding::ReplyTimedOut | WaitEnding::ReplyCanceled | WaitEnding::ReplyCapped => {
            ("W", "test.ask")
        }
        WaitEnding::ApprovalAnswered => (TEST_NODE_ID, "test.approve"),
    };
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node(node_id, kind, 1, None),
            ],
            &[edge("trigger", node_id, 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, node_id, "status").as_deref() == Some("waiting"))
        .await;
    let wait_id = harness.wait_id(node_id);

    let expected = match ending {
        WaitEnding::FormAnswered => {
            let answer = PersonWaitAnswer::Form(Map::from_iter([("ok".to_owned(), json!(1))]));
            EngineAnswers::new(harness.inbox.clone())
                .answer_wait(wait_id, answer)
                .await
                .expect("the form's answer is taken");
            Some(("answered", "workflow.phase.resumed"))
        }
        WaitEnding::ReplyTimedOut => {
            harness
                .clock
                .set_now(SystemTime::now() + Duration::from_secs(121));
            harness
                .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("failed"))
                .await;
            Some(("timedOut", "workflow.step.failed"))
        }
        WaitEnding::ReplyCanceled => {
            let replied = harness.cancel("Not needed any more").await;
            timeout(WAIT, replied)
                .await
                .expect("the loop replies in time")
                .expect("the loop keeps the reply")
                .expect("the cancel is taken");
            Some(("ended", "workflow.step.canceled"))
        }
        WaitEnding::ReplyCapped => {
            let report = StepReport {
                step: stored_step(&harness, "W"),
                at: WireInstant::now(),
                kind: StepReportKind::RunCapped {
                    limit_ms: SafeInt::new(60_000).expect("a cap"),
                },
            };
            harness
                .reports
                .send(report)
                .await
                .unwrap_or_else(|_| panic!("the loop takes the report"));
            harness
                .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("failed"))
                .await;
            Some(("ended", "workflow.step.failed"))
        }
        WaitEnding::ApprovalAnswered => {
            let gate = gate_answer(
                harness.scope.run_id.text().as_str(),
                1,
                WorkflowGateKind::HumanApproval,
                ApprovalDecision::Approved,
            );
            let answered = harness
                .answer(
                    wait_id,
                    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
                    Some(gate),
                )
                .await;
            assert_eq!(answered, Ok(Ok(())));
            None
        }
    };
    harness.wait_for_earlier_turns().await;
    assert_rebuild_rewrites_run_rows(
        &harness.rows,
        harness.scope.session_id.text().as_str(),
        harness.scope.run_id.text().as_str(),
    );

    let marks: Vec<_> = harness
        .events()
        .into_iter()
        .filter(|(_, event_type, _, _)| event_type == "question.wait.settled")
        .collect();
    let Some((outcome, ending_event)) = expected else {
        assert_eq!(marks.len(), 0, "{marks:?}");
        return;
    };
    assert_eq!(marks.len(), 1, "{marks:?}");
    let (sequence, _, occurred_at, payload) = &marks[0];
    assert_eq!(
        (
            &payload["sessionId"],
            &payload["waitId"],
            &payload["outcome"]
        ),
        (
            &json!(harness.scope.session_id),
            &json!(wait_id),
            &json!(outcome)
        )
    );
    let (ending_sequence, _, ending_at, _) = harness.event(ending_event, node_id);
    assert!(*sequence > ending_sequence, "{ending:?}");
    assert_eq!(*occurred_at, ending_at, "{ending:?}");
}
