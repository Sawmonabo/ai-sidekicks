//! What a live session's task applies of what its frames report.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{LiveCodexSession, TEST_TURN, answer_stopping_request};
use crate::mutex_lock::lock;
use crate::provider::driver::codex::intervention::CodexSteerRunRequest;
use crate::provider::driver::codex::session::test_session::{
    TEST_THREAD, fork_reply, no_turns, test_thread_settings, turn_completed, turn_reply,
};
use crate::provider::driver::run_control::{
    FasterModelRetryOutcome, FasterModelRetryParams, PauseRunParams,
};
use crate::session::run::engine::tests::stored_run_state;

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

/// Which reaches the session first once a pause's interrupt stopped its turn.
#[derive(Clone, Copy, Debug)]
enum PauseOrder {
    /// The turn's end, ahead of Codex's answer to the interrupt.
    EndFirst,
    /// Codex's answer, settled on the session before the turn's end.
    SettleFirst,
}

// Real time under a timeout, as above. A steer still unechoed when a pause stops its turn goes back
// to the queue, never refused, and the run reads paused, whether the turn's end reaches the
// session before or after it settles the interrupt's answer. Killed by reading a live turn ahead
// of the pause's mark in `find_turn_run_id` (the end-first run reads interrupted), and by dropping
// the `message_given_back` call from the session task's turn end.
#[rstest]
#[case::end_first(PauseOrder::EndFirst)]
#[case::settle_first(PauseOrder::SettleFirst)]
#[tokio::test]
async fn a_paused_turn_reads_paused_and_gives_its_unechoed_steer_back(#[case] order: PauseOrder) {
    let steer = new_message_id();
    let mut session = LiveCodexSession::start(&[steer]).await;
    let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
    // As the run engine moves the run before it asks the driver to pause it.
    session
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'pausing', run_version = 2 WHERE run_id = ?1",
            [session.run_id.text().as_str()],
        )
        .expect("the test moves the run to pausing");
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
    let ended = turn_completed(TEST_THREAD, TEST_TURN, "interrupted");
    match order {
        PauseOrder::EndFirst => {
            script.send(&ended);
            script.answer(&interrupt, &json!({}));
        }
        PauseOrder::SettleFirst => {
            script.answer(&interrupt, &json!({}));
            // The settle retires the stopped turn's route, the run's last.
            tokio::time::timeout(Duration::from_secs(10), async {
                while parts.run_routes.session_id_for(session.run_id).is_some() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the session settles the interrupt's answer");
            script.send(&ended);
        }
    }
    let mut changes = session.followers.change_count(&session.session_id);
    while stored_run_state(&session.database, &session.run_id).0 != "paused" {
        tokio::time::timeout(Duration::from_secs(10), changes.changed())
            .await
            .expect("the session's task reports the run paused")
            .expect("the followers stay open");
    }
    while lock(&session.queue.given_back).is_empty() {
        tokio::time::timeout(Duration::from_secs(10), session.queue.changed.notified())
            .await
            .expect("the session's task gives the steer back");
    }

    assert_eq!(*lock(&session.queue.given_back), [steer.to_string()]);
    assert!(lock(&session.queue.refused).is_empty());
}

// Real time under a timeout, as above. A steer still unechoed when a faster-model retry stops its
// turn goes back to the queue only once the turn sent again on the fork runs as the run's, and the
// queue's next hand of it steers into that turn. Killed by giving the steer back at the held
// turn's end (it is back before the new turn's start is answered), and by giving back none.
#[tokio::test]
async fn a_retry_gives_its_held_turns_unechoed_steer_back_once_its_new_turn_runs() {
    let steer = new_message_id();
    let mut session = LiveCodexSession::retriable(&[steer]).await;
    let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
    let settings = test_thread_settings(session.session_id);
    let queue = Arc::clone(&session.queue);
    let retry = parts.retries.retry(retry_params(&session));
    let script = &mut session.scripted.script;
    let service = async {
        let interrupt = script.next_sent().await;
        assert_eq!(interrupt["method"], "turn/interrupt");
        script.answer(&interrupt, &json!({}));
        script.send(&turn_completed(TEST_THREAD, TEST_TURN, "interrupted"));
        // The fork and what moving onto it sends, up to the turn sent again there.
        let started = loop {
            let sent = script.next_sent().await;
            match sent["method"].as_str() {
                Some("thread/fork") => {
                    assert_eq!(sent["params"]["model"], "gpt-5-fast");
                    script.answer(&sent, &fork_reply("thread-2", &settings));
                }
                Some("thread/turns/list") => script.answer(&sent, &no_turns()),
                Some("turn/start") => break sent,
                _ => answer_stopping_request(script, &sent),
            }
        };
        assert_eq!(started["params"]["threadId"], "thread-2");
        assert!(
            lock(&queue.given_back).is_empty(),
            "nothing goes back before the new turn runs"
        );
        script.answer(&started, &turn_reply("turn-2"));
    };
    let (retried, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(retry, service)
    })
    .await
    .expect("the retry settles");

    assert_eq!(
        retried.expect("the retry applies"),
        FasterModelRetryOutcome::Applied {}
    );
    assert_eq!(*lock(&session.queue.given_back), [steer.to_string()]);
    let steered = parts.run_control.steer_run(CodexSteerRunRequest {
        run_id: session.run_id,
        content: MessageContent::new("also check the tests".to_owned()).expect("the words"),
        skills: Vec::new(),
        attachments: Vec::new(),
        expected_turn_id: None,
        client_idempotency_key: steer,
    });
    let service = async {
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "turn/steer");
        assert_eq!(sent["params"]["threadId"], "thread-2");
        assert_eq!(sent["params"]["expectedTurnId"], "turn-2");
        script.answer(&sent, &json!({"turnId": "turn-2"}));
    };
    let (acknowledged, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(steered, service)
    })
    .await
    .expect("the steer is answered");
    assert_eq!(
        acknowledged
            .expect("the new turn takes the steer")
            .targeted_turn_id,
        "turn-2"
    );
}

