//! An approval pause's snapshot point, taken before its card, and what a pausing run holds until
//! its point ends.

use std::time::{Duration, SystemTime};

use serde_json::json;
use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::{WorkflowRunEpoch, WorkflowRunPauseNumber};

use super::{approval, outcomes_of, stored_deadline, wall_instant};
use crate::engine::ports::WorkflowRunSnapshotPointRequest;
use crate::engine::tick::turns::tests::harness::ports::OrderedCall;
use crate::engine::tick::turns::tests::harness::{
    Harness, QUIET, attempt_column, edge, item, node, retried, step_column,
};
use crate::engine::waits::PersonWaitAnswer;

/// The order log's line for pause `pause_number` of the first execution of the run of `harness`.
fn pause_point(harness: &Harness, pause_number: u64) -> OrderedCall {
    OrderedCall::Point(WorkflowRunSnapshotPointRequest {
        session_id: harness.scope.session_id,
        workflow_run_id: harness.scope.run_id,
        point: WorkflowRunSnapshotPoint::Pause {
            epoch: WorkflowRunEpoch(SafeInt::ZERO),
            pause_number: WorkflowRunPauseNumber(
                SafeInt::new(pause_number).expect("the test's pause number"),
            ),
        },
    })
}

/// The order log's line for the card raised for `wait_id`.
fn card(wait_id: UuidTextForm) -> OrderedCall {
    OrderedCall::Ask {
        kind: "approval",
        wait_id,
    }
}

/// Each approval pause takes its point, counted from 1, before its card is raised. Kills: the
/// card raised in `ask_people` before the capture is spawned; the pause count not moved, so the
/// second pause takes `pause-1` again.
#[tokio::test]
async fn each_approval_pause_takes_its_point_before_its_card() {
    let harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("approve", "test.approve", 1, None),
                node("second", "test.approve", 2, None),
            ],
            &[edge("trigger", "approve", 0), edge("approve", "second", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    let calls = harness.ordered_calls(2).await;
    let first_wait = harness.wait_id("approve");
    assert_eq!(calls, [pause_point(&harness, 1), card(first_wait)]);

    let (answer, gate) = approval(&harness, 1);
    assert_eq!(harness.answer(first_wait, answer, gate).await, Ok(Ok(())));
    let calls = harness.ordered_calls(4).await;
    let second_wait = harness.wait_id("second");
    assert_eq!(calls[2..], [pause_point(&harness, 2), card(second_wait)]);
}

/// A capture held at its gate holds only its own run's card: another run's step completes and
/// its next step's row is written meanwhile, and the card is raised once the capture ends.
/// Kills: the tick awaiting the capture, so the other run's write never lands; the card raised
/// as soon as the capture is spawned.
#[tokio::test]
async fn a_held_capture_holds_only_its_runs_card() {
    const OTHER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70";
    let mut harness = Harness::new(None).await;
    harness.points.set_gate(false);
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
    let (point, wait_id) = (pause_point(&harness, 1), harness.wait_id("approve"));

    harness.scope.run_id = WorkflowRunId::new(OTHER_RUN_ID).expect("the test's run id");
    harness
        .start(
            vec![
                node("other", "test.trigger", 0, None),
                node("B", "test.step", 1, None),
                node("C", "test.step", 2, None),
            ],
            &[edge("other", "B", 0), edge("B", "C", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "C", "status").as_deref() == Some("succeeded"))
        .await;
    harness.wait_for_earlier_turns().await;
    assert_eq!(
        harness.ordered_calls(1).await,
        std::slice::from_ref(&point),
        "the card waits for its capture"
    );

    harness.points.set_gate(true);
    assert_eq!(harness.ordered_calls(2).await, [point, card(wait_id)]);
}

/// A capture that fails still raises its card, after the point, and its step still waits.
/// Kills: a failed capture dropping its ask, so no card is raised; a failed capture failing its
/// step.
#[tokio::test]
async fn a_failed_capture_still_raises_its_card() {
    let harness = Harness::new(None).await;
    harness.points.refuse_every_capture();
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
    let calls = harness.ordered_calls(2).await;
    assert_eq!(
        calls,
        [pause_point(&harness, 1), card(harness.wait_id("approve"))]
    );
    harness.wait_for_earlier_turns().await;
    assert_eq!(harness.status("approve").as_deref(), Some("waiting"));
    let intents = harness.record_lines("raisingCard");
    assert_eq!(intents.len(), 1);
    assert_eq!(outcomes_of(&harness, &intents[0]), [json!("done")]);
}

/// A form wait and a reply wait open their questions and take no snapshot point. Kills: a point
/// taken for every person wait.
#[tokio::test]
async fn a_form_or_reply_wait_takes_no_point() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("Q", "test.ask", 1, None),
                node("F", "test.form", 2, None),
            ],
            &[edge("trigger", "Q", 0), edge("trigger", "F", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| {
            ["Q", "F"]
                .iter()
                .all(|node_id| step_column(rows, node_id, "status").as_deref() == Some("waiting"))
        })
        .await;
    harness.wait_for_earlier_turns().await;

    let calls = harness.ordered_calls(2).await;
    assert_eq!(calls.len(), 2, "{calls:?}");
    for (node_id, kind) in [("Q", "reply"), ("F", "form")] {
        let wait_id = harness.wait_id(node_id);
        assert!(
            calls.contains(&OrderedCall::Ask { kind, wait_id }),
            "{node_id}"
        );
    }
}

/// A pausing run writes nothing while its point is pending: an answer, a step's report and a
/// retry come due wait on the run, and the turn the point's end opens takes the answer, writes
/// the report, dispatches the retry and raises the card after its write. Kills: answers, reports
/// or due retries not held (the window's asserts); a held answer refused or dropped (the
/// answer's value); held reports dropped (`N` never runs); held due retries dropped (`F`'s
/// attempt 2 stays `pending`); a held answer replied before its write (`Q` not yet
/// `succeeded`); the card raised before the opening turn's write (`Q` still `waiting` at the
/// card's call); the hold putting the run in its batch on every held turn (the loop never yields
/// on the test's single-thread runtime, so the test never ends).
#[tokio::test]
async fn a_pausing_run_takes_what_reached_it_once_its_point_ends() {
    // F's retry timer starts at its first failure, before `go`, so it outlasts the waits up to
    // P's point on a loaded machine.
    const RETRY_WAIT_MS: u64 = 3_000;
    let mut harness = Harness::new(None).await;
    harness.points.set_gate(false);
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("Q", "test.ask", 1, None),
                retried(node("F", "test.flaky", 2, None), 2, RETRY_WAIT_MS),
                node("L", "test.large", 3, None),
                node("N", "test.step", 4, None),
                node("G", "test.gated", 5, None),
                node("P", "test.approve", 6, None),
            ],
            &[
                edge("trigger", "Q", 0),
                edge("trigger", "F", 0),
                edge("trigger", "L", 0),
                edge("L", "N", 0),
                edge("trigger", "G", 0),
                edge("G", "P", 0),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| {
            step_column(rows, "Q", "status").as_deref() == Some("waiting")
                && ["L", "G"].iter().all(|node_id| {
                    step_column(rows, node_id, "status").as_deref() == Some("running")
                })
                && attempt_column(rows, "F", 2, "status").as_deref() == Some("pending")
        })
        .await;
    harness.wait_for_earlier_turns().await;
    let q_wait = harness.wait_id("Q");

    harness.signal.go.notify_one();
    assert_eq!(
        harness.ordered_calls(2).await,
        [
            OrderedCall::Ask {
                kind: "reply",
                wait_id: q_wait,
            },
            pause_point(&harness, 1),
        ]
    );
    assert_eq!(
        attempt_column(&harness.rows, "F", 2, "status").as_deref(),
        Some("pending"),
        "F's retry came due before the pause began"
    );
    harness.signal.release.notify_one();

    let reply = PersonWaitAnswer::Reply(NonEmptyText::new("Ship it".to_owned()).expect("a reply"));
    let (answered, ()) = tokio::join!(harness.answer(q_wait, reply, None), async {
        tokio::time::sleep(Duration::from_millis(RETRY_WAIT_MS) + QUIET).await;
        assert_eq!(harness.status("Q").as_deref(), Some("waiting"));
        assert_eq!(harness.status("L").as_deref(), Some("running"));
        assert_eq!(harness.status("N"), None);
        assert_eq!(
            attempt_column(&harness.rows, "F", 2, "status").as_deref(),
            Some("pending")
        );
        harness.points.set_gate(true);
    });

    assert_eq!(answered, Ok(Ok(())));
    assert_eq!(harness.status("Q").as_deref(), Some("succeeded"));
    let p_wait = harness.wait_id("P");
    assert_eq!(harness.ordered_calls(3).await[2], card(p_wait));
    let card_call = harness
        .asks
        .calls()
        .into_iter()
        .find(|call| call.wait_id == p_wait)
        .expect("P's card is raised");
    assert!(
        card_call
            .run_statuses
            .contains(&("Q".to_owned(), "succeeded".to_owned())),
        "the card is raised after the opening turn's write: {:?}",
        card_call.run_statuses
    );
    harness
        .wait_until(|rows| {
            step_column(rows, "N", "status").as_deref() == Some("succeeded")
                && attempt_column(rows, "F", 2, "status").as_deref() == Some("succeeded")
        })
        .await;
}

