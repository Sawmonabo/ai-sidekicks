//! What a live session's task applies of what its frames report.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{LiveCodexSession, TEST_TURN};
use crate::mutex_lock::lock;
use crate::provider::driver::codex::session::test_session::{TEST_THREAD, turn_completed};
use crate::provider::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::provider::driver::run_control::PauseRunParams;

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
    let (echoed, blocked, stopped) = (new_message_id(), new_message_id(), new_message_id());
    let session = LiveCodexSession::start(&[echoed, blocked, stopped]).await;
    let script = &session.scripted.script;

    script.send(&prompt_hook_completed("0", "completed", ""));
    script.send(&prompt_hook_completed(
        "1",
        "blocked",
        "the opening is blocked",
    ));
    script.send(&prompt_hook_completed("0", "completed", ""));
    script.send(&prompt_hook_completed("1", "completed", ""));
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
    script.send(&prompt_hook_completed(
        "0",
        "blocked",
        "no secrets in prompts",
    ));
    script.send(&prompt_hook_completed("1", "blocked", "keys stay home"));
    script.send(&prompt_hook_completed("0", "completed", ""));
    script.send(&prompt_hook_completed("1", "stopped", "stop here"));
    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    while lock(&session.queue.refused).len() < 2 {
        tokio::time::timeout(Duration::from_secs(10), session.queue.changed.notified())
            .await
            .expect("the session's task reports the refusals");
    }

    assert_eq!(
        refused_words(&session),
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

// Real time under a timeout, as above. The opening prompt and the first steer are refused, and the
// second steer, whose hook never ran, is still unechoed when the person's interrupt stops the
// turn. Killed by pairing the refusals from the tail, which refuses the first steer with the
// opening's words and the second with the first's.
#[tokio::test]
async fn a_refused_steer_pairs_with_its_own_prompt_and_an_unrun_one_is_dropped() {
    let (blocked, unrun) = (new_message_id(), new_message_id());
    let mut session = LiveCodexSession::start(&[blocked, unrun]).await;
    let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
    let script = &mut session.scripted.script;
    script.send(&prompt_hook_completed(
        "0",
        "blocked",
        "the opening is blocked",
    ));
    script.send(&prompt_hook_completed("0", "blocked", "keys stay home"));

    let interrupt = parts.run_control.interrupt_run(session.run_id);
    tokio::pin!(interrupt);
    let dropped = loop {
        tokio::select! {
            dropped = &mut interrupt => break dropped.expect("the interrupt stops the turn"),
            sent = tokio::time::timeout(Duration::from_secs(10), script.next_sent()) => {
                answer_stopping_request(script, &sent.expect("the interrupt goes out"));
            }
        }
    };

    assert_eq!(dropped, [unrun]);
    assert_eq!(
        refused_words(&session),
        [(blocked.to_string(), "keys stay home".to_owned())]
    );
}

/// What stopped the turn a steer was sent into.
#[derive(Clone, Copy, Debug)]
enum TurnStop {
    /// A pause, at the turn's next step end.
    Pause,
    /// A faster-model retry.
    Retry,
}

// Real time under a timeout, as above. A steer sent and still unechoed when a pause or a retry
// stops its turn goes back to the queue, never refused, whether the pause's turn end arrives
// before or after the session settles its interrupt's answer. Killed by dropping the
// `message_given_back` call from the session task's turn end.
#[rstest]
#[case::pause(TurnStop::Pause)]
#[case::retry(TurnStop::Retry)]
#[tokio::test]
async fn a_steer_a_pause_or_retry_stopped_unechoed_is_given_back(#[case] stop: TurnStop) {
    let steer = new_message_id();
    let mut session = match stop {
        TurnStop::Pause => LiveCodexSession::start(&[steer]).await,
        TurnStop::Retry => LiveCodexSession::retried(&[steer]).await,
    };
    match stop {
        TurnStop::Pause => {
            let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
            parts
                .run_control
                .pause_run(PauseRunParams {
                    session_id: session.session_id,
                    run_id: session.run_id,
                })
                .await
                .expect("the pause is marked on the live turn");
            let script = &mut session.scripted.script;
            script.send(&json!({
                "jsonrpc": "2.0",
                "method": "item/completed",
                "params": {
                    "threadId": TEST_THREAD,
                    "turnId": TEST_TURN,
                    "item": {"type": "reasoning", "id": "item-1", "summary": [], "content": []},
                },
            }));
            let interrupt = tokio::time::timeout(Duration::from_secs(10), script.next_sent())
                .await
                .expect("the step's end interrupts the turn");
            assert_eq!(interrupt["method"], "turn/interrupt");
            answer_stopping_request(script, &interrupt);
        }
        TurnStop::Retry => {
            let script = &session.scripted.script;
            script.send(&turn_completed(TEST_THREAD, TEST_TURN, "interrupted"));
        }
    }
    while lock(&session.queue.given_back).is_empty() {
        tokio::time::timeout(Duration::from_secs(10), session.queue.changed.notified())
            .await
            .expect("the session's task gives the steer back");
    }

    assert_eq!(*lock(&session.queue.given_back), [steer.to_string()]);
    assert!(lock(&session.queue.refused).is_empty());
}

fn new_message_id() -> QueueItemId {
    QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id")
}

// One run of the person's `userPromptSubmit` hook handler `handler` on a prompt of the test turn,
// ending `status` with `words`.
fn prompt_hook_completed(handler: &str, status: &str, words: &str) -> Value {
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
}

// Answers what stopping a turn sends: an interrupt, with its turn's end as Codex sends it on the
// abort, the running-command list as empty, and the rest with nothing.
fn answer_stopping_request(script: &ScriptedService, sent: &Value) {
    match sent["method"].as_str() {
        Some("turn/interrupt") => {
            script.answer(sent, &json!({}));
            script.send(&turn_completed(TEST_THREAD, TEST_TURN, "interrupted"));
        }
        Some("thread/backgroundTerminals/list") => {
            script.answer(sent, &json!({"data": [], "nextCursor": null}));
        }
        _ => script.answer(sent, &json!({})),
    }
}

// Each message the queue was told a hook refused, with the hook's words.
fn refused_words(session: &LiveCodexSession) -> Vec<(String, String)> {
    lock(&session.queue.refused)
        .iter()
        .map(|(message_id, reason)| {
            let QueueItemNotDeliveredReason::RefusedByHook { words } = reason else {
                panic!("each steer is refused by its hook");
            };
            (message_id.clone(), words.as_str().to_owned())
        })
        .collect()
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
