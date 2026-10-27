//! What a live session's task applies of what its frames report.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;

use super::{LiveCodexSession, TEST_TURN, answer_stopping_request};
use crate::codex::run::control::record::{CodexContinuePlace, CodexRunControlCall};
use crate::codex::session::calls::call_codex_session;
use crate::codex::session::inbound::CodexSessionCall;
use crate::codex::session::test_session::{
    TEST_THREAD, fork_reply, no_turns, test_thread_settings, turn_completed, turn_reply,
};
use crate::driver::contract::DriverError;
use crate::driver::run_control::{
    FasterModelRetryOutcome, FasterModelRetryParams, PauseRunParams, ResumeRunParams,
    WaitingMessage,
};
use crate::driver::test_registry::new_message_id;
use crate::port::question::QuestionPort;
use crate::port::question::test_card::QuestionCard;
use crate::run::delivery::LateAppendableRow;
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use sidekicks_std::mutex_lock::lock;

// Real time under a timeout, since the session's task applies each frame on its own task. Two
// handlers run on each prompt: the opening prompt's second blocks, the first steer
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

/// Which reaches the session first once a pause's interrupt went out.
#[derive(Clone, Copy, Debug)]
enum PauseOrder {
    /// The turn's end, ahead of Codex's answer to the interrupt.
    EndFirst,
    /// Codex's answer, settled on the session before the turn's end.
    SettleFirst,
}

/// How the turn a pause's interrupt went out for ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PauseEnd {
    /// The interrupt stopped it, a steer still unechoed in it.
    Stopped,
    /// It completed by itself first, so Codex refuses the interrupt as of no active turn.
    CompletedByItself,
    /// It failed by itself first, so Codex refuses the interrupt as of no active turn.
    FailedByItself,
    /// It ended by itself first with a status Codex does not send, so Codex refuses the interrupt
    /// as of no active turn.
    UnknownStatusByItself,
}