// Real time under a timeout, as above. An interrupt that stops a retry before it forks answers the
// steer its held turn dropped, which is never given back besides. Killed by answering the stopped
// retry's interrupt with no steers.
#[tokio::test]
async fn an_interrupt_that_stops_a_retry_answers_its_held_turns_unechoed_steer() {
    let steer = new_message_id();
    let mut session = LiveCodexSession::retriable(&[steer]).await;
    let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
    let retry = parts.retries.retry(retry_params(&session));
    tokio::pin!(retry);
    let script = &mut session.scripted.script;
    let stop = tokio::select! {
        _ = &mut retry => panic!("the retry waits for its interrupt's answer"),
        sent = tokio::time::timeout(Duration::from_secs(10), script.next_sent()) => {
            sent.expect("the retry stops its turn")
        }
    };
    assert_eq!(stop["method"], "turn/interrupt");
    let interrupt = parts.run_control.interrupt_run(session.run_id);
    tokio::pin!(interrupt);
    assert!(futures::poll!(&mut interrupt).is_pending());
    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "interrupted"));
    script.answer(&stop, &json!({}));
    let settled = async { tokio::join!(&mut retry, &mut interrupt) };
    tokio::pin!(settled);
    let (retried, dropped) = loop {
        tokio::select! {
            both = &mut settled => break both,
            sent = tokio::time::timeout(Duration::from_secs(10), script.next_sent()) => {
                answer_stopping_request(script, &sent.expect("the interrupt settles"));
            }
        }
    };

    assert_eq!(
        retried.expect("a stopped retry answers"),
        FasterModelRetryOutcome::Rejected {
            rejection_reason: "The run was interrupted.".to_owned(),
        }
    );
    assert_eq!(dropped.expect("the interrupt stops the retry"), [steer]);
    assert!(lock(&session.queue.given_back).is_empty());
}

// A retry of the session's run on [`TEST_TURN`] onto the faster model.
fn retry_params(session: &LiveCodexSession) -> FasterModelRetryParams {
    FasterModelRetryParams {
        session_id: session.session_id,
        run_id: session.run_id,
        expected_turn_id: TEST_TURN.to_owned(),
        model: ProviderToken::new("gpt-5-fast".to_owned()).expect("a model token"),
    }
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
