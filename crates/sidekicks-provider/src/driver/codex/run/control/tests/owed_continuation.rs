//! A paused run whose turn the daemon's restart cut while it was pausing, continued by the
//! person: its next turn takes up the cut work before the messages that waited for it.

use serde_json::{Value, json};
use sidekicks_contracts::run::queue::MessageText;
use sidekicks_std::mutex_lock::lock;

use super::{DEADLOCK_BOUND, live_run};
use crate::driver::codex::session::establishment::continuation::CODEX_CONTINUATION_TEXT;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession, turn_reply};
use crate::driver::run_control::{ResumeRunParams, WaitingMessage};
use crate::driver::test_registry::new_message_id;

// A continue owed its continuation starts the run's next turn with Codex's continuation words, then
// the waiting message, under that message's id; Codex's echo of the turn's input tells the queue
// nothing and its words, the continuation's among them, reach no row: the person's message reads as
// the queue wrote it. Killed by the flag ignored (the turn holds the message alone), and by the
// echo's words written to the run (the continuation reaches the engine).
#[tokio::test]
async fn a_continue_owed_its_continuation_starts_with_it() {
    let mut session = TestCodexSession::start().await;
    let (control, run_id) = live_run(&mut session).await;
    session.task.record.remove_active_turn("turn-1");
    session
        .task
        .run_routes
        .retire_turn_route(&mut session.task.record, "turn-1");
    let inbound = session.task.record.inbound.clone();
    let message_id = new_message_id();
    let params = ResumeRunParams {
        session_id: session.task.record.session_id,
        run_id,
        messages: vec![WaitingMessage {
            id: message_id,
            content: MessageText::new("carry on".to_owned()).expect("the words"),
            attachments: Vec::new(),
            skills: Vec::new(),
        }],
        is_continuation_owed: true,
    };
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let flow = async {
        task.handle_next().await;
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "turn/start");
        script.answer(&sent, &turn_reply("turn-2"));
        task.handle_next().await;
        sent
    };

    let (continued, sent): (_, Value) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(control.continue_run(&inbound, params), flow) }),
    )
    .await
    .expect("the continue's turn starts");

    continued.expect("the run's next turn starts");
    let input = &sent["params"]["input"];
    assert_eq!(input[0]["text"], CODEX_CONTINUATION_TEXT);
    assert_eq!(input[1]["text"], "carry on");
    assert_eq!(
        sent["params"]["clientUserMessageId"],
        message_id.to_string()
    );

    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": "turn-2",
            "item": {
                "type": "userMessage",
                "id": "item-echo",
                "clientId": message_id.to_string(),
                "content": [
                    { "type": "text", "text": CODEX_CONTINUATION_TEXT, "text_elements": [] },
                    { "type": "text", "text": "carry on", "text_elements": [] },
                ],
            },
        },
    }));
    tokio::time::timeout(DEADLOCK_BOUND, session.task.handle_next())
        .await
        .expect("the echo is handled");

    assert!(
        !lock(&session.queue.taken).contains(&message_id.to_string()),
        "the echo settles again a message the continue's answer settled"
    );
    let engine_calls = format!("{:?}", session.engine.calls());
    assert!(
        !engine_calls.contains(CODEX_CONTINUATION_TEXT),
        "the continuation's words reach no row: {engine_calls}"
    );
}
