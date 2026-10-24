//! What a live session's task applies of what its frames report.

use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{LiveCodexSession, TEST_TURN};
use crate::mutex_lock::lock;
use crate::provider::driver::codex::session::test_session::{TEST_THREAD, turn_completed};

// Real time under a timeout, since the run engine writes the turn's end through the database
// writer. Two handlers run on each prompt: the opening prompt's second blocks, the first steer
// passes and is echoed, the second steer is blocked by both, the third is stopped by its second.
// Killed by dropping the `message_refused` call from the session task's turn end, by pairing the
// opening prompt's refusal with a steer, by refusing a steer Codex echoed, by leaving
// `hook/completed` out of the methods the daemon reads, which opts it out at the start, by
// starting a new prompt at every hook run (the second steer's two refusals would count as two
// prompts), and by not counting a `stopped` run as a refusal (the third steer would pair with the
// second's words).
#[tokio::test]
async fn the_steers_a_prompt_hook_refused_are_refused_with_its_words_and_never_taken() {
    let new_id = || QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id");
    let (echoed, blocked, stopped) = (new_id(), new_id(), new_id());
    let session = LiveCodexSession::start(&[echoed, blocked, stopped]).await;
    let hook_completed = |handler: &str, status: &str, words: &str| {
        json!({
            "jsonrpc": "2.0",
            "method": "hook/completed",
            "params": {
                "threadId": TEST_THREAD,
                "turnId": TEST_TURN,
                "run": {
                    "id": format!("user-prompt-submit:{handler}:/hooks.json"),
                    "eventName": "userPromptSubmit",
                    "status": status,
                    "entries": if words.is_empty() { json!([]) } else { json!([{"text": words}]) },
                },
            },
        })
    };
    let script = &session.scripted.script;

    script.send(&hook_completed("0", "completed", ""));
    script.send(&hook_completed("1", "blocked", "the opening is blocked"));
    script.send(&hook_completed("0", "completed", ""));
    script.send(&hook_completed("1", "completed", ""));
    script.send(&json!({
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
    script.send(&hook_completed("0", "blocked", "no secrets in prompts"));
    script.send(&hook_completed("1", "blocked", "keys stay home"));
    script.send(&hook_completed("0", "completed", ""));
    script.send(&hook_completed("1", "stopped", "stop here"));
    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    while lock(&session.queue.refused).len() < 2 {
        tokio::time::timeout(Duration::from_secs(10), session.queue.changed.notified())
            .await
            .expect("the session's task reports the refusals");
    }

    let refused: Vec<(String, String)> = lock(&session.queue.refused)
        .iter()
        .map(|(message_id, reason)| {
            let QueueItemNotDeliveredReason::RefusedByHook { words } = reason else {
                panic!("each steer is refused by its hook");
            };
            (message_id.clone(), words.as_str().to_owned())
        })
        .collect();
    assert_eq!(
        refused,
        [
            (
                blocked.to_string(),
                "no secrets in prompts\nkeys stay home".to_owned()
            ),
            (stopped.to_string(), "stop here".to_owned()),
        ]
    );
    assert_eq!(*lock(&session.queue.taken), [echoed.to_string()]);
}

// Real time under a timeout, since the run engine writes the row through the database writer.
// Killed by dropping the context-window readings from the session task's `apply`, and by reading
// each reading's run after the batch's turn ends retired their routes: no row would be filed, or
// the one of a turn that ended in the same batch would name no run.
#[tokio::test]
async fn a_token_usage_reading_files_the_context_window_on_its_run_even_as_its_turn_ends() {
    let usage = json!({
        "jsonrpc": "2.0",
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "tokenUsage": {
                "total": {"inputTokens": 1_200, "outputTokens": 300, "totalTokens": 1_500},
                "last": {"inputTokens": 1_200, "outputTokens": 300, "totalTokens": 1_500},
                "modelContextWindow": 258_400,
            },
        },
    });
    let live = LiveCodexSession::start(&[]).await;
    live.scripted.script.send(&usage);
    let ended_with_it = LiveCodexSession::with_released(&[
        usage,
        turn_completed(TEST_THREAD, TEST_TURN, "completed"),
    ])
    .await;

    for session in [&live, &ended_with_it] {
        assert_eq!(
            wait_for_context_windows(session).await,
            [json!({
                "sessionId": session.session_id.to_string(),
                "runId": session.run_id.to_string(),
                "windowUsedTokens": 1_500,
                "windowMaxTokens": 258_400,
                "windowSource": "providerReported",
                "exceeded": false,
            })]
        );
    }
}

// The session's `usage.contextWindow.updated` payloads, once one is written.
async fn wait_for_context_windows(session: &LiveCodexSession) -> Vec<Value> {
    let mut changes = session.followers.change_count(&session.session_id);
    loop {
        let payloads: Vec<Value> = session
            .database
            .reader()
            .prepare(
                "SELECT payload FROM session_events \
                 WHERE session_id = ?1 AND type = 'usage.contextWindow.updated' ORDER BY sequence",
            )
            .expect("the test reads the session's events")
            .query_map([session.session_id.to_string()], |row| {
                row.get::<_, String>(0)
            })
            .expect("the session's events read")
            .map(|payload| {
                serde_json::from_str(&payload.expect("each event reads"))
                    .expect("a stored payload is JSON")
            })
            .collect();
        if !payloads.is_empty() {
            return payloads;
        }
        tokio::time::timeout(Duration::from_secs(10), changes.changed())
            .await
            .expect("the session's task files the reading")
            .expect("the followers stay open");
    }
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