// Real time under a timeout, as above. A pause's turn reads by its own end, whichever of its end
// and the interrupt's answer the session takes first: one the interrupt stopped reads paused and
// gives its unechoed steer back to the queue, never refused; one that completed by itself is the
// step that landed and reads paused too; one that failed by itself, or ended with a status Codex
// does not send, ends its run failed, its failure surfacing, and the continue that waited on the
// pause is refused, so its resume leaves the messages waiting. Each ends with its turn's route
// retired and no second end once every answer landed. Killed by reading a pause-marked turn paused
// whatever its status (the failed run reads paused), by settling an already-ended answer as a stop
// (the settle-first by-itself run's route is retired before its end), by reading a live turn ahead
// of the pause's mark in `find_turn_run_id` (the end-first stopped run reads interrupted), by
// dropping the `message_given_back` call from the session task's turn end, and by dropping the
// waiting continue with the failed turn's mark (its resume never answers).
#[rstest]
#[case::end_first(PauseOrder::EndFirst, PauseEnd::Stopped)]
#[case::settle_first(PauseOrder::SettleFirst, PauseEnd::Stopped)]
#[case::end_first_completed_by_itself(PauseOrder::EndFirst, PauseEnd::CompletedByItself)]
#[case::settle_first_completed_by_itself(PauseOrder::SettleFirst, PauseEnd::CompletedByItself)]
#[case::end_first_failed_by_itself(PauseOrder::EndFirst, PauseEnd::FailedByItself)]
#[case::settle_first_failed_by_itself(PauseOrder::SettleFirst, PauseEnd::FailedByItself)]
#[case::end_first_unknown_status_by_itself(PauseOrder::EndFirst, PauseEnd::UnknownStatusByItself)]
#[tokio::test]
async fn a_pause_marked_turn_reads_by_its_own_end(
    #[case] order: PauseOrder,
    #[case] end: PauseEnd,
) {
    let steers = match end {
        PauseEnd::Stopped => vec![new_message_id()],
        PauseEnd::CompletedByItself
        | PauseEnd::FailedByItself
        | PauseEnd::UnknownStatusByItself => Vec::new(),
    };
    let mut session = LiveCodexSession::start(&steers).await;
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
    // A continue asked for while the pause's interrupt is out waits on the pause: its resume is
    // answered once its turn starts, or refused when the run ends first.
    let awaiting = match end {
        PauseEnd::FailedByItself => {
            let inbound = parts
                .slots
                .require_live(session.session_id)
                .expect("the session is live");
            let params = ResumeRunParams {
                session_id: session.session_id,
                run_id: session.run_id,
                messages: vec![WaitingMessage {
                    id: new_message_id(),
                    content: MessageContent::new("carry on".to_owned())
                        .expect("the words are a message"),
                    attachments: Vec::new(),
                    skills: Vec::new(),
                }],
            };
            let place = call_codex_session(&inbound, |reply| {
                CodexSessionCall::RunControl(CodexRunControlCall::PlaceContinue { params, reply })
            })
            .await
            .expect("the continue is placed");
            let resolved = match place {
                CodexContinuePlace::AwaitsPause { resolved } => Some(resolved),
                CodexContinuePlace::SteerInto { .. } | CodexContinuePlace::StartTurn(_) => None,
            };
            Some(resolved.expect("the continue waits on the pause"))
        }
        PauseEnd::Stopped | PauseEnd::CompletedByItself | PauseEnd::UnknownStatusByItself => None,
    };
    let (ended, answer, expected_state) = match end {
        PauseEnd::Stopped => (
            turn_completed(TEST_THREAD, TEST_TURN, "interrupted"),
            json!({"jsonrpc": "2.0", "id": interrupt["id"], "result": {}}),
            RunStateChangeState::Paused,
        ),
        PauseEnd::CompletedByItself => (
            turn_completed(TEST_THREAD, TEST_TURN, "completed"),
            no_active_turn_refusal(&interrupt),
            RunStateChangeState::Paused,
        ),
        PauseEnd::FailedByItself => {
            let mut failed = turn_completed(TEST_THREAD, TEST_TURN, "failed");
            failed["params"]["turn"]["error"] = json!({"message": "The model is overloaded."});
            (
                failed,
                no_active_turn_refusal(&interrupt),
                RunStateChangeState::Failed,
            )
        }
        PauseEnd::UnknownStatusByItself => (
            turn_completed(TEST_THREAD, TEST_TURN, "wandered"),
            no_active_turn_refusal(&interrupt),
            RunStateChangeState::Failed,
        ),
    };
    match order {
        PauseOrder::EndFirst => {
            // The end is read off the socket ahead of the answer, so the session takes it first.
            script.send(&ended);
            script.send(&answer);
        }
        PauseOrder::SettleFirst => {
            script.send(&answer);
            let live_turn_runs = live_turn_runs_once_settled(&mut session).await;
            // A stop retires the turn's route, the run's last; an end already reached leaves it
            // for that end to retire.
            let kept_live: &[RunId] = match end {
                PauseEnd::Stopped => &[],
                PauseEnd::CompletedByItself
                | PauseEnd::FailedByItself
                | PauseEnd::UnknownStatusByItself => &[session.run_id],
            };
            assert_eq!(live_turn_runs, kept_live);
            session.scripted.script.send(&ended);
        }
    }
    tokio::time::timeout(
        Duration::from_secs(10),
        session.engine.wait_until(|_| {
            session
                .engine
                .run_moves()
                .iter()
                .any(|change| change.entry.state() == expected_state)
                .then_some(())
        }),
    )
    .await
    .expect("the session's task reports the run's end");
    if end == PauseEnd::Stopped {
        while lock(&session.queue.given_back).is_empty() {
            tokio::time::timeout(Duration::from_secs(10), session.queue.changed.notified())
                .await
                .expect("the session's task gives the steer back");
        }
    }
    if let Some(resolved) = awaiting {
        let answer = tokio::time::timeout(Duration::from_secs(10), resolved)
            .await
            .expect("the failed end answers the waiting continue")
            .expect("the record keeps the continue's reply");
        assert!(
            matches!(answer, Err(DriverError::SteerTurnEnded(_))),
            "the continue is refused, so its resume leaves the messages waiting"
        );
    }
    // The interrupt's answer, read off the socket after the end here, has landed too.
    let live_turn_runs = live_turn_runs_once_settled(&mut session).await;

    assert_eq!(live_turn_runs, Vec::new());

    let moves = session.engine.run_moves();
    match end {
        PauseEnd::Stopped | PauseEnd::CompletedByItself => {
            // Reported from the pausing state, so a pause a resume already moved past is refused.
            assert_eq!(
                moves,
                [RunStateReport {
                    expected_state: Some(RunState::Pausing),
                    ..RunStateReport::new(session.run_id, RunStateEntry::Paused)
                }]
            );
        }
        PauseEnd::FailedByItself | PauseEnd::UnknownStatusByItself => {
            let [failed] = moves.as_slice() else {
                panic!("the run ends once, failed: {moves:?}");
            };
            assert_eq!(failed.run_id, session.run_id);
            assert_eq!(failed.entry.state(), RunStateChangeState::Failed);
            assert_eq!(
                failed.failure_category,
                Some(RunFailureCategory::ProviderFailure)
            );
        }
    }
    let given_back: Vec<String> = steers.iter().map(ToString::to_string).collect();
    assert_eq!(*lock(&session.queue.given_back), given_back);
    assert!(lock(&session.queue.refused).is_empty());
}

