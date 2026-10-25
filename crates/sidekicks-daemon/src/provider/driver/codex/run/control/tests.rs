//! Run control against the scripted service, on real time under a bound: the session's run engine
//! sits on a real database, whose writer does not run under paused time.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};

use super::CodexRunControl;
use crate::mutex_lock::lock;
use crate::provider::driver::codex::intervention::CodexSteerRunRequest;
use crate::provider::driver::codex::run::routes::CodexRunBinding;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::test_session::{
    TEST_THREAD, TestCodexSession, turn_completed,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::test_registry::{new_message_id, new_run_id};

/// How long a test waits before it counts a hold on the session's task as a deadlock.
const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

/// The test session's run control, with the run `run_id` live on turn `turn-1`.
async fn live_run(session: &mut TestCodexSession) -> (Arc<CodexRunControl>, RunId) {
    let binding_id = session.record_binding().await;
    let run_id = new_run_id();
    let session_id = session.task.record.session_id;
    let run_routes = Arc::clone(&session.task.run_routes);
    run_routes.bind_run_delivery(
        run_id,
        CodexRunBinding {
            session_id,
            binding_id: binding_id.clone(),
            agent_id: session.daemon_turn_bindings.agent_id,
            step_bound: None,
        },
    );
    session.open_epoch(binding_id, run_id);
    session
        .task
        .record
        .add_active_turn("turn-1".to_owned(), run_id);
    run_routes.bind_run(run_id, session_id);
    (Arc::clone(&session.task.run_control), run_id)
}

fn steer(run_id: RunId, message_id: QueueItemId) -> CodexSteerRunRequest {
    CodexSteerRunRequest {
        run_id,
        content: MessageContent::new("also check the tests".to_owned()).expect("the words"),
        skills: Vec::new(),
        attachments: Vec::new(),
        expected_turn_id: None,
        client_idempotency_key: message_id,
    }
}

/// The `userMessage` echo of the steer `message_id` on `turn-1`, as Codex writes it.
fn echo(message_id: QueueItemId) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": "turn-1",
            "item": {
                "type": "userMessage",
                "id": format!("item-{message_id}"),
                "clientId": message_id.to_string(),
                "content": [],
            },
        },
    })
}

// Kills: `cancelled` left empty; `cancelled` read at the interrupt's answer rather than after the
// turn's end, which names the echo that came between the interrupt's send and its answer; a steer
// registered on its reply rather than before its send, which leaves the echo that came first
// untaken; and the interrupt marking nothing before it goes, which writes the steer that came
// after it into the turn being stopped.
#[tokio::test]
async fn an_interrupt_cancels_only_the_steers_codex_dropped_unechoed() {
    let mut session = TestCodexSession::start().await;
    let (control, run_id) = live_run(&mut session).await;
    let [echoed_first, dropped, echoed_after_interrupt, late] = [
        new_message_id(),
        new_message_id(),
        new_message_id(),
        new_message_id(),
    ];
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let (interrupt_sent, interrupt_seen) = tokio::sync::oneshot::channel::<()>();
    let (late_refused, late_seen) = tokio::sync::oneshot::channel::<()>();
    let control_side = async {
        let steered = tokio::join!(
            control.steer_run(steer(run_id, echoed_first)),
            control.steer_run(steer(run_id, dropped)),
            control.steer_run(steer(run_id, echoed_after_interrupt)),
        );
        let interrupt = control.interrupt_run(run_id);
        let late_steer = async {
            interrupt_seen.await.expect("the service saw the interrupt");
            let refused = control.steer_run(steer(run_id, late)).await;
            late_refused
                .send(())
                .expect("the service waits for the late steer");
            refused
        };
        let (cancelled, late_steer) = tokio::join!(interrupt, late_steer);
        (steered, cancelled, late_steer)
    };
    let service_side = async {
        for (message_id, is_echoed_first) in [
            (echoed_first, true),
            (dropped, false),
            (echoed_after_interrupt, false),
        ] {
            let steered = script.next_sent().await;
            assert_eq!(steered["method"], "turn/steer");
            assert_eq!(
                steered["params"]["clientUserMessageId"],
                message_id.to_string()
            );
            if is_echoed_first {
                script.send(&echo(message_id));
            }
            script.answer(&steered, &json!({"turnId": "turn-1"}));
        }
        let interrupt = script.next_sent().await;
        assert_eq!(interrupt["method"], "turn/interrupt");
        interrupt_sent.send(()).expect("the late steer waits");
        late_seen.await.expect("the late steer was answered");
        script.send(&echo(echoed_after_interrupt));
        script.answer(&interrupt, &json!({}));
        let listed = script.next_sent().await;
        assert_eq!(
            listed["method"], "thread/backgroundTerminals/list",
            "nothing but the commands' list follows the interrupt"
        );
        script.answer(&listed, &json!({"data": []}));
        script.send(&turn_completed(TEST_THREAD, "turn-1", "interrupted"));
    };
    let ((steered, cancelled, late_steer), ()) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(task.drive(control_side), service_side) }),
    )
    .await
    .expect("the steers and the interrupt settle");
    for acknowledged in [steered.0, steered.1, steered.2] {
        acknowledged.expect("Codex took each steer's request");
    }
    assert!(
        matches!(late_steer, Err(DriverError::SteerTurnEnded(_))),
        "a steer after the interrupt waits for the next turn: {late_steer:?}"
    );
    assert_eq!(
        cancelled.expect("the interrupt applies"),
        vec![dropped],
        "only the steer Codex dropped unechoed is cancelled"
    );
    assert_eq!(
        *lock(&session.queue.taken),
        vec![echoed_first.to_string(), echoed_after_interrupt.to_string()],
        "each echoed steer is taken once"
    );
}

