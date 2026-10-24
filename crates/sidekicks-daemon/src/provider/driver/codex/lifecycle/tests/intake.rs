//! What a live session's task applies of what its frames report.

use std::time::Duration;

use serde_json::json;
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