// Codex's refusal of an interrupt whose turn already ended.
fn no_active_turn_refusal(interrupt: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": interrupt["id"],
        "error": {"code": -32600, "message": "no active turn to interrupt"},
    })
}

// The runs whose turns are live once the session settled a pause's interrupt answered ahead of the
// turn's end. A request Codex sends after the answer is read off the socket after it, and the
// test's runtime polls woken tasks in the order they woke, so the pause's task has queued its
// settle by the time that request is answered; a reading asked after that is answered after the
// settle.
async fn live_turn_runs_once_settled(session: &mut LiveCodexSession) -> Vec<RunId> {
    let script = &mut session.scripted.script;
    script.send(&json!({
        "jsonrpc": "2.0",
        "id": "after-the-answer",
        "method": "item/tool/call",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "callId": "call-1",
            "tool": "lookup",
            "arguments": {},
        },
    }));
    loop {
        let sent = tokio::time::timeout(Duration::from_secs(10), script.next_sent())
            .await
            .expect("the session answers the request after the interrupt's answer");
        if sent["id"] == "after-the-answer" {
            break;
        }
    }
    let parts = session.driver.parts().expect("the driver composes");
    let inbound = parts
        .slots
        .require_live(session.session_id)
        .expect("the session is live");
    call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
        thread_id: None,
        reply,
    })
    .await
    .expect("the session reads")
    .live_turn_runs
}

// Real time under a timeout, as above. The person's interrupt whose turn's end reaches the session
// ahead of Codex's answer to it ends no run as one Codex stopped by itself: the driver writes no
// end, which the run engine writes for the person's interrupt, and the steer the turn dropped is
// answered to the interrupt. Killed by dropping the read of the turns being interrupted from the
// turn's end (the driver ends the run interrupted as Codex's own stop).
#[tokio::test]
async fn an_interrupts_turn_ending_ahead_of_its_answer_is_the_interrupts() {
    let steer = new_message_id();
    let mut session = LiveCodexSession::start(&[steer]).await;
    let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
    let script = &mut session.scripted.script;

    let interrupt = parts.run_control.interrupt_run(session.run_id);
    tokio::pin!(interrupt);
    let dropped = loop {
        tokio::select! {
            dropped = &mut interrupt => break dropped.expect("the interrupt stops the turn"),
            sent = tokio::time::timeout(Duration::from_secs(10), script.next_sent()) => {
                let sent = sent.expect("the interrupt goes out");
                if sent["method"] == "turn/interrupt" {
                    // The end is read off the socket ahead of the answer.
                    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "interrupted"));
                    script.answer(&sent, &json!({}));
                } else {
                    answer_stopping_request(script, &sent);
                }
            }
        }
    };

    assert_eq!(dropped, [steer]);
    assert_eq!(session.engine.run_moves(), Vec::new());
}

// Real time under a timeout, as above. A steer still unechoed when a faster-model retry stops its
// turn goes back to the queue at that turn's end, ahead of the turn sent again on the fork, and
// nothing steers it meanwhile: Codex takes a given-back message at its run's next tool boundary.
// Killed by the retried turn's end keeping its steers rather than dropping them, and by dropping
// the `message_given_back` call from the session task's turn end.
#[tokio::test]
async fn a_retry_gives_its_held_turns_unechoed_steer_back_at_that_turns_end() {
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
                Some("turn/steer") => panic!("nothing steers the given-back message"),
                _ => answer_stopping_request(script, &sent),
            }
        };
        assert_eq!(started["params"]["threadId"], "thread-2");
        assert_eq!(
            *lock(&queue.given_back),
            [steer.to_string()],
            "the held turn's end gave it back"
        );
        script.answer(&started, &turn_reply("turn-2"));
    };
    let (retried, ()) = tokio::time::timeout(
        Duration::from_secs(10),
        Box::pin(async { tokio::join!(retry, service) }),
    )
    .await
    .expect("the retry settles");

    assert_eq!(
        retried.expect("the retry applies"),
        FasterModelRetryOutcome::Applied {}
    );
    assert_eq!(*lock(&session.queue.given_back), [steer.to_string()]);
}