/// A pausing run's answer and its deadline both wait for its point, and the turn the point's end
/// opens takes the answer first: an answer that came before its wait's deadline still wins.
/// Kills: the deadline's report not held (`P` reads `failed` in the window); held reports
/// replayed before held answers, so the deadline settles the wait and the answer is refused (the
/// answer's value and `P`'s status).
#[tokio::test]
async fn a_held_answer_wins_over_its_held_deadline() {
    let mut harness = Harness::new(None).await;
    harness.points.set_gate(false);
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("G", "test.gated", 1, None),
                node("P", "test.approve", 2, None),
            ],
            &[edge("trigger", "G", 0), edge("G", "P", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "G", "status").as_deref() == Some("running"))
        .await;
    harness.wait_for_earlier_turns().await;
    harness.signal.go.notify_one();
    assert_eq!(harness.ordered_calls(1).await, [pause_point(&harness, 1)]);
    harness.wait_for_earlier_turns().await;
    assert_eq!(
        harness.armed(),
        Some(wall_instant(&stored_deadline(&harness, "P")))
    );

    let p_wait = harness.wait_id("P");
    let (answer, gate) = approval(&harness, 1);
    let (answered, ()) = tokio::join!(harness.answer(p_wait, answer, gate), async {
        tokio::time::sleep(QUIET).await;
        harness
            .clock
            .set_now(SystemTime::now() + Duration::from_secs(61));
        tokio::time::sleep(QUIET).await;
        assert_eq!(harness.status("P").as_deref(), Some("waiting"));
        harness.points.set_gate(true);
    });

    assert_eq!(answered, Ok(Ok(())));
    assert_eq!(harness.status("P").as_deref(), Some("succeeded"));
}