/// What Codex answers a run's interrupt with, or that the run has no live turn to send it to.
#[derive(Clone, Copy, Debug)]
enum InterruptAnswer {
    NoLiveTurn,
    NoActiveTurn,
    AnotherTurnRunning,
}

// Kills: mapping Codex's refusal of a turn it no longer runs to an error; mapping every `-32600`
// to `Ok`; and a run with no live turn sending an interrupt.
#[rstest]
#[case::no_live_turn(InterruptAnswer::NoLiveTurn)]
#[case::no_active_turn(InterruptAnswer::NoActiveTurn)]
#[case::another_turn_running(InterruptAnswer::AnotherTurnRunning)]
#[tokio::test]
async fn an_interrupt_with_nothing_running_answers_ok(#[case] answer: InterruptAnswer) {
    let mut session = TestCodexSession::start().await;
    let (control, run_id) = live_run(&mut session).await;
    if matches!(answer, InterruptAnswer::NoLiveTurn) {
        session.task.record.remove_active_turn("turn-1");
        session
            .task
            .run_routes
            .retire_turn_route(&mut session.task.record, "turn-1");
    }
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service_side = async {
        let refusal = match answer {
            InterruptAnswer::NoLiveTurn => return,
            InterruptAnswer::NoActiveTurn => {
                // Codex refuses once the turn's end is out, ahead of the refusal.
                script.send(&turn_completed(TEST_THREAD, "turn-1", "completed"));
                "no active turn to interrupt"
            }
            InterruptAnswer::AnotherTurnRunning => {
                "expected active turn id turn-1 but found turn-2"
            }
        };
        let interrupt = script.next_sent().await;
        assert_eq!(interrupt["method"], "turn/interrupt");
        script.send(&json!({
            "jsonrpc": "2.0",
            "id": interrupt["id"],
            "error": {"code": -32600, "message": refusal},
        }));
        if matches!(answer, InterruptAnswer::NoActiveTurn) {
            let listed = script.next_sent().await;
            assert_eq!(listed["method"], "thread/backgroundTerminals/list");
            script.answer(&listed, &json!({"data": []}));
        }
    };
    let (interrupted, ()) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(task.drive(control.interrupt_run(run_id)), service_side) }),
    )
    .await
    .expect("the interrupt is answered");
    match answer {
        InterruptAnswer::NoLiveTurn | InterruptAnswer::NoActiveTurn => {
            assert_eq!(interrupted.expect("nothing is left to stop"), Vec::new());
        }
        InterruptAnswer::AnotherTurnRunning => {
            assert!(
                matches!(interrupted, Err(CodexError::ProviderRequest { .. })),
                "{interrupted:?}"
            );
            assert_eq!(
                session.task.record.active_turn_run("turn-1"),
                Some(run_id),
                "a turn Codex did not stop stays the run's"
            );
        }
    }
    assert!(
        session.scripted.script.sent.try_recv().is_err(),
        "nothing more was sent"
    );
}
