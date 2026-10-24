//! What a live session's task applies of what its frames report.

use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{LiveCodexSession, TEST_TURN};
use crate::mutex_lock::lock;
use crate::provider::driver::codex::session::test_session::{TEST_THREAD, turn_completed};

// Real time under a timeout, since the run engine writes the turn's end through the database
// writer. Killed by dropping the `message_refused` call from the session task's turn end, by
// pairing the opening prompt's block with a steer, by refusing a steer Codex echoed, and by
// leaving `hook/completed` out of the methods the daemon reads, which opts it out at the start.
#[tokio::test]
async fn a_steer_the_prompt_hook_blocked_is_refused_with_its_words_and_never_taken() {
    let echoed = QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id");
    let blocked = QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id");
    let session = LiveCodexSession::start(&[echoed, blocked]).await;
    let hook_completed = |words: &str| {
        json!({
            "jsonrpc": "2.0",
            "method": "hook/completed",
            "params": {
                "threadId": TEST_THREAD,
                "turnId": TEST_TURN,
                "run": {
                    "eventName": "userPromptSubmit",
                    "status": "blocked",
                    "entries": [{"text": words}],
                },
            },
        })
    };

    session
        .scripted
        .script
        .send(&hook_completed("the opening is blocked"));
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "item": {
                "type": "userMessage",
                "id": "item-1",
                "clientId": echoed.to_string(),
                "content": [],
            },
        },
    }));
    session
        .scripted
        .script
        .send(&hook_completed("no secrets in prompts"));
    session
        .scripted
        .script
        .send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    while lock(&session.queue.refused).is_empty() {
        tokio::time::timeout(Duration::from_secs(10), session.queue.changed.notified())
            .await
            .expect("the session's task reports the refusal");
    }

    let QueueItemNotDeliveredReason::RefusedByHook { words } =
        lock(&session.queue.refused)[0].1.clone()
    else {
        panic!("the steer is refused by its hook");
    };
    assert_eq!(
        lock(&session.queue.refused)
            .iter()
            .map(|(message_id, _)| message_id.clone())
            .collect::<Vec<_>>(),
        [blocked.to_string()]
    );
    assert_eq!(words.as_str(), "no secrets in prompts");
    assert_eq!(*lock(&session.queue.taken), [echoed.to_string()]);
}

// The daemon declares no dynamic tool, so a tool call Codex sends anyway is refused with the ask's
// refusal, never held. Killed by holding a tool call as an approval or a question is held.
#[tokio::test]
async fn a_dynamic_tool_call_is_refused_as_a_tool_the_daemon_does_not_serve() {
    let mut session = LiveCodexSession::start(&[]).await;

    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": "tool-call-1",
        "method": "item/tool/call",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "callId": "call-1",
            "tool": "lookup",
            "arguments": {},
        },
    }));
    let answer = loop {
        let sent =
            tokio::time::timeout(Duration::from_secs(10), session.scripted.script.next_sent())
                .await
                .expect("the session answers the tool call");
        if sent["id"] == "tool-call-1" {
            break sent;
        }
    };

    let refusal = "The daemon serves no tool for the provider's \"item/tool/call\" request.";
    assert_eq!(
        answer,
        json!({
            "jsonrpc": "2.0",
            "id": "tool-call-1",
            "result": {
                "success": false,
                "contentItems": [{
                    "type": "inputText",
                    "text": refusal,
                }],
            },
        })
    );
}
