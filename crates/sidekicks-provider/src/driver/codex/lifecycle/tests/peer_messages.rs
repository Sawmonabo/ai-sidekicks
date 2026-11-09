//! A message the daemon hands a live Codex session through the driver: held while a turn runs,
//! steered in at its run's next tool boundary or opening the next turn once the session is idle,
//! and what becomes of each read from the session message readings.

use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_std::mutex_lock::lock;

use super::{LiveCodexSession, TEST_TURN, answer_stopping_request, prompt_hook_completed};
use crate::driver::codex::session::test_fixture::{TEST_THREAD, turn_completed, turn_reply};
use crate::driver::contract::ProviderDriver;
use crate::driver::session_messages::{
    SessionMessageDelivery, SessionMessageKind, SessionMessageSent, SessionMessageTarget,
};
use crate::driver::test_registry::{new_message_id, new_session_id};
use crate::port::session_message_reading_publisher::SessionMessageReading;

/// How long a step of the exchange may take before the test fails.
const PATIENCE: Duration = Duration::from_secs(10);

// Real time under a timeout, since the session's task applies each frame on its own task. Both
// messages reach a busy session, which takes neither until its command ends; the person's
// `userPromptSubmit` hook passes the opening prompt and the first, and blocks the second. Killed
// by a `turn/start` on the busy conversation, by steering at once rather than at the boundary, by
// the steered echo or the hook's refusal told to the run queue (which holds no such message)
// rather than read on the readings port, and by the refusal read without the hook's words.
#[tokio::test]
async fn a_busy_session_takes_held_messages_at_its_next_tool_boundary_and_reads_each() {
    let mut session = LiveCodexSession::start(&[]).await;
    let (first, second) = (new_message_id(), new_message_id());

    for message_id in [first, second] {
        let sent = tokio::time::timeout(
            PATIENCE,
            ProviderDriver::deliver_session_message(
                &session.driver,
                delivery(&session, message_id),
            ),
        )
        .await
        .expect("the delivery settles")
        .expect("the delivery is taken");
        assert_eq!(sent, SessionMessageSent::Sent);
    }
    let script = &mut session.scripted.script;
    assert!(
        script
            .next_sent_within(Duration::from_millis(200))
            .await
            .is_none(),
        "nothing goes to Codex before the boundary"
    );
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "item": {"type": "commandExecution", "id": "call-1", "command": "true",
                "exitCode": 0},
        },
    }));
    let mut steered = Vec::new();
    while steered.len() < 2 {
        let sent = tokio::time::timeout(PATIENCE, script.next_sent())
            .await
            .expect("each held message is steered");
        match sent["method"].as_str() {
            Some("turn/steer") => {
                steered.push(sent["params"]["clientUserMessageId"].clone());
                script.answer(&sent, &json!({"turnId": TEST_TURN}));
            }
            Some("turn/start") => panic!("a busy conversation is never sent a new turn"),
            _ => answer_stopping_request(script, &sent),
        }
    }
    for (handler, status, words) in [
        ("0", "completed", ""),
        ("1", "completed", ""),
        ("0", "completed", ""),
        ("1", "completed", ""),
    ] {
        script.send(&prompt_hook_completed(handler, status, words));
    }
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "item": {"type": "userMessage", "id": "item-1", "clientId": first.to_string(),
                "content": []},
        },
    }));
    script.send(&prompt_hook_completed("0", "completed", ""));
    script.send(&prompt_hook_completed("1", "blocked", "keys stay home"));
    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    let readings = wait_for_readings(&session, 2).await;

    assert_eq!(
        steered,
        [json!(first.to_string()), json!(second.to_string())]
    );
    assert_eq!(
        readings,
        [
            SessionMessageReading::Delivered {
                message_id: first.to_string(),
            },
            SessionMessageReading::Refused {
                message_id: second.to_string(),
                reason: Some("keys stay home".to_owned()),
                drop_reason: None,
            },
        ]
    );
    assert_eq!(*lock(&session.queue.taken), Vec::<String>::new());
    assert_eq!(lock(&session.queue.refused).len(), 0);
}

// Real time under a timeout, as above. A turn that ends with no tool boundary leaves the held
// message to open the session's next turn, framed for an idle conversation, under its own id.
// Killed by a held message dropped at the turn's end, and by its turn's echo read on the run
// queue rather than the readings port.
#[tokio::test]
async fn a_message_held_through_a_turn_opens_the_next_once_the_session_is_idle() {
    let mut session = LiveCodexSession::start(&[]).await;
    session
        .daemon_turn_bindings
        .open_on(session.binding_id.clone());
    let message_id = new_message_id();

    let sent = tokio::time::timeout(
        PATIENCE,
        ProviderDriver::deliver_session_message(&session.driver, delivery(&session, message_id)),
    )
    .await
    .expect("the delivery settles")
    .expect("the delivery is taken");
    let script = &mut session.scripted.script;
    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    let started = loop {
        let sent = tokio::time::timeout(PATIENCE, script.next_sent())
            .await
            .expect("the held message opens a turn");
        match sent["method"].as_str() {
            Some("turn/start") => break sent,
            Some("turn/steer") => panic!("an ended turn is never steered"),
            _ => answer_stopping_request(script, &sent),
        }
    };
    script.answer(&started, &turn_reply("turn-2"));
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": "turn-2",
            "item": {"type": "userMessage", "id": "item-2", "clientId": message_id.to_string(),
                "content": []},
        },
    }));
    let readings = wait_for_readings(&session, 1).await;

    assert_eq!(sent, SessionMessageSent::Sent);
    assert_eq!(
        started["params"]["clientUserMessageId"],
        message_id.to_string()
    );
    assert_eq!(
        readings,
        [SessionMessageReading::Delivered {
            message_id: message_id.to_string(),
        }]
    );
    assert_eq!(*lock(&session.queue.taken), Vec::<String>::new());
}

// A message from another session to the live one, under `message_id`.
fn delivery(session: &LiveCodexSession, message_id: QueueItemId) -> SessionMessageDelivery {
    SessionMessageDelivery {
        target: SessionMessageTarget::Hosted(session.session_id),
        message_id,
        sender_session_id: new_session_id(),
        sender_name: "planner".to_owned(),
        kind: SessionMessageKind::Message {
            body: "Use the new Money type.".to_owned(),
            sender_level: PermissionLevel::Ask,
            hop_chain: Vec::new(),
        },
    }
}

// The session message readings once there are at least `count`.
async fn wait_for_readings(session: &LiveCodexSession, count: usize) -> Vec<SessionMessageReading> {
    loop {
        let readings = lock(&session.queue.readings).clone();
        if readings.len() >= count {
            return readings;
        }
        tokio::time::timeout(PATIENCE, session.queue.changed.notified())
            .await
            .expect("the readings come in time");
    }
}