// Real time under a timeout, as above. An interrupt that stops a retry before it forks answers no
// steer, since the held turn's end gave the one it dropped back to the queue, once. Killed by the
// retried turn's end keeping its steers rather than dropping them.
#[tokio::test]
async fn an_interrupt_that_stops_a_retry_answers_no_steer_its_held_turns_end_gave_back() {
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
    assert_eq!(dropped.expect("the interrupt stops the retry"), Vec::new());
    assert_eq!(*lock(&session.queue.given_back), [steer.to_string()]);
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

// Real time under a timeout, as above. Killed by dropping the context-window readings from the
// session task's `apply`, and by reading each reading's run after the batch's turn ends retired
// their routes: no row would be filed, or the one of a turn that ended in the same batch would name
// no run.
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

// The session's `usage.contextWindow.updated` payloads, once one is delivered.
async fn wait_for_context_windows(session: &LiveCodexSession) -> Vec<Value> {
    tokio::time::timeout(
        Duration::from_secs(10),
        session.engine.wait_until(|_| {
            let payloads: Vec<Value> = session
                .engine
                .deliveries()
                .iter()
                .filter_map(|delivery| {
                    let Some(LateAppendableRow::UsageContextWindowUpdated(payload)) = &delivery.row
                    else {
                        return None;
                    };
                    Some(serde_json::to_value(payload).expect("a payload serializes"))
                })
                .collect();
            (!payloads.is_empty()).then_some(payloads)
        }),
    )
    .await
    .expect("the session's task files the reading")
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

// Real time under a timeout, as above. Codex lets a question go with its turn's end while its
// record's write is still queued: the turn's withdrawal finds nothing on the card, and the
// question's own take withdraws it once the record lands. Killed by leaving the let-go out of
// forgetting a question.
#[tokio::test]
async fn a_question_its_turn_let_go_before_its_record_landed_is_withdrawn_once_it_lands() {
    let session = LiveCodexSession::start(&[]).await;
    let card = Arc::new(QuestionCard::default());
    card.hold_records();
    let port: Arc<dyn QuestionPort> = card.clone();
    assert!(session.questions.register(port).is_ok());
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": "question-1",
        "method": "item/tool/requestUserInput",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "itemId": "item-1",
            "questions": [{"id": "name", "header": "Name", "question": "Which name?"}],
        },
    }));
    card.wait_until_records_held(1).await;

    session
        .scripted
        .script
        .send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    card.wait_until_withdrawals(1).await;
    assert!(
        card.taken().is_empty(),
        "the turn's withdrawal finds nothing"
    );
    card.land_records();
    card.wait_until_withdrawals(2).await;

    assert_eq!(card.withdrawals(), [r#""question-1""#, r#""question-1""#]);
    assert_eq!(card.taken().len(), 1, "the record landed");
    card.wait_until_none_open().await;
}

// Real time under a timeout, as above. A question recorded waiting for its run whose take fails is
// withdrawn from the card by its request id, and Codex's request is answered with no answers, its
// refusal, so the agent never waits on a request no card holds. Killed by leaving out the take's
// withdrawal or the driver's refusal.
#[tokio::test]
async fn a_question_whose_take_failed_is_withdrawn_and_refused() {
    let mut session = LiveCodexSession::start(&[]).await;
    let card = Arc::new(QuestionCard::default());
    card.fail_waiting_opens();
    let port: Arc<dyn QuestionPort> = card.clone();
    assert!(session.questions.register(port).is_ok());
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": "question-1",
        "method": "item/tool/requestUserInput",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "itemId": "item-1",
            "questions": [{"id": "name", "header": "Name", "question": "Which name?"}],
        },
    }));
    let answer = loop {
        let sent =
            tokio::time::timeout(Duration::from_secs(10), session.scripted.script.next_sent())
                .await
                .expect("the session answers the question");
        if sent["id"] == "question-1" {
            break sent;
        }
    };

    assert_eq!(card.withdrawals(), [r#""question-1""#]);
    assert!(card.taken().is_empty(), "it never opened");
    card.wait_until_none_waiting().await;
    assert_eq!(answer["result"], json!({"answers": {}}));
}
